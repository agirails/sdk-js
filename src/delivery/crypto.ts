/**
 * AIP-16 Delivery Surface — AES-256-GCM AEAD + Body Hashing (Phase 2a Foundation)
 * ==============================================================================
 *
 * Authenticated encryption primitives for the `x25519-aes256gcm-v1`
 * delivery scheme of AIP-16 Rev 5.
 *
 * This module sits one layer above `./keys.ts` (which produces the
 * 32-byte session key via X25519 ECDH + HKDF-SHA256) and one layer
 * below the envelope builders (`./envelopeBuilder.ts`, later phase),
 * which assemble the ciphertext + nonce + tag + signature into the
 * wire envelope.
 *
 * ## Scope of this file
 *
 * - {@link encryptBody}: seal a UTF-8 string or raw byte body with
 *   AES-256-GCM, returning ciphertext + 12-byte nonce + 16-byte tag.
 * - {@link decryptBody}: inverse — verify the GCM tag and return the
 *   plaintext.
 * - {@link bodyHash}: keccak256 of the UTF-8 / raw bytes, in the exact
 *   form used for the `payloadHash` field of the signed EIP-712
 *   projection.
 * - Hex format helpers ({@link bytesToHex}, {@link bytesFromHex}) for
 *   ciphertext / nonce / tag serialization at the wire boundary.
 *
 * ## Library choice: `node:crypto`
 *
 * We use Node's built-in AES-GCM (`createCipheriv('aes-256-gcm', …)`)
 * rather than `@noble/ciphers`. Reasons:
 *
 *  1. AES-256-GCM is a *standard* AEAD; the implementation surface is
 *     small and audited as part of OpenSSL (the engine behind
 *     `node:crypto`).
 *  2. Zero new dependencies — matches the design constraint in the
 *     Phase 2a task brief.
 *  3. The `setAuthTag` / `getAuthTag` pattern is mechanical and easy
 *     to audit for "did we actually verify the tag before returning
 *     plaintext?" (`decipher.final()` throws on tag mismatch).
 *
 * ## AAD (Additional Authenticated Data) — H5 defense-in-depth
 *
 * Both {@link encryptBody} and {@link decryptBody} accept an OPTIONAL
 * `aad` byte buffer. When supplied, the bytes are fed into GCM via
 * `cipher.setAAD(aad)` / `decipher.setAAD(aad)` — they are *not*
 * encrypted, but the GCM authentication tag commits to them, so a
 * decryption with the wrong AAD fails closed with a tag mismatch.
 *
 * For the `x25519-aes256gcm-v1` scheme the envelope builder constructs
 *
 *   aad = txId_bytes (32) || signerAddress_bytes (20)   // 52 bytes
 *
 * and passes it to both encrypt and decrypt. This binds the GCM
 * authentication to the on-chain transaction id and the EOA that
 * signed the envelope, so a misrouted envelope (correct ciphertext +
 * nonce + tag + sessionKey, but delivered to a different `txId` or
 * `signerAddress`) cannot be opened — defense-in-depth on top of the
 * EIP-712 signature over `txId` and `payloadHash`.
 *
 * Because the channel is gated behind the Phase 2f feature flag and
 * no in-flight `x25519-aes256gcm-v1` envelopes exist in production, we
 * change the AAD inline within the existing scheme tag rather than
 * minting a `-v2` suffix; the scheme name stays `x25519-aes256gcm-v1`.
 *
 * AAD is OPTIONAL at the primitive level. Callers that omit it get
 * the legacy "AAD = empty" behavior (still interoperable with prior
 * versions of the function). The envelope builder always supplies AAD.
 *
 * ## Memory hygiene
 *
 * `sessionKey` and plaintext are held in plain `Uint8Array`s. Like
 * `./keys.ts`, this module does not attempt to zero memory — V8 makes
 * no such guarantees, and the SDK target environments (Node + Bun)
 * inherit that limitation. Callers SHOULD let secrets go out of scope
 * promptly after use.
 *
 * @module delivery/crypto
 * @see ./keys — produces the 32-byte session key consumed here
 * @see ./eip712 — signs the `payloadHash` produced by {@link bodyHash}
 * @see {@link https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf NIST SP 800-38D — GCM mode}
 * @see {@link https://www.rfc-editor.org/rfc/rfc5116 RFC 5116 — AEAD interface}
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ethers } from 'ethers';

import { DeliveryCryptoError, DELIVERY_SESSION_KEY_LENGTH } from './keys';

// ============================================================================
// Constants
// ============================================================================

/**
 * Length (in bytes) of the AES-256-GCM nonce / IV.
 *
 * Twelve bytes is the GCM-standard length (NIST SP 800-38D §5.2.1.1).
 * Any other length is technically permitted by the spec but triggers
 * an additional GHASH step and is interoperable only by convention;
 * AIP-16 v1 mandates 12 bytes to keep the wire format unambiguous.
 *
 * We sample the nonce from `randomBytes(12)` per-encryption. The
 * 2^96 nonce space is more than adequate for the AIP-16 use case
 * (one nonce per delivery envelope per session key, with session keys
 * themselves bound to a single transaction via HKDF).
 */
export const AES_GCM_NONCE_LENGTH = 12 as const;

/**
 * Length (in bytes) of the AES-256-GCM authentication tag.
 *
 * Sixteen bytes is the maximum (full-strength) tag length permitted
 * by GCM; NIST SP 800-38D recommends this size when the application
 * cannot tolerate any forgery probability. The wire format reserves
 * a fixed 16-byte slot for the tag.
 */
export const AES_GCM_TAG_LENGTH = 16 as const;

/**
 * Length (in bytes) of an AES-256 key. Equal to
 * {@link DELIVERY_SESSION_KEY_LENGTH} (re-exported from `./keys`) so
 * callers do not have to import both files just for the length check.
 */
export const AES_KEY_LENGTH = DELIVERY_SESSION_KEY_LENGTH;

// ============================================================================
// Types
// ============================================================================

/**
 * Result of {@link encryptBody}.
 *
 * All three fields are raw bytes (not hex). The envelope builder will
 * apply {@link bytesToHex} just before serializing to the wire
 * envelope's `bodyCiphertextHex`, `nonceHex`, and `tagHex` fields.
 *
 * The separation of `ciphertext` and `tag` matches the `node:crypto`
 * GCM API surface (`getAuthTag` is a distinct call from the cipher's
 * `update` / `final` output). It also makes the wire format
 * unambiguous: there is no need to peel the last 16 bytes off the
 * ciphertext, which is a common parsing bug.
 */
export interface EncryptResult {
  /**
   * The AES-256-GCM ciphertext. Length is exactly equal to the
   * plaintext length (GCM is a stream-cipher mode, no padding).
   */
  ciphertext: Uint8Array;

  /**
   * The 12-byte random nonce / IV used for this encryption. Embedded
   * verbatim in the wire envelope so the recipient can pass it to
   * {@link decryptBody}.
   */
  nonce: Uint8Array;

  /**
   * The 16-byte GCM authentication tag. The recipient MUST present
   * this tag to AES-GCM during decryption; `decipher.final()` will
   * throw if it does not match, which {@link decryptBody} catches
   * and re-raises as `DeliveryCryptoError('crypto_decrypt_failed')`.
   */
  tag: Uint8Array;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Convert a `string | Uint8Array` plaintext to bytes. UTF-8 is the
 * canonical text encoding for AIP-16 envelope bodies; any other
 * encoding (UTF-16, Latin-1, …) MUST be transcoded to UTF-8 by the
 * caller before calling {@link encryptBody}.
 *
 * @internal
 */
function toBytes(value: string | Uint8Array, field: string): Uint8Array {
  if (typeof value === 'string') {
    return new Uint8Array(Buffer.from(value, 'utf8'));
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new DeliveryCryptoError(
    'crypto_encrypt_failed',
    `${field} must be a string or Uint8Array, got ${typeof value}`,
    { field, type: typeof value },
  );
}

/**
 * Hex alphabet for the lowercase no-Buffer hex encoder. Kept in lock-
 * step with `./keys.ts` so both files produce byte-identical output.
 *
 * @internal
 */
const HEX_CHARS = '0123456789abcdef';

// ============================================================================
// Public API: AES-256-GCM
// ============================================================================

/**
 * Encrypt a delivery envelope body with AES-256-GCM using the supplied
 * session key.
 *
 * The session key MUST have been produced by
 * {@link import('./keys').deriveSessionKey} (32 bytes, HKDF-SHA256
 * output bound to the on-chain `txId`).
 *
 * A fresh 12-byte nonce is sampled from `randomBytes` per call.
 * Re-using a (key, nonce) pair is *catastrophic* for GCM — it leaks
 * the GHASH key, allowing both decryption of past messages and
 * forgery of future ones. With session keys scoped to one transaction
 * and nonces randomized per envelope, the probability of collision
 * over realistic envelope counts is negligible.
 *
 * AAD is OPTIONAL. When supplied, the bytes are committed by the GCM
 * tag (defense-in-depth — see the H5 section of the module-level docs).
 * Decryption with a different AAD (or with no AAD at all when the
 * encrypt side used one) will fail with `crypto_decrypt_failed`.
 *
 * @param plaintext - Body bytes to encrypt. A `string` is interpreted
 *   as UTF-8; pre-encoded `Uint8Array` is passed through verbatim.
 * @param sessionKey - 32-byte AES-256-GCM key from `deriveSessionKey`.
 * @param aad - Optional Additional Authenticated Data. When omitted,
 *   no AAD is fed into GCM (legacy behavior). When supplied, MUST be a
 *   `Uint8Array`; mismatched AAD at decrypt time fails tag verification.
 * @returns {@link EncryptResult} carrying ciphertext, nonce, and tag.
 * @throws {DeliveryCryptoError} `crypto_encrypt_failed` if
 *   `sessionKey` is malformed (not a `Uint8Array` of length 32), if
 *   `plaintext` is the wrong type, if `aad` is supplied as a non-bytes
 *   value, or if `node:crypto` raises.
 *
 * @example
 * ```typescript
 * const key = deriveSessionKey(shared, txId);
 * // AAD = txId_bytes || signerAddress_bytes (H5 binding)
 * const aad = new Uint8Array(52);
 * aad.set(bytesFromHex(txId), 0);
 * aad.set(bytesFromHex(signerAddress), 32);
 * const { ciphertext, nonce, tag } = encryptBody('{"result":"ok"}', key, aad);
 * ```
 */
export function encryptBody(
  plaintext: Uint8Array | string,
  sessionKey: Uint8Array,
  aad?: Uint8Array,
): EncryptResult {
  // ── Validate session key shape ──────────────────────────────────
  if (!(sessionKey instanceof Uint8Array)) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `sessionKey must be a Uint8Array, got ${typeof sessionKey}`,
      { field: 'sessionKey', type: typeof sessionKey },
    );
  }
  if (sessionKey.length !== AES_KEY_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `sessionKey must be exactly ${AES_KEY_LENGTH} bytes (got ${sessionKey.length})`,
      {
        field: 'sessionKey',
        expectedLength: AES_KEY_LENGTH,
        actualLength: sessionKey.length,
      },
    );
  }

  // ── Validate AAD shape (if provided) ────────────────────────────
  //
  // We accept either `undefined` (no-AAD legacy behavior) or a
  // `Uint8Array` (any length, including zero). Anything else is a
  // caller bug and surfaces as `crypto_encrypt_failed` so it fails
  // closed at the encrypt boundary rather than producing an envelope
  // the buyer cannot open.
  if (aad !== undefined && !(aad instanceof Uint8Array)) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `aad must be a Uint8Array when supplied, got ${typeof aad}`,
      { field: 'aad', type: typeof aad },
    );
  }

  // ── Coerce plaintext to bytes ───────────────────────────────────
  const ptBytes = toBytes(plaintext, 'plaintext');

  // ── Sample a fresh 12-byte nonce ────────────────────────────────
  let nonce: Uint8Array;
  try {
    nonce = new Uint8Array(randomBytes(AES_GCM_NONCE_LENGTH));
  } catch (err) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `randomBytes(${AES_GCM_NONCE_LENGTH}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  // ── Encrypt ─────────────────────────────────────────────────────
  let ciphertext: Uint8Array;
  let tag: Uint8Array;
  try {
    const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce, {
      authTagLength: AES_GCM_TAG_LENGTH,
    });
    // H5 binding: when AAD is supplied, feed it into GCM BEFORE any
    // ciphertext bytes are produced. AAD is authenticated but not
    // encrypted — the tag will only verify on decrypt if the same AAD
    // is presented. `setAAD` MUST be called before `update` per the
    // node:crypto contract (the underlying OpenSSL state machine
    // forbids AAD after ciphertext input).
    if (aad !== undefined) {
      cipher.setAAD(aad);
    }
    const part1 = cipher.update(ptBytes);
    const part2 = cipher.final();
    // Concatenate as a single Uint8Array. `Buffer.concat` returns a
    // Buffer (subclass of Uint8Array); we wrap to a plain Uint8Array
    // view to avoid leaking the Buffer subclass to consumers, which
    // matters for downstream `instanceof Uint8Array` checks across
    // realms / workers.
    const combined = Buffer.concat([part1, part2]);
    ciphertext = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
    const rawTag = cipher.getAuthTag();
    tag = new Uint8Array(rawTag.buffer, rawTag.byteOffset, rawTag.byteLength);
  } catch (err) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `AES-256-GCM encryption failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  // ── Defensive length checks (paranoia) ──────────────────────────
  if (tag.length !== AES_GCM_TAG_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `GCM authentication tag has unexpected length: ${tag.length}`,
      { expectedLength: AES_GCM_TAG_LENGTH, actualLength: tag.length },
    );
  }
  if (nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `GCM nonce has unexpected length: ${nonce.length}`,
      { expectedLength: AES_GCM_NONCE_LENGTH, actualLength: nonce.length },
    );
  }

  return { ciphertext, nonce, tag };
}

/**
 * Decrypt and authenticate an AES-256-GCM ciphertext produced by
 * {@link encryptBody} (or an interoperable peer).
 *
 * The GCM authentication tag is verified inside `decipher.final()` —
 * if the tag does not match, `node:crypto` throws and we re-raise as
 * `DeliveryCryptoError('crypto_decrypt_failed')`. This is the *only*
 * integrity check on the envelope body bytes; pair it with EIP-712
 * signature verification one layer up to also bind the body to a
 * specific signer.
 *
 * AAD is OPTIONAL but MUST match what the encrypt side used. The GCM
 * tag commits to the AAD bytes; supplying the wrong AAD (or omitting
 * AAD when the encrypt side supplied one, or vice versa) produces a
 * tag-mismatch error, surfaced here as `crypto_decrypt_failed`. This
 * is the H5 misrouting defense — see the module-level AAD section.
 *
 * @param ciphertext - GCM ciphertext as raw bytes.
 * @param sessionKey - 32-byte AES-256-GCM key (same as encrypt side).
 * @param nonce - 12-byte nonce that was used at encrypt time.
 * @param tag - 16-byte GCM authentication tag.
 * @param aad - Optional Additional Authenticated Data. MUST exactly
 *   match the AAD passed to {@link encryptBody}; mismatch (including
 *   AAD/no-AAD asymmetry) fails the tag check and throws
 *   `crypto_decrypt_failed`.
 * @returns The decrypted plaintext as raw bytes. If the original
 *   plaintext was a UTF-8 string, the caller can recover it via
 *   `Buffer.from(plaintext).toString('utf8')`.
 * @throws {DeliveryCryptoError} `crypto_decrypt_failed` on any of:
 *   malformed lengths, wrong session key, tampered ciphertext / tag /
 *   nonce, AAD mismatch, malformed AAD type, or underlying
 *   `node:crypto` failure.
 *
 * @example
 * ```typescript
 * const aad = new Uint8Array(52);
 * aad.set(bytesFromHex(txId), 0);
 * aad.set(bytesFromHex(signerAddress), 32);
 * const plaintextBytes = decryptBody(ciphertext, key, nonce, tag, aad);
 * const json = Buffer.from(plaintextBytes).toString('utf8');
 * ```
 */
export function decryptBody(
  ciphertext: Uint8Array,
  sessionKey: Uint8Array,
  nonce: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  // ── Validate all four inputs up-front ───────────────────────────
  if (!(ciphertext instanceof Uint8Array)) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `ciphertext must be a Uint8Array, got ${typeof ciphertext}`,
      { field: 'ciphertext', type: typeof ciphertext },
    );
  }
  if (!(sessionKey instanceof Uint8Array) || sessionKey.length !== AES_KEY_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `sessionKey must be a Uint8Array of exactly ${AES_KEY_LENGTH} bytes (got ${
        sessionKey instanceof Uint8Array ? sessionKey.length : typeof sessionKey
      })`,
      {
        field: 'sessionKey',
        expectedLength: AES_KEY_LENGTH,
        actualLength: sessionKey instanceof Uint8Array ? sessionKey.length : null,
      },
    );
  }
  if (!(nonce instanceof Uint8Array) || nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `nonce must be a Uint8Array of exactly ${AES_GCM_NONCE_LENGTH} bytes (got ${
        nonce instanceof Uint8Array ? nonce.length : typeof nonce
      })`,
      {
        field: 'nonce',
        expectedLength: AES_GCM_NONCE_LENGTH,
        actualLength: nonce instanceof Uint8Array ? nonce.length : null,
      },
    );
  }
  if (!(tag instanceof Uint8Array) || tag.length !== AES_GCM_TAG_LENGTH) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `tag must be a Uint8Array of exactly ${AES_GCM_TAG_LENGTH} bytes (got ${
        tag instanceof Uint8Array ? tag.length : typeof tag
      })`,
      {
        field: 'tag',
        expectedLength: AES_GCM_TAG_LENGTH,
        actualLength: tag instanceof Uint8Array ? tag.length : null,
      },
    );
  }
  if (aad !== undefined && !(aad instanceof Uint8Array)) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `aad must be a Uint8Array when supplied, got ${typeof aad}`,
      { field: 'aad', type: typeof aad },
    );
  }

  // ── Decrypt ─────────────────────────────────────────────────────
  try {
    const decipher = createDecipheriv('aes-256-gcm', sessionKey, nonce, {
      authTagLength: AES_GCM_TAG_LENGTH,
    });
    decipher.setAuthTag(tag);
    // H5 binding: AAD MUST be supplied to setAAD before any ciphertext
    // is fed in (node:crypto / OpenSSL contract). If the encrypt side
    // used AAD and we omit it here, the tag will fail to verify in
    // `final()`. If the encrypt side used no AAD and we supply one
    // here, same outcome — symmetric failure, fail-closed.
    if (aad !== undefined) {
      decipher.setAAD(aad);
    }
    const part1 = decipher.update(ciphertext);
    // `final()` throws if the GCM tag doesn't authenticate. This is
    // the integrity check; anything that reaches the assignment
    // below has been authenticated under (sessionKey, nonce, tag).
    const part2 = decipher.final();
    const combined = Buffer.concat([part1, part2]);
    return new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
  } catch (err) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `AES-256-GCM decryption / authentication failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

// ============================================================================
// Public API: keccak256 body hash
// ============================================================================

/**
 * Compute the keccak256 hash of an envelope body, in the exact form
 * embedded into the `payloadHash` field of the signed EIP-712
 * projection.
 *
 * Per AIP-16 Rev 5 §6.2, `payloadHash = keccak256(bodyBytes)` where
 * `bodyBytes` is:
 *  - For `scheme: "public-v1"`: the UTF-8 bytes of the plaintext body
 *    string (or the raw `Uint8Array` if the caller pre-encoded).
 *  - For `scheme: "x25519-aes256gcm-v1"`: the *ciphertext* bytes (the
 *    output of {@link encryptBody}.ciphertext), not the plaintext.
 *    This commits the signer to the exact bytes that travel on the
 *    wire, preventing a malicious relay from substituting alternative
 *    ciphertext with the same plaintext (which GCM nonces would
 *    actually preclude, but the EIP-712 commitment is independent of
 *    that).
 *
 * The output is a 0x-prefixed lowercase 66-char hex string (32-byte
 * keccak256 digest), exactly matching the `bytes32` field shape in
 * the EIP-712 types.
 *
 * @param body - The bytes to hash. A `string` is interpreted as UTF-8.
 * @returns The keccak256 digest as `0x` + 64 lowercase hex chars.
 *
 * @example
 * ```typescript
 * // Public scheme:
 * const h1 = bodyHash('{"result":"ok"}');
 *
 * // Encrypted scheme — hash the CIPHERTEXT, not the plaintext:
 * const { ciphertext } = encryptBody(plaintext, key);
 * const h2 = bodyHash(ciphertext);
 * ```
 */
export function bodyHash(body: string | Uint8Array): `0x${string}` {
  const bytes = toBytes(body, 'body');
  // ethers.keccak256 accepts `BytesLike`; a Uint8Array is one of the
  // accepted forms. The return value is already a 0x-prefixed
  // lowercase hex string of length 66.
  const digest = ethers.keccak256(bytes);
  return digest as `0x${string}`;
}

// ============================================================================
// Public API: Hex format helpers
// ============================================================================

/**
 * Encode raw bytes to a lowercase 0x-prefixed hex string.
 *
 * Intentionally byte-for-byte equivalent to the equivalent helper in
 * `./keys.ts` (which is `internal` there). Exposed here at the
 * module surface so envelope-builder callers can serialize their
 * ciphertext / nonce / tag without reaching into `./keys.ts` internals.
 *
 * Hand-rolled rather than `Buffer.from(b).toString('hex')` so the
 * implementation is portable to non-Node runtimes (Bun, web) without
 * polyfills, and to avoid Buffer-vs-Uint8Array subclass confusion.
 *
 * @param b - Raw bytes to encode.
 * @returns A `0x`-prefixed lowercase hex string of length
 *   `2 + 2 * b.length`.
 *
 * @example
 * ```typescript
 * bytesToHex(new Uint8Array([0xab, 0xcd])); // "0xabcd"
 * ```
 */
export function bytesToHex(b: Uint8Array): `0x${string}` {
  if (!(b instanceof Uint8Array)) {
    throw new DeliveryCryptoError(
      'crypto_encrypt_failed',
      `bytesToHex expected Uint8Array, got ${typeof b}`,
      { type: typeof b },
    );
  }
  let out = '0x';
  for (let i = 0; i < b.length; i++) {
    const byte = b[i] as number;
    out += HEX_CHARS[(byte >>> 4) & 0x0f];
    out += HEX_CHARS[byte & 0x0f];
  }
  return out as `0x${string}`;
}

/**
 * Decode a 0x-prefixed hex string to raw bytes.
 *
 * Strict on shape: the string MUST start with `0x` (case-insensitive
 * prefix), MUST contain only hex digits after the prefix, and MUST
 * have an even number of hex digits. Returns a fresh `Uint8Array`.
 *
 * Used at the wire boundary to decode `bodyCiphertextHex`, `nonceHex`,
 * `tagHex`, and any other hex-serialized byte field into the byte
 * forms expected by {@link decryptBody}.
 *
 * @param hex - 0x-prefixed hex string, even number of hex digits.
 * @returns A fresh `Uint8Array` of length `(hex.length - 2) / 2`.
 * @throws {DeliveryCryptoError} `crypto_decrypt_failed` if `hex` is
 *   missing the `0x` prefix, has odd length, or contains non-hex
 *   characters. (`crypto_decrypt_failed` is the most likely site of
 *   failure for this helper; encrypt-side callers will instead get
 *   the structural validation in {@link encryptBody}.)
 *
 * @example
 * ```typescript
 * bytesFromHex('0xabcd'); // Uint8Array(2) [0xab, 0xcd]
 * ```
 */
export function bytesFromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `bytesFromHex expected string, got ${typeof hex}`,
      { type: typeof hex },
    );
  }
  if (
    hex.length < 2 ||
    hex[0] !== '0' ||
    (hex[1] !== 'x' && hex[1] !== 'X')
  ) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      'bytesFromHex requires a 0x-prefixed string',
      { prefix: hex.slice(0, 4) },
    );
  }
  const body = hex.slice(2);
  if (body.length % 2 !== 0) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      `bytesFromHex requires an even number of hex digits (got ${body.length})`,
      { hexChars: body.length },
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    throw new DeliveryCryptoError(
      'crypto_decrypt_failed',
      'bytesFromHex received non-hex characters after the 0x prefix',
      {},
    );
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(body[i * 2] as string, 16);
    const lo = parseInt(body[i * 2 + 1] as string, 16);
    out[i] = (hi << 4) | lo;
  }
  return out;
}
