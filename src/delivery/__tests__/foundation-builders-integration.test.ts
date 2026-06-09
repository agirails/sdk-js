/**
 * Integration tests for AIP-16 Phase 2b builders + channel + verification.
 *
 * These tests stitch together the foundation (Phase 2a) crypto primitives,
 * the Phase 2b builders, and the channel layer to walk the full
 * end-to-end AIP-16 delivery flow that the SDK ships to its callers.
 */

import { Wallet } from 'ethers';

import { DeliveryEnvelopeBuilder, buildEnvelopeAad } from '../envelopeBuilder';
import {
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  pubkeyFromHex,
} from '../keys';
import { MockDeliveryChannel } from '../MockDeliveryChannel';
import { DeliverySetupBuilder } from '../setupBuilder';
import { bytesFromHex, decryptBody } from '../crypto';
import type {
  DeliveryEnvelopeWireV1,
  DeliverySetupWireV1,
} from '../types';

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const CHAIN_ID = 84532;
const BASE_NOW = 1_750_000_000;
const TX_ID = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const TX_ID_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`;

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ----------------------------------------------------------------------------
// Setup end-to-end
// ----------------------------------------------------------------------------

describe('AIP-16 integration: setup end-to-end', () => {
  test('buyer builds setup → publishes on Mock channel → provider subscribes + verifies', async () => {
    const buyer = Wallet.createRandom();
    const buyerKp = generateEphemeralKeyPair();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });

    // Provider side subscribes first.
    const received: DeliverySetupWireV1[] = [];
    await channel.subscribeSetups(TX_ID, (w) => {
      received.push(w);
    });

    // Buyer signs + publishes.
    const builder = new DeliverySetupBuilder(buyer);
    const { wire } = await builder.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: buyer.address as `0x${string}`,
      signerAddress: buyer.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 3600,
    });
    await channel.publishSetup(wire);
    await flush();

    expect(received).toHaveLength(1);
    const verify = DeliverySetupBuilder.verify(received[0]!, {
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(verify.ok).toBe(true);
  });

  test('publish setup with mismatched expectedKernel rejected at channel', async () => {
    const buyer = Wallet.createRandom();
    const buyerKp = generateEphemeralKeyPair();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: '0x' + '11'.repeat(20),
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const builder = new DeliverySetupBuilder(buyer);
    const { wire } = await builder.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: buyer.address as `0x${string}`,
      signerAddress: buyer.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 3600,
    });
    await expect(channel.publishSetup(wire)).rejects.toMatchObject({
      code: 'setup_kernel_mismatch',
    });
  });
});

// ----------------------------------------------------------------------------
// Envelope end-to-end
// ----------------------------------------------------------------------------

describe('AIP-16 integration: envelope end-to-end', () => {
  test('public envelope: provider builds → publishes → buyer receives + verifies + reads body', async () => {
    const provider = Wallet.createRandom();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const received: DeliveryEnvelopeWireV1[] = [];
    await channel.subscribeEnvelopes(TX_ID, (w) => {
      received.push(w);
    });

    const builder = new DeliveryEnvelopeBuilder(provider);
    const payload = { greeting: 'hi' };
    const { wire } = await builder.buildPublic({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: provider.address as `0x${string}`,
      signerAddress: provider.address as `0x${string}`,
      payload,
      createdAt: BASE_NOW,
    });
    await channel.publishEnvelope(wire);
    await flush();

    expect(received).toHaveLength(1);
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      received[0]!,
      new Uint8Array(32),
      { expectedKernelAddress: KERNEL, expectedChainId: CHAIN_ID, now: BASE_NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  test('encrypted envelope: setup pubkey → envelope encrypts → buyer decrypts', async () => {
    const buyer = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const buyerKp = generateEphemeralKeyPair();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });

    // Buyer sets up, posts pubkey.
    const setupBuilder = new DeliverySetupBuilder(buyer);
    const { wire: setupWire } = await setupBuilder.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: buyer.address as `0x${string}`,
      signerAddress: buyer.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 3600,
    });
    await channel.publishSetup(setupWire);

    // Provider reads setup, builds + posts encrypted envelope.
    const setups = await channel.getSetups(TX_ID);
    expect(setups).toHaveLength(1);
    const buyerPub = setups[0]!.signed.buyerEphemeralPubkey;

    const envBuilder = new DeliveryEnvelopeBuilder(provider);
    const payload = { secret: 'fortune' };
    const { wire: envWire } = await envBuilder.buildEncrypted({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: provider.address as `0x${string}`,
      signerAddress: provider.address as `0x${string}`,
      payload,
      buyerEphemeralPubkey: buyerPub,
      createdAt: BASE_NOW,
    });
    await channel.publishEnvelope(envWire);

    // Buyer reads envelope, decrypts.
    const envs = await channel.getEnvelopes(TX_ID);
    expect(envs).toHaveLength(1);
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      envs[0]!,
      buyerKp.privateKey,
      { expectedKernelAddress: KERNEL, expectedChainId: CHAIN_ID, now: BASE_NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });
});

// ----------------------------------------------------------------------------
// Cross-builder + manual ECDH+HKDF interop
// ----------------------------------------------------------------------------

describe('AIP-16 integration: ECDH + HKDF interop', () => {
  test('provider session key matches buyer session key', async () => {
    const buyerKp = generateEphemeralKeyPair();
    const provider = Wallet.createRandom();
    const builder = new DeliveryEnvelopeBuilder(provider);
    const { wire, blobKey } = await builder.buildEncrypted({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: provider.address as `0x${string}`,
      signerAddress: provider.address as `0x${string}`,
      payload: { x: 1 },
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      createdAt: BASE_NOW,
    });

    // Buyer derives independently using the provider's published pubkey.
    const providerPub = pubkeyFromHex(wire.signed.providerEphemeralPubkey);
    const sharedBuyer = deriveSharedSecret(buyerKp.privateKey, providerPub);
    const sessionKeyBuyer = deriveSessionKey(sharedBuyer, wire.signed.txId);

    expect(Buffer.from(sessionKeyBuyer).equals(Buffer.from(blobKey!))).toBe(true);

    // Buyer manually decrypts. H5: AAD = txId || signerAddress is bound
    // into the GCM tag by `buildEncrypted`, so the manual path must
    // reconstruct it identically — otherwise tag verification fails.
    const ciphertext = bytesFromHex(wire.body);
    const nonce = bytesFromHex(wire.signed.nonce);
    const tag = bytesFromHex(wire.signed.tag);
    const aad = buildEnvelopeAad(wire.signed.txId, wire.signed.signerAddress);
    const plaintextBytes = decryptBody(
      ciphertext,
      sessionKeyBuyer,
      nonce,
      tag,
      aad,
    );
    expect(JSON.parse(Buffer.from(plaintextBytes).toString('utf8'))).toEqual({ x: 1 });
  });
});

// ----------------------------------------------------------------------------
// Multi-txId subscriber isolation
// ----------------------------------------------------------------------------

describe('AIP-16 integration: multi-txId channel isolation', () => {
  test('two txIds in one channel — subscribers only see their own', async () => {
    const wA = Wallet.createRandom();
    const wB = Wallet.createRandom();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });

    const kpA = generateEphemeralKeyPair();
    const kpB = generateEphemeralKeyPair();

    const aReceived: DeliverySetupWireV1[] = [];
    const bReceived: DeliverySetupWireV1[] = [];
    await channel.subscribeSetups(TX_ID, (w) => {
      aReceived.push(w);
    });
    await channel.subscribeSetups(TX_ID_B, (w) => {
      bReceived.push(w);
    });

    const builderA = new DeliverySetupBuilder(wA);
    const builderB = new DeliverySetupBuilder(wB);
    const { wire: a } = await builderA.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: wA.address as `0x${string}`,
      signerAddress: wA.address as `0x${string}`,
      buyerEphemeralPubkey: kpA.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 3600,
    });
    const { wire: b } = await builderB.build({
      txId: TX_ID_B,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: wB.address as `0x${string}`,
      signerAddress: wB.address as `0x${string}`,
      buyerEphemeralPubkey: kpB.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 3600,
    });
    await channel.publishSetup(a);
    await channel.publishSetup(b);
    await flush();

    expect(aReceived).toHaveLength(1);
    expect(aReceived[0]?.signed.txId).toBe(TX_ID);
    expect(bReceived).toHaveLength(1);
    expect(bReceived[0]?.signed.txId).toBe(TX_ID_B);
  });
});

// ----------------------------------------------------------------------------
// AIP-16 §6.1.4 ordering
// ----------------------------------------------------------------------------

describe('AIP-16 §6.1.4 builder+channel+verify ordering', () => {
  test('build → publish → channel verify → subscriber → verifyAndDecrypt', async () => {
    const buyer = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const buyerKp = generateEphemeralKeyPair();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });

    // Step 1: buyer setup.
    const setupBuilder = new DeliverySetupBuilder(buyer);
    const { wire: setupWire } = await setupBuilder.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: buyer.address as `0x${string}`,
      signerAddress: buyer.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 3600,
    });

    // Provider waits for setup.
    let observedSetup: DeliverySetupWireV1 | null = null;
    await channel.subscribeSetups(TX_ID, (w) => {
      observedSetup = w;
    });
    await channel.publishSetup(setupWire);
    await flush();
    expect(observedSetup).not.toBeNull();

    // Step 2: provider builds envelope using observed buyer pubkey.
    const envBuilder = new DeliveryEnvelopeBuilder(provider);
    const payload = { ordered: true };
    const { wire: envWire } = await envBuilder.buildEncrypted({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: provider.address as `0x${string}`,
      signerAddress: provider.address as `0x${string}`,
      payload,
      buyerEphemeralPubkey: (observedSetup as unknown as DeliverySetupWireV1).signed.buyerEphemeralPubkey,
      createdAt: BASE_NOW,
    });

    // Buyer waits for envelope.
    let observedEnv: DeliveryEnvelopeWireV1 | null = null;
    await channel.subscribeEnvelopes(TX_ID, (w) => {
      observedEnv = w;
    });
    await channel.publishEnvelope(envWire);
    await flush();
    expect(observedEnv).not.toBeNull();

    // Step 3: buyer verifies + decrypts.
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      observedEnv as unknown as DeliveryEnvelopeWireV1,
      buyerKp.privateKey,
      { expectedKernelAddress: KERNEL, expectedChainId: CHAIN_ID, now: BASE_NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  test('full flow: replay-on-subscribe makes order-independent', async () => {
    const buyer = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const buyerKp = generateEphemeralKeyPair();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });

    // Buyer publishes BEFORE provider subscribes.
    const setupBuilder = new DeliverySetupBuilder(buyer);
    const { wire: setupWire } = await setupBuilder.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: buyer.address as `0x${string}`,
      signerAddress: buyer.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 3600,
    });
    await channel.publishSetup(setupWire);

    // Provider subscribes after the fact — should still see the setup via replay.
    const observed: DeliverySetupWireV1[] = [];
    await channel.subscribeSetups(TX_ID, (w) => {
      observed.push(w);
    });
    await flush();
    expect(observed).toHaveLength(1);

    // Continue with envelope, same shape.
    const envBuilder = new DeliveryEnvelopeBuilder(provider);
    const payload = { late: true };
    const { wire: envWire } = await envBuilder.buildEncrypted({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: provider.address as `0x${string}`,
      signerAddress: provider.address as `0x${string}`,
      payload,
      buyerEphemeralPubkey: observed[0]!.signed.buyerEphemeralPubkey,
      createdAt: BASE_NOW,
    });
    await channel.publishEnvelope(envWire);
    const envs = await channel.getEnvelopes(TX_ID);
    expect(envs).toHaveLength(1);
    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      envs[0]!,
      buyerKp.privateKey,
      { expectedKernelAddress: KERNEL, expectedChainId: CHAIN_ID, now: BASE_NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });
});

// ----------------------------------------------------------------------------
// Adversarial flow: tampered envelope dropped at channel before reaching buyer
// ----------------------------------------------------------------------------

describe('AIP-16 integration: cross-wallet consistency', () => {
  test('static computeHash agrees across two builder instances', async () => {
    const wallet = Wallet.createRandom();
    const builderA = new DeliverySetupBuilder(wallet);
    const builderB = new DeliverySetupBuilder(wallet);
    const buyerKp = generateEphemeralKeyPair();
    const params = {
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted' as const,
      createdAt: BASE_NOW,
      expiresInSec: 600,
    };
    const { wire: a } = await builderA.build(params);
    const { wire: b } = await builderB.build(params);
    // Different signatures (HD wallets sign deterministically per the RFC
    // but EIP-712 reuses the same signed digest, so signatures should be
    // the same too) — what matters is signed-projection equality:
    expect(DeliverySetupBuilder.computeHash(a)).toBe(
      DeliverySetupBuilder.computeHash(b),
    );
  });

  test('static envelope computeHash agrees for identical signed projection', async () => {
    const wallet = Wallet.createRandom();
    const b1 = new DeliveryEnvelopeBuilder(wallet);
    const b2 = new DeliveryEnvelopeBuilder(wallet);
    const params = {
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      payload: { x: 1 },
      createdAt: BASE_NOW,
    };
    const { wire: a } = await b1.buildPublic(params);
    const { wire: b } = await b2.buildPublic(params);
    expect(DeliveryEnvelopeBuilder.computeHash(a)).toBe(
      DeliveryEnvelopeBuilder.computeHash(b),
    );
  });

  test('relay-channel-shape: hash of wire stable across serialization', async () => {
    const wallet = Wallet.createRandom();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const { wire } = await builder.buildPublic({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      payload: { ok: true },
      createdAt: BASE_NOW,
    });
    const json = JSON.stringify(wire);
    const reparsed = JSON.parse(json) as typeof wire;
    expect(DeliveryEnvelopeBuilder.computeHash(reparsed)).toBe(
      DeliveryEnvelopeBuilder.computeHash(wire),
    );
  });

  test('subscribe-then-publish AND publish-then-subscribe both deliver', async () => {
    const wallet = Wallet.createRandom();
    const buyerKp = generateEphemeralKeyPair();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const builder = new DeliverySetupBuilder(wallet);
    const { wire: w1 } = await builder.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 600,
    });
    // subscribe-then-publish
    const a: DeliverySetupWireV1[] = [];
    await channel.subscribeSetups(TX_ID, (w) => {
      a.push(w);
    });
    await channel.publishSetup(w1);
    await flush();
    expect(a).toHaveLength(1);

    // publish-then-subscribe (different txId so we control replay)
    const { wire: w2 } = await builder.build({
      txId: TX_ID_B,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 600,
    });
    await channel.publishSetup(w2);
    const b: DeliverySetupWireV1[] = [];
    await channel.subscribeSetups(TX_ID_B, (w) => {
      b.push(w);
    });
    await flush();
    expect(b).toHaveLength(1);
  });

  test('verify→subscribe→verify chain matches dedup-after-verify invariant', async () => {
    // Adversarial: a malformed wire is rejected at publish; the same
    // signed projection's hash is never added to dedup; the legitimate
    // wire is then accepted.
    const wallet = Wallet.createRandom();
    const buyerKp = generateEphemeralKeyPair();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const builder = new DeliverySetupBuilder(wallet);
    const { wire: good } = await builder.build({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      requesterAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      buyerEphemeralPubkey: buyerKp.publicKeyHex,
      expectedPrivacy: 'encrypted',
      createdAt: BASE_NOW,
      expiresInSec: 600,
    });
    const tampered: DeliverySetupWireV1 = {
      ...good,
      signed: { ...good.signed, txId: ('0x' + 'cd'.repeat(32)) as `0x${string}` },
    };
    await expect(channel.publishSetup(tampered)).rejects.toBeDefined();
    // Good still publishes.
    const received: DeliverySetupWireV1[] = [];
    await channel.subscribeSetups(TX_ID, (w) => {
      received.push(w);
    });
    await channel.publishSetup(good);
    await flush();
    expect(received).toHaveLength(1);
  });
});

describe('AIP-16 integration: channel rejects tampered wires', () => {
  test('encrypted envelope with wrong buyerEphemeralPubkey produces undecryptable body for unrelated buyer', async () => {
    // The provider encrypts to buyerA's pubkey; an unrelated buyerB
    // cannot decrypt even though the signature + payloadHash + chain
    // bindings are all valid.
    const provider = Wallet.createRandom();
    const buyerA = generateEphemeralKeyPair();
    const buyerB = generateEphemeralKeyPair();
    const builder = new DeliveryEnvelopeBuilder(provider);
    const { wire } = await builder.buildEncrypted({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: provider.address as `0x${string}`,
      signerAddress: provider.address as `0x${string}`,
      payload: { only: 'for A' },
      buyerEphemeralPubkey: buyerA.publicKeyHex,
      createdAt: BASE_NOW,
    });
    // Verify still passes (envelope is structurally valid).
    const verifyResult = DeliveryEnvelopeBuilder.verify(wire, {
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: BASE_NOW,
    });
    expect(verifyResult.ok).toBe(true);
    // But B cannot decrypt.
    const decryptResult = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      wire,
      buyerB.privateKey,
      { expectedKernelAddress: KERNEL, expectedChainId: CHAIN_ID, now: BASE_NOW },
    );
    expect(decryptResult.ok).toBe(false);
    if (!decryptResult.ok) expect(decryptResult.code).toBe('envelope_decrypt_failed');
    // A can.
    const okResult = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      wire,
      buyerA.privateKey,
      { expectedKernelAddress: KERNEL, expectedChainId: CHAIN_ID, now: BASE_NOW },
    );
    expect(okResult.ok).toBe(true);
    if (okResult.ok) expect(okResult.payload).toEqual({ only: 'for A' });
  });

  test('tampered envelope body never reaches subscriber', async () => {
    const provider = Wallet.createRandom();
    const channel = new MockDeliveryChannel({
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const received: DeliveryEnvelopeWireV1[] = [];
    await channel.subscribeEnvelopes(TX_ID, (w) => {
      received.push(w);
    });

    const builder = new DeliveryEnvelopeBuilder(provider);
    const { wire } = await builder.buildPublic({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL as `0x${string}`,
      providerAddress: provider.address as `0x${string}`,
      signerAddress: provider.address as `0x${string}`,
      payload: { good: 1 },
      createdAt: BASE_NOW,
    });
    const tampered: DeliveryEnvelopeWireV1 = {
      ...wire,
      body: '0xff',
    };
    await expect(channel.publishEnvelope(tampered)).rejects.toMatchObject({
      code: 'envelope_payload_hash_mismatch',
    });

    // Now the good envelope still goes through.
    await channel.publishEnvelope(wire);
    await flush();
    expect(received).toHaveLength(1);
  });
});
