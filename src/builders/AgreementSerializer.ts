/**
 * Agreement Serializer — the single CANONICAL `agreementHash` preimage serializer
 * (AIP-14c D3).
 *
 * This is the TypeScript half of a cross-language (TS ⇄ Py) byte-identical
 * serializer. Its Python twin is
 * `python-sdk-v2/src/agirails/builders/agreement.py`. Both MUST produce
 * IDENTICAL `canonical_bytes` and therefore an identical `agreementHash` for the
 * same logical agreement.
 *
 * ## What `agreementHash` commits (AIP-14c D3 — LOCKED)
 *
 * The creation-time `agreementHash` (7th arg of the v2 `createTransaction`,
 * stored in `Transaction.agreementHash`) commits the **request + input + SLA
 * ONLY** — deliberately NOT the quote. The quote arrives *after* creation
 * (`INITIATED→QUOTED` sets `txn.metadata = quoteHash`; `acceptQuote` sets the
 * final `txn.amount`), so a creation-time hash cannot universally include it.
 * The evaluator therefore verifies the **effective agreement triple**:
 *   `{ agreementHash (request/input/SLA), txn.metadata (quoteHash), txn.amount }`.
 *
 * `agreementHash == bytes32(0)` ⇒ the kernel/evaluator emit NO automatic signed
 * ruling for that transaction (D3 fail-closed). Pass {@link ZERO_AGREEMENT_HASH}
 * to opt out explicitly.
 *
 * ## Canonical byte rule (mirrors the evidence-bundle serializer)
 *
 *  - `canonical_bytes = utf8(canonicalJsonStringify(agreement))` — reuses the
 *    existing cross-language-proven canonicalizer (fast-json-stable-stringify),
 *    NOT a new one. Sorted keys at every level, no whitespace, raw UTF-8.
 *  - `agreementHash = keccak256(canonical_bytes)` — what the kernel stores and
 *    what the evaluator recomputes from the agreement preimage.
 *
 * @module builders/AgreementSerializer
 */

// PARITY: python-sdk-v2/src/agirails/builders/agreement.py
// This file and its Python twin MUST produce byte-identical canonical bytes and
// agreementHash for the same logical agreement; keep the schema, error names,
// and public API surface 1:1.

import { keccak256, toUtf8Bytes } from 'ethers';
import { canonicalJsonStringify } from '../utils/canonicalJson';

/** Current frozen agreement schema version (semver). */
export const AGREEMENT_SCHEMA_VERSION = '1.0.0' as const;

/** The major schema version this serializer understands. */
export const SUPPORTED_AGREEMENT_MAJOR = 1 as const;

/** bytes32(0) — the "no automatic AI ruling" sentinel for `agreementHash` (D3). */
export const ZERO_AGREEMENT_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * The canonical agreement preimage (AIP-14c D3). EXACTLY four top-level keys.
 * `request` / `input` / `sla` are arbitrary JSON-serializable values — their
 * internal shape is application-defined, but the canonical BYTES are frozen by
 * the shared canonicalizer so TS and Python hash them identically.
 */
export interface AgreementTerms {
  /** Frozen "1.0.0". */
  schemaVersion: string;
  /** The service request (what the requester asked for). */
  request: unknown;
  /** The input parameters / payload the request runs against. */
  input: unknown;
  /** The service-level agreement terms (deadline policy, quality bar, etc.). */
  sla: unknown;
}

/** Raised when the agreement is structurally invalid (missing/extra key). */
export class InvalidAgreementError extends Error {
  constructor(message: string) {
    super(`Invalid agreement: ${message}`);
    this.name = 'InvalidAgreementError';
    Object.setPrototypeOf(this, InvalidAgreementError.prototype);
  }
}

/** Raised when the agreement `schemaVersion` major is unknown to this serializer. */
export class UnsupportedAgreementVersionError extends Error {
  public readonly schemaVersion: string;
  constructor(schemaVersion: string) {
    super(
      `Unsupported agreement schemaVersion "${schemaVersion}": ` +
        `this SDK understands major version ${SUPPORTED_AGREEMENT_MAJOR}.`
    );
    this.name = 'UnsupportedAgreementVersionError';
    this.schemaVersion = schemaVersion;
    Object.setPrototypeOf(this, UnsupportedAgreementVersionError.prototype);
  }
}

const REQUIRED_KEYS = ['schemaVersion', 'request', 'input', 'sla'] as const;

/**
 * Validate + normalize a logical agreement into the frozen 4-key shape.
 *
 * Rejects: non-object input, a missing required key, or any extra top-level key
 * (exactly the four keys — no additional properties). Unknown MAJOR schema
 * version raises {@link UnsupportedAgreementVersionError}.
 *
 * @throws {InvalidAgreementError | UnsupportedAgreementVersionError}
 */
export function validateAgreement(agreement: unknown): AgreementTerms {
  if (agreement === null || typeof agreement !== 'object' || Array.isArray(agreement)) {
    throw new InvalidAgreementError('must be a plain object with keys {schemaVersion, request, input, sla}');
  }
  const obj = agreement as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const req of REQUIRED_KEYS) {
    if (!(req in obj)) {
      throw new InvalidAgreementError(`missing required key "${req}"`);
    }
  }
  for (const k of keys) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(k)) {
      throw new InvalidAgreementError(`unexpected extra key "${k}" (only ${REQUIRED_KEYS.join(', ')} allowed)`);
    }
  }
  if (typeof obj.schemaVersion !== 'string') {
    throw new InvalidAgreementError('schemaVersion must be a string');
  }
  assertSupportedAgreementVersion(obj.schemaVersion);
  return obj as unknown as AgreementTerms;
}

/**
 * Reject an agreement whose `schemaVersion` major is unknown to this serializer.
 * @throws {UnsupportedAgreementVersionError}
 */
export function assertSupportedAgreementVersion(schemaVersion: string): void {
  const major = schemaVersion.split('.')[0];
  if (!/^\d+$/.test(major) || Number(major) !== SUPPORTED_AGREEMENT_MAJOR) {
    throw new UnsupportedAgreementVersionError(schemaVersion);
  }
}

/**
 * Serialize an agreement to its canonical UTF-8 string form (the exact text
 * that is hashed). Keys sorted at every level, no whitespace, raw UTF-8 — the
 * text is byte-identical to the Python twin's `serialize_agreement`.
 *
 * @throws {InvalidAgreementError | UnsupportedAgreementVersionError}
 */
export function serializeAgreement(agreement: AgreementTerms | unknown): string {
  const valid = validateAgreement(agreement);
  return canonicalJsonStringify(valid);
}

/**
 * Compute `agreementHash = keccak256(utf8(serializeAgreement(agreement)))`
 * (AIP-14c D3). Identical hex to the Python twin's `compute_agreement_hash`.
 *
 * @returns `0x` + 64 lowercase hex chars.
 * @throws {InvalidAgreementError | UnsupportedAgreementVersionError}
 */
export function computeAgreementHash(agreement: AgreementTerms | unknown): string {
  return keccak256(toUtf8Bytes(serializeAgreement(agreement)));
}

/** Alias of {@link computeAgreementHash} (symmetry with the evidence-bundle `bundleHash`). */
export const agreementHash = computeAgreementHash;
