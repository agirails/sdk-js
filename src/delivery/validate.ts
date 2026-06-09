/**
 * AIP-16 Delivery Surface — Runtime Validation (Phase 2a)
 * ========================================================
 *
 * Pure, dependency-light runtime validators for the delivery surface
 * wire and signed shapes. Used by:
 *
 *  - Buyer SDK when receiving a {@link DeliveryEnvelopeWireV1} from the
 *    relay, before signature recovery and decryption.
 *  - Provider SDK when receiving a {@link DeliverySetupWireV1} from the
 *    relay, before signature recovery and ECDH key derivation.
 *  - Server-side Platform routes that accept these objects over HTTP
 *    (mirrored in Phase 2c so client and server share the same
 *    validation contract — defense-in-depth against a malicious peer
 *    or a buggy/older client).
 *
 * Design notes:
 *
 *  - Validators are PURE — they do not throw, do not perform I/O, do
 *    not consult network state. They return a discriminated
 *    {@link ValidationResult} so callers can branch cleanly.
 *
 *  - On the first failure the validator returns; we do NOT accumulate
 *    error lists. The first structural defect makes downstream checks
 *    meaningless and the order in which we check is deliberately
 *    coarse → fine (top-level shape, then individual fields, then
 *    cross-field invariants).
 *
 *  - The error string is a stable, machine-actionable identifier
 *    (snake_case, no message punctuation). Higher layers map it to a
 *    {@link DeliveryErrorCode} when they want a structured error.
 *
 *  - Field order in {@link DeliverySetupSignedV1} and
 *    {@link DeliveryEnvelopeSignedV1} is part of the EIP-712 type hash
 *    and therefore part of the cross-SDK contract. The validators here
 *    do NOT enforce order (it cannot be enforced on a parsed
 *    JavaScript object), but they DO enforce the *presence and type*
 *    of every field — which is sufficient to guarantee that signature
 *    recovery has a well-formed input.
 *
 *  - Canonical-empty rule: for `scheme: "public-v1"`, the
 *    encryption-related slots (`providerEphemeralPubkey`, `nonce`,
 *    `tag`) MUST be the canonical zero-filled values of the correct
 *    length — NOT omitted, NOT non-zero. This is enforced by
 *    {@link validateSchemeConsistency} after the per-field validators
 *    pass.
 *
 * @module delivery/validate
 * @see ./types — the underlying signed/wire interfaces
 * @see ./eip712 — domain + signed-type schemas (kept in lock-step)
 */

import { isAddress } from 'ethers';

import {
  CANONICAL_EMPTY_BYTES12,
  CANONICAL_EMPTY_BYTES16,
  CANONICAL_EMPTY_BYTES32,
  type DeliveryEnvelopeSignedV1,
  type DeliveryEnvelopeWireV1,
  type DeliveryPrivacy,
  type DeliveryScheme,
  type DeliverySetupSignedV1,
  type DeliverySetupWireV1,
  type ParticipantRole,
} from './types';

// ============================================================================
// Result Type
// ============================================================================

/**
 * Discriminated-union result of every validator in this module.
 *
 * - `{ ok: true }` — the object satisfies all structural and field-level
 *   invariants enforced here. The caller MAY proceed to signature
 *   recovery, smart-wallet auth, decryption, etc.
 *
 * - `{ ok: false, error }` — the object failed at least one invariant.
 *   `error` is a stable snake_case identifier suitable for logging,
 *   metric labels, and mapping to a {@link DeliveryErrorCode}.
 *
 * Errors are surfaced as VALUES (not exceptions) because every call
 * site here is hot-path validation of untrusted input from the relay
 * or a peer SDK — throwing would force every caller into a try/catch
 * just to branch on a boolean.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

// ============================================================================
// Internal Constants
// ============================================================================
//
// Hex regexes here are intentionally compiled once at module scope (not
// per-call) — they are exercised on every inbound wire object, and the
// per-call regex cost would otherwise be a measurable share of the
// validation budget.
//
// We accept BOTH cases of A-F in the hex body so that callers using
// checksum-cased addresses or mixed-case bytes32 (e.g. straight from
// `ethers.hexlify`, which currently lowercases but may not always)
// are not punished by this layer. The signed types canonicalize
// addresses to lowercase later, before signature recovery.

const BYTES32_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const BYTES16_HEX_RE = /^0x[0-9a-fA-F]{32}$/;
const BYTES12_HEX_RE = /^0x[0-9a-fA-F]{24}$/;
const UINT_STRING_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Allowed delivery schemes (kept in lock-step with {@link DeliveryScheme}).
 * Exported as a tuple-cast Set so adding a new scheme is a single
 * source-of-truth edit visible to all validators.
 */
const ALLOWED_SCHEMES: ReadonlySet<DeliveryScheme> = new Set<DeliveryScheme>([
  'x25519-aes256gcm-v1',
  'public-v1',
]);

/**
 * Allowed expected-privacy values (kept in lock-step with
 * {@link DeliveryPrivacy}).
 */
const ALLOWED_PRIVACY: ReadonlySet<DeliveryPrivacy> = new Set<DeliveryPrivacy>([
  'encrypted',
  'public',
]);

/**
 * Allowed participant role tokens (kept in lock-step with
 * {@link ParticipantRole}).
 */
const ALLOWED_ROLES: ReadonlySet<ParticipantRole> = new Set<ParticipantRole>([
  'provider',
  'requester',
]);

/**
 * Lowercased canonical-empty hex strings, computed once at module load
 * so comparisons in {@link validateSchemeConsistency} are a fast string
 * equality on already-normalized values.
 */
const CANONICAL_EMPTY_BYTES32_LC = CANONICAL_EMPTY_BYTES32.toLowerCase();
const CANONICAL_EMPTY_BYTES12_LC = CANONICAL_EMPTY_BYTES12.toLowerCase();
const CANONICAL_EMPTY_BYTES16_LC = CANONICAL_EMPTY_BYTES16.toLowerCase();

/**
 * Maximum reasonable `acceptedChannels` array length. The v1 channel
 * registry has exactly one entry (`agirails-relay-v1`); we accept up
 * to 32 to leave room for future channels without making the cap a
 * forwards-compat hazard, but reject obviously-pathological lists
 * that could be used to inflate signed-payload size.
 */
const MAX_ACCEPTED_CHANNELS = 32;

/**
 * Maximum reasonable length of a single channel identifier string.
 * The v1 identifier `agirails-relay-v1` is 17 chars; a 256-char cap
 * provides ample room for namespaced future identifiers (e.g.
 * `libp2p://Qm…`) while preventing memory amplification attacks.
 */
const MAX_CHANNEL_ID_LENGTH = 256;

// ============================================================================
// Primitive Validators
// ============================================================================

/**
 * True iff `s` is a string of exactly `0x` + 64 hex characters
 * (case-insensitive), i.e. a well-formed `bytes32` hex value.
 *
 * Does NOT enforce lowercase — both lower and upper hex digits are
 * accepted. Higher layers (signature recovery, canonical-empty
 * checks) are responsible for case normalization where it matters.
 */
export function isValidBytes32(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && BYTES32_HEX_RE.test(s);
}

/**
 * True iff `s` is a string of exactly `0x` + 24 hex characters
 * (case-insensitive), i.e. a well-formed `bytes12` value — the
 * AES-GCM nonce length.
 */
export function isValidBytes12(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && BYTES12_HEX_RE.test(s);
}

/**
 * True iff `s` is a string of exactly `0x` + 32 hex characters
 * (case-insensitive), i.e. a well-formed `bytes16` value — the
 * AES-GCM authentication tag length.
 */
export function isValidBytes16(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && BYTES16_HEX_RE.test(s);
}

/**
 * True iff `s` is a string that `ethers.isAddress` accepts as an EVM
 * address. Accepts both lowercase and EIP-55 mixed-case checksummed
 * addresses. `ethers.isAddress` returns false on invalid checksums,
 * so a mixed-case address whose case is wrong is rejected here too —
 * which is the intended behaviour.
 *
 * NOTE: We do NOT enforce a particular case at this layer; callers
 * that need canonical (lowercase) comparison MUST `.toLowerCase()`
 * both sides themselves, per the repo-wide convention.
 */
export function isValidAddress(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && isAddress(s);
}

/**
 * True iff `s` is a decimal-string representation of a non-negative
 * integer with no leading zeros (other than the literal `"0"`).
 *
 * Exists for forward-compat with future receipts-style integer
 * fields that must round-trip across JSON without losing precision
 * (JavaScript numbers cannot represent uint256 values).
 */
export function isValidUintString(s: unknown): boolean {
  return typeof s === 'string' && UINT_STRING_RE.test(s);
}

/**
 * True iff `s` is one of the {@link DeliveryScheme} discriminants.
 * Type guard so downstream code can branch on `scheme` with
 * exhaustiveness.
 */
export function isValidScheme(s: unknown): s is DeliveryScheme {
  return typeof s === 'string' && ALLOWED_SCHEMES.has(s as DeliveryScheme);
}

/**
 * True iff `s` is one of the {@link DeliveryPrivacy} discriminants.
 */
export function isValidPrivacy(s: unknown): s is DeliveryPrivacy {
  return typeof s === 'string' && ALLOWED_PRIVACY.has(s as DeliveryPrivacy);
}

/**
 * True iff `s` is one of the {@link ParticipantRole} discriminants.
 */
export function isValidRole(s: unknown): s is ParticipantRole {
  return typeof s === 'string' && ALLOWED_ROLES.has(s as ParticipantRole);
}

// ============================================================================
// Canonical-Empty Checks
// ============================================================================

/**
 * True iff `s` is the canonical empty bytes32 value (32 zero bytes,
 * hex-encoded). Comparison is case-insensitive — the canonical form
 * itself is all-zero so case is moot, but accepting `0x0000…` and
 * `0x0000…` (uppercase X is not valid per regex) consistently is
 * cheapest with a single `.toLowerCase()`.
 *
 * Used by {@link validateSchemeConsistency} to enforce the
 * `public-v1` canonical-empty rule on `providerEphemeralPubkey`
 * and (in setups) `buyerEphemeralPubkey`.
 */
export function isCanonicalEmptyBytes32(s: string): boolean {
  return typeof s === 'string' && s.toLowerCase() === CANONICAL_EMPTY_BYTES32_LC;
}

/**
 * True iff `s` is the canonical empty bytes12 value (12 zero bytes,
 * hex-encoded). Used to enforce the `public-v1` canonical-empty rule
 * on the AES-GCM `nonce` slot.
 */
export function isCanonicalEmptyBytes12(s: string): boolean {
  return typeof s === 'string' && s.toLowerCase() === CANONICAL_EMPTY_BYTES12_LC;
}

/**
 * True iff `s` is the canonical empty bytes16 value (16 zero bytes,
 * hex-encoded). Used to enforce the `public-v1` canonical-empty rule
 * on the AES-GCM authentication `tag` slot.
 */
export function isCanonicalEmptyBytes16(s: string): boolean {
  return typeof s === 'string' && s.toLowerCase() === CANONICAL_EMPTY_BYTES16_LC;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Convenience: type guard for non-null objects. Narrows `unknown` to
 * a record we can index into without TS complaining. Excludes arrays
 * because arrays are objects-with-numeric-keys and would otherwise
 * pass through this guard misleadingly.
 */
function isObjectLike(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * True iff `n` is a finite integer (no NaN, no Infinity, no
 * fractional component) AND strictly positive (Unix-seconds timestamps
 * are always > 0 in our era).
 */
function isPositiveInteger(n: unknown): n is number {
  return (
    typeof n === 'number' &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n > 0
  );
}

/**
 * True iff `arr` is a non-empty array of non-empty strings, each at
 * most {@link MAX_CHANNEL_ID_LENGTH} characters, with at most
 * {@link MAX_ACCEPTED_CHANNELS} entries.
 *
 * The length caps are not part of the AIP-16 spec; they are local
 * structural-validation guards against pathological inputs that
 * could inflate the signed-payload size or the cost of downstream
 * processing.
 */
function isValidAcceptedChannels(arr: unknown): arr is string[] {
  if (!Array.isArray(arr)) {
    return false;
  }
  if (arr.length === 0 || arr.length > MAX_ACCEPTED_CHANNELS) {
    return false;
  }
  for (const c of arr) {
    if (typeof c !== 'string') {
      return false;
    }
    if (c.length === 0 || c.length > MAX_CHANNEL_ID_LENGTH) {
      return false;
    }
  }
  return true;
}

/**
 * Build a failure result with the given error identifier. Tiny
 * helper that exists so call sites read as a single expression.
 */
function fail(error: string): ValidationResult {
  return { ok: false, error };
}

/**
 * Singleton success result reused across all validators — these
 * objects are immutable from this module's perspective and reusing
 * a single instance eliminates allocation on the common (valid) path.
 */
const OK: ValidationResult = { ok: true };

// ============================================================================
// Setup Signed Validator
// ============================================================================

/**
 * Validate a {@link DeliverySetupSignedV1} object's structure and
 * field-level invariants.
 *
 * Checks performed (in order):
 *
 *  1. Top-level shape is a non-null object.
 *  2. `version === 1` exactly (integer-equal, not string-equal).
 *  3. `txId` is a well-formed bytes32 hex string.
 *  4. `chainId` is a positive integer.
 *  5. `kernelAddress`, `requesterAddress`, `signerAddress` are valid
 *     EVM addresses (case-insensitive per `ethers.isAddress`).
 *  6. `buyerEphemeralPubkey` is a well-formed bytes32 hex string.
 *  7. `acceptedChannels` is a non-empty bounded array of non-empty
 *     bounded strings.
 *  8. `expectedPrivacy` is one of the {@link DeliveryPrivacy} values.
 *  9. `createdAt`, `expiresAt` are positive integers (Unix seconds).
 * 10. `expiresAt > createdAt` (cross-field).
 *
 * Does NOT verify the signature, the chainId↔network mapping, the
 * smart-wallet derivation, the kernel allowlist, or the canonical-
 * empty rule for `buyerEphemeralPubkey` against `expectedPrivacy` —
 * those are the responsibility of higher layers (signature recovery,
 * verifier modules, scheme-consistency in {@link validateSchemeConsistency}
 * for envelopes; setup-side privacy/pubkey consistency is enforced
 * by the setup verifier in Phase 2b).
 *
 * @param obj — value of `unknown` static type (validated at runtime).
 * @returns {@link ValidationResult}.
 */
export function validateSetupSigned(obj: unknown): ValidationResult {
  if (!isObjectLike(obj)) {
    return fail('setup_signed_not_object');
  }

  if (obj.version !== 1) {
    return fail('setup_version_invalid');
  }

  if (!isValidBytes32(obj.txId)) {
    return fail('setup_txid_invalid');
  }

  if (
    typeof obj.chainId !== 'number' ||
    !Number.isInteger(obj.chainId) ||
    obj.chainId <= 0
  ) {
    return fail('setup_chain_id_invalid');
  }

  if (!isValidAddress(obj.kernelAddress)) {
    return fail('setup_kernel_address_invalid');
  }

  if (!isValidAddress(obj.requesterAddress)) {
    return fail('setup_requester_address_invalid');
  }

  if (!isValidAddress(obj.signerAddress)) {
    return fail('setup_signer_address_invalid');
  }

  if (!isValidBytes32(obj.buyerEphemeralPubkey)) {
    return fail('setup_buyer_pubkey_invalid');
  }

  if (!isValidAcceptedChannels(obj.acceptedChannels)) {
    return fail('setup_accepted_channels_invalid');
  }

  if (!isValidPrivacy(obj.expectedPrivacy)) {
    return fail('setup_expected_privacy_invalid');
  }

  if (!isPositiveInteger(obj.createdAt)) {
    return fail('setup_created_at_invalid');
  }

  if (!isPositiveInteger(obj.expiresAt)) {
    return fail('setup_expires_at_invalid');
  }

  if ((obj.expiresAt as number) <= (obj.createdAt as number)) {
    return fail('expiresAt_before_createdAt');
  }

  return OK;
}

// ============================================================================
// Setup Wire Validator
// ============================================================================

/**
 * Validate a {@link DeliverySetupWireV1} object's structure.
 *
 * Checks performed (in order):
 *
 *  1. Top-level shape is a non-null object.
 *  2. `signed` validates as a {@link DeliverySetupSignedV1}.
 *  3. `requesterSig` is a string starting with `0x` and of even hex
 *     length consistent with a typical 65-byte EIP-712 signature
 *     (132 hex chars + `0x` = 134 chars). We accept any `0x`-hex
 *     string of plausible signature length; the actual cryptographic
 *     validity is checked by `ethers.verifyTypedData` in the
 *     recovery helpers — there is no point duplicating that here.
 *  4. `serverMeta`, if present, is an object with `receivedAt`
 *     (non-empty string) and `relayId` (non-empty string). Absence
 *     is fine — `serverMeta` is set by the relay on read and is not
 *     present on freshly built setups.
 *
 * @param obj — value of `unknown` static type.
 * @returns {@link ValidationResult}.
 */
export function validateSetupWire(obj: unknown): ValidationResult {
  if (!isObjectLike(obj)) {
    return fail('setup_wire_not_object');
  }

  const signedResult = validateSetupSigned(obj.signed);
  if (!signedResult.ok) {
    return signedResult;
  }

  if (!isValidSignatureHex(obj.requesterSig)) {
    return fail('setup_requester_sig_invalid');
  }

  if (obj.serverMeta !== undefined) {
    const sm = obj.serverMeta;
    if (!isObjectLike(sm)) {
      return fail('setup_server_meta_invalid');
    }
    if (typeof sm.receivedAt !== 'string' || sm.receivedAt.length === 0) {
      return fail('setup_server_meta_received_at_invalid');
    }
    if (typeof sm.relayId !== 'string' || sm.relayId.length === 0) {
      return fail('setup_server_meta_relay_id_invalid');
    }
  }

  return OK;
}

// ============================================================================
// Envelope Signed Validator
// ============================================================================

/**
 * Validate a {@link DeliveryEnvelopeSignedV1} object's structure and
 * field-level invariants.
 *
 * Checks performed (in order):
 *
 *  1. Top-level shape is a non-null object.
 *  2. `version === 1` exactly.
 *  3. `txId` is a well-formed bytes32 hex string.
 *  4. `chainId` is a positive integer.
 *  5. `kernelAddress`, `providerAddress`, `signerAddress` are valid
 *     EVM addresses.
 *  6. `scheme` is one of the {@link DeliveryScheme} discriminants.
 *  7. `providerEphemeralPubkey` is a well-formed bytes32 hex string.
 *  8. `nonce` is a well-formed bytes12 hex string.
 *  9. `payloadHash` is a well-formed bytes32 hex string.
 * 10. `tag` is a well-formed bytes16 hex string.
 * 11. `createdAt` is a positive integer.
 * 12. Scheme/canonical-empty consistency via
 *     {@link validateSchemeConsistency}.
 *
 * Does NOT verify the signature, recompute `payloadHash`, or
 * decrypt — those happen in higher layers.
 *
 * @param obj — value of `unknown` static type.
 * @returns {@link ValidationResult}.
 */
export function validateEnvelopeSigned(obj: unknown): ValidationResult {
  if (!isObjectLike(obj)) {
    return fail('envelope_signed_not_object');
  }

  if (obj.version !== 1) {
    return fail('envelope_version_invalid');
  }

  if (!isValidBytes32(obj.txId)) {
    return fail('envelope_txid_invalid');
  }

  if (
    typeof obj.chainId !== 'number' ||
    !Number.isInteger(obj.chainId) ||
    obj.chainId <= 0
  ) {
    return fail('envelope_chain_id_invalid');
  }

  if (!isValidAddress(obj.kernelAddress)) {
    return fail('envelope_kernel_address_invalid');
  }

  if (!isValidAddress(obj.providerAddress)) {
    return fail('envelope_provider_address_invalid');
  }

  if (!isValidAddress(obj.signerAddress)) {
    return fail('envelope_signer_address_invalid');
  }

  if (!isValidScheme(obj.scheme)) {
    return fail('envelope_scheme_invalid');
  }

  if (!isValidBytes32(obj.providerEphemeralPubkey)) {
    return fail('envelope_provider_pubkey_invalid');
  }

  if (!isValidBytes12(obj.nonce)) {
    return fail('envelope_nonce_invalid');
  }

  if (!isValidBytes32(obj.payloadHash)) {
    return fail('envelope_payload_hash_invalid');
  }

  if (!isValidBytes16(obj.tag)) {
    return fail('envelope_tag_invalid');
  }

  if (!isPositiveInteger(obj.createdAt)) {
    return fail('envelope_created_at_invalid');
  }

  // Cross-field: scheme ↔ canonical-empty invariant. At this point we
  // know every field has the right TYPE and LENGTH; the consistency
  // check confirms the VALUES are correct for the declared scheme.
  return validateSchemeConsistency(obj as unknown as DeliveryEnvelopeSignedV1);
}

// ============================================================================
// Envelope Wire Validator
// ============================================================================

/**
 * Validate a {@link DeliveryEnvelopeWireV1} object's structure.
 *
 * Checks performed (in order):
 *
 *  1. Top-level shape is a non-null object.
 *  2. `signed` validates as a {@link DeliveryEnvelopeSignedV1}
 *     (which includes the scheme/canonical-empty consistency check).
 *  3. `body` is a string. For `public-v1` this is plaintext UTF-8
 *     JSON; for `x25519-aes256gcm-v1` this is base64-encoded
 *     ciphertext. We do NOT verify base64-ness here because the
 *     receiver will discover any malformed encoding when it
 *     recomputes `payloadHash`. We DO insist on non-empty — an
 *     empty body would imply the provider sent nothing.
 *  4. `providerSig` is a `0x`-hex string of plausible signature length.
 *  5. `serverMeta`, if present, is well-formed.
 *
 * @param obj — value of `unknown` static type.
 * @returns {@link ValidationResult}.
 */
export function validateEnvelopeWire(obj: unknown): ValidationResult {
  if (!isObjectLike(obj)) {
    return fail('envelope_wire_not_object');
  }

  const signedResult = validateEnvelopeSigned(obj.signed);
  if (!signedResult.ok) {
    return signedResult;
  }

  if (typeof obj.body !== 'string' || obj.body.length === 0) {
    return fail('envelope_body_invalid');
  }

  if (!isValidSignatureHex(obj.providerSig)) {
    return fail('envelope_provider_sig_invalid');
  }

  if (obj.serverMeta !== undefined) {
    const sm = obj.serverMeta;
    if (!isObjectLike(sm)) {
      return fail('envelope_server_meta_invalid');
    }
    if (typeof sm.receivedAt !== 'string' || sm.receivedAt.length === 0) {
      return fail('envelope_server_meta_received_at_invalid');
    }
    if (typeof sm.relayId !== 'string' || sm.relayId.length === 0) {
      return fail('envelope_server_meta_relay_id_invalid');
    }
  }

  return OK;
}

// ============================================================================
// Scheme Consistency (Canonical-Empty Rule)
// ============================================================================

/**
 * Cross-field check enforcing the AIP-16 canonical-empty rule on a
 * {@link DeliveryEnvelopeSignedV1}.
 *
 * Rule:
 *
 *  - `scheme === "public-v1"` →
 *      `providerEphemeralPubkey === CANONICAL_EMPTY_BYTES32` AND
 *      `nonce === CANONICAL_EMPTY_BYTES12` AND
 *      `tag === CANONICAL_EMPTY_BYTES16`.
 *
 *  - `scheme === "x25519-aes256gcm-v1"` →
 *      `providerEphemeralPubkey` MUST NOT be canonical empty (a zero
 *      X25519 public key cannot produce a usable shared secret —
 *      RFC 7748 §6.1 actually requires implementations to reject it)
 *      AND `nonce` MUST NOT be canonical empty (a zero AES-GCM nonce
 *      under a real key catastrophically breaks GCM) AND `tag` MUST
 *      NOT be canonical empty (a zero 128-bit tag has ~2^-128 chance
 *      of matching, so this is effectively a signal that the
 *      provider built the envelope incorrectly).
 *
 * This validator assumes the underlying field types are already
 * correct (length, hex shape) — callers must run
 * {@link validateEnvelopeSigned} first, which is also where this is
 * invoked from automatically.
 *
 * @param env — already-shape-validated envelope.
 * @returns {@link ValidationResult}.
 */
export function validateSchemeConsistency(
  env: DeliveryEnvelopeSignedV1,
): ValidationResult {
  if (env.scheme === 'public-v1') {
    if (!isCanonicalEmptyBytes32(env.providerEphemeralPubkey)) {
      return fail('envelope_public_pubkey_not_canonical_empty');
    }
    if (!isCanonicalEmptyBytes12(env.nonce)) {
      return fail('envelope_public_nonce_not_canonical_empty');
    }
    if (!isCanonicalEmptyBytes16(env.tag)) {
      return fail('envelope_public_tag_not_canonical_empty');
    }
    return OK;
  }

  if (env.scheme === 'x25519-aes256gcm-v1') {
    if (isCanonicalEmptyBytes32(env.providerEphemeralPubkey)) {
      return fail('envelope_encrypted_pubkey_is_canonical_empty');
    }
    if (isCanonicalEmptyBytes12(env.nonce)) {
      return fail('envelope_encrypted_nonce_is_canonical_empty');
    }
    if (isCanonicalEmptyBytes16(env.tag)) {
      return fail('envelope_encrypted_tag_is_canonical_empty');
    }
    return OK;
  }

  // Unreachable if validateEnvelopeSigned has run, but guards against
  // direct callers using a malformed scheme via the public type cast.
  return fail('envelope_scheme_invalid');
}

// ============================================================================
// Internal: Signature-Shape Heuristic
// ============================================================================

/**
 * True iff `s` is a `0x`-prefixed hex string of length consistent
 * with a standard 65-byte secp256k1 EIP-712 signature (r ‖ s ‖ v).
 * Specifically: `0x` + 130 hex characters.
 *
 * This is a *shape* check; cryptographic validity is established by
 * `ethers.verifyTypedData` in the recovery helpers — there is no
 * value in re-implementing that here, and doing so would risk
 * disagreeing with ethers on edge cases.
 *
 * We do NOT export this helper as part of the public API because
 * downstream code that wants signature validation should use the
 * recovery helpers in `./eip712.ts`; the shape check is internal
 * structural validation only.
 */
function isValidSignatureHex(s: unknown): s is `0x${string}` {
  return (
    typeof s === 'string' &&
    s.length === 132 &&
    /^0x[0-9a-fA-F]{130}$/.test(s)
  );
}

// ============================================================================
// Discriminator-Union Re-Export Notes
// ============================================================================
//
// The signature `validateSetupSigned(obj: unknown): ValidationResult`
// (and friends) uses `unknown` deliberately rather than the typed
// `DeliverySetupSignedV1`. The whole point of these validators is
// to accept untrusted input from the relay / a peer SDK and reject
// it if structurally invalid; if the caller already had a
// statically-typed object, they would not need this layer.
//
// After a successful validation, callers MAY safely treat the
// validated `obj` as the corresponding typed interface (e.g. cast
// it via `as DeliverySetupSignedV1`), and the rest of the SDK
// is built around that contract.

// re-export the wire/signed types here so callers can do a single
// import for both validators and types if they prefer:
export type {
  DeliveryEnvelopeSignedV1,
  DeliveryEnvelopeWireV1,
  DeliverySetupSignedV1,
  DeliverySetupWireV1,
};
