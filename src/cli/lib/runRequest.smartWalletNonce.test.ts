/**
 * AIP-16 Phase 3 H4 fix — runRequest smartWalletNonce threading tests.
 *
 * Verifies that the buyer-side `smartWalletNonce` option on
 * {@link RunRequestOptions} is threaded all the way down to the signed
 * setup payload via {@link DeliverySetupBuilder.build}.
 *
 * Before the H4 follow-up these tests would have failed: runRequest
 * hardcoded `smartWalletNonce: 0` at the setup-build call site, so
 * callers whose Smart Wallet was deployed at a non-zero factory nonce
 * could never produce a signature that verified against the correct
 * derived address server-side.
 *
 * Coverage:
 *   1. Default behavior (no `smartWalletNonce` option) ⇒ signed setup
 *      carries `smartWalletNonce === 0` (byte-identical to pre-H4).
 *   2. Explicit `smartWalletNonce: 0` ⇒ identical projection to (1).
 *   3. Explicit `smartWalletNonce: 5` ⇒ signed setup carries 5.
 *   4. Verifier recovers the real signer when nonce ≠ 0.
 *   5. Two runs with the same params but different nonces produce
 *      distinct signatures (nonce is bound by the EIP-712 type hash).
 *   6. Explicit `smartWalletNonce: 12345` (large value) ⇒ signed setup
 *      carries 12345 and verifies.
 *
 * Mock-mode + MockDeliveryChannel; no on-chain calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HDNodeWallet, Wallet } from 'ethers';

import { runRequest } from './runRequest';
import { Agent } from '../../level1/Agent';
import { MockDeliveryChannel } from '../../delivery/MockDeliveryChannel';
import {
  recoverSetupSigner,
  type DeliverySetupSignedV1,
  type DeliverySetupWireV1,
} from '../../delivery';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const CHAIN_ID = 84532;

function ensureBaseDir(): string {
  const base = path.join(os.homedir(), '.agirails');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AIP-16 Phase 3 H4 — runRequest smartWalletNonce threading', () => {
  let testDir: string;
  let providerAgent: Agent | undefined;
  let buyerWallet: HDNodeWallet;

  beforeEach(async () => {
    const base = ensureBaseDir();
    testDir = fs.mkdtempSync(path.join(base, 'runRequest-swn-test-'));
    buyerWallet = Wallet.createRandom();
    providerAgent = undefined;
  });

  afterEach(async () => {
    if (providerAgent && providerAgent.status === 'running') {
      await providerAgent.stop().catch(() => undefined);
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function startProvider(): Promise<Agent> {
    const agent = new Agent({
      name: 'TestProvider',
      network: 'mock',
      stateDirectory: testDir,
    });
    agent.provide(
      { name: 'echo' },
      async (job) => ({ echoed: job.input ?? null }),
    );
    await agent.start();
    providerAgent = agent;
    return agent;
  }

  it('default (no smartWalletNonce option): signed setup carries nonce=0', async () => {
    const provider = await startProvider();
    const channel = new MockDeliveryChannel();

    await runRequest({
      provider: provider.address,
      amount: '0.05',
      service: 'echo',
      network: 'mock',
      quoteTimeoutMs: 10_000,
      deliveryTimeoutMs: 10_000,
      stateDirectory: testDir,
      privateKey: buyerWallet.privateKey,
      deliveryChannel: channel,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      deliveryPrivacy: 'public',
      envelopeWaitMs: 500,
      // smartWalletNonce intentionally omitted
    });

    const setups = channel.getAllSetups();
    expect(setups.length).toBeGreaterThanOrEqual(1);
    const setup = setups[0] as DeliverySetupWireV1;
    expect(setup.signed.smartWalletNonce).toBe(0);
  }, 30_000);

  it('explicit smartWalletNonce=0: identical projection to default', async () => {
    const provider = await startProvider();
    const channel = new MockDeliveryChannel();

    await runRequest({
      provider: provider.address,
      amount: '0.05',
      service: 'echo',
      network: 'mock',
      quoteTimeoutMs: 10_000,
      deliveryTimeoutMs: 10_000,
      stateDirectory: testDir,
      privateKey: buyerWallet.privateKey,
      deliveryChannel: channel,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      deliveryPrivacy: 'public',
      envelopeWaitMs: 500,
      smartWalletNonce: 0,
    });

    const setups = channel.getAllSetups();
    expect(setups.length).toBeGreaterThanOrEqual(1);
    const setup = setups[0] as DeliverySetupWireV1;
    expect(setup.signed.smartWalletNonce).toBe(0);
  }, 30_000);

  it('explicit smartWalletNonce=5: signed setup carries nonce=5', async () => {
    const provider = await startProvider();
    const channel = new MockDeliveryChannel();

    await runRequest({
      provider: provider.address,
      amount: '0.05',
      service: 'echo',
      network: 'mock',
      quoteTimeoutMs: 10_000,
      deliveryTimeoutMs: 10_000,
      stateDirectory: testDir,
      privateKey: buyerWallet.privateKey,
      deliveryChannel: channel,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      deliveryPrivacy: 'public',
      envelopeWaitMs: 500,
      smartWalletNonce: 5,
    });

    const setups = channel.getAllSetups();
    expect(setups.length).toBeGreaterThanOrEqual(1);
    const setup = setups[0] as DeliverySetupWireV1;
    expect(setup.signed.smartWalletNonce).toBe(5);
  }, 30_000);

  it('verifier recovers the real signer for non-zero smartWalletNonce', async () => {
    const provider = await startProvider();
    const channel = new MockDeliveryChannel();

    await runRequest({
      provider: provider.address,
      amount: '0.05',
      service: 'echo',
      network: 'mock',
      quoteTimeoutMs: 10_000,
      deliveryTimeoutMs: 10_000,
      stateDirectory: testDir,
      privateKey: buyerWallet.privateKey,
      deliveryChannel: channel,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      deliveryPrivacy: 'public',
      envelopeWaitMs: 500,
      smartWalletNonce: 7,
    });

    const setups = channel.getAllSetups();
    expect(setups.length).toBeGreaterThanOrEqual(1);
    const setup = setups[0] as DeliverySetupWireV1;
    expect(setup.signed.smartWalletNonce).toBe(7);

    const recovered = recoverSetupSigner(setup.signed, setup.requesterSig, KERNEL);
    expect(recovered.toLowerCase()).toBe(buyerWallet.address.toLowerCase());
  }, 30_000);

  it('different smartWalletNonce values yield distinct signatures (EIP-712 binds the field)', async () => {
    // Two separate runRequest calls (same buyer wallet, same provider) with
    // different smartWalletNonce values MUST produce different `requesterSig`
    // payloads, because the nonce is part of the EIP-712 type hash.
    const provider = await startProvider();
    const ch0 = new MockDeliveryChannel();
    const ch5 = new MockDeliveryChannel();

    await runRequest({
      provider: provider.address,
      amount: '0.05',
      service: 'echo',
      network: 'mock',
      quoteTimeoutMs: 10_000,
      deliveryTimeoutMs: 10_000,
      stateDirectory: testDir,
      privateKey: buyerWallet.privateKey,
      deliveryChannel: ch0,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      deliveryPrivacy: 'public',
      envelopeWaitMs: 500,
      smartWalletNonce: 0,
    });

    await runRequest({
      provider: provider.address,
      amount: '0.05',
      service: 'echo',
      network: 'mock',
      quoteTimeoutMs: 10_000,
      deliveryTimeoutMs: 10_000,
      stateDirectory: testDir,
      privateKey: buyerWallet.privateKey,
      deliveryChannel: ch5,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      deliveryPrivacy: 'public',
      envelopeWaitMs: 500,
      smartWalletNonce: 5,
    });

    const s0 = ch0.getAllSetups()[0] as DeliverySetupWireV1;
    const s5 = ch5.getAllSetups()[0] as DeliverySetupWireV1;
    expect(s0.signed.smartWalletNonce).toBe(0);
    expect(s5.signed.smartWalletNonce).toBe(5);
    expect(s0.requesterSig.toLowerCase()).not.toBe(s5.requesterSig.toLowerCase());

    // Cross-check: each signature only verifies under the correct nonce.
    const tampered0: DeliverySetupSignedV1 = {
      ...s0.signed,
      smartWalletNonce: 5,
    };
    const recoveredWrong = recoverSetupSigner(
      tampered0,
      s0.requesterSig,
      KERNEL,
    );
    expect(recoveredWrong.toLowerCase()).not.toBe(
      buyerWallet.address.toLowerCase(),
    );
  }, 60_000);

  it('large non-zero smartWalletNonce (12345): signs and verifies', async () => {
    const provider = await startProvider();
    const channel = new MockDeliveryChannel();

    await runRequest({
      provider: provider.address,
      amount: '0.05',
      service: 'echo',
      network: 'mock',
      quoteTimeoutMs: 10_000,
      deliveryTimeoutMs: 10_000,
      stateDirectory: testDir,
      privateKey: buyerWallet.privateKey,
      deliveryChannel: channel,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      deliveryPrivacy: 'encrypted',
      envelopeWaitMs: 500,
      smartWalletNonce: 12_345,
    });

    const setups = channel.getAllSetups();
    expect(setups.length).toBeGreaterThanOrEqual(1);
    const setup = setups[0] as DeliverySetupWireV1;
    expect(setup.signed.smartWalletNonce).toBe(12_345);
    // EIP-712 recovery round-trip — sanity check that the signed payload
    // is internally consistent at this nonce value.
    const recovered = recoverSetupSigner(setup.signed, setup.requesterSig, KERNEL);
    expect(recovered.toLowerCase()).toBe(buyerWallet.address.toLowerCase());
  }, 30_000);
});
