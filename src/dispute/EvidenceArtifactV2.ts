/**
 * EvidenceArtifactV2 — the canonical Schema-2.0.0 IMMUTABLE evidence artifact
 * serializer (AIP-14c D5/D6).
 *
 * The 2.0.0 artifact is the evidence object a v2 dispute freezes + hashes BEFORE
 * evaluation. It differs from the 1.0.0 {@link EvidenceBundle} in exactly the
 * D5/D6 ways:
 *  - a top-level `transaction` block (authoritative economics/parties/timestamps,
 *    cross-checked against the on-chain `TransactionView` by the evaluator);
 *  - NO `reasoning` key (D6 — reasoning is a separate post-evaluation artifact,
 *    committed via `reasoningHash`/`reasoningRefHash` in the 9-field AIRuling);
 *  - NO `timeline` key (D5 — the lifecycle timeline is derived from chain).
 *
 * CANONICALIZATION IS UNCHANGED: `canonical_bytes = utf8(canonicalJsonStringify(validated))`
 * — the SAME frozen canonicalizer as the 1.0.0 bundle (sorted keys, no whitespace,
 * raw UTF-8), and `bundleHash = keccak256(canonical_bytes)`. Validation is STRICT
 * (no additional properties at any level) so two different wire objects can never
 * canonicalize to the same bytes.
 *
 * The evaluator (`services/dispute-evaluator`) re-derives this hash server-side and
 * never trusts a client-supplied value; the hash is the `bundleHash` committed in
 * the signed 9-field AIRuling and CID-bound via
 * `evidenceRefHash = keccak256(abi.encode(bundleHash, keccak256(bytes(evidenceCID))))`.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';

import { canonicalJsonStringify } from '../utils/canonicalJson';
import { countBundleTokens, enforceTokenCap } from './EvidenceBundle';

/** Frozen evidence-artifact schema version (D5). */
export const EVIDENCE_ARTIFACT_V2_SCHEMA_VERSION = '2.0.0' as const;

// =====================================================================
// Types (mirror the evaluator's schema2.ts — field names are load-bearing)
// =====================================================================

/** The two on-chain parties. */
export interface ArtifactV2Parties {
  requester: string;
  provider: string;
}

/** Chain-derived lifecycle timestamps (unix seconds). */
export interface ArtifactV2Timestamps {
  createdAt: number;
  deliveredAt: number;
  disputedAt: number;
}

/** The top-level `transaction` block (D5). */
export interface ArtifactV2Transaction {
  /** bytes32 kernel transaction id this dispute is bound to. */
  transactionId: string;
  parties: ArtifactV2Parties;
  /** Accepted final amount, USDC base units as a decimal string (== `tx.amount`). */
  amount: string;
  /** Who opened the dispute (== `tx.disputeInitiator`). */
  initiator: string;
  timestamps: ArtifactV2Timestamps;
}

/** The effective-agreement preimage (D3). */
export interface ArtifactV2Agreement {
  /** Canonical agreement preimage (raw UTF-8) whose keccak == `tx.agreementHash`. */
  bytes?: string;
  /** CID the agreement preimage is stored at (required when `bytes` is absent). */
  cid?: string;
  /** The accepted quote (present iff the tx was QUOTED). */
  quote?: {
    /** Canonical quote preimage (raw UTF-8) whose keccak == `quoteHash`. */
    bytes: string;
    /** keccak256 of the canonical quote (== `tx.metadata`). */
    quoteHash: string;
  };
}

/** The delivery block (D2). */
export interface ArtifactV2Delivery {
  /** keccak of the delivered result committed at DELIVERED (== `tx.resultHash`). */
  resultHash: string;
  /** True for an encrypted-envelope delivery (unjudgeable ⇒ proposeDirectly). */
  encrypted?: boolean;
  /** The plaintext deliverable inlined (UTF-8), when small enough. */
  inline?: string;
  /** CID to fetch the deliverable when not inlined. */
  cid?: string;
  /** Human-readable retrieval instructions. */
  retrievalInstructions?: string;
}

/** The IMMUTABLE Schema-2.0.0 evidence artifact (D5/D6). */
export interface EvidenceArtifactV2 {
  /** Frozen "2.0.0". */
  schemaVersion: string;
  /** On-chain dispute identifier this artifact is evidence for (bytes32hex). */
  disputeId: string;
  transaction: ArtifactV2Transaction;
  agreement: ArtifactV2Agreement;
  delivery: ArtifactV2Delivery;
}

// =====================================================================
// Errors (mirror the evaluator's schema2.ts names)
// =====================================================================

/** Raised when `schemaVersion` is not the exact frozen "2.0.0". */
export class UnsupportedArtifactVersionError extends Error {
  public readonly schemaVersion: string;
  constructor(schemaVersion: string) {
    super(
      `Unsupported evidence-artifact schemaVersion "${schemaVersion}": only the exact frozen ` +
        `"${EVIDENCE_ARTIFACT_V2_SCHEMA_VERSION}" is accepted (strict — any other 2.x is rejected).`
    );
    this.name = 'UnsupportedArtifactVersionError';
    this.schemaVersion = schemaVersion;
    Object.setPrototypeOf(this, UnsupportedArtifactVersionError.prototype);
  }
}

/** Raised when the artifact shape is invalid (missing/extra/typed-wrong field). */
export class InvalidArtifactError extends Error {
  constructor(detail: string) {
    super(`Invalid Schema 2.0.0 evidence artifact: ${detail}`);
    this.name = 'InvalidArtifactError';
    Object.setPrototypeOf(this, InvalidArtifactError.prototype);
  }
}

// =====================================================================
// Strict zod schema (no additional properties at ANY level)
// =====================================================================

const bytes32Hex = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, 'must be 0x + 64 lowercase hex chars (bytes32hex)');

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x + 40 hex char address');

const uint = z
  .number()
  .int('must be an integer (floats prohibited)')
  .nonnegative('must be non-negative')
  .finite();

const decimalAmount = z
  .string()
  .regex(/^[0-9]+$/, 'must be a base-10 unsigned integer string (USDC base units)');

const timestampsSchema = z
  .object({ createdAt: uint, deliveredAt: uint, disputedAt: uint })
  .strict();

const transactionSchema = z
  .object({
    transactionId: bytes32Hex,
    parties: z.object({ requester: address, provider: address }).strict(),
    amount: decimalAmount,
    initiator: address,
    timestamps: timestampsSchema,
  })
  .strict();

const quoteSchema = z
  .object({ bytes: z.string(), quoteHash: bytes32Hex })
  .strict();

const agreementSchema = z
  .object({
    bytes: z.string().optional(),
    cid: z.string().min(1).optional(),
    quote: quoteSchema.optional(),
  })
  .strict()
  .refine((a) => a.bytes !== undefined || a.cid !== undefined, {
    message: 'agreement requires an inline `bytes` preimage or a `cid` to fetch it',
  });

const deliverySchema = z
  .object({
    resultHash: bytes32Hex,
    encrypted: z.boolean().optional(),
    inline: z.string().optional(),
    cid: z.string().min(1).optional(),
    retrievalInstructions: z.string().optional(),
  })
  .strict();

const artifactSchema = z
  .object({
    schemaVersion: z.string(),
    disputeId: bytes32Hex,
    transaction: transactionSchema,
    agreement: agreementSchema,
    delivery: deliverySchema,
  })
  .strict();

/**
 * Assert `schemaVersion` is EXACTLY "2.0.0" (strict D5 — any other 2.x could carry
 * fields this serializer does not understand and MUST be rejected, never silently
 * canonicalized).
 *
 * @throws {UnsupportedArtifactVersionError | InvalidArtifactError}
 */
export function assertArtifactV2Version(schemaVersion: unknown): void {
  if (typeof schemaVersion !== 'string' || schemaVersion.length === 0) {
    throw new InvalidArtifactError('schemaVersion must be a non-empty semver string');
  }
  if (schemaVersion !== EVIDENCE_ARTIFACT_V2_SCHEMA_VERSION) {
    throw new UnsupportedArtifactVersionError(schemaVersion);
  }
}

/**
 * Strictly validate + narrow an unknown value to an {@link EvidenceArtifactV2}.
 *
 * Rejects: missing required key, ANY extra key at ANY level (so a `reasoning` or
 * `timeline` key — D6/D5 — is rejected as unrecognized), wrong type, non-integer
 * timestamps, malformed bytes32hex/address, agreement with neither bytes nor cid.
 *
 * @throws {InvalidArtifactError | UnsupportedArtifactVersionError}
 */
export function validateEvidenceArtifactV2(artifact: unknown): EvidenceArtifactV2 {
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    throw new InvalidArtifactError('<root> must be an object');
  }
  assertArtifactV2Version((artifact as { schemaVersion?: unknown }).schemaVersion);
  const parsed = artifactSchema.safeParse(artifact);
  if (!parsed.success) {
    throw new InvalidArtifactError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    );
  }
  return parsed.data as EvidenceArtifactV2;
}

// =====================================================================
// Canonical serialization + hash (same frozen canonicalizer as 1.0.0)
// =====================================================================

/**
 * Canonical bytes of a validated artifact:
 * `utf8(canonicalJsonStringify(validated))` — sorted keys at every level, no
 * whitespace, raw UTF-8. Validates first, so the bytes are schema-stable.
 *
 * @throws {InvalidArtifactError | UnsupportedArtifactVersionError}
 */
export function serializeArtifactV2(artifact: EvidenceArtifactV2 | unknown): Uint8Array {
  return toUtf8Bytes(serializeArtifactV2ToString(artifact));
}

/** Canonical bytes as a UTF-8 string (the exact text that is hashed and pinned). */
export function serializeArtifactV2ToString(artifact: EvidenceArtifactV2 | unknown): string {
  const valid = validateEvidenceArtifactV2(artifact);
  return canonicalJsonStringify(valid);
}

/**
 * `bundleHash = keccak256(canonical_bytes)` for a Schema-2.0.0 evidence artifact —
 * the value committed inside the signed 9-field AIRuling (`ruling.bundleHash`) and
 * CID-bound into `evidenceRefHash` (D7).
 *
 * Enforces the same token cap as the 1.0.0 bundle BEFORE hashing unless
 * `skipTokenCheck` is set (only when the caller already enforced it on the same bytes).
 *
 * @throws {BundleTooLargeError | InvalidArtifactError | UnsupportedArtifactVersionError}
 * @returns `0x` + 64 lowercase hex chars.
 */
export function computeArtifactV2Hash(
  artifact: EvidenceArtifactV2 | unknown,
  options?: { skipTokenCheck?: boolean }
): string {
  const text = serializeArtifactV2ToString(artifact);
  if (!options?.skipTokenCheck) {
    enforceTokenCap(text);
  }
  return keccak256(toUtf8Bytes(text));
}

/** Token count of the canonical artifact text (cl100k_base — same tokenizer as 1.0.0). */
export function countArtifactV2Tokens(artifact: EvidenceArtifactV2 | unknown): number {
  return countBundleTokens(serializeArtifactV2ToString(artifact));
}
