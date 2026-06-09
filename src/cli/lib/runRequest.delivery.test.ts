/**
 * AIP-16 Phase 2e — runRequest delivery surface tests.
 *
 * Coverage:
 *  - No deliveryChannel: no setup POST, no subscription, payload undefined.
 *  - Setup POST with public privacy: signed setup contains canonical-empty pubkey.
 *  - Setup POST with encrypted privacy: signed setup contains real X25519 pubkey.
 *  - Setup POST timeout >= 3 s: deliveryError.code === "setup_post_failed";
 *    runRequest CONTINUES.
 *  - Envelope arrives BEFORE DELIVERED → payload populated, settle proceeds.
 *  - Envelope arrives AFTER DELIVERED within grace period → payload populated.
 *  - Envelope NEVER arrives → settle happens; payload undefined;
 *    deliveryError.code === "envelope_missing".
 *  - Encrypted payload decrypt round-trip.
 *  - Public envelope parse round-trip.
 *  - Channel close() called on return.
 *
 * Uses MockRuntime via ACTPClient + MockDeliveryChannel + a real provider Agent
 * to drive end-to-end state transitions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HDNodeWallet, Wallet, getAddress } from 'ethers';

import { runRequest } from './runRequest';
import { Agent } from '../../level1/Agent';
import { MockDeliveryChannel } from '../../delivery/MockDeliveryChannel';
import {
  DeliveryEnvelopeBuilder,
  generateEphemeralKeyPair,
  type DeliveryChannel,
  type DeliveryEnvelopeWireV1,
  type DeliverySetupWireV1,
  type DeliverySubscription,
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

interface SlowChannel extends DeliveryChannel {
  // Marker for slow-publish-setup channels (used by timeout tests).
}

/**
 * Wrap a MockDeliveryChannel so `publishSetup` hangs forever. Useful for
 * exercising the 3-second timeout path inside runRequest.
 */
function makeHangingPublishChannel(
  base: MockDeliveryChannel,
): SlowChannel {
  return {
    publishSetup: () => new Promise<void>(() => {
      // Never resolves.
    }),
    publishEnvelope: (env) => base.publishEnvelope(env),
    subscribeSetups: (txId, cb) => base.subscribeSetups(txId, cb),
    subscribeEnvelopes: (txId, cb) => base.subscribeEnvelopes(txId, cb),
    getSetups: (txId) => base.getSetups(txId),
    getEnvelopes: (txId) => base.getEnvelopes(txId),
    close: () => base.close(),
  } as SlowChannel;
}

interface CloseTrackingChannel {
  channel: DeliveryChannel;
  closeCalls: { setup: number; envelope: number };
}

function makeCloseTrackingChannel(
  base: MockDeliveryChannel,
): CloseTrackingChannel {
  const closeCalls = { setup: 0, envelope: 0 };
  const ch: DeliveryChannel = {
    publishSetup: (s) => base.publishSetup(s),
    publishEnvelope: (e) => base.publishEnvelope(e),
    subscribeSetups: async (txId, cb) => {
      const sub = await base.subscribeSetups(txId, cb);
      return {
        close: async () => {
          closeCalls.setup += 1;
          await sub.close();
        },
      } as DeliverySubscription;
    },
    subscribeEnvelopes: async (txId, cb) => {
      const sub = await base.subscribeEnvelopes(txId, cb);
      return {
        close: async () => {
          closeCalls.envelope += 1;
          await sub.close();
        },
      } as DeliverySubscription;
    },
    getSetups: (txId) => base.getSetups(txId),
    getEnvelopes: (txId) => base.getEnvelopes(txId),
    close: () => base.close(),
  };
  return { channel: ch, closeCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AIP-16 Phase 2e — runRequest delivery surface', () => {
  let testDir: string;
  let providerAgent: Agent;
  let providerWallet: HDNodeWallet;
  let buyerWallet: HDNodeWallet;

  beforeEach(async () => {
    const base = ensureBaseDir();
    testDir = fs.mkdtempSync(path.join(base, 'runRequest-delivery-test-'));
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
  });

  afterEach(async () => {
    if (providerAgent && providerAgent.status === 'running') {
      await providerAgent.stop().catch(() => undefined);
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function startProvider(opts?: {
    publishEnvelope?: boolean;
    deliveryCfg?: { mode: 'channel' | 'none'; privacy: 'public' | 'encrypted' };
    channel?: DeliveryChannel;
  }): Promise<Agent> {
    const config: ConstructorParameters<typeof Agent>[0] = {
      name: 'TestProvider',
      network: 'mock',
      stateDirectory: testDir,
    };
    if (opts?.publishEnvelope && opts?.channel) {
      Object.assign(config, {
        deliveryChannel: opts.channel,
        deliverySigner: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
      });
    }
    providerAgent = new Agent(config);
    providerAgent.provide(
      {
        name: 'echo',
        ...(opts?.deliveryCfg ? { delivery: opts.deliveryCfg } : {}),
      },
      async (job) => ({ echoed: job.input ?? null }),
    );
    await providerAgent.start();
    return providerAgent;
  }

  // -------------------------------------------------------------------------
  // Legacy / no delivery channel
  // -------------------------------------------------------------------------

  describe('No deliveryChannel (legacy / pre-AIP-16)', () => {
    it('does NOT post setup, does NOT subscribe, payload from legacy proof', async () => {
      const provider = await startProvider();

      const r = await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 10_000,
        deliveryTimeoutMs: 10_000,
        stateDirectory: testDir,
        // deliveryChannel intentionally omitted
      });

      expect(r.finalState === 'DELIVERED' || r.finalState === 'SETTLED').toBe(true);
      expect(r.deliveryError).toBeUndefined();
    }, 20_000);
  });

  // -------------------------------------------------------------------------
  // Setup POST shape
  // -------------------------------------------------------------------------

  describe('Setup POST shape', () => {
    it('public privacy: setup has CANONICAL_EMPTY buyer ephemeral pubkey', async () => {
      const provider = await startProvider();
      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
      });
      // Lower kernel/chain expectations: tests sign under unrelated kernel,
      // so disable channel enforcement and let it accept the wire as-signed.
      const looseChannel = new MockDeliveryChannel();

      await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 10_000,
        deliveryTimeoutMs: 10_000,
        stateDirectory: testDir,
        privateKey: buyerWallet.privateKey,
        deliveryChannel: looseChannel,
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        deliveryPrivacy: 'public',
        envelopeWaitMs: 500,
      });

      const setups = looseChannel.getAllSetups();
      expect(setups.length).toBeGreaterThanOrEqual(1);
      const setup = setups[0] as DeliverySetupWireV1;
      expect(setup.signed.expectedPrivacy).toBe('public');
      expect(setup.signed.buyerEphemeralPubkey).toBe(
        '0x' + '00'.repeat(32),
      );
      // Cleanup
      expect(channel).toBeDefined();
    }, 30_000);

    it('encrypted privacy: setup carries a real (non-zero) X25519 pubkey', async () => {
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
      });

      const setups = channel.getAllSetups();
      expect(setups.length).toBeGreaterThanOrEqual(1);
      const setup = setups[0] as DeliverySetupWireV1;
      expect(setup.signed.expectedPrivacy).toBe('encrypted');
      const empty = '0x' + '00'.repeat(32);
      expect(setup.signed.buyerEphemeralPubkey).not.toBe(empty);
      expect(setup.signed.buyerEphemeralPubkey).toMatch(/^0x[0-9a-f]{64}$/);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Setup POST timeout
  // -------------------------------------------------------------------------

  describe('Setup POST timeout', () => {
    it('hangs >= 3 s: deliveryError.code === "setup_post_failed"; runRequest CONTINUES', async () => {
      const provider = await startProvider();
      const base = new MockDeliveryChannel();
      const slow = makeHangingPublishChannel(base);

      const t0 = Date.now();
      const r = await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 15_000,
        deliveryTimeoutMs: 15_000,
        stateDirectory: testDir,
        privateKey: buyerWallet.privateKey,
        deliveryChannel: slow,
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        envelopeWaitMs: 500,
      });
      const elapsed = Date.now() - t0;

      expect(r.deliveryError).toBeDefined();
      expect(r.deliveryError?.code).toBe('setup_post_failed');
      // runRequest continued past the 3 s setup timeout.
      expect(elapsed).toBeGreaterThanOrEqual(3_000);
      expect(r.finalState === 'DELIVERED' || r.finalState === 'SETTLED').toBe(true);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Envelope arrival ordering
  // -------------------------------------------------------------------------

  describe('Envelope arrival ordering', () => {
    it('envelope arrives during state polling: payload is populated', async () => {
      // Provider publishes envelope through Agent.processJob hook.
      const channel = new MockDeliveryChannel();
      process.env.ACTP_DELIVERY_CHANNEL = 'v1';
      try {
        const provider = await startProvider({
          publishEnvelope: true,
          channel,
        });

        const r = await runRequest({
          provider: provider.address,
          amount: '0.05',
          service: 'echo',
          network: 'mock',
          quoteTimeoutMs: 15_000,
          deliveryTimeoutMs: 15_000,
          stateDirectory: testDir,
          privateKey: buyerWallet.privateKey,
          deliveryChannel: channel,
          expectedKernelAddress: KERNEL,
          expectedChainId: CHAIN_ID,
          deliveryPrivacy: 'public',
          envelopeWaitMs: 5_000,
        });

        expect(r.finalState === 'DELIVERED' || r.finalState === 'SETTLED').toBe(true);
        expect(r.payload).toBeDefined();
        // payload was decoded from the envelope (public-v1 JSON parse). The
        // provider echoes `job.input` which BlockchainRuntime / MockRuntime
        // surfaces as `{}` (not `null`) when the request supplied no input.
        expect(r.payload).toHaveProperty('echoed');
      } finally {
        delete process.env.ACTP_DELIVERY_CHANNEL;
      }
    }, 30_000);

    it('envelope NEVER arrives: deliveryError.code === "envelope_missing"; settle proceeds', async () => {
      const provider = await startProvider();
      const channel = new MockDeliveryChannel();

      const r = await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 15_000,
        deliveryTimeoutMs: 15_000,
        stateDirectory: testDir,
        privateKey: buyerWallet.privateKey,
        deliveryChannel: channel,
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        deliveryPrivacy: 'public',
        envelopeWaitMs: 500, // short grace period
      });

      expect(r.deliveryError?.code).toBe('envelope_missing');
      // Settlement still happened (legacy proof path may still populate
      // payload from tx.deliveryProof — that's fine).
      expect(r.finalState === 'DELIVERED' || r.finalState === 'SETTLED').toBe(true);
    }, 30_000);

    it('envelope arrives within grace AFTER DELIVERED: payload populated', async () => {
      // We seed a pre-built envelope into the channel BEFORE runRequest is
      // called; the subscription will fire immediately and resolve payload.
      const channel = new MockDeliveryChannel();
      const provider = await startProvider();

      // Use the provider's address as the on-chain provider/signer pair for
      // the envelope. We sign under a known kernel.
      const envBuilder = new DeliveryEnvelopeBuilder(providerWallet);

      // We don't know txId yet — we'll resolve a placeholder. So instead use
      // the late-publish trick: run runRequest with an envelopeWaitMs and
      // publish after DELIVERED. We do this from a side closure: subscribe a
      // listener on transition.

      let publishedEnv: DeliveryEnvelopeWireV1 | undefined;

      const onTransition = async (
        state: string,
        txId: string,
      ): Promise<void> => {
        if (state === 'DELIVERED' && !publishedEnv) {
          const { wire } = await envBuilder.buildPublic({
            txId: txId as `0x${string}`,
            chainId: CHAIN_ID,
            kernelAddress: KERNEL,
            providerAddress: getAddress(providerWallet.address) as `0x${string}`,
            signerAddress: getAddress(providerWallet.address) as `0x${string}`,
            payload: { late: 'envelope' },
          });
          publishedEnv = wire;
          await channel.publishEnvelope(wire);
        }
      };

      const r = await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 15_000,
        deliveryTimeoutMs: 15_000,
        stateDirectory: testDir,
        privateKey: buyerWallet.privateKey,
        deliveryChannel: channel,
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        deliveryPrivacy: 'public',
        envelopeWaitMs: 5_000,
        onTransition: (s, t) => {
          // Fire-and-forget; we don't await inside the callback.
          void onTransition(s, t);
        },
      });

      expect(publishedEnv).toBeDefined();
      // Payload should be the late-published envelope's contents.
      expect(r.payload).toMatchObject({ late: 'envelope' });
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Decryption round-trip
  // -------------------------------------------------------------------------

  describe('Encrypted decrypt round-trip', () => {
    it('encrypted envelope is decrypted to original payload', async () => {
      const channel = new MockDeliveryChannel();
      const provider = await startProvider();

      // After buyer setup is on the channel, the test publishes an encrypted
      // envelope using the buyer's ephemeral pubkey from the setup. The
      // runRequest grace-period loop will pick it up and decrypt.
      let publishedEnv: DeliveryEnvelopeWireV1 | undefined;
      const builder = new DeliveryEnvelopeBuilder(providerWallet);

      const onTransition = async (
        state: string,
        txId: string,
      ): Promise<void> => {
        if (state === 'DELIVERED' && !publishedEnv) {
          // Wait briefly for buyer's setup to be published by runRequest.
          for (let i = 0; i < 20 && !publishedEnv; i += 1) {
            const setups = channel.getAllSetups(txId);
            const setup = setups[0];
            if (setup && setup.signed.expectedPrivacy === 'encrypted') {
              const { wire } = await builder.buildEncrypted({
                txId: txId as `0x${string}`,
                chainId: CHAIN_ID,
                kernelAddress: KERNEL,
                providerAddress: getAddress(providerWallet.address) as `0x${string}`,
                signerAddress: getAddress(providerWallet.address) as `0x${string}`,
                payload: { secret: 'enc-payload-roundtrip' },
                buyerEphemeralPubkey: setup.signed.buyerEphemeralPubkey,
              });
              publishedEnv = wire;
              await channel.publishEnvelope(wire);
              break;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      };

      const r = await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 15_000,
        deliveryTimeoutMs: 15_000,
        stateDirectory: testDir,
        privateKey: buyerWallet.privateKey,
        deliveryChannel: channel,
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        deliveryPrivacy: 'encrypted',
        envelopeWaitMs: 5_000,
        onTransition: (s, t) => {
          void onTransition(s, t);
        },
      });

      expect(publishedEnv).toBeDefined();
      expect(r.payload).toMatchObject({ secret: 'enc-payload-roundtrip' });
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Public envelope parse
  // -------------------------------------------------------------------------

  describe('Public envelope JSON parse', () => {
    it('public envelope body parses to its original payload', async () => {
      const channel = new MockDeliveryChannel();
      const provider = await startProvider();
      const builder = new DeliveryEnvelopeBuilder(providerWallet);
      let publishedEnv: DeliveryEnvelopeWireV1 | undefined;

      const onTransition = async (
        state: string,
        txId: string,
      ): Promise<void> => {
        if (state === 'DELIVERED' && !publishedEnv) {
          const { wire } = await builder.buildPublic({
            txId: txId as `0x${string}`,
            chainId: CHAIN_ID,
            kernelAddress: KERNEL,
            providerAddress: getAddress(providerWallet.address) as `0x${string}`,
            signerAddress: getAddress(providerWallet.address) as `0x${string}`,
            payload: { greeting: 'hello', n: 7 },
          });
          publishedEnv = wire;
          await channel.publishEnvelope(wire);
        }
      };

      const r = await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 15_000,
        deliveryTimeoutMs: 15_000,
        stateDirectory: testDir,
        privateKey: buyerWallet.privateKey,
        deliveryChannel: channel,
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        deliveryPrivacy: 'public',
        envelopeWaitMs: 5_000,
        onTransition: (s, t) => {
          void onTransition(s, t);
        },
      });

      expect(r.payload).toMatchObject({ greeting: 'hello', n: 7 });
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Channel close on return
  // -------------------------------------------------------------------------

  describe('Channel teardown', () => {
    it('envelope subscription close() is called before runRequest returns', async () => {
      const base = new MockDeliveryChannel();
      const wrapped = makeCloseTrackingChannel(base);
      const provider = await startProvider();

      await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'echo',
        network: 'mock',
        quoteTimeoutMs: 15_000,
        deliveryTimeoutMs: 15_000,
        stateDirectory: testDir,
        privateKey: buyerWallet.privateKey,
        deliveryChannel: wrapped.channel,
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        deliveryPrivacy: 'public',
        envelopeWaitMs: 500,
      });

      // envelope subscription should have been closed.
      expect(wrapped.closeCalls.envelope).toBeGreaterThanOrEqual(1);
    }, 30_000);
  });
});
