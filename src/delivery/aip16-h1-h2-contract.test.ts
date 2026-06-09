/**
 * AIP-16 Phase 3 — H1 + H2 cross-repo contract tests.
 *
 * H1: Platform's `authenticateEnvelope` was hashing the wire body as
 *     `keccak256(toUtf8Bytes(body))` regardless of scheme. For the
 *     `x25519-aes256gcm-v1` scheme the SDK signs over
 *     `keccak256(rawCiphertextBytes)`. Because the wire body is
 *     `0x`-prefixed hex of the ciphertext (NOT base64 — see H2), the
 *     server's previous code hashed the hex STRING as UTF-8 and never
 *     decoded it, producing a different digest. Every valid encrypted
 *     envelope was falsely rejected with `payload_hash_mismatch`.
 *
 * H2: The wire body encoding was documented as base64 in SDK types.ts
 *     and Platform auth.ts, but implemented as hex throughout the SDK
 *     (`envelopeBuilder.ts` uses `bytesToHex(ciphertext)`). The
 *     authoritative choice is HEX — it keeps every byte-bearing field
 *     in AIP-16 on a single shared decoder (`bytesFromHex`), is
 *     debug-friendly, and aligns with `nonce` / `tag` / `payloadHash`
 *     / ephemeral pubkey serialization. The docs in three places have
 *     been updated to match the implementation.
 *
 * What these tests prove
 * ----------------------
 *  1. The SDK signs `payloadHash = bodyHash(rawCiphertext)` and the
 *     Platform recomputes the same digest by hex-decoding `wire.body`
 *     then hashing — i.e. the byte arrays match.
 *  2. A single-byte flip in the wire body produces a different
 *     recompute that no longer matches `signed.payloadHash` (server
 *     would respond `payload_hash_mismatch`).
 *  3. Hashing the hex STRING as UTF-8 (the buggy pre-fix code path)
 *     yields a DIFFERENT digest than hashing the decoded ciphertext —
 *     this is the core regression we are guarding against.
 *  4. Both directions of the contract — SDK→server hashing — agree
 *     byte-for-byte for both schemes (`public-v1` uses UTF-8 of
 *     plaintext; `x25519-aes256gcm-v1` uses decoded ciphertext bytes).
 *
 * No HTTP mocks here — we reproduce the Platform's exact hash
 * recompute step (the deterministic, framework-agnostic part of
 * `authenticateEnvelope` step 8) inline, so the contract holds even
 * if the network path changes.
 */

import { HDNodeWallet, Wallet, keccak256, toUtf8Bytes } from 'ethers';

import { bodyHash, bytesFromHex, bytesToHex } from './crypto';
import { DeliveryEnvelopeBuilder } from './envelopeBuilder';
import { generateEphemeralKeyPair, pubkeyToHex } from './keys';
import type { DeliveryEnvelopeWireV1 } from './types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const CHAIN_ID = 84532;
const TX_ID = ('0x' + '22'.repeat(32)) as `0x${string}`;
const BASE_NOW = 1_750_000_000;

/**
 * Inline reproduction of Platform `authenticateEnvelope` step 8 (the
 * scheme-aware payload-hash recompute introduced by the H1 fix).
 *
 * Returns the recomputed digest as `0x`-prefixed lowercase hex. Throws
 * on malformed hex input for the encrypted scheme (so a test can
 * assert the `invalid_hex_body` precondition).
 */
function platformRecomputePayloadHash(
  scheme: 'public-v1' | 'x25519-aes256gcm-v1',
  body: string,
): string {
  if (scheme === 'x25519-aes256gcm-v1') {
    if (!/^0x[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
      throw new Error('invalid_hex_body');
    }
    const hexBody = body.slice(2);
    const bytes = new Uint8Array(hexBody.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      const hi = parseInt(hexBody[i * 2] as string, 16);
      const lo = parseInt(hexBody[i * 2 + 1] as string, 16);
      bytes[i] = (hi << 4) | lo;
    }
    return keccak256(bytes);
  }
  // public-v1
  return keccak256(toUtf8Bytes(body));
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface BuiltEncrypted {
  wire: DeliveryEnvelopeWireV1;
  rawCiphertextBytes: Uint8Array;
  signedPayloadHash: string;
}

async function buildEncryptedEnvelope(
  wallet: HDNodeWallet,
): Promise<BuiltEncrypted> {
  const builder = new DeliveryEnvelopeBuilder(wallet);
  // A throwaway buyer keypair — we are only exercising provider-side
  // hashing here; the buyer never opens this ciphertext.
  const buyerKp = generateEphemeralKeyPair();
  const { wire, bodyBytes } = await builder.buildEncrypted({
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    payload: { secret: 'data', n: 42 },
    buyerEphemeralPubkey: pubkeyToHex(buyerKp.publicKey),
    createdAt: BASE_NOW,
  });
  return {
    wire,
    rawCiphertextBytes: bodyBytes, // ciphertext for encrypted scheme
    signedPayloadHash: wire.signed.payloadHash,
  };
}

// ============================================================================
// H1 — Platform decodes hex body before hashing (encrypted scheme)
// ============================================================================

describe('AIP-16 H1: Platform recomputes encrypted payloadHash by hex-decoding body', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('SDK signedPayloadHash == Platform recompute(hexDecode(wire.body))', async () => {
    const { wire, signedPayloadHash } = await buildEncryptedEnvelope(wallet);

    // What the Platform does now (post-fix): branch on scheme, decode
    // hex, hash the raw bytes.
    const recomputed = platformRecomputePayloadHash(
      wire.signed.scheme,
      wire.body,
    );

    expect(recomputed.toLowerCase()).toBe(signedPayloadHash.toLowerCase());
    expect(wire.signed.scheme).toBe('x25519-aes256gcm-v1');
  });

  test('SDK bodyHash(rawCiphertext) byte-equals Platform decoded-hash', async () => {
    const { wire, rawCiphertextBytes, signedPayloadHash } =
      await buildEncryptedEnvelope(wallet);

    // 1. SDK side: bodyHash over the raw ciphertext bytes.
    const sdkHash = bodyHash(rawCiphertextBytes);

    // 2. Platform side: hex-decode the wire body, then keccak256.
    const platformBytes = bytesFromHex(wire.body);
    const platformHash = keccak256(platformBytes);

    // 3. All three forms agree.
    expect(sdkHash.toLowerCase()).toBe(platformHash.toLowerCase());
    expect(sdkHash.toLowerCase()).toBe(signedPayloadHash.toLowerCase());

    // 4. And the byte arrays are byte-for-byte identical (no UTF-8
    //    re-encoding lurking on either side).
    expect(platformBytes.length).toBe(rawCiphertextBytes.length);
    for (let i = 0; i < platformBytes.length; i++) {
      expect(platformBytes[i]).toBe(rawCiphertextBytes[i]);
    }
  });

  test('buggy (pre-fix) UTF-8-of-hex-string hash DIFFERS from signed.payloadHash', async () => {
    // This codifies the H1 regression: the old code hashed
    // `toUtf8Bytes(wire.body)` directly, which for an encrypted
    // envelope is the UTF-8 bytes of the HEX STRING, not the
    // ciphertext. Asserting that this digest does NOT match
    // signed.payloadHash is the canonical "the bug is dead" guard.
    const { wire, signedPayloadHash } = await buildEncryptedEnvelope(wallet);

    const buggyHash = keccak256(toUtf8Bytes(wire.body));

    expect(buggyHash.toLowerCase()).not.toBe(
      signedPayloadHash.toLowerCase(),
    );
  });

  test('single-byte flip in wire body breaks Platform recompute', async () => {
    const { wire, signedPayloadHash } = await buildEncryptedEnvelope(wallet);

    // Mutate one hex character (= flipping 4 bits of one byte). The
    // first hex char of the payload (index 2, just past "0x").
    const original = wire.body;
    const firstHex = original[2] as string;
    const flippedHex = firstHex === '0' ? '1' : '0';
    const tampered =
      original.slice(0, 2) + flippedHex + original.slice(3);

    const recomputed = platformRecomputePayloadHash(
      wire.signed.scheme,
      tampered,
    );

    expect(recomputed.toLowerCase()).not.toBe(
      signedPayloadHash.toLowerCase(),
    );
  });

  test('malformed hex body throws invalid_hex_body precondition (server returns 400)', async () => {
    expect(() =>
      platformRecomputePayloadHash(
        'x25519-aes256gcm-v1',
        'not-hex-at-all',
      ),
    ).toThrow('invalid_hex_body');

    expect(() =>
      platformRecomputePayloadHash('x25519-aes256gcm-v1', '0xZZ'),
    ).toThrow('invalid_hex_body');

    // Odd-length hex.
    expect(() =>
      platformRecomputePayloadHash('x25519-aes256gcm-v1', '0xabc'),
    ).toThrow('invalid_hex_body');
  });
});

// ============================================================================
// H2 — Wire body encoding is hex (canonical choice), not base64
// ============================================================================

describe('AIP-16 H2: Wire body is 0x-prefixed lowercase hex (not base64)', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('encrypted wire.body is 0x-prefixed lowercase hex of ciphertext', async () => {
    const { wire, rawCiphertextBytes } = await buildEncryptedEnvelope(wallet);

    // Shape: 0x + even-length lowercase hex.
    expect(wire.body.startsWith('0x')).toBe(true);
    expect(wire.body.length).toBeGreaterThan(2);
    expect((wire.body.length - 2) % 2).toBe(0);
    expect(/^0x[0-9a-f]*$/.test(wire.body)).toBe(true);

    // Round-trips against the SDK's own bytesToHex helper.
    const expected = bytesToHex(rawCiphertextBytes);
    expect(wire.body).toBe(expected);

    // Sanity: it is NOT a base64 string. Base64 alphabet includes
    // upper-case letters, '+', '/', and '=' padding. A hex string of
    // 16+ bytes will (with overwhelming probability) contain at least
    // one digit that base64's alphabet maps differently — but the
    // strongest assertion is the regex above; we also explicitly
    // assert no base64 padding character is present.
    expect(wire.body.includes('=')).toBe(false);
    expect(wire.body.includes('+')).toBe(false);
    expect(wire.body.includes('/')).toBe(false);
  });

  test('hex round-trip: bytesFromHex(bytesToHex(x)) === x', async () => {
    const { wire, rawCiphertextBytes } = await buildEncryptedEnvelope(wallet);

    const decoded = bytesFromHex(wire.body);
    expect(decoded.length).toBe(rawCiphertextBytes.length);
    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i]).toBe(rawCiphertextBytes[i]);
    }
  });
});

// ============================================================================
// Cross-scheme: both schemes preserve the contract bodyHash(rawBytes)_sdk
//               == platformHash(rawBytes)_server
// ============================================================================

describe('AIP-16 H1+H2: bodyHash contract holds for both schemes', () => {
  test('public-v1: SDK signs over utf8(plaintext); Platform hashes wire.body as utf8 directly', async () => {
    const wallet = Wallet.createRandom();
    const builder = new DeliveryEnvelopeBuilder(wallet);
    const payload = { result: 'ok' };
    const { wire, bodyBytes } = await builder.buildPublic({
      txId: TX_ID,
      chainId: CHAIN_ID,
      kernelAddress: KERNEL,
      providerAddress: wallet.address as `0x${string}`,
      signerAddress: wallet.address as `0x${string}`,
      payload,
      createdAt: BASE_NOW,
    });

    // FIX-1 (AIP-16 Phase 3.5 HIGH): wire.body for public-v1 is the
    // plaintext UTF-8 JSON STRING, NOT hex. The Platform verifier at
    // `lib/delivery/auth.ts` step 8 computes
    // `keccak256(toUtf8Bytes(body))` directly on the wire body, which
    // matches the SDK's `bodyHash(bodyString)` =
    // `keccak256(utf8Bytes(bodyString))`. All three values agree:
    //   - signed.payloadHash (what the SDK signed),
    //   - keccak256(bodyBytes) on the raw utf8 bytes,
    //   - platformRecomputePayloadHash('public-v1', wire.body).

    // Wire body shape: plaintext, NOT hex.
    expect(wire.body).toBe(JSON.stringify(payload));
    expect(wire.body.startsWith('0x')).toBe(false);

    // SDK side: keccak256 over the raw utf8 bytes.
    const recomputedFromBytes = keccak256(bodyBytes);
    expect(recomputedFromBytes.toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );

    // bodyHash on the raw bytes agrees with the signed value.
    expect(bodyHash(bodyBytes).toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );

    // Platform recompute path: hashes wire.body as UTF-8 string
    // directly (no hex decode). MUST match signed.payloadHash.
    const platformHash = platformRecomputePayloadHash('public-v1', wire.body);
    expect(platformHash.toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );
  });

  test('x25519-aes256gcm-v1: SDK signs over rawCiphertext; Platform hashes hex-decoded body', async () => {
    const wallet = Wallet.createRandom();
    const { wire, rawCiphertextBytes } = await buildEncryptedEnvelope(wallet);

    // SDK side.
    const sdkHash = keccak256(rawCiphertextBytes);
    expect(sdkHash.toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );

    // Platform side (scheme-aware recompute as in auth.ts post-fix).
    const platformHash = platformRecomputePayloadHash(
      'x25519-aes256gcm-v1',
      wire.body,
    );
    expect(platformHash.toLowerCase()).toBe(sdkHash.toLowerCase());
  });
});
