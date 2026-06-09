/**
 * Unit tests for MockDeliveryChannel (AIP-16 Phase 2b).
 *
 * Covers: publish, subscribe, fan-out, replay-on-subscribe, dedup
 * (after verify), subscriber-error isolation, close lifecycle, and
 * adversarial signature-poisoning attempts.
 */

import { HDNodeWallet, Wallet } from 'ethers';

import { DeliveryEnvelopeBuilder } from './envelopeBuilder';
import { generateEphemeralKeyPair } from './keys';
import {
  MockDeliveryChannel,
  type MockDeliveryChannelOptions,
} from './MockDeliveryChannel';
import { DeliverySetupBuilder } from './setupBuilder';
import type {
  DeliveryEnvelopeWireV1,
  DeliverySetupWireV1,
} from './types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const CHAIN_ID = 84532;
const BASE_NOW = 1_750_000_000;
const TX_ID_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const TX_ID_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`;

async function buildSetup(
  wallet: HDNodeWallet,
  txId: `0x${string}` = TX_ID_A,
  createdAt = BASE_NOW,
): Promise<DeliverySetupWireV1> {
  const kp = generateEphemeralKeyPair();
  const builder = new DeliverySetupBuilder(wallet);
  const { wire } = await builder.build({
    txId,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL as `0x${string}`,
    requesterAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    buyerEphemeralPubkey: kp.publicKeyHex,
    expectedPrivacy: 'encrypted',
    createdAt,
    expiresInSec: 3600,
  });
  return wire;
}

async function buildEnvelope(
  wallet: HDNodeWallet,
  txId: `0x${string}` = TX_ID_A,
  createdAt = BASE_NOW,
): Promise<DeliveryEnvelopeWireV1> {
  const builder = new DeliveryEnvelopeBuilder(wallet);
  const { wire } = await builder.buildPublic({
    txId,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL as `0x${string}`,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    payload: { tag: txId },
    createdAt,
  });
  return wire;
}

function newChannel(opts: Partial<MockDeliveryChannelOptions> = {}): MockDeliveryChannel {
  return new MockDeliveryChannel({
    expectedKernelAddress: KERNEL,
    expectedChainId: CHAIN_ID,
    now: () => BASE_NOW,
    ...opts,
  });
}

/** Wait for the microtask queue to flush so fan-out callbacks resolve. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ----------------------------------------------------------------------------
// publishSetup → subscriber
// ----------------------------------------------------------------------------

describe('MockDeliveryChannel publishSetup → subscriber', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('publishSetup fires single subscriber for matching txId', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    await ch.publishSetup(wire);
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0]?.signed.txId).toBe(TX_ID_A);
  });

  test('subscriber for different txId does NOT fire', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet, TX_ID_A);
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_B, (w) => {
      received.push(w);
    });
    await ch.publishSetup(wire);
    await flush();
    expect(received).toHaveLength(0);
  });

  test('multiple subscribers on same txId each fire', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    const a: DeliverySetupWireV1[] = [];
    const b: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      a.push(w);
    });
    await ch.subscribeSetups(TX_ID_A, (w) => {
      b.push(w);
    });
    await ch.publishSetup(wire);
    await flush();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test('re-publishing same setup is idempotent (single fan-out)', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    await ch.publishSetup(wire);
    await ch.publishSetup(wire);
    await flush();
    expect(received).toHaveLength(1);
  });

  test('two distinct sigs (signed by two wallets) both fire even on same txId', async () => {
    const ch = newChannel();
    const w1 = Wallet.createRandom();
    const w2 = Wallet.createRandom();
    const setup1 = await buildSetup(w1);
    const setup2 = await buildSetup(w2);
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    await ch.publishSetup(setup1);
    await ch.publishSetup(setup2);
    await flush();
    expect(received).toHaveLength(2);
  });

  test('subscriber that throws does NOT halt fan-out to other subscribers', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    const a: DeliverySetupWireV1[] = [];
    const b: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, () => {
      throw new Error('a-boom');
    });
    await ch.subscribeSetups(TX_ID_A, (w) => {
      a.push(w);
    });
    await ch.subscribeSetups(TX_ID_A, (w) => {
      b.push(w);
    });
    await ch.publishSetup(wire);
    await flush();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test('async subscriber that rejects is isolated', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    const a: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, async () => {
      throw new Error('async-boom');
    });
    await ch.subscribeSetups(TX_ID_A, (w) => {
      a.push(w);
    });
    await ch.publishSetup(wire);
    await flush();
    expect(a).toHaveLength(1);
  });

  test('replay-on-subscribe: late subscriber receives previously-published setup', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    await ch.publishSetup(wire);
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    await flush();
    expect(received).toHaveLength(1);
  });

  test('replay then fanout: subscriber sees each message exactly once', async () => {
    const ch = newChannel();
    const a = await buildSetup(wallet, TX_ID_A, BASE_NOW);
    const b = await buildSetup(Wallet.createRandom(), TX_ID_A, BASE_NOW);
    await ch.publishSetup(a);
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    await ch.publishSetup(b);
    await flush();
    expect(received).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// publishEnvelope → subscriber
// ----------------------------------------------------------------------------

describe('MockDeliveryChannel publishEnvelope → subscriber', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('publishEnvelope fires matching subscriber', async () => {
    const ch = newChannel();
    const wire = await buildEnvelope(wallet);
    const received: DeliveryEnvelopeWireV1[] = [];
    await ch.subscribeEnvelopes(TX_ID_A, (w) => {
      received.push(w);
    });
    await ch.publishEnvelope(wire);
    await flush();
    expect(received).toHaveLength(1);
  });

  test('envelope subscriber for different txId does NOT fire', async () => {
    const ch = newChannel();
    const wire = await buildEnvelope(wallet, TX_ID_A);
    const received: DeliveryEnvelopeWireV1[] = [];
    await ch.subscribeEnvelopes(TX_ID_B, (w) => {
      received.push(w);
    });
    await ch.publishEnvelope(wire);
    await flush();
    expect(received).toHaveLength(0);
  });

  test('republishing same envelope is idempotent', async () => {
    const ch = newChannel();
    const wire = await buildEnvelope(wallet);
    const received: DeliveryEnvelopeWireV1[] = [];
    await ch.subscribeEnvelopes(TX_ID_A, (w) => {
      received.push(w);
    });
    await ch.publishEnvelope(wire);
    await ch.publishEnvelope(wire);
    await flush();
    expect(received).toHaveLength(1);
  });

  test('envelope subscriber that throws does not halt other subscribers', async () => {
    const ch = newChannel();
    const wire = await buildEnvelope(wallet);
    const ok: DeliveryEnvelopeWireV1[] = [];
    await ch.subscribeEnvelopes(TX_ID_A, () => {
      throw new Error('boom');
    });
    await ch.subscribeEnvelopes(TX_ID_A, (w) => {
      ok.push(w);
    });
    await ch.publishEnvelope(wire);
    await flush();
    expect(ok).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Subscription lifecycle
// ----------------------------------------------------------------------------

describe('MockDeliveryChannel subscription lifecycle', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('close() on subscription stops future deliveries', async () => {
    const ch = newChannel();
    const received: DeliverySetupWireV1[] = [];
    const sub = await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    await sub.close();
    const wire = await buildSetup(wallet);
    await ch.publishSetup(wire);
    await flush();
    expect(received).toHaveLength(0);
  });

  test('close() is idempotent', async () => {
    const ch = newChannel();
    const sub = await ch.subscribeSetups(TX_ID_A, () => undefined);
    await sub.close();
    await sub.close();
    // No throw is success.
    expect(ch.activeSubscriptionCount()).toBe(0);
  });

  test('closing one subscription does not affect siblings', async () => {
    const ch = newChannel();
    const a: DeliverySetupWireV1[] = [];
    const b: DeliverySetupWireV1[] = [];
    const subA = await ch.subscribeSetups(TX_ID_A, (w) => {
      a.push(w);
    });
    await ch.subscribeSetups(TX_ID_A, (w) => {
      b.push(w);
    });
    await subA.close();
    const wire = await buildSetup(wallet);
    await ch.publishSetup(wire);
    await flush();
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  test('activeSubscriptionCount tracks setup + envelope subs', async () => {
    const ch = newChannel();
    expect(ch.activeSubscriptionCount()).toBe(0);
    const s1 = await ch.subscribeSetups(TX_ID_A, () => undefined);
    const s2 = await ch.subscribeEnvelopes(TX_ID_A, () => undefined);
    expect(ch.activeSubscriptionCount()).toBe(2);
    await s1.close();
    await s2.close();
    expect(ch.activeSubscriptionCount()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// clear() and getAllSetups / getAllEnvelopes
// ----------------------------------------------------------------------------

describe('MockDeliveryChannel test helpers', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('getAllSetups returns published setups for txId', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    await ch.publishSetup(wire);
    expect(ch.getAllSetups(TX_ID_A)).toHaveLength(1);
    expect(ch.getAllSetups()).toHaveLength(1);
  });

  test('getAllEnvelopes returns published envelopes for txId', async () => {
    const ch = newChannel();
    const wire = await buildEnvelope(wallet);
    await ch.publishEnvelope(wire);
    expect(ch.getAllEnvelopes(TX_ID_A)).toHaveLength(1);
    expect(ch.getAllEnvelopes()).toHaveLength(1);
  });

  test('clear() empties storage but preserves subscribers', async () => {
    const ch = newChannel();
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    const wire = await buildSetup(wallet);
    await ch.publishSetup(wire);
    await flush();
    expect(received).toHaveLength(1);
    ch.clear();
    expect(ch.getAllSetups()).toHaveLength(0);
    expect(ch.activeSubscriptionCount()).toBe(1);
  });

  test('async getSetups / getEnvelopes mirror sync helpers', async () => {
    const ch = newChannel();
    const setup = await buildSetup(wallet);
    const env = await buildEnvelope(wallet);
    await ch.publishSetup(setup);
    await ch.publishEnvelope(env);
    expect(await ch.getSetups(TX_ID_A)).toHaveLength(1);
    expect(await ch.getEnvelopes(TX_ID_A)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// close()
// ----------------------------------------------------------------------------

describe('MockDeliveryChannel close()', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('close() rejects subsequent publishes', async () => {
    const ch = newChannel();
    ch.close();
    const wire = await buildSetup(wallet);
    await expect(ch.publishSetup(wire)).rejects.toThrow(/closed/i);
  });

  test('close() is idempotent', async () => {
    const ch = newChannel();
    ch.close();
    ch.close();
    // No throw → idempotent.
    expect(ch.activeSubscriptionCount()).toBe(0);
  });

  test('close() cancels all current subscribers', async () => {
    const ch = newChannel();
    await ch.subscribeSetups(TX_ID_A, () => undefined);
    await ch.subscribeEnvelopes(TX_ID_A, () => undefined);
    expect(ch.activeSubscriptionCount()).toBe(2);
    ch.close();
    expect(ch.activeSubscriptionCount()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// ADVERSARIAL — Signature poisoning + verification
// ----------------------------------------------------------------------------

describe('MockDeliveryChannel adversarial', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('publish rejects setup with tampered txId (signature invalid)', async () => {
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    const tampered: DeliverySetupWireV1 = {
      ...wire,
      signed: { ...wire.signed, txId: ('0x' + 'ff'.repeat(32)) as `0x${string}` },
    };
    await expect(ch.publishSetup(tampered)).rejects.toMatchObject({
      code: 'setup_signature_invalid',
    });
    // Storage unaffected.
    expect(ch.getAllSetups()).toHaveLength(0);
  });

  test('publish rejects envelope with tampered body (payload-hash mismatch)', async () => {
    const ch = newChannel();
    const wire = await buildEnvelope(wallet);
    const tampered: DeliveryEnvelopeWireV1 = {
      ...wire,
      body: '0xff',
    };
    await expect(ch.publishEnvelope(tampered)).rejects.toMatchObject({
      code: 'envelope_payload_hash_mismatch',
    });
    expect(ch.getAllEnvelopes()).toHaveLength(0);
  });

  test('skipVerifyForTests=true: malformed wire accepted (test poison hook)', async () => {
    const ch = new MockDeliveryChannel({ skipVerifyForTests: true });
    const wire = await buildSetup(wallet);
    const tampered: DeliverySetupWireV1 = {
      ...wire,
      signed: { ...wire.signed, txId: ('0x' + 'cc'.repeat(32)) as `0x${string}` },
    };
    await expect(ch.publishSetup(tampered)).resolves.toBeUndefined();
    expect(ch.getAllSetups()).toHaveLength(1);
  });

  test('publish failure does NOT add to dedup set (legitimate signature still accepted later)', async () => {
    // The dedup-after-verify invariant. We poison with a tampered wire
    // whose computeHash would otherwise be added to the dedup set, then
    // verify the legitimate wire still publishes successfully.
    const ch = newChannel();
    const wire = await buildSetup(wallet);
    const tampered: DeliverySetupWireV1 = {
      ...wire,
      signed: { ...wire.signed, txId: ('0x' + 'ee'.repeat(32)) as `0x${string}` },
    };
    await expect(ch.publishSetup(tampered)).rejects.toBeDefined();
    // Now publish the legit one — it should succeed and fan out.
    const received: DeliverySetupWireV1[] = [];
    await ch.subscribeSetups(TX_ID_A, (w) => {
      received.push(w);
    });
    await ch.publishSetup(wire);
    await flush();
    expect(received).toHaveLength(1);
  });

  test('warn log emitted on subscriber throw (security invariant #2)', async () => {
    const events: Array<{ level: string; msg: string }> = [];
    const ch = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
      log: (level, msg) => {
        events.push({ level, msg });
      },
    });
    const wire = await buildSetup(wallet);
    await ch.subscribeSetups(TX_ID_A, () => {
      throw new Error('subscriber boom');
    });
    await ch.publishSetup(wire);
    await flush();
    expect(events.some((e) => e.level === 'warn' && /subscriber threw/.test(e.msg))).toBe(true);
  });

  test('warn log emitted on publish verify failure', async () => {
    const events: Array<{ level: string; msg: string }> = [];
    const ch = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
      log: (level, msg) => {
        events.push({ level, msg });
      },
    });
    const wire = await buildSetup(wallet);
    const tampered: DeliverySetupWireV1 = {
      ...wire,
      signed: { ...wire.signed, txId: ('0x' + 'cd'.repeat(32)) as `0x${string}` },
    };
    await expect(ch.publishSetup(tampered)).rejects.toBeDefined();
    expect(events.some((e) => e.level === 'warn' && /verify failed/.test(e.msg))).toBe(true);
  });
});
