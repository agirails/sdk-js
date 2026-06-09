/**
 * AIP-16 Delivery Surface — X25519 Keys, ECDH, HKDF (Phase 2a Foundation)
 * ========================================================================
 *
 * Cryptographic primitives for the encrypted delivery scheme
 * (`x25519-aes256gcm-v1`) of AIP-16 Rev 5.
 *
 * This module is intentionally *primitive-level* — it deals only in
 * raw key material (Uint8Array), 0x-prefixed hex serialization, and
 * the three numbered steps of the ECDH+HKDF derivation:
 *
 *   1. Generate an ephemeral X25519 keypair.
 *   2. Combine the local secret with the peer's public key (ECDH on
 *      Curve25519, per RFC 7748) to produce a 32-byte shared secret.
 *   3. Stretch the shared secret to a 32-byte AES-256-GCM key via
 *      HKDF-SHA256 (RFC 5869), using the on-chain `txId` as the salt
 *      and `"agirails-delivery-v1"` as the info string.
 *
 * AEAD encryption itself, body framing, and EIP-712 signing live in
 * later phases (`crypto.ts`, `envelopeBuilder.ts`); this file is
 * deliberately small so it can be audited end-to-end.
 *
 * ## Library choice
 *
 * X25519 is implemented via `@noble/curves/ed25519` (audited, no
 * native deps, constant-time on supported runtimes). HKDF-SHA256 is
 * provided by Node's built-in `crypto.hkdfSync` — chosen over
 * `@noble/hashes` to minimize the new-dependency surface. Both choices
 * are deterministic and have no global state.
 *
 * ## Memory hygiene
 *
 * Private key material returned by `generateEphemeralKeyPair` is held
 * in plain `Uint8Array`s. The intent of "ephemeral" in AIP-16 is that
 * the caller derives the session key and then drops the reference to
 * the private key. Forward secrecy against compromise of long-term
 * provider/requester keys is provided by *fresh keypair per delivery*;
 * there is no key-rotation mechanism within a single delivery exchange.
 *
 * Callers SHOULD avoid logging `EphemeralKeyPair.privateKey` or any
 * value derived from it.
 *
 * ## What is NOT here
 *
 * - AES-256-GCM seal/open (later: `crypto.ts`).
 * - keccak256 hashing of body bytes (uses ethers in builders).
 * - EIP-712 signing (already in `eip712.ts`).
 * - Smart-wallet equality checks (later: verifier modules).
 *
 * @module delivery/keys
 * @see {@link https://www.rfc-editor.org/rfc/rfc7748 RFC 7748 — Elliptic Curves for Security (X25519)}
 * @see {@link https://www.rfc-editor.org/rfc/rfc5869 RFC 5869 — HKDF}
 * @see ./types — `DeliveryErrorCode` (crypto_* codes referenced here)
 * @see ./eip712 — EIP-712 domain & recovery (the *other* foundation module)
 */

import { hkdfSync } from 'node:crypto';

import { x25519 } from '@noble/curves/ed25519';

import type { DeliveryErrorCode } from './types';

// ============================================================================
// Constants
// ============================================================================

/**
 * Length (in bytes) of an X25519 public key. RFC 7748 §5.
 *
 * Both the buyer's `buyerEphemeralPubkey` field and the provider's
 * `providerEphemeralPubkey` field in the signed EIP-712 payloads carry
 * exactly this many bytes (encoded as `bytes32` in the typed-data
 * schema; X25519 keys happen to also be 32 bytes, which is why a
 * single `bytes32` slot fits).
 */
export const X25519_PUBLIC_KEY_LENGTH = 32 as const;

/**
 * Length (in bytes) of an X25519 private key (clamped scalar). RFC 7748 §5.
 *
 * Equal to {@link X25519_PUBLIC_KEY_LENGTH}, which is coincidence — the
 * scalar field of Curve25519 is 252 bits but is encoded into a 32-byte
 * little-endian field with the canonical clamping applied by
 * `@noble/curves`.
 */
export const X25519_PRIVATE_KEY_LENGTH = 32 as const;

/**
 * Length (in bytes) of the X25519 shared secret produced by ECDH.
 *
 * Per RFC 7748 the shared secret is the 32-byte little-endian encoding
 * of the resulting u-coordinate.
 */
export const X25519_SHARED_SECRET_LENGTH = 32 as const;

/**
 * Length (in bytes) of the session key derived from HKDF. Sized for
 * AES-256-GCM (the only AEAD scheme defined for `x25519-aes256gcm-v1`).
 */
export const DELIVERY_SESSION_KEY_LENGTH = 32 as const;

/**
 * Length (in bytes) of an on-chain `txId` (`bytes32`).
 *
 * The txId is used directly as the HKDF salt: it is high-entropy
 * (keccak256 of requester/provider/amount/serviceHash/nonce) and
 * unique per transaction, satisfying RFC 5869's salt recommendation
 * ("a non-secret random value, ideally hash-output length").
 */
export const TX_ID_BYTES = 32 as const;

/**
 * HKDF `info` string for v1 delivery session-key derivation.
 *
 * Per RFC 5869 the `info` parameter provides context binding so that
 * the same `(ikm, salt)` pair produces distinct keys for distinct
 * application contexts. Locking this string at v1 prevents accidental
 * key reuse with any future delivery scheme that lands in v2.
 *
 * Encoded as UTF-8 bytes when passed to `hkdfSync`.
 */
export const DELIVERY_HKDF_INFO_V1 = 'agirails-delivery-v1' as const;

// ============================================================================
// Error Class
// ============================================================================

/**
 * Error thrown by the delivery key primitives when key material or
 * ECDH/HKDF inputs are malformed, or when the derivation produces a
 * degenerate result (e.g. all-zero shared secret indicating a
 * low-order peer pubkey).
 *
 * Mirrors the `DeliveryEip712Error` pattern from `./eip712.ts` — a
 * plain `Error` subclass with a stable `code` field. The codes here
 * are drawn from the `crypto_*` subset of {@link DeliveryErrorCode}.
 *
 * The higher-level `ACTPError`-based delivery class is introduced
 * alongside the builders/verifiers in a later phase; for the
 * pre-builder foundation we keep the dependency surface minimal (no
 * `ACTPError` import, no `State` import).
 *
 * @example
 * ```typescript
 * try {
 *   const shared = deriveSharedSecret(myPriv, peerPub);
 * } catch (err) {
 *   if (err instanceof DeliveryCryptoError) {
 *     console.error(err.code, err.message, err.details);
 *   }
 *   throw err;
 * }
 * ```
 */
export class DeliveryCryptoError extends Error {
  /** Stable machine-actionable error code from the `crypto_*` subset. */
  public readonly code: DeliveryErrorCode;
  /** Optional structured details for debugging (expected/actual lengths, etc.). */
  public readonly details?: Record<string, unknown>;

  constructor(
    code: DeliveryErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeliveryCryptoError';
    this.code = code;
    this.details = details;
    // Restore prototype chain for `instanceof` after transpilation to ES5.
    Object.setPrototypeOf(this, DeliveryCryptoError.prototype);
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * A freshly generated X25519 ephemeral keypair.
 *
 * Returned by {@link generateEphemeralKeyPair}. Carries both the raw
 * 32-byte representations (for direct passing to ECDH) and the
 * canonical lowercase 0x-prefixed hex form of the public key (for
 * embedding into the EIP-712 signed projection as `bytes32`).
 *
 * The hex form is provided for the *public* key only; the private key
 * is intentionally NOT serialized to hex by the generator. Callers
 * that need to persist the private key (which AIP-16 does NOT
 * require — keypairs are ephemeral) must do so explicitly.
 */
export interface EphemeralKeyPair {
  /**
   * X25519 public key as 32 raw bytes.
   *
   * Equal to `pubkeyFromHex(publicKeyHex)` — the two forms are kept
   * in lock-step. Pass this to {@link deriveSharedSecret} (as the
   * peer's pubkey on the receiving side, or for self-verification on
   * the sending side).
   */
  publicKey: Uint8Array;

  /**
   * X25519 private (secret) scalar as 32 raw bytes.
   *
   * SECURITY: this value MUST NOT be logged, persisted to disk, or
   * transmitted across a process boundary. The recommended pattern is
   * to derive the shared secret + session key immediately after
   * generation and let the keypair go out of scope.
   */
  privateKey: Uint8Array;

  /**
   * Canonical 0x-prefixed lowercase hex form of `publicKey`, length 66
   * characters (`"0x" + 64`). Exactly the value to embed into the
   * `buyerEphemeralPubkey` or `providerEphemeralPubkey` field of the
   * signed EIP-712 projection.
   */
  publicKeyHex: `0x${string}`;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Hex alphabet for fast lowercase encoding without `.toLowerCase()` overhead. */
const HEX_CHARS = '0123456789abcdef';

/**
 * Encode raw bytes to a lowercase 0x-prefixed hex string.
 *
 * Hand-rolled rather than `Buffer.from(...).toString('hex')` to avoid
 * any subtle Buffer-vs-Uint8Array confusion (Buffer is a Node-only
 * subclass that overrides several typed-array methods). The output is
 * pure ASCII so there is no encoding ambiguity.
 *
 * @internal
 */
function bytesToHexLower(bytes: Uint8Array): string {
  let out = '0x';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number; // bounded by loop
    out += HEX_CHARS[(b >>> 4) & 0x0f];
    out += HEX_CHARS[b & 0x0f];
  }
  return out;
}

/**
 * Decode a 0x-prefixed hex string to raw bytes. Strict on shape: the
 * string MUST start with `0x` (or `0X`), MUST contain only hex digits
 * after the prefix, and MUST have an even number of hex digits.
 *
 * Throws {@link DeliveryCryptoError} with code `crypto_keygen_failed`
 * (the most-applicable existing code) for malformed input. The
 * specific failure reason is in the error `message` and `details`.
 *
 * @internal
 */
function hexToBytes(
  hex: string,
  ctx: { expectedLength: number; field: string },
): Uint8Array {
  if (typeof hex !== 'string') {
    throw new DeliveryCryptoError(
      'crypto_keygen_failed',
      `${ctx.field} must be a string, got ${typeof hex}`,
      { field: ctx.field, type: typeof hex },
    );
  }
  if (hex.length < 2 || (hex[0] !== '0' || (hex[1] !== 'x' && hex[1] !== 'X'))) {
    throw new DeliveryCryptoError(
      'crypto_keygen_failed',
      `${ctx.field} must start with 0x prefix`,
      { field: ctx.field, prefix: hex.slice(0, 4) },
    );
  }
  const body = hex.slice(2);
  if (body.length !== ctx.expectedLength * 2) {
    throw new DeliveryCryptoError(
      'crypto_keygen_failed',
      `${ctx.field} must be ${ctx.expectedLength * 2} hex chars after 0x (got ${body.length})`,
      { field: ctx.field, expectedHexChars: ctx.expectedLength * 2, actualHexChars: body.length },
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    throw new DeliveryCryptoError(
      'crypto_keygen_failed',
      `${ctx.field} contains non-hex characters`,
      { field: ctx.field },
    );
  }
  const out = new Uint8Array(ctx.expectedLength);
  for (let i = 0; i < ctx.expectedLength; i++) {
    const hi = parseInt(body[i * 2] as string, 16);
    const lo = parseInt(body[i * 2 + 1] as string, 16);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/**
 * Branded assertion that `value` is exactly `length` bytes long.
 * Throws {@link DeliveryCryptoError} with the supplied code on
 * mismatch. Used to guard the public ECDH/HKDF entry points.
 *
 * @internal
 */
function assertByteLength(
  value: Uint8Array,
  length: number,
  code: DeliveryErrorCode,
  field: string,
): void {
  if (!(value instanceof Uint8Array)) {
    throw new DeliveryCryptoError(
      code,
      `${field} must be a Uint8Array, got ${typeof value}`,
      { field, type: typeof value },
    );
  }
  if (value.length !== length) {
    throw new DeliveryCryptoError(
      code,
      `${field} must be exactly ${length} bytes (got ${value.length})`,
      { field, expectedLength: length, actualLength: value.length },
    );
  }
}

/**
 * Check whether a buffer is *entirely* zero. Used to detect degenerate
 * ECDH outputs (peer pubkey was a low-order Curve25519 point — all
 * such points map to the zero shared secret, allowing a malicious peer
 * to force a known key).
 *
 * Implemented as an OR-fold rather than `bytes.every(b => b === 0)` so
 * the JIT can hoist the loop; the constant-time properties of this
 * particular check are not security-critical (the secret would have
 * leaked regardless).
 *
 * @internal
 */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc |= bytes[i] as number;
  }
  return acc === 0;
}

// ============================================================================
// Public API: Key Generation
// ============================================================================

/**
 * Generate a fresh X25519 ephemeral keypair using the system CSPRNG
 * (via `@noble/curves`, which delegates to `crypto.getRandomValues` /
 * `node:crypto.randomBytes`).
 *
 * The returned pair is intended to live for a *single* delivery
 * exchange:
 *  - Buyer side: generated when constructing the `DeliverySetup`,
 *    public key embedded into `buyerEphemeralPubkey`, private key
 *    held in memory until the envelope arrives and is decrypted.
 *  - Provider side: generated when sealing the envelope, public key
 *    embedded into `providerEphemeralPubkey`, private key used to
 *    derive the shared secret and then dropped (forward secrecy w.r.t.
 *    long-term provider keys).
 *
 * @returns A new {@link EphemeralKeyPair}.
 * @throws {DeliveryCryptoError} `crypto_keygen_failed` if the
 *   underlying library returns key material of unexpected length
 *   (defensive — should never happen with `@noble/curves` on a
 *   conformant runtime).
 *
 * @example
 * ```typescript
 * const kp = generateEphemeralKeyPair();
 * // kp.publicKeyHex → "0x" + 64-hex-char ephemeral pubkey
 * // pass kp.publicKey to deriveSharedSecret(myPriv, theirPub) on the peer
 * ```
 */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  let secretKey: Uint8Array;
  let publicKey: Uint8Array;
  try {
    const generated = x25519.keygen();
    secretKey = generated.secretKey;
    publicKey = generated.publicKey;
  } catch (err) {
    throw new DeliveryCryptoError(
      'crypto_keygen_failed',
      `Underlying X25519 keygen failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  // Defensive length checks: @noble/curves SHOULD return 32-byte values,
  // but we guard so a regression in the library doesn't silently feed
  // malformed key material into ECDH downstream.
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== X25519_PUBLIC_KEY_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_keygen_failed',
      `X25519 keygen returned public key of unexpected length: ${publicKey?.length}`,
      { actualLength: publicKey?.length, expectedLength: X25519_PUBLIC_KEY_LENGTH },
    );
  }
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== X25519_PRIVATE_KEY_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_keygen_failed',
      `X25519 keygen returned private key of unexpected length: ${secretKey?.length}`,
      { actualLength: secretKey?.length, expectedLength: X25519_PRIVATE_KEY_LENGTH },
    );
  }

  return {
    publicKey,
    privateKey: secretKey,
    publicKeyHex: bytesToHexLower(publicKey) as `0x${string}`,
  };
}

// ============================================================================
// Public API: ECDH
// ============================================================================

/**
 * Compute the X25519 ECDH shared secret between a local private key
 * and a peer's public key.
 *
 * Per RFC 7748, the shared secret is `X25519(privateKey, peerPubkey)`
 * — the 32-byte little-endian encoding of the u-coordinate of the
 * scalar multiplication. Both inputs MUST be exactly 32 bytes;
 * X25519 itself accepts any 32-byte scalar (the canonical clamping
 * is applied internally by `@noble/curves`), but malformed lengths
 * indicate caller bugs.
 *
 * ## Low-order point check
 *
 * Curve25519 has a small set of "low-order" public keys for which
 * the ECDH output is the all-zero secret regardless of the local
 * private key. A peer that supplies a low-order pubkey can therefore
 * force a known shared secret. We detect this by rejecting all-zero
 * outputs with `crypto_shared_secret_failed`; the caller MUST treat
 * this as a peer-protocol violation, not a transient error.
 *
 * (See RFC 7748 §6.1, which notes that implementations "MAY" reject
 * such inputs; for AGIRAILS we MUST.)
 *
 * @param privateKey - Local X25519 private scalar, exactly 32 bytes.
 * @param peerPubkey - Peer's X25519 public key, exactly 32 bytes.
 * @returns The 32-byte shared secret (NOT the session key — see
 *   {@link deriveSessionKey} for the HKDF stretch).
 * @throws {DeliveryCryptoError} `crypto_shared_secret_failed` if
 *   either input is the wrong length, if `@noble/curves` raises, or
 *   if the resulting shared secret is all-zero (degenerate peer).
 *
 * @example
 * ```typescript
 * const shared = deriveSharedSecret(buyerPriv, providerPub);
 * const key = deriveSessionKey(shared, txId);
 * // → 32-byte AES-256-GCM key
 * ```
 */
export function deriveSharedSecret(
  privateKey: Uint8Array,
  peerPubkey: Uint8Array,
): Uint8Array {
  assertByteLength(
    privateKey,
    X25519_PRIVATE_KEY_LENGTH,
    'crypto_shared_secret_failed',
    'privateKey',
  );
  assertByteLength(
    peerPubkey,
    X25519_PUBLIC_KEY_LENGTH,
    'crypto_shared_secret_failed',
    'peerPubkey',
  );

  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateKey, peerPubkey);
  } catch (err) {
    throw new DeliveryCryptoError(
      'crypto_shared_secret_failed',
      `X25519 ECDH failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  if (!(shared instanceof Uint8Array) || shared.length !== X25519_SHARED_SECRET_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_shared_secret_failed',
      `X25519 ECDH returned unexpected length: ${shared?.length}`,
      { actualLength: shared?.length, expectedLength: X25519_SHARED_SECRET_LENGTH },
    );
  }

  if (isAllZero(shared)) {
    throw new DeliveryCryptoError(
      'crypto_shared_secret_failed',
      'X25519 ECDH produced an all-zero shared secret (peer pubkey is a ' +
        'low-order Curve25519 point). Treat the peer as malicious.',
      { peerPubkeyHex: bytesToHexLower(peerPubkey) },
    );
  }

  return shared;
}

// ============================================================================
// Public API: HKDF
// ============================================================================

/**
 * Stretch an X25519 shared secret into a 32-byte AES-256-GCM session
 * key via HKDF-SHA256 (RFC 5869).
 *
 * The derivation parameters are locked for AIP-16 v1:
 *  - `ikm`    = `sharedSecret` (32 bytes, output of {@link deriveSharedSecret})
 *  - `salt`   = `txId` (32 bytes, decoded from the 0x-prefixed hex form)
 *  - `info`   = `"agirails-delivery-v1"` UTF-8 by default (overridable
 *               for *testing only* via the optional `info` argument —
 *               production callers MUST use the default)
 *  - `digest` = SHA-256
 *  - `keylen` = 32 bytes
 *
 * Salting with the on-chain `txId` binds the session key to a
 * specific ACTP transaction. Even if two parties exchange the same
 * ephemeral keypairs across two different transactions (which would
 * itself be a protocol violation), the resulting session keys would
 * differ — limiting blast radius.
 *
 * ## Implementation choice: node:crypto
 *
 * We use Node's built-in `crypto.hkdfSync` rather than `@noble/hashes`
 * to keep the dependency surface minimal. The behavior is identical:
 * both implementations follow RFC 5869 step-for-step.
 *
 * Note that `hkdfSync` returns an `ArrayBuffer`; we wrap it in a
 * `Uint8Array` view for ergonomic interop with `@noble/curves` and
 * the rest of the SDK.
 *
 * @param sharedSecret - The 32-byte ECDH output from {@link deriveSharedSecret}.
 * @param txId - The on-chain transaction id (`bytes32`) as a 0x-prefixed
 *   lowercase hex string (66 chars total).
 * @param info - Optional info string override. Defaults to
 *   {@link DELIVERY_HKDF_INFO_V1}. Production callers MUST omit this
 *   argument; it exists solely so tests can assert that distinct
 *   info strings produce distinct keys (negative test).
 * @returns A 32-byte session key suitable for AES-256-GCM.
 * @throws {DeliveryCryptoError} `crypto_hkdf_failed` on length mismatch,
 *   malformed `txId`, or underlying `hkdfSync` failure.
 *
 * @example
 * ```typescript
 * const key = deriveSessionKey(shared, '0xabc…32bytes…');
 * // → 32-byte Uint8Array, ready for createCipheriv('aes-256-gcm', key, nonce)
 * ```
 */
export function deriveSessionKey(
  sharedSecret: Uint8Array,
  txId: `0x${string}`,
  info: string = DELIVERY_HKDF_INFO_V1,
): Uint8Array {
  assertByteLength(
    sharedSecret,
    X25519_SHARED_SECRET_LENGTH,
    'crypto_hkdf_failed',
    'sharedSecret',
  );

  // Decode txId to bytes for use as HKDF salt. Reusing hexToBytes
  // (with crypto_keygen_failed code) is unfortunate; we re-throw with
  // the correct crypto_hkdf_failed code so the caller can branch on
  // the *operation* that failed, not the helper that detected it.
  let salt: Uint8Array;
  try {
    salt = hexToBytes(txId, { expectedLength: TX_ID_BYTES, field: 'txId' });
  } catch (err) {
    throw new DeliveryCryptoError(
      'crypto_hkdf_failed',
      `txId is malformed: ${err instanceof Error ? err.message : String(err)}`,
      {
        txIdPreview: typeof txId === 'string' ? txId.slice(0, 12) : typeof txId,
        cause: err instanceof Error ? err.message : String(err),
      },
    );
  }

  if (typeof info !== 'string') {
    throw new DeliveryCryptoError(
      'crypto_hkdf_failed',
      `info must be a string, got ${typeof info}`,
      { type: typeof info },
    );
  }

  let derived: ArrayBuffer;
  try {
    // hkdfSync(digest, ikm, salt, info, keylen)
    derived = hkdfSync(
      'sha256',
      sharedSecret,
      salt,
      Buffer.from(info, 'utf8'),
      DELIVERY_SESSION_KEY_LENGTH,
    );
  } catch (err) {
    throw new DeliveryCryptoError(
      'crypto_hkdf_failed',
      `HKDF-SHA256 failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  const sessionKey = new Uint8Array(derived);
  if (sessionKey.length !== DELIVERY_SESSION_KEY_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_hkdf_failed',
      `HKDF returned unexpected length: ${sessionKey.length}`,
      {
        actualLength: sessionKey.length,
        expectedLength: DELIVERY_SESSION_KEY_LENGTH,
      },
    );
  }
  return sessionKey;
}

// ============================================================================
// Public API: Hex Format Helpers
// ============================================================================

/**
 * Serialize a 32-byte X25519 public key to its canonical 0x-prefixed
 * lowercase hex form.
 *
 * This is exactly the form embedded into the `bytes32` slots of the
 * signed EIP-712 payloads (`buyerEphemeralPubkey`,
 * `providerEphemeralPubkey`). The lowercase normalization ensures
 * that two SDKs producing the same key produce byte-identical hex
 * strings; the JSON serialization of the wire envelope then has
 * exactly one valid encoding, which is required for any downstream
 * `JSON.stringify` + hash anchoring.
 *
 * @param pubkey - X25519 public key, exactly 32 bytes.
 * @returns The 0x-prefixed lowercase hex form (66 chars).
 * @throws {DeliveryCryptoError} `crypto_keygen_failed` if `pubkey` is
 *   not a `Uint8Array` of length 32.
 *
 * @example
 * ```typescript
 * pubkeyToHex(new Uint8Array(32)); // "0x00...00" (32 zero bytes)
 * ```
 */
export function pubkeyToHex(pubkey: Uint8Array): `0x${string}` {
  assertByteLength(
    pubkey,
    X25519_PUBLIC_KEY_LENGTH,
    'crypto_keygen_failed',
    'pubkey',
  );
  return bytesToHexLower(pubkey) as `0x${string}`;
}

/**
 * Deserialize a 0x-prefixed hex string into a 32-byte X25519 public
 * key.
 *
 * Accepts both uppercase and lowercase hex digits in the input (for
 * resilience with legacy systems and Ethereum's mixed-case checksum
 * convention — though X25519 keys are NOT checksummed). The output is
 * always raw bytes; if you need the canonical hex form, call
 * `pubkeyToHex` on the result, which will be lowercase.
 *
 * @param hex - 0x-prefixed hex string, exactly 66 characters (`0x` +
 *   64 hex chars).
 * @returns The 32-byte X25519 public key.
 * @throws {DeliveryCryptoError} `crypto_keygen_failed` if `hex` is
 *   missing the `0x` prefix, the wrong length, or contains non-hex
 *   characters.
 *
 * @example
 * ```typescript
 * const bytes = pubkeyFromHex('0x' + 'ab'.repeat(32));
 * // → Uint8Array(32) [0xab, 0xab, …]
 * ```
 */
export function pubkeyFromHex(hex: string): Uint8Array {
  return hexToBytes(hex, {
    expectedLength: X25519_PUBLIC_KEY_LENGTH,
    field: 'pubkey hex',
  });
}
