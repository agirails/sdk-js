import { Signer, ethers } from 'ethers';

// PARITY: python-sdk-v2/src/agirails/types/dispute.py
// This file and its Python twin MUST stay 1:1 — same public function/type/enum
// names + arity, same EIP-712 digest, same enum VALUES (Tier/Ruling). Any change
// here (rename, reorder, new export) must be mirrored in the twin and vice versa.

/**
 * Dispute Types — AIP-14b three-tier dispute system + AIRuling EIP-712 signing.
 *
 * The off-chain AI evaluator, this SDK, and the on-chain
 * `BondEscalation._verifyEvaluatorSignatures` MUST all produce the SAME
 * EIP-712 digest for a given `AIRuling`. This module is the SDK half of that
 * contract, anchored to the cross-language GOLDEN VECTOR proven in
 * `Protocol/actp-kernel/test/EncodingCanonical.t.sol`.
 *
 * Reference: AIP-14b §4.4 (AIRuling), §4.5 (EIP-712 domain).
 *
 * Mirror of `Protocol/actp-kernel/src/interfaces/DisputeTypes.sol` —
 * the field ORDER of {@link AIRuling} is load-bearing (it is hashed into
 * {@link RULING_TYPEHASH}); any reorder breaks signature verification.
 */

// =====================================================================
// Enums
// =====================================================================

/**
 * Ruling outcome (AIP-14b / INV-1). The 0/1/2 mapping is load-bearing —
 * see the negative-control test in EncodingCanonical.t.sol. Member identifiers
 * are UPPER_SNAKE to match the shared {@link State} / Py `TransactionState`
 * casing precedent and the Py `Ruling` twin 1:1.
 *
 * - `PROVIDER_WINS` (0): provider keeps the escrow (net of fee).
 * - `REQUESTER_WINS` (1): requester is refunded the full remaining.
 * - `SPLIT` (2): remaining apportioned by `splitBps` (provider share).
 */
export enum Ruling {
  PROVIDER_WINS = 0,
  REQUESTER_WINS = 1,
  SPLIT = 2
}

/**
 * Dispute escalation tier (AIP-14b three-tier bond-escalation engine).
 *
 * Values are anchored 0-based to `BondEscalation.sol`'s `d.tier` field:
 * `tier: 0` (opened) → `d.tier = 1` (proposal/challenge live) →
 * `d.tier = 2` (escalated to UMA OOV3). The Py `Tier` twin uses the SAME
 * member names + values; a `disputes()`/`d.tier` reader in either SDK MUST
 * classify identically. (See the negative-control test pinning TIER1 == 1.)
 *
 * - `TIER0` (0): no proposal yet (dispute opened, bond game not started).
 * - `TIER1` (1): a direct/AI proposal is live in the challengeable bond game.
 * - `TIER2` (2): escalated to UMA Optimistic Oracle V3.
 */
export enum Tier {
  TIER0 = 0,
  TIER1 = 1,
  TIER2 = 2
}

// =====================================================================
// Core types (mirror DisputeTypes.sol — field order is load-bearing)
// =====================================================================

/**
 * AIRuling (AIP-14b §4.4).
 *
 * Field ORDER is load-bearing: it is hashed verbatim into {@link RULING_TYPEHASH}
 * and ABI-encoded (each field padded to 32 bytes) to form the EIP-712 struct hash.
 * Reordering any field breaks signature verification across SDK / evaluator / chain.
 */
export interface AIRuling {
  /** keccak256 dispute identifier (bytes32). */
  disputeId: string;
  /** Outcome: 0 = provider wins, 1 = requester wins, 2 = split. */
  ruling: Ruling | number;
  /** Evaluator confidence in basis points (uint16, 0–10000). */
  confidence: number;
  /** Provider share in basis points when `ruling == 2` (uint16). */
  splitBps: number;
  /** Unix timestamp the ruling was produced (uint64). */
  timestamp: number;
  /** keccak256 of the evaluator reasoning blob (bytes32). */
  reasoningHash: string;
  /** keccak256 of the canonical evidence bundle (bytes32). */
  bundleHash: string;
}

/**
 * On-chain dispute state view (AIP-14b). Mirrors the public `disputes(...)`
 * struct fields the SDK reads back from BondEscalation.
 */
export interface DisputeState {
  /** The transaction this dispute is bound to (bytes32 txId). */
  txId: string;
  /** keccak256 dispute identifier (bytes32). */
  disputeId: string;
  /** Current escalation tier. */
  tier: Tier | number;
  /** The finalized ruling, once resolved (undefined while unresolved). */
  ruling?: Ruling | number;
  /** Provider share in basis points (relevant for `ruling == 2`). */
  splitBps?: number;
  /** Whether the dispute has been finalized / resolved on-chain. */
  resolved: boolean;
}

// =====================================================================
// EIP-712 constants (AIP-14b §4.5) — anchored to the GOLDEN VECTOR
// =====================================================================

/**
 * EIP-712 typed-data definition for {@link AIRuling}.
 *
 * The string passed to keccak256 for {@link RULING_TYPEHASH} is derived from
 * this exactly:
 * `AIRuling(bytes32 disputeId,uint8 ruling,uint16 confidence,uint16 splitBps,uint64 timestamp,bytes32 reasoningHash,bytes32 bundleHash)`
 */
export const AIRulingTypes = {
  AIRuling: [
    { name: 'disputeId', type: 'bytes32' },
    { name: 'ruling', type: 'uint8' },
    { name: 'confidence', type: 'uint16' },
    { name: 'splitBps', type: 'uint16' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'reasoningHash', type: 'bytes32' },
    { name: 'bundleHash', type: 'bytes32' }
  ]
} as const;

/**
 * The canonical EIP-712 `EIP712Domain` typeHash (AIP-14b §4.5).
 *
 * `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`.
 * Exposed for symmetry with the Py twin's `DOMAIN_TYPEHASH` (and for callers
 * computing the domain separator manually). Note the cross-language
 * REPRESENTATION differs by design: TS exposes typehashes as 0x-hex `string`,
 * Py as `bytes` — the underlying 32 bytes are identical (golden test proves it).
 */
export const DOMAIN_TYPEHASH: string = ethers.keccak256(
  ethers.toUtf8Bytes(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  )
);

/**
 * The canonical EIP-712 typeHash for the AIRuling struct (AIP-14b §4.4).
 *
 * `keccak256("AIRuling(bytes32 disputeId,uint8 ruling,uint16 confidence,uint16 splitBps,uint64 timestamp,bytes32 reasoningHash,bytes32 bundleHash)")`
 *
 * REPRESENTATION NOTE: this is a 0x-hex `string` in TS; the Py twin exposes the
 * same constant as `bytes`. Cross-language VALUE is byte-identical — a consumer
 * comparing across langs must compare the 32 raw bytes (Py: `RULING_TYPEHASH`,
 * TS: `ethers.getBytes(RULING_TYPEHASH)`), not the surface type.
 */
export const RULING_TYPEHASH: string = ethers.keccak256(
  ethers.toUtf8Bytes(
    'AIRuling(bytes32 disputeId,uint8 ruling,uint16 confidence,uint16 splitBps,uint64 timestamp,bytes32 reasoningHash,bytes32 bundleHash)'
  )
);

/** EIP-712 domain name for the dispute evaluator (AIP-14b §4.5). */
export const DISPUTE_EVALUATOR_DOMAIN_NAME = 'ACTPDisputeEvaluator';

/** EIP-712 domain version for the dispute evaluator (AIP-14b §4.5). */
export const DISPUTE_EVALUATOR_DOMAIN_VERSION = '1';

/**
 * Build the EIP-712 domain for the dispute evaluator.
 *
 * @param chainId - Chain the verifying contract is deployed on (e.g. 8453 = Base mainnet).
 * @param verifyingContract - Address of the BondEscalation (dispute evaluator) contract.
 */
export function disputeEvaluatorDomain(
  chainId: number,
  verifyingContract: string
): { name: string; version: string; chainId: number; verifyingContract: string } {
  return {
    name: DISPUTE_EVALUATOR_DOMAIN_NAME,
    version: DISPUTE_EVALUATOR_DOMAIN_VERSION,
    chainId,
    verifyingContract
  };
}

// =====================================================================
// Digest / signing / recovery — the cross-language EIP-712 anchor
// =====================================================================

/**
 * Compute the EIP-712 signing digest for an {@link AIRuling}.
 *
 * `digest = keccak256(0x1901 || domainSeparator || structHash)` where
 * `structHash = keccak256(abi.encode(RULING_TYPEHASH, disputeId, ruling, confidence,
 * splitBps, timestamp, reasoningHash, bundleHash))`.
 *
 * This MUST equal the digest the on-chain BondEscalation contract verifies and the
 * GOLDEN_DIGEST in `EncodingCanonical.t.sol`.
 *
 * @returns The 32-byte EIP-712 digest as a 0x-prefixed hex string.
 */
export function computeRulingDigest(
  ruling: AIRuling,
  chainId: number,
  verifyingContract: string
): string {
  const domain = disputeEvaluatorDomain(chainId, verifyingContract);
  return ethers.TypedDataEncoder.hash(domain, AIRulingTypes as any, ruling as any);
}

/**
 * Compute the EIP-712 domain separator for the dispute evaluator domain.
 * `keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(name), keccak256(version), chainId, verifyingContract))`.
 */
export function computeRulingDomainSeparator(
  chainId: number,
  verifyingContract: string
): string {
  const domain = disputeEvaluatorDomain(chainId, verifyingContract);
  return ethers.TypedDataEncoder.hashDomain(domain);
}

/**
 * Compute the EIP-712 struct hash for an {@link AIRuling}
 * (`keccak256(abi.encode(RULING_TYPEHASH, ...fields))`).
 */
export function computeRulingStructHash(ruling: AIRuling): string {
  return ethers.TypedDataEncoder.hashStruct('AIRuling', AIRulingTypes as any, ruling as any);
}

/**
 * Minimal ethers v6 Signer surface used for typed-data signing.
 * (ethers v6 exposes `signTypedData` without the leading underscore.)
 */
interface SignerWithTypedData extends Signer {
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>
  ): Promise<string>;
}

/**
 * Sign an {@link AIRuling} with the given signer over the dispute-evaluator EIP-712 domain.
 *
 * Produces an ECDSA signature over {@link computeRulingDigest}. The resulting signature
 * is verifiable on-chain by BondEscalation's `_verifyEvaluatorSignatures`.
 *
 * @returns 65-byte signature as a 0x-prefixed hex string.
 */
export async function signRuling(
  ruling: AIRuling,
  signer: Signer,
  chainId: number,
  verifyingContract: string
): Promise<string> {
  const domain = disputeEvaluatorDomain(chainId, verifyingContract);
  const typedSigner = signer as SignerWithTypedData;
  return typedSigner.signTypedData(
    domain,
    AIRulingTypes as unknown as Record<string, Array<{ name: string; type: string }>>,
    ruling as unknown as Record<string, unknown>
  );
}

/**
 * Recover the signer address from an {@link AIRuling} and its signature.
 *
 * The address returned MUST match the evaluator that produced `signature` and is the
 * same address the on-chain `ecrecover` over the golden digest yields.
 *
 * @returns The recovered signer address (checksummed).
 */
export function recoverRulingSigner(
  ruling: AIRuling,
  signature: string,
  chainId: number,
  verifyingContract: string
): string {
  const domain = disputeEvaluatorDomain(chainId, verifyingContract);
  return ethers.verifyTypedData(
    domain,
    AIRulingTypes as unknown as Record<string, Array<{ name: string; type: string }>>,
    ruling as unknown as Record<string, unknown>,
    signature
  );
}
