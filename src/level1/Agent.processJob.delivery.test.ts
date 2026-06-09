/**
 * AIP-16 Phase 2e — Agent.processJob delivery envelope hook tests.
 *
 * Targets the private `maybePublishDeliveryEnvelope` hook on Agent.
 *
 * Coverage:
 *  - Feature flag (`ACTP_DELIVERY_CHANNEL=v1`) gating.
 *  - Constructor-side dependency gating (channel/signer/kernel/chainId).
 *  - Service config gating: `mode: "channel"` vs `mode: "none"`.
 *  - Privacy branching: public → publishPublic-shaped envelope on the channel,
 *    encrypted → publishEncrypted-shaped envelope when buyer setup is present.
 *  - Idempotency: skip when tx is not in COMMITTED.
 *  - Encrypted privacy + missing setup: warn-and-skip without throwing.
 *  - Channel publish failure: log + swallow.
 *  - Hook NEVER throws to caller.
 *
 * Uses MockDeliveryChannel + a real Wallet signer + a hand-rolled MockRuntime
 * stub that returns a controllable tx state. We bypass the full Agent
 * polling/start/stop pipeline to keep the suite fast and deterministic.
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
  type DeliveryEnvelopeWireV1,
  type DeliverySetupWireV1,
} from '../delivery';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const CHAIN_ID = 84532;
const TX_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

interface AgentInternals {
  maybePublishDeliveryEnvelope(job: Job, result: unknown): Promise<void>;
  services: Map<string, { config: ServiceConfig; handler: JobHandler }>;
  _client?: {
    runtime: { getTransaction(txId: string): Promise<unknown> };
    getAddress(): string;
  };
  logger: {
    warn: jest.Mock;
    info: jest.Mock;
    debug: jest.Mock;
    error: jest.Mock;
  };
}

interface StubRuntime {
  getTransaction: jest.Mock;
}

const STUB_PROVIDER_ADDRESS = '0x' + 'dd'.repeat(20);

interface TxStateView {
  id: string;
  state: 'INITIATED' | 'COMMITTED' | 'IN_PROGRESS' | 'DELIVERED' | 'SETTLED' | 'CANCELLED' | 'DISPUTED';
}

function makeStubRuntime(state: TxStateView['state'] = 'COMMITTED'): StubRuntime {
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
  // The hook reads `this._client?.runtime.getTransaction(...)` AND the agent
  // `address` getter calls `this._client?.getAddress()`. We give it both.
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

describe('AIP-16 Phase 2e — Agent.processJob delivery envelope hook', () => {
  const ORIGINAL_FLAG = process.env.ACTP_DELIVERY_CHANNEL;
  let testDir: string;
  let providerWallet: HDNodeWallet;

  beforeEach(() => {
    const base = ensureBaseDir();
    testDir = fs.mkdtempSync(path.join(base, 'agent-delivery-test-'));
    providerWallet = Wallet.createRandom();
    delete process.env.ACTP_DELIVERY_CHANNEL;
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

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  describe('Feature-flag gate (ACTP_DELIVERY_CHANNEL)', () => {
    it('flag OFF + all deps present: hook is a no-op (no publish)', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { hello: 'world' },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('flag ON + all deps present + tx COMMITTED + mode channel: publishes envelope', async () => {
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { payload: 42 },
      );
      await flush();

      const envs = channel.getAllEnvelopes(TX_ID);
      expect(envs).toHaveLength(1);
      expect(envs[0]?.signed.scheme).toBe('public-v1');
    });
  });

  describe('Constructor-side dependency gate', () => {
    beforeEach(() => {
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
    });

    it('no deliveryChannel: hook is a no-op', async () => {
      const channel = new MockDeliveryChannel();
      const agent = newAgent({
        // deliveryChannel intentionally omitted
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('no deliverySigner: hook is a no-op', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        // signer omitted
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('no kernelAddress: hook is a no-op', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        // kernelAddress omitted
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('no chainId: hook is a no-op', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        // chainId omitted
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });
  });

  describe('Service config gate (delivery.mode)', () => {
    beforeEach(() => {
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
    });

    it('mode === "none": no envelope published', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        deliveryCfg: { mode: 'none', privacy: 'public' },
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('mode === "channel" (default): envelope published', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(1);
    });

    it('explicit channel + public: envelope is scheme public-v1', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        deliveryCfg: { mode: 'channel', privacy: 'public' },
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { payload: 'pub' },
      );
      await flush();

      const envs = channel.getAllEnvelopes(TX_ID);
      expect(envs).toHaveLength(1);
      expect(envs[0]?.signed.scheme).toBe('public-v1');
    });
  });

  // -------------------------------------------------------------------------
  // Encrypted privacy
  // -------------------------------------------------------------------------

  describe('Encrypted privacy', () => {
    beforeEach(() => {
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
    });

    it('setup present: encrypted envelope published', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      // Pre-publish a buyer setup so the encrypted path finds the pubkey.
      const buyerWallet = Wallet.createRandom();
      const setup = await buildBuyerSetup(buyerWallet);
      await channel.publishSetup(setup);
      await flush();

      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        deliveryCfg: { mode: 'channel', privacy: 'encrypted' },
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { secret: 'value' },
      );
      await flush();

      const envs = channel.getAllEnvelopes(TX_ID);
      expect(envs).toHaveLength(1);
      expect(envs[0]?.signed.scheme).toBe('x25519-aes256gcm-v1');
    });

    it('NO setup posted: hook logs warn and skips, NO envelope', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });

      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        deliveryCfg: { mode: 'channel', privacy: 'encrypted' },
        testDir,
      });
      const internals = agent as unknown as AgentInternals;
      const warnSpy = jest.spyOn(internals.logger, 'warn');
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await internals.maybePublishDeliveryEnvelope(makeJob(), { x: 1 });
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
      const warnedAboutSetup = warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].toLowerCase().includes('no setup'),
      );
      expect(warnedAboutSetup).toBe(true);
    });

    it('channel without getSetups: hook logs warn and skips, NO envelope', async () => {
      // A minimal channel stub WITHOUT getSetups defined.
      const minimal: import('../delivery/channel').DeliveryChannel = {
        publishSetup: jest.fn().mockResolvedValue(undefined),
        publishEnvelope: jest.fn().mockResolvedValue(undefined),
        subscribeSetups: jest.fn().mockResolvedValue({ close: () => {} }),
        subscribeEnvelopes: jest.fn().mockResolvedValue({ close: () => {} }),
      };

      const agent = newAgent({
        channel: minimal as unknown as MockDeliveryChannel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        deliveryCfg: { mode: 'channel', privacy: 'encrypted' },
        testDir,
      });
      const internals = agent as unknown as AgentInternals;
      const warnSpy = jest.spyOn(internals.logger, 'warn');
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await internals.maybePublishDeliveryEnvelope(makeJob(), { x: 1 });
      await flush();

      expect(minimal.publishEnvelope).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('Idempotency / state guard', () => {
    beforeEach(() => {
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
    });

    it('tx in IN_PROGRESS: NO envelope published', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('IN_PROGRESS'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('tx in DELIVERED: NO envelope published', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('DELIVERED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('tx not found (null runtime): hook returns without publishing', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      const internals = agent as unknown as AgentInternals;
      internals._client = {
        runtime: {
          getTransaction: jest.fn().mockResolvedValue(null) as unknown as (
            txId: string,
          ) => Promise<unknown>,
        },
        getAddress: (): string => STUB_PROVIDER_ADDRESS,
      };

      await internals.maybePublishDeliveryEnvelope(makeJob(), { v: 1 });
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('tx in CANCELLED: NO envelope published', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('CANCELLED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { v: 1 },
      );
      await flush();

      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Failure containment
  // -------------------------------------------------------------------------

  describe('Failure containment', () => {
    beforeEach(() => {
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
    });

    it('channel publish FAILS: hook logs warn and returns (does NOT throw)', async () => {
      const channel: import('../delivery/channel').DeliveryChannel = {
        publishSetup: jest.fn().mockResolvedValue(undefined),
        publishEnvelope: jest
          .fn()
          .mockRejectedValue(new Error('relay down')),
        subscribeSetups: jest.fn().mockResolvedValue({ close: () => {} }),
        subscribeEnvelopes: jest.fn().mockResolvedValue({ close: () => {} }),
      };

      const agent = newAgent({
        channel: channel as unknown as MockDeliveryChannel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      const internals = agent as unknown as AgentInternals;
      const warnSpy = jest.spyOn(internals.logger, 'warn');
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await expect(
        internals.maybePublishDeliveryEnvelope(makeJob(), { v: 1 }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('envelope publish failed'),
      );
      expect(warned).toBe(true);
    });

    it('runtime.getTransaction throws: hook returns without publish (no throw)', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      const internals = agent as unknown as AgentInternals;
      internals._client = {
        runtime: {
          getTransaction: jest
            .fn()
            .mockResolvedValue(null) as unknown as (
            txId: string,
          ) => Promise<unknown>,
        },
        getAddress: (): string => STUB_PROVIDER_ADDRESS,
      };

      await expect(
        internals.maybePublishDeliveryEnvelope(makeJob(), { v: 1 }),
      ).resolves.toBeUndefined();
      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });

    it('signer.getAddress throws: hook returns without publish (no throw)', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const badSigner = {
        getAddress: jest.fn().mockRejectedValue(new Error('hw locked')),
        signTypedData: jest
          .fn()
          .mockResolvedValue('0x' + '1'.repeat(130)),
      } as unknown as HDNodeWallet;
      const agent = newAgent({
        channel,
        signer: badSigner,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await expect(
        (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
          makeJob(),
          { v: 1 },
        ),
      ).resolves.toBeUndefined();
      expect(channel.getAllEnvelopes(TX_ID)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Envelope content fidelity
  // -------------------------------------------------------------------------

  describe('Envelope content fidelity', () => {
    beforeEach(() => {
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
    });

    it('public envelope: signed.txId matches the job id', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { x: 1 },
      );
      await flush();

      const env = channel.getAllEnvelopes(TX_ID)[0] as DeliveryEnvelopeWireV1;
      expect(env.signed.txId.toLowerCase()).toBe(TX_ID.toLowerCase());
      expect(env.signed.chainId).toBe(CHAIN_ID);
      expect(env.signed.kernelAddress.toLowerCase()).toBe(KERNEL.toLowerCase());
    });

    it('public envelope: signerAddress equals the EOA derived from deliverySigner', async () => {
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      const agent = newAgent({
        channel,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        testDir,
      });
      attachStubRuntime(agent, makeStubRuntime('COMMITTED'));

      await (agent as unknown as AgentInternals).maybePublishDeliveryEnvelope(
        makeJob(),
        { x: 1 },
      );
      await flush();

      const env = channel.getAllEnvelopes(TX_ID)[0] as DeliveryEnvelopeWireV1;
      expect(env.signed.signerAddress.toLowerCase()).toBe(
        providerWallet.address.toLowerCase(),
      );
    });
  });
});
