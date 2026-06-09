/**
 * AIP-16 Phase 3 H4 fix — Agent.processJob smartWalletNonce threading tests.
 *
 * Verifies that the provider-side `smartWalletNonce` field on
 * {@link AgentConfig} is threaded all the way down to the signed
 * envelope payload via both {@link DeliveryEnvelopeBuilder.buildPublic}
 * and {@link DeliveryEnvelopeBuilder.buildEncrypted}.
 *
 * Before the H4 follow-up these tests would have failed: Agent.processJob
 * hardcoded `smartWalletNonce: 0` at both build call sites, so providers
 * whose Smart Wallet was deployed at a non-zero factory nonce could
 * never produce an envelope that verified against the correct derived
 * `providerAddress` server-side.
 *
 * Coverage:
 *   1. Default behavior (no `smartWalletNonce` on AgentConfig) ⇒ signed
 *      envelope carries `smartWalletNonce === 0` (byte-identical to
 *      pre-H4).
 *   2. Explicit `smartWalletNonce: 0` on AgentConfig ⇒ identical to (1).
 *   3. Explicit `smartWalletNonce: 3` ⇒ public envelope carries 3.
 *   4. Explicit `smartWalletNonce: 7` ⇒ encrypted envelope carries 7.
 *   5. Verifier recovers the real signer for non-zero nonce (public).
 *   6. Two agents with different smartWalletNonce values produce
 *      distinct envelope signatures (the field is bound by the EIP-712
 *      type hash).
 *
 * Mocks the runtime via the same `attachStubRuntime` pattern used in
 * Agent.processJob.delivery.test.ts so the suite stays fast and
 * deterministic — no polling, no full lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HDNodeWallet, Wallet } from 'ethers';

import { Agent } from './Agent';
import type { ServiceConfig } from './Agent';
import type { Job, JobHandler } from './types/Job';
import { MockDeliveryChannel } from '../delivery/MockDeliveryChannel';
import {
  DeliverySetupBuilder,
  generateEphemeralKeyPair,
  recoverEnvelopeSigner,
  type DeliveryEnvelopeWireV1,
  type DeliverySetupWireV1,
} from '../delivery';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const CHAIN_ID = 84532;
const TX_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const STUB_PROVIDER_ADDRESS = '0x' + 'dd'.repeat(20);

interface AgentInternals {
  maybePublishDeliveryEnvelope(job: Job, result: unknown): Promise<void>;
  _client?: {
    runtime: { getTransaction(txId: string): Promise<unknown> };
    getAddress(): string;
  };
}

interface StubRuntime {
  getTransaction: jest.Mock;
}

function makeStubRuntime(state: string = 'COMMITTED'): StubRuntime {
  return {
    getTransaction: jest.fn().mockResolvedValue({
      id: TX_ID,
      state,
    }),
  };
}

function ensureBaseDir(): string {
  const base = path.join(os.homedir(), '.agirails');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

function newAgent(opts: {
  channel?: MockDeliveryChannel;
  signer?: HDNodeWallet;
  kernelAddress?: string;
  chainId?: number;
  smartWalletNonce?: number;
  deliveryCfg?: { mode: 'channel' | 'none'; privacy: 'public' | 'encrypted' };
  serviceName?: string;
  testDir: string;
}): Agent {
  const agent = new Agent({
    name: 'DeliveryAgent',
    network: 'mock',
    stateDirectory: opts.testDir,
    deliveryChannel: opts.channel,
    deliverySigner: opts.signer,
    kernelAddress: opts.kernelAddress,
    chainId: opts.chainId,
    smartWalletNonce: opts.smartWalletNonce,
  });

  const handler: JobHandler = async () => ({ ok: true });
  const cfg: ServiceConfig = {
    name: opts.serviceName ?? 'echo',
    ...(opts.deliveryCfg ? { delivery: opts.deliveryCfg } : {}),
  };
  agent.provide(cfg, handler);
  return agent;
}

function makeJob(service = 'echo'): Job {
  return {
    id: TX_ID,
    service,
    input: { x: 1 },
    budget: 1,
    deadline: new Date(Date.now() + 60_000),
    requester: '0x' + 'ee'.repeat(20),
    metadata: {},
  };
}

function attachStubRuntime(
  agent: Agent,
  runtime: StubRuntime,
  providerAddress: string = STUB_PROVIDER_ADDRESS,
): void {
  (agent as unknown as AgentInternals)._client = {
    runtime: runtime as unknown as {
      getTransaction(txId: string): Promise<unknown>;
    },
    getAddress: (): string => providerAddress,
  };
}

async function buildBuyerSetup(
  buyerWallet: HDNodeWallet,
): Promise<DeliverySetupWireV1> {
  const kp = generateEphemeralKeyPair();
  const builder = new DeliverySetupBuilder(buyerWallet);
  const { wire } = await builder.build({
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
    requesterAddress: buyerWallet.address as `0x${string}`,
    signerAddress: buyerWallet.address as `0x${string}`,
    buyerEphemeralPubkey: kp.publicKeyHex,
    expectedPrivacy: 'encrypted',
  });
  return wire;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AIP-16 Phase 3 H4 — Agent.processJob smartWalletNonce threading', () => {
  const ORIGINAL_FLAG = process.env.ACTP_DELIVERY_CHANNEL;
  let testDir: string;
  let providerWallet: HDNodeWallet;

  beforeEach(() => {
    const base = ensureBaseDir();
    testDir = fs.mkdtempSync(path.join(base, 'agent-swn-test-'));
    providerWallet = Wallet.createRandom();
    process.env.ACTP_DELIVERY_CHANNEL = 'v1';
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.ACTP_DELIVERY_CHANNEL;
    } else {
      process.env.ACTP_DELIVERY_CHANNEL = ORIGINAL_FLAG;
    }
  });

  it('default (no smartWalletNonce on AgentConfig): envelope carries nonce=0 (public)', async () => {
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
    });
    const agent = newAgent({
      channel,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      // smartWalletNonce intentionally omitted
      testDir,
    });
    attachStubRuntime(agent, makeStubRuntime('COMMITTED'), providerWallet.address);

    await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
      makeJob(),
      { hello: 'world' },
    );
    await flush();

    const envs = channel.getAllEnvelopes(TX_ID);
    expect(envs).toHaveLength(1);
    const env = envs[0] as DeliveryEnvelopeWireV1;
    expect(env.signed.scheme).toBe('public-v1');
    expect(env.signed.smartWalletNonce).toBe(0);
  });

  it('explicit smartWalletNonce=0: envelope carries nonce=0', async () => {
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
    });
    const agent = newAgent({
      channel,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      smartWalletNonce: 0,
      testDir,
    });
    attachStubRuntime(agent, makeStubRuntime('COMMITTED'), providerWallet.address);

    await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
      makeJob(),
      { hello: 'world' },
    );
    await flush();

    const envs = channel.getAllEnvelopes(TX_ID);
    expect(envs).toHaveLength(1);
    const env = envs[0] as DeliveryEnvelopeWireV1;
    expect(env.signed.smartWalletNonce).toBe(0);
  });

  it('explicit smartWalletNonce=3: public envelope carries nonce=3', async () => {
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
    });
    const agent = newAgent({
      channel,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      smartWalletNonce: 3,
      testDir,
    });
    attachStubRuntime(agent, makeStubRuntime('COMMITTED'), providerWallet.address);

    await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
      makeJob(),
      { hello: 'world' },
    );
    await flush();

    const envs = channel.getAllEnvelopes(TX_ID);
    expect(envs).toHaveLength(1);
    const env = envs[0] as DeliveryEnvelopeWireV1;
    expect(env.signed.scheme).toBe('public-v1');
    expect(env.signed.smartWalletNonce).toBe(3);
  });

  it('explicit smartWalletNonce=7: encrypted envelope carries nonce=7', async () => {
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
    });
    // Seed a buyer setup on the channel so the encrypted-path lookup
    // (getSetups) finds a buyerEphemeralPubkey.
    const buyerWallet = Wallet.createRandom();
    const setup = await buildBuyerSetup(buyerWallet);
    await channel.publishSetup(setup);

    const agent = newAgent({
      channel,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      smartWalletNonce: 7,
      deliveryCfg: { mode: 'channel', privacy: 'encrypted' },
      testDir,
    });
    attachStubRuntime(agent, makeStubRuntime('COMMITTED'), providerWallet.address);

    await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
      makeJob(),
      { secret: 'encrypted-payload' },
    );
    await flush();

    const envs = channel.getAllEnvelopes(TX_ID);
    expect(envs).toHaveLength(1);
    const env = envs[0] as DeliveryEnvelopeWireV1;
    expect(env.signed.scheme).toBe('x25519-aes256gcm-v1');
    expect(env.signed.smartWalletNonce).toBe(7);
  });

  it('verifier recovers the real signer for non-zero smartWalletNonce', async () => {
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
    });
    const agent = newAgent({
      channel,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      smartWalletNonce: 9,
      testDir,
    });
    attachStubRuntime(agent, makeStubRuntime('COMMITTED'), providerWallet.address);

    await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
      makeJob(),
      { hello: 'world' },
    );
    await flush();

    const envs = channel.getAllEnvelopes(TX_ID);
    expect(envs).toHaveLength(1);
    const env = envs[0] as DeliveryEnvelopeWireV1;
    expect(env.signed.smartWalletNonce).toBe(9);

    const recovered = recoverEnvelopeSigner(env.signed, env.providerSig, KERNEL);
    expect(recovered.toLowerCase()).toBe(providerWallet.address.toLowerCase());
  });

  it('different smartWalletNonce values yield distinct envelope signatures (EIP-712 binds the field)', async () => {
    const channel0 = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
    });
    const channel5 = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
    });
    const agent0 = newAgent({
      channel: channel0,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      smartWalletNonce: 0,
      testDir,
    });
    const agent5 = newAgent({
      channel: channel5,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      smartWalletNonce: 5,
      testDir,
    });
    attachStubRuntime(agent0, makeStubRuntime('COMMITTED'), providerWallet.address);
    attachStubRuntime(agent5, makeStubRuntime('COMMITTED'), providerWallet.address);

    await (agent0 as unknown as AgentInternals).maybePublishDeliveryEnvelope(
      makeJob(),
      { same: 'payload' },
    );
    await (agent5 as unknown as AgentInternals).maybePublishDeliveryEnvelope(
      makeJob(),
      { same: 'payload' },
    );
    await flush();

    const env0 = channel0.getAllEnvelopes(TX_ID)[0] as DeliveryEnvelopeWireV1;
    const env5 = channel5.getAllEnvelopes(TX_ID)[0] as DeliveryEnvelopeWireV1;
    expect(env0.signed.smartWalletNonce).toBe(0);
    expect(env5.signed.smartWalletNonce).toBe(5);
    // Both verify under their own claimed nonce.
    const r0 = recoverEnvelopeSigner(env0.signed, env0.providerSig, KERNEL);
    const r5 = recoverEnvelopeSigner(env5.signed, env5.providerSig, KERNEL);
    expect(r0.toLowerCase()).toBe(providerWallet.address.toLowerCase());
    expect(r5.toLowerCase()).toBe(providerWallet.address.toLowerCase());
    // But the signatures themselves differ — EIP-712 binds the nonce.
    expect(env0.providerSig.toLowerCase()).not.toBe(
      env5.providerSig.toLowerCase(),
    );
  });
});
