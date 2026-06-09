/**
 * AIP-16 Phase 2e — End-to-end stress test.
 *
 * Drives 100 concurrent buyer/provider transactions through a single
 * MockDeliveryChannel and asserts the union of every delivery-surface
 * invariant under load:
 *
 *   1. All envelopes delivered correctly (100 envelopes, one per tx).
 *   2. Payloads decrypted/parsed correctly (incl. encrypted half).
 *   3. No cross-tx leakage: subscriber X never sees tx Y's envelope.
 *   4. Memory stable: channel storage growth bounded by tx count
 *      across repeated runs (no unbounded retention).
 *   5. Dedup-after-verify holds under load: re-publishing every
 *      envelope/setup is a no-op (no duplicate fan-out, no double-store).
 *
 * Concurrency model: the 100-way parallelism is INSIDE this test via
 * Promise.all. We still respect Jest's maxWorkers: 1.
 */

import { HDNodeWallet, Wallet, getAddress } from 'ethers';

import { MockDeliveryChannel } from '../delivery/MockDeliveryChannel';
import {
  CANONICAL_EMPTY_BYTES32,
  DeliveryEnvelopeBuilder,
  DeliverySetupBuilder,
  generateEphemeralKeyPair,
  type DeliveryEnvelopeWireV1,
  type DeliverySetupWireV1,
  type EphemeralKeyPair,
} from '../delivery';

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const CHAIN_ID = 84532;
const BASE_NOW = 1_750_000_000;
const N = 100;

function txIdN(n: number): `0x${string}` {
  return ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`;
}

interface BuyerCtx {
  txId: `0x${string}`;
  buyer: HDNodeWallet;
  provider: HDNodeWallet;
  privacy: 'public' | 'encrypted';
  payload: { txIndex: number; tag: string; nested: { a: number; b: string } };
  ephemeral?: EphemeralKeyPair;
}

interface RunResult {
  received: DeliveryEnvelopeWireV1[];
  setupSubClose: () => void | Promise<void>;
  envSubClose: () => void | Promise<void>;
}

function makePayload(i: number, privacy: 'public' | 'encrypted'): BuyerCtx['payload'] {
  return {
    txIndex: i,
    tag: `tx-${i}-${privacy}`,
    nested: { a: i * 7, b: `secret-${i}` },
  };
}

async function buyerPublishSetup(
  channel: MockDeliveryChannel,
  buyer: HDNodeWallet,
  txId: `0x${string}`,
  privacy: 'public' | 'encrypted',
): Promise<{ wire: DeliverySetupWireV1; ephemeral?: EphemeralKeyPair }> {
  const builder = new DeliverySetupBuilder(buyer);
  let ephemeral: EphemeralKeyPair | undefined;
  let buyerEphemeralPubkey: `0x${string}` = CANONICAL_EMPTY_BYTES32;
  if (privacy === 'encrypted') {
    ephemeral = generateEphemeralKeyPair();
    buyerEphemeralPubkey = ephemeral.publicKeyHex;
  }
  const { wire } = await builder.build({
    txId,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
    requesterAddress: getAddress(buyer.address) as `0x${string}`,
    signerAddress: getAddress(buyer.address) as `0x${string}`,
    buyerEphemeralPubkey,
    expectedPrivacy: privacy,
    createdAt: BASE_NOW,
  });
  await channel.publishSetup(wire);
  return { wire, ephemeral };
}

async function providerPublishEnvelope(
  channel: MockDeliveryChannel,
  provider: HDNodeWallet,
  txId: `0x${string}`,
  setup: DeliverySetupWireV1,
  payload: unknown,
): Promise<DeliveryEnvelopeWireV1> {
  const builder = new DeliveryEnvelopeBuilder(provider);
  if (setup.signed.expectedPrivacy === 'encrypted') {
    const { wire } = await builder.buildEncrypted({
      txId,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL,
      providerAddress: getAddress(provider.address) as `0x${string}`,
      signerAddress: getAddress(provider.address) as `0x${string}`,
      payload,
      buyerEphemeralPubkey: setup.signed.buyerEphemeralPubkey,
      createdAt: BASE_NOW,
    });
    await channel.publishEnvelope(wire);
    return wire;
  }
  const { wire } = await builder.buildPublic({
    txId,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
    providerAddress: getAddress(provider.address) as `0x${string}`,
    signerAddress: getAddress(provider.address) as `0x${string}`,
    payload,
    createdAt: BASE_NOW,
  });
  await channel.publishEnvelope(wire);
  return wire;
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

async function runRound(
  channel: MockDeliveryChannel,
  contexts: BuyerCtx[],
): Promise<Map<string, RunResult>> {
  const results = new Map<string, RunResult>();

  // Phase 1: every buyer + provider subscribes per-txId.
  await Promise.all(
    contexts.map(async (ctx) => {
      const txKey = ctx.txId.toLowerCase();
      const received: DeliveryEnvelopeWireV1[] = [];

      const envSub = await channel.subscribeEnvelopes(ctx.txId, (e) => {
        // Cross-tx leakage guard: assertion-by-construction.
        // If a subscriber bound to ctx.txId ever sees a wire for some
        // other tx, the final assertion below will catch it because
        // every recorded wire is keyed against its enclosing ctx.txId.
        received.push(e);
      });

      const setupSub = await channel.subscribeSetups(ctx.txId, async (s) => {
        await providerPublishEnvelope(
          channel,
          ctx.provider,
          ctx.txId,
          s,
          ctx.payload,
        );
      });

      results.set(txKey, {
        received,
        setupSubClose: () => setupSub.close(),
        envSubClose: () => envSub.close(),
      });
    }),
  );

  // Phase 2: every buyer publishes its setup concurrently.
  const ephemeralByTx = new Map<string, EphemeralKeyPair | undefined>();
  await Promise.all(
    contexts.map(async (ctx) => {
      const { ephemeral } = await buyerPublishSetup(
        channel,
        ctx.buyer,
        ctx.txId,
        ctx.privacy,
      );
      ephemeralByTx.set(ctx.txId.toLowerCase(), ephemeral);
      ctx.ephemeral = ephemeral;
    }),
  );

  // Phase 3: let fan-out + provider publishes settle.
  await flush(8);

  return results;
}

describe('AIP-16 Phase 2e — End-to-end stress (100 parallel txs)', () => {
  it(
    'delivers 100 concurrent buyer/provider txs cleanly across public + encrypted',
    async () => {
      const t0 = Date.now();
      const memBefore = process.memoryUsage().heapUsed;

      const channel = new MockDeliveryChannel({
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        now: () => BASE_NOW,
      });

      // Build 100 contexts (50 public, 50 encrypted) up-front to keep the
      // hot path measuring delivery, not wallet generation.
      const contexts: BuyerCtx[] = [];
      for (let i = 0; i < N; i += 1) {
        const privacy: 'public' | 'encrypted' =
          i % 2 === 0 ? 'public' : 'encrypted';
        contexts.push({
          txId: txIdN(0x1000 + i),
          buyer: Wallet.createRandom(),
          provider: Wallet.createRandom(),
          privacy,
          payload: makePayload(i, privacy),
        });
      }

      const results = await runRound(channel, contexts);

      // --- Invariant 1: exactly one envelope per tx ---
      expect(results.size).toBe(N);
      for (const ctx of contexts) {
        const r = results.get(ctx.txId.toLowerCase());
        expect(r).toBeDefined();
        if (!r) throw new Error('missing run result');
        expect(r.received).toHaveLength(1);
      }

      // --- Invariant 2 + 3: payloads parse correctly and bind to the
      // right txId (no cross-tx leakage). For encrypted half, we also
      // confirm the wire scheme + plaintext payload via verifyAndDecrypt.
      await Promise.all(
        contexts.map(async (ctx) => {
          const r = results.get(ctx.txId.toLowerCase());
          if (!r) throw new Error('missing run result');
          const wire = r.received[0] as DeliveryEnvelopeWireV1;

          // Cross-tx leakage check.
          expect(wire.signed.txId.toLowerCase()).toBe(ctx.txId.toLowerCase());

          if (ctx.privacy === 'encrypted') {
            expect(wire.signed.scheme).toBe('x25519-aes256gcm-v1');
            if (!ctx.ephemeral) throw new Error('missing ephemeral');
            const decoded = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
              wire,
              ctx.ephemeral.privateKey,
              {
                expectedKernelAddress: KERNEL,
                expectedChainId: CHAIN_ID,
                now: BASE_NOW,
              },
            );
            expect(decoded.ok).toBe(true);
            if (decoded.ok) {
              expect(decoded.payload).toEqual(ctx.payload);
            }
          } else {
            expect(wire.signed.scheme).toBe('public-v1');
            const decoded = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
              wire,
              new Uint8Array(32),
              {
                expectedKernelAddress: KERNEL,
                expectedChainId: CHAIN_ID,
                now: BASE_NOW,
              },
            );
            expect(decoded.ok).toBe(true);
            if (decoded.ok) {
              expect(decoded.payload).toEqual(ctx.payload);
            }
          }
        }),
      );

      // --- Invariant 5: dedup-after-verify holds under load.
      // Re-publish every setup AND every envelope and confirm no second
      // fan-out (received[] still length 1) and storage size unchanged.
      const setupsBefore = channel.getAllSetups().length;
      const envelopesBefore = channel.getAllEnvelopes().length;
      expect(setupsBefore).toBe(N);
      expect(envelopesBefore).toBe(N);

      await Promise.all(
        channel.getAllSetups().map((s) => channel.publishSetup(s)),
      );
      await Promise.all(
        channel.getAllEnvelopes().map((e) => channel.publishEnvelope(e)),
      );
      await flush(4);

      expect(channel.getAllSetups().length).toBe(setupsBefore);
      expect(channel.getAllEnvelopes().length).toBe(envelopesBefore);
      for (const ctx of contexts) {
        const r = results.get(ctx.txId.toLowerCase());
        if (!r) throw new Error('missing run result');
        // Setup re-publish fires the provider subscriber, but the
        // provider re-publishes the same envelope — dedup MUST suppress
        // the second fan-out. So received[] stays at exactly 1.
        expect(r.received).toHaveLength(1);
      }

      // --- Invariant: subscription cleanup leaves zero leaked subs.
      await Promise.all(
        Array.from(results.values()).flatMap((r) => [
          r.setupSubClose(),
          r.envSubClose(),
        ]),
      );
      expect(channel.activeSubscriptionCount()).toBe(0);

      // --- Invariant 4: memory stability across repeated runs.
      // Run the round 2 more times with FRESH txIds; storage should
      // grow linearly with txIds we keep, and clear() must zero it.
      const round2 = contexts.map((c, i) => ({
        ...c,
        txId: txIdN(0x2000 + i),
        ephemeral: undefined,
      }));
      const round3 = contexts.map((c, i) => ({
        ...c,
        txId: txIdN(0x3000 + i),
        ephemeral: undefined,
      }));
      const r2 = await runRound(channel, round2);
      const r3 = await runRound(channel, round3);

      // After 3 rounds with N distinct txIds each, storage must equal
      // exactly 3N (bounded linear growth, no leak).
      expect(channel.getAllSetups().length).toBe(3 * N);
      expect(channel.getAllEnvelopes().length).toBe(3 * N);

      // Close all the round-2/3 subs.
      await Promise.all(
        [...r2.values(), ...r3.values()].flatMap((r) => [
          r.setupSubClose(),
          r.envSubClose(),
        ]),
      );
      expect(channel.activeSubscriptionCount()).toBe(0);

      // clear() must zero storage — proves the channel does not retain
      // wires across explicit resets.
      channel.clear();
      expect(channel.getAllSetups().length).toBe(0);
      expect(channel.getAllEnvelopes().length).toBe(0);

      const t1 = Date.now();
      const memAfter = process.memoryUsage().heapUsed;
      const memDelta = memAfter - memBefore;

      // Surface the timing + memory delta in test output for the
      // operator. We do NOT fail the test on a memory budget because GC
      // timing is non-deterministic, but we do guard the upper bound
      // loosely (300 MB) to catch catastrophic regressions.
      // eslint-disable-next-line no-console
      console.log(
        `[stress] N=${N} totalMs=${t1 - t0} memDeltaMB=${(memDelta / 1024 / 1024).toFixed(2)}`,
      );
      expect(memDelta).toBeLessThan(300 * 1024 * 1024);
    },
    60_000,
  );
});
