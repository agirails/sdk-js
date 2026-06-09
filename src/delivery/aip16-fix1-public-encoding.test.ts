/**
 * AIP-16 Phase 3.5 — FIX-1 cross-repo contract tests for public-v1 body
 * encoding.
 *
 * The bug
 * -------
 * Pre-fix `buildPublic()` constructed
 *   wireBodyHex = bytesToHex(utf8(JSON.stringify(payload)))
 * and emitted `wire.body = wireBodyHex` (0x-prefixed lowercase hex).
 *
 * Pre-fix Platform `authenticateEnvelope` step 8 (public-v1 branch)
 * computed
 *   recomputed = keccak256(toUtf8Bytes(body))
 * directly on the wire body.
 *
 * The two paths hashed DIFFERENT byte sequences:
 *  - SDK signed `keccak256(utf8(JSON.stringify(payload)))`.
 *  - Platform recomputed `keccak256(utf8(0x...hex string...))`.
 * Every Sentinel `public-v1` POST would 400 with
 *   `code: "payload_hash_mismatch"`.
 *
 * The fix (canonical decision)
 * ----------------------------
 *  - `public-v1`: `wire.body = JSON.stringify(payload)` — plaintext
 *    UTF-8 JSON string, NOT hex. `payloadHash = keccak256(utf8Bytes(body))`.
 *  - `x25519-aes256gcm-v1`: `wire.body = bytesToHex(ciphertext)` (hex).
 *    `payloadHash = keccak256(hexDecode(body))`. (Unchanged from the H1
 *    fix — still hex because ciphertext is arbitrary binary.)
 *
 * Both SDK build/verify and Platform verify hash the SAME bytes for
 * each scheme; Sentinel public delivery now works wire-compatibly.
 */

import { HDNodeWallet, Wallet, keccak256, toUtf8Bytes } from 'ethers';

import { bodyHash } from './crypto';
import { DeliveryEnvelopeBuilder } from './envelopeBuilder';
import type { DeliveryEnvelopeWireV1 } from './types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411' as `0x${string}`;
const CHAIN_ID = 84532;
const TX_ID = ('0x' + '33'.repeat(32)) as `0x${string}`;
const BASE_NOW = 1_750_000_000;

/**
 * Inline reproduction of Platform `authenticateEnvelope` step 8
 * (public-v1 branch). Mirrors `keccak256(toUtf8Bytes(body))` from
 * `lib/delivery/auth.ts` so this test does not depend on Next/Supabase
 * at build time.
 */
function platformRecomputePublicHash(body: string): string {
  return keccak256(toUtf8Bytes(body));
}

interface BuiltPublic {
  wire: DeliveryEnvelopeWireV1;
  bodyBytes: Uint8Array;
  originalPayload: unknown;
}

async function buildPublicEnvelope(
  wallet: HDNodeWallet,
  payload: unknown,
): Promise<BuiltPublic> {
  const builder = new DeliveryEnvelopeBuilder(wallet);
  const { wire, bodyBytes } = await builder.buildPublic({
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    payload,
    createdAt: BASE_NOW,
  });
  return { wire, bodyBytes, originalPayload: payload };
}

// ============================================================================
// FIX-1: wire.body is plaintext UTF-8 JSON for public-v1
// ============================================================================

describe('AIP-16 FIX-1: buildPublic produces plaintext (not hex) wire.body', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('wire.body JSON.parses back to the original object payload', async () => {
    const payload = { result: 'ok', n: 42, nested: { a: 1 } };
    const { wire } = await buildPublicEnvelope(wallet, payload);

    expect(typeof wire.body).toBe('string');
    expect(wire.body.startsWith('0x')).toBe(false);
    expect(JSON.parse(wire.body)).toEqual(payload);
  });

  test('wire.body JSON.parses back to a string payload', async () => {
    // JSON.stringify("hello") === '"hello"' — the wire body must be
    // exactly that 7-character string, not a hex wrapper.
    const payload = 'hello';
    const { wire } = await buildPublicEnvelope(wallet, payload);

    expect(wire.body).toBe('"hello"');
    expect(JSON.parse(wire.body)).toBe('hello');
  });

  test('wire.body JSON.parses back to an array payload', async () => {
    const payload: ReadonlyArray<number | string> = [1, 'two', 3];
    const { wire } = await buildPublicEnvelope(wallet, payload);

    expect(wire.body).toBe(JSON.stringify(payload));
    expect(JSON.parse(wire.body)).toEqual(payload);
  });

  test('wire.body JSON.parses back to a deeply nested payload', async () => {
    const payload = {
      level1: {
        level2: {
          level3: { leaf: [true, null, { x: 'y' }] },
        },
      },
    };
    const { wire } = await buildPublicEnvelope(wallet, payload);

    expect(JSON.parse(wire.body)).toEqual(payload);
    expect(wire.body.startsWith('0x')).toBe(false);
  });

  test('wire.body equals JSON.stringify(payload) verbatim (no hex wrapping)', async () => {
    const payload = { kind: 'plain', value: 7 };
    const { wire } = await buildPublicEnvelope(wallet, payload);

    expect(wire.body).toBe(JSON.stringify(payload));
    // Defensive: the buggy pre-fix encoding would have produced
    //   "0x" + Buffer.from(JSON.stringify(payload), "utf8").toString("hex")
    // We explicitly assert wire.body is NOT that form.
    const buggyHex =
      '0x' + Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
    expect(wire.body).not.toBe(buggyHex);
  });
});

// ============================================================================
// FIX-1: SDK builds match Platform recompute byte-for-byte
// ============================================================================

describe('AIP-16 FIX-1: SDK signed.payloadHash == Platform keccak256(utf8(wire.body))', () => {
  let wallet: HDNodeWallet;

  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('SDK signs over utf8(JSON.stringify(payload)); Platform recomputes the same digest', async () => {
    const payload = { hello: 'world', n: [1, 2, 3] };
    const { wire } = await buildPublicEnvelope(wallet, payload);

    const platformDigest = platformRecomputePublicHash(wire.body);
    expect(platformDigest.toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );
  });

  test('SDK bodyHash(bodyBytes) byte-equals Platform recompute', async () => {
    const payload = { secret: 'no-it-is-public', items: ['a', 'b', 'c'] };
    const { wire, bodyBytes } = await buildPublicEnvelope(wallet, payload);

    // 1. SDK side: bodyHash over the utf8 bytes.
    const sdkHash = bodyHash(bodyBytes);

    // 2. Platform side: keccak256(toUtf8Bytes(wire.body)).
    const platformHash = platformRecomputePublicHash(wire.body);

    // 3. All three forms agree.
    expect(sdkHash.toLowerCase()).toBe(platformHash.toLowerCase());
    expect(sdkHash.toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );
  });

  test('round-trip: SDK build → SDK verify path succeeds', async () => {
    const payload = { ok: true, n: 1 };
    const { wire } = await buildPublicEnvelope(wallet, payload);

    const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
      wire,
      new Uint8Array(32), // ignored for public-v1
      {
        expectedKernelAddress: KERNEL,
        expectedChainId: CHAIN_ID,
        now: BASE_NOW,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(payload);
    }
  });

  test('round-trip: SDK build → Platform-simulated path succeeds', async () => {
    // Simulates the Sentinel server-side recompute end-to-end:
    //  1. Receive wire.body verbatim.
    //  2. Recompute keccak256(utf8(body)).
    //  3. Compare to signed.payloadHash.
    //  4. JSON.parse(body) for the application payload.
    const payload = { kind: 'invoice', amount: 100, currency: 'USDC' };
    const { wire } = await buildPublicEnvelope(wallet, payload);

    const recomputed = platformRecomputePublicHash(wire.body);
    expect(recomputed.toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );

    const parsedPayload: unknown = JSON.parse(wire.body);
    expect(parsedPayload).toEqual(payload);
  });

  test('pre-fix buggy encoding would diverge from Platform recompute', async () => {
    // Codifies "the bug is dead": the OLD code path emitted
    //   wire.body = bytesToHex(utf8(JSON.stringify(payload)))
    // which Sentinel would hash as
    //   keccak256(utf8(0x<hex string>))
    // — a different digest than the SDK signed. The CURRENT code
    // emits plaintext, so this assertion locks in the fix.
    const payload = { proof: 'we-fixed-it' };
    const { wire } = await buildPublicEnvelope(wallet, payload);

    const buggyBody =
      '0x' + Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
    const buggyDigest = keccak256(toUtf8Bytes(buggyBody));

    // 1. The current wire.body is NOT the buggy hex form.
    expect(wire.body).not.toBe(buggyBody);
    // 2. Hashing the buggy form via the Platform path does NOT match
    //    the signed payloadHash — i.e. that pre-fix wire would have
    //    been rejected with payload_hash_mismatch.
    expect(buggyDigest.toLowerCase()).not.toBe(
      wire.signed.payloadHash.toLowerCase(),
    );
    // 3. The current (fixed) wire.body DOES match.
    expect(platformRecomputePublicHash(wire.body).toLowerCase()).toBe(
      wire.signed.payloadHash.toLowerCase(),
    );
  });
});
