/**
 * Evidence Bundle — the single CANONICAL evidence-bundle serializer (PRD P2-3).
 *
 * This is the TypeScript half of a cross-language (TS ⇄ Py) byte-identical
 * serializer. Its Python twin is `python-sdk-v2/src/agirails/dispute/evidence_bundle.py`.
 * Both MUST produce IDENTICAL `canonical_bytes` and therefore an identical
 * `bundleHash` for the same logical bundle.
 *
 * FROZEN schema (the normative source): `DISPUTE SYSTEM/EVIDENCE-BUNDLE-SCHEMA.md`.
 * No field set, canonical byte rule, `bundleHash` rule, or token cap is defined
 * here independently — they are pinned in the schema and reproduced 1:1 below.
 *
 * Key invariants (schema §3, §4, §5):
 *  - `canonical_bytes = utf8(canonicalJsonStringify(bundle))` — reuses the
 *    existing cross-language-proven canonicalizer (fast-json-stable-stringify),
 *    NOT a new one. Sorted keys at every level, no whitespace, ensure_ascii=false.
 *  - `bundleHash = keccak256(canonical_bytes)` — what the on-chain AIRuling
 *    commits and what OQ-10 binds to the pinned CID.
 *  - Bundles whose cl100k_base token count over the canonical bytes exceeds
 *    100_000 are rejected with {@link BundleTooLargeError} BEFORE hashing/pinning.
 *  - All numeric fields are integers (`uint`); floats are rejected upstream so
 *    the JSON number-formatting divergence between TS and Py never arises.
 *
 * Anchor: Example A (schema §7) → bundleHash
 *   `0x379fb8140138f7d90cfbcb481898b6ec646e2c0378ff0d3a4a4572a6570ca257`.
 *
 * @module dispute/EvidenceBundle
 */

// PARITY: python-sdk-v2/src/agirails/dispute/evidence_bundle.py
// This file and its Python twin MUST produce byte-identical canonical_bytes and
// bundleHash for the same logical bundle; keep the schema, error names, and
// public API surface 1:1.

import { keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';
import { canonicalJsonStringify } from '../utils/canonicalJson';

// =====================================================================
// Schema version (schema §1)
// =====================================================================

/** Current frozen evidence-bundle schema version (semver, schema §1). */
export const EVIDENCE_BUNDLE_SCHEMA_VERSION = '1.0.0' as const;

/**
 * The major version this deserializer understands. A bundle whose
 * `schemaVersion` major number differs is rejected
 * ({@link UnsupportedBundleVersionError}).
 */
export const SUPPORTED_BUNDLE_MAJOR = 1 as const;

/** Canonical tokenizer + cap (schema §4 / OQ-9). */
export const MAX_BUNDLE_TOKENS = 100_000 as const;

// =====================================================================
// Types (schema §2 — field set is 1:1 with the frozen schema + Py twin)
// =====================================================================

/** The original service spec (schema §2.3). */
export interface EvidenceBundleSpec {
  /** CID of the provider's AGIRAILS.md at transaction-creation time. */
  agirailsMdCID: string;
  /** Declared capabilities (order preserved). */
  capabilities: string[];
  /** keccak256 of the canonical-JSON SLA object (bytes32hex). */
  slaHash: string;
}

/** Deliverable-or-content-hash + retrieval instructions (schema §2.4). */
export interface EvidenceBundleDelivery {
  /** keccak256 of the deliverable content (bytes32hex). Always present. */
  deliverableHash: string;
  /** IPFS CID of the deliverable content. */
  deliverableCID: string;
  /** Full deliverable inlined — present ONLY when small enough (optional). */
  deliverableInline?: string;
  /** Instructions to fetch + verify the deliverable. */
  retrievalInstructions: string;
  /** Unix seconds of the DELIVERED transition (uint). */
  deliveredAt: number;
}

/** Why the dispute was opened (schema §2.5). */
export interface EvidenceBundleDispute {
  /** Disputer's stated reason (free text, treated as DATA). */
  reason: string;
  /** CID of supporting evidence the disputer pinned. */
  evidenceCID: string;
  /** Inlined supporting evidence — present ONLY when small enough (optional). */
  evidenceInline?: string;
  /** Unix seconds of the DELIVERED→DISPUTED transition (uint). */
  openedAt: number;
}

/** A single timeline event (schema §2.6). */
export interface EvidenceBundleTimelineEvent {
  /** State/transition name (e.g. "COMMITTED", "DELIVERED", "DISPUTED"). */
  event: string;
  /** Unix seconds the event occurred (uint). */
  at: number;
}

/** AI reasoning + evaluation metadata (schema §2.7). */
export interface EvidenceBundleReasoning {
  /** CID of the canonical evaluator prompt version. */
  evaluatorPromptCID: string;
  /** Model identifiers expected/used (order preserved). */
  modelVersions: string[];
  /** Tier-0 AI reasoning text, or "" for a pre-evaluation bundle. */
  notes: string;
}

/**
 * The canonical evidence bundle (schema §2). EXACTLY seven top-level keys —
 * no additional properties at any object level.
 */
export interface EvidenceBundle {
  /** Frozen "1.0.0" (schema §1). */
  schemaVersion: string;
  /** On-chain dispute identifier this bundle is evidence for (bytes32hex). */
  disputeId: string;
  /** Original service spec. */
  spec: EvidenceBundleSpec;
  /** Deliverable / content-hash + retrieval. */
  delivery: EvidenceBundleDelivery;
  /** Dispute reason + evidence. */
  dispute: EvidenceBundleDispute;
  /** Chronological lifecycle events (≥ DELIVERED and DISPUTED). */
  timeline: EvidenceBundleTimelineEvent[];
  /** AI reasoning + evaluation metadata. */
  reasoning: EvidenceBundleReasoning;
}

// =====================================================================
// Errors (schema §6 — frozen names, identical to the Py twin)
// =====================================================================

/** Raised when the canonical-bytes token count exceeds {@link MAX_BUNDLE_TOKENS}. */
export class BundleTooLargeError extends Error {
  public readonly tokenCount: number;
  public readonly maxTokens: number;
  constructor(tokenCount: number, maxTokens: number = MAX_BUNDLE_TOKENS) {
    super(
      `Evidence bundle too large: ${tokenCount} tokens > ${maxTokens} cap ` +
        `(cl100k_base over canonical bytes). Submit large deliverables as ` +
        `deliverableHash + deliverableCID + retrievalInstructions (omit deliverableInline).`
    );
    this.name = 'BundleTooLargeError';
    this.tokenCount = tokenCount;
    this.maxTokens = maxTokens;
    Object.setPrototypeOf(this, BundleTooLargeError.prototype);
  }
}

/** Raised when `schemaVersion` major number is unknown to this deserializer. */
export class UnsupportedBundleVersionError extends Error {
  public readonly schemaVersion: string;
  constructor(schemaVersion: string) {
    super(
      `Unsupported evidence-bundle schemaVersion "${schemaVersion}": ` +
        `this SDK understands major version ${SUPPORTED_BUNDLE_MAJOR}.`
    );
    this.name = 'UnsupportedBundleVersionError';
    this.schemaVersion = schemaVersion;
    Object.setPrototypeOf(this, UnsupportedBundleVersionError.prototype);
  }
}

/** Raised on schema validation failure (missing/extra key, wrong type, etc.). */
export class InvalidBundleError extends Error {
  public readonly issues?: unknown;
  constructor(message: string, issues?: unknown) {
    super(`Invalid evidence bundle: ${message}`);
    this.name = 'InvalidBundleError';
    this.issues = issues;
    Object.setPrototypeOf(this, InvalidBundleError.prototype);
  }
}

// =====================================================================
// zod validation (schema §2 / §6 — strict: no additional properties,
// integers only, bytes32hex / non-empty strings)
// =====================================================================

const bytes32Hex = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, 'must be 0x + 64 lowercase hex chars (bytes32hex)');

const cid = z.string().min(1, 'CID must be a non-empty string');
const uint = z
  .number()
  .int('must be an integer (floats prohibited)')
  .nonnegative('must be non-negative')
  .finite();

const specSchema = z
  .object({
    agirailsMdCID: cid,
    capabilities: z.array(z.string()),
    slaHash: bytes32Hex
  })
  .strict();

const deliverySchema = z
  .object({
    deliverableHash: bytes32Hex,
    deliverableCID: cid,
    deliverableInline: z.string().optional(),
    retrievalInstructions: z.string(),
    deliveredAt: uint
  })
  .strict();

const disputeSchema = z
  .object({
    reason: z.string(),
    evidenceCID: cid,
    evidenceInline: z.string().optional(),
    openedAt: uint
  })
  .strict();

const timelineEventSchema = z
  .object({
    event: z.string().min(1),
    at: uint
  })
  .strict();

const reasoningSchema = z
  .object({
    evaluatorPromptCID: cid,
    modelVersions: z.array(z.string()),
    notes: z.string()
  })
  .strict();

const bundleSchema = z
  .object({
    schemaVersion: z.string(),
    disputeId: bytes32Hex,
    spec: specSchema,
    delivery: deliverySchema,
    dispute: disputeSchema,
    timeline: z
      .array(timelineEventSchema)
      .min(2, 'timeline must contain at least DELIVERED and DISPUTED'),
    reasoning: reasoningSchema
  })
  .strict();

/**
 * Validate a logical bundle against the frozen schema (schema §2 / §6).
 *
 * Rejects: missing required key, extra key (additionalProperties:false at every
 * level), wrong type, non-integer where a `uint` is expected, malformed
 * `bytes32hex`, optional key present as `null`.
 *
 * `schemaVersion` is validated separately: an unknown MAJOR version raises
 * {@link UnsupportedBundleVersionError}, not {@link InvalidBundleError}.
 *
 * @throws {InvalidBundleError} on any structural / type failure.
 * @throws {UnsupportedBundleVersionError} on unknown major schema version.
 * @returns The validated bundle (typed).
 */
export function validateBundle(bundle: unknown): EvidenceBundle {
  const parsed = bundleSchema.safeParse(bundle);
  if (!parsed.success) {
    throw new InvalidBundleError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), parsed.error.issues);
  }
  assertSupportedVersion(parsed.data.schemaVersion);
  return parsed.data as EvidenceBundle;
}

/**
 * Reject a bundle whose `schemaVersion` major number is unknown to this
 * deserializer (schema §1). The version string is treated as an opaque semver
 * token — only the major component is checked.
 *
 * @throws {UnsupportedBundleVersionError}
 */
export function assertSupportedVersion(schemaVersion: string): void {
  const major = schemaVersion.split('.')[0];
  if (!/^\d+$/.test(major) || Number(major) !== SUPPORTED_BUNDLE_MAJOR) {
    throw new UnsupportedBundleVersionError(schemaVersion);
  }
}

// =====================================================================
// Canonical serialization (schema §3) — reuse the existing canonicalizer
// =====================================================================

/**
 * Serialize a bundle to its canonical UTF-8 byte form (schema §3).
 *
 * `canonical_bytes = utf8(canonicalJsonStringify(bundle))`. Keys are sorted at
 * every nesting level, no whitespace, minimal escaping, `ensure_ascii=false`
 * (raw UTF-8). Array order is preserved. The byte form is identical to the
 * Python twin's `serialize_bundle`.
 *
 * Validates the bundle first (schema §6). Note the canonical bytes are derived
 * from the VALIDATED bundle, so unknown/extra keys are rejected (never silently
 * serialized) and the byte output is schema-stable.
 *
 * @throws {InvalidBundleError | UnsupportedBundleVersionError}
 * @returns The canonical bytes as a `Uint8Array`.
 */
export function serializeBundle(bundle: EvidenceBundle | unknown): Uint8Array {
  const valid = validateBundle(bundle);
  return toUtf8Bytes(canonicalJsonStringify(valid));
}

/**
 * Canonical bytes as a UTF-8 string (convenience; the exact text that is hashed,
 * pinned, and token-counted).
 */
export function serializeBundleToString(bundle: EvidenceBundle | unknown): string {
  const valid = validateBundle(bundle);
  return canonicalJsonStringify(valid);
}

/**
 * Compute `bundleHash = keccak256(canonical_bytes)` (schema §3.3).
 *
 * This is the value committed on-chain inside the AIRuling (§4.4) and bound to
 * the pinned CID by OQ-10. Identical hex to the Python twin's `bundle_hash`.
 *
 * Enforces the token cap (schema §4) BEFORE hashing: a too-large bundle raises
 * {@link BundleTooLargeError} and is never hashed. Pass `{ skipTokenCheck: true }`
 * only when the count has already been enforced by the caller (e.g. the cap
 * itself was computed for the same bytes).
 *
 * @throws {BundleTooLargeError | InvalidBundleError | UnsupportedBundleVersionError}
 * @returns `0x` + 64 lowercase hex chars.
 */
export function bundleHash(
  bundle: EvidenceBundle | unknown,
  options?: { skipTokenCheck?: boolean }
): string {
  const valid = validateBundle(bundle);
  const text = canonicalJsonStringify(valid);
  if (!options?.skipTokenCheck) {
    enforceTokenCap(text);
  }
  return keccak256(toUtf8Bytes(text));
}

/** Alias matching the schema §8 acceptance-checklist name. */
export const computeBundleHash = bundleHash;

// =====================================================================
// Token cap (schema §4 / OQ-9) — tiktoken cl100k_base over canonical bytes
// =====================================================================

/**
 * Pluggable tokenizer. The frozen tokenizer (OQ-9) is tiktoken `cl100k_base`.
 * `js-tiktoken` / `@dqbd/tiktoken` are optional peer deps; when absent the SDK
 * falls back to the same byte-accurate cl100k BPE if a tokenizer was injected,
 * otherwise it throws so the cap is never silently skipped.
 */
export interface BundleTokenizer {
  /** Return the cl100k_base token count of `text`. */
  encode(text: string): { length: number } | number[];
}

let _tokenizer: BundleTokenizer | null = null;

/**
 * Inject the cl100k_base tokenizer (schema §4). Call once at startup with a
 * `js-tiktoken` encoder:
 *
 * ```ts
 * import { getEncoding } from 'js-tiktoken';
 * setBundleTokenizer(getEncoding('cl100k_base'));
 * ```
 *
 * The injected object only needs an `encode(text) => number[]` method.
 */
export function setBundleTokenizer(tokenizer: BundleTokenizer): void {
  _tokenizer = tokenizer;
}

/** Try to lazily load a bundled tiktoken implementation if one is installed. */
function _resolveTokenizer(): BundleTokenizer | null {
  if (_tokenizer) return _tokenizer;
  // Optional dependency — only used if the host app installed it.
  /* eslint-disable @typescript-eslint/no-var-requires */
  try {
    // js-tiktoken (pure-JS, no wasm) — preferred for the SDK.
    const mod = require('js-tiktoken');
    const enc = mod.getEncoding('cl100k_base');
    _tokenizer = { encode: (t: string) => enc.encode(t) };
    return _tokenizer;
  } catch {
    /* not installed */
  }
  try {
    const mod = require('@dqbd/tiktoken');
    const enc = mod.get_encoding('cl100k_base');
    _tokenizer = { encode: (t: string) => Array.from(enc.encode(t)) };
    return _tokenizer;
  } catch {
    /* not installed */
  }
  /* eslint-enable @typescript-eslint/no-var-requires */
  return null;
}

/**
 * Count cl100k_base tokens over the canonical-bytes TEXT (schema §4).
 *
 * @throws Error if no cl100k_base tokenizer is available — the cap must never
 *         be silently skipped. Inject one with {@link setBundleTokenizer}.
 */
export function countBundleTokens(canonicalText: string): number {
  const tk = _resolveTokenizer();
  if (!tk) {
    throw new Error(
      'No cl100k_base tokenizer available. Install `js-tiktoken` (or `@dqbd/tiktoken`) ' +
        'or call setBundleTokenizer(getEncoding("cl100k_base")) before serializing bundles.'
    );
  }
  const encoded = tk.encode(canonicalText);
  return Array.isArray(encoded) ? encoded.length : (encoded as { length: number }).length;
}

/**
 * Enforce the token cap (schema §4). Counts cl100k_base tokens over the
 * canonical text; raises {@link BundleTooLargeError} when `> MAX_BUNDLE_TOKENS`.
 *
 * @returns the token count (when within the cap).
 * @throws {BundleTooLargeError}
 */
export function enforceTokenCap(canonicalText: string): number {
  const count = countBundleTokens(canonicalText);
  if (count > MAX_BUNDLE_TOKENS) {
    throw new BundleTooLargeError(count, MAX_BUNDLE_TOKENS);
  }
  return count;
}

// =====================================================================
// IPFS pinning (schema §5 — INV-20 / OQ-10 integrity binding)
// =====================================================================

/**
 * Result of pinning an evidence bundle (schema §5).
 *
 * The integrity invariant (OQ-10) is `keccak256(fetch(cid)) === bundleHash`;
 * the on-chain AIRuling commits `bundleHash`, the CID is the retrieval handle.
 */
export interface PinEvidenceBundleResult {
  /** IPFS CIDv1 of the pinned canonical bytes. */
  cid: string;
  /** `bundleHash` of the pinned bytes (the on-chain commitment). */
  bundleHash: string;
  /** Byte length of the pinned canonical bytes. */
  size: number;
}

/**
 * Minimal binary-pinning surface the bundle pinner needs. Satisfied by the
 * existing `FilebaseClient.uploadBinary(...)` (G-IPFS provider) — REUSED here
 * so the bundle is pinned through the same hot-storage tier as the rest of the
 * SDK. Any client exposing this method can pin bundles.
 */
export interface EvidenceBundlePinner {
  uploadBinary(
    data: Uint8Array | Buffer,
    contentType: string,
    options?: { key?: string; metadata?: Record<string, string> }
  ): Promise<{ cid: string; size: number }>;
}

/**
 * Pin the EXACT canonical bytes of an evidence bundle to IPFS (schema §5.1).
 *
 * CRITICAL (OQ-10): the bytes pinned are exactly `serializeBundle(bundle)` — not
 * a re-encoded / re-ordered / pretty-printed copy — so `keccak256(fetch(cid))`
 * round-trips to the returned `bundleHash`. The token cap (schema §4) is
 * enforced BEFORE pinning, so an over-cap bundle is never pinned or quoted.
 *
 * @param bundle  The logical evidence bundle.
 * @param pinner  An IPFS binary pinner (e.g. a configured `FilebaseClient`).
 * @returns `{ cid, bundleHash, size }` for the INV-20 / OQ-10 binding.
 * @throws {BundleTooLargeError | InvalidBundleError | UnsupportedBundleVersionError}
 */
export async function pinEvidenceBundle(
  bundle: EvidenceBundle | unknown,
  pinner: EvidenceBundlePinner
): Promise<PinEvidenceBundleResult> {
  const valid = validateBundle(bundle);
  const text = canonicalJsonStringify(valid);
  enforceTokenCap(text); // schema §4 — before any pin/spend
  const canonicalBytes = toUtf8Bytes(text);
  const hash = keccak256(canonicalBytes);
  const { cid } = await pinner.uploadBinary(canonicalBytes, 'application/json', {
    metadata: { bundleHash: hash, schemaVersion: valid.schemaVersion }
  });
  return { cid, bundleHash: hash, size: canonicalBytes.length };
}
