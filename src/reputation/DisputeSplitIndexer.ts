/**
 * DisputeSplitIndexer — per-agent dispute split-rate surfacing (PRD P2-8,
 * AIP-14b §3.4 / §3.5, INV-22, INV-4).
 *
 * ## What it does
 * Surfaces the per-agent **split rate** — the fraction of an agent's resolved
 * disputes that ended in a SPLIT — so systematic dispute-to-split ambiguity
 * griefing is visible to future counterparties (e.g. *"14% of this agent's
 * disputes end in splits"*). A split carries NO on-chain reputation penalty
 * (INV-4); the rate is the ONLY signal, which is why under-counting it would
 * silently re-open the griefing path.
 *
 * ## OQ-11 (normative default — PRD §9, P2-8)
 * A dispute counts as a SPLIT for the HEADLINE rate when it resolved via EITHER:
 *   1. `DisputeSplitRecorded` — CompositeMediator ruling-2 (finalize /
 *      forceResolveStale / UMA no-winner fallback), OR
 *   2. kernel `DISPUTED → CANCELLED` — the kernel-level split path, which
 *      includes **admin-CANCELLED** disputes that bypass CompositeMediator.
 * BOTH are counted at **IDENTICAL weight**. Counting only (1) would miss
 * admin-CANCELLED splits and undercount the rate (R11). The headline `getSplitRate`
 * therefore treats them as fungible; `getSplitRateBreakdown` exposes the two
 * sub-counts for operators who want to see the source mix, WITHOUT changing the
 * headline number.
 *
 * ## ZERO-REMAINING CONSUMER RULE (AIP-14b §6, normative — load-bearing)
 * Split classification derives from **event semantics + escrow `remaining`**,
 * NEVER from resolution-proof amounts. When on-chain `remaining == 0` the proof
 * carries only a phantom 1-wei sentinel (placed to satisfy the kernel's
 * existence check); this indexer NEVER reads it as a payout. A drained dispute
 * (remaining==0) still counts as a split — the outcome is a split regardless of
 * whether escrow was already milestone-drained. {@link DisputeSplitIndexer.classifyPayout}
 * delegates to {@link decodeResolutionProof}, which zeros the phantom sentinel.
 *
 * PARITY: python-sdk-v2/src/agirails/reputation/dispute_split_indexer.py — every
 * public symbol here has a Py twin (same name/arity) and vice-versa. The shared
 * golden fixture `DISPUTE SYSTEM/test-vectors/dispute-split-indexer-vectors.json`
 * is consumed byte-identically by both SDKs.
 *
 * @module reputation/DisputeSplitIndexer
 */

import {
  DisputeSplitRecorded,
  DecodedResolutionProof,
  decodeResolutionProof,
  computeSplitRate,
} from '../dispute/CompositeMediator';

// PARITY: python-sdk-v2/src/agirails/reputation/dispute_split_indexer.py

// =====================================================================
// Outcome model
// =====================================================================

/**
 * How a dispute resolved, for split-rate accounting. Both `disputeSplitRecorded`
 * and `kernelDisputedToCancelled` are SPLITS and are counted at identical weight
 * (OQ-11). `settled` is a non-split resolution (kernel DISPUTED→SETTLED).
 *
 * PARITY: Py `DisputeOutcomeKind` (string literals identical).
 */
export type DisputeOutcomeKind =
  | 'disputeSplitRecorded'
  | 'kernelDisputedToCancelled'
  | 'settled';

/**
 * The two split sources are fungible for the headline rate.
 * @internal
 */
const SPLIT_KINDS: ReadonlySet<DisputeOutcomeKind> = new Set([
  'disputeSplitRecorded',
  'kernelDisputedToCancelled',
]);

/**
 * Returns true for both split kinds (OQ-11: identical weight). PARITY: Py
 * `is_split_kind`.
 */
export function isSplitKind(kind: DisputeOutcomeKind): boolean {
  return SPLIT_KINDS.has(kind);
}

/**
 * One resolved dispute, normalized for split-rate accounting.
 *
 * Assembled from {@link DisputeSplitRecorded} events + kernel
 * `StateTransitioned(DISPUTED→CANCELLED / DISPUTED→SETTLED)` events, joined with
 * the kernel transaction's `provider`/`requester`. `remaining` is the on-chain
 * escrow `remaining` at resolution time and is the ONLY thing (with `kind`) that
 * drives classification — proof amounts are never trusted (ZERO-REMAINING RULE).
 *
 * PARITY: Py `DisputeOutcome` dataclass.
 */
export interface DisputeOutcome {
  /** Provider agent address (the party whose split rate we surface). */
  provider: string;
  /** Requester address (counterparty). */
  requester: string;
  /** How the dispute resolved. */
  kind: DisputeOutcomeKind;
  /** On-chain escrow `remaining` at resolution time (default 0n). */
  remaining?: bigint;
  /** Split share in bps, when known from a `DisputeSplitRecorded` event. */
  splitBps?: number;
  /**
   * Raw resolution proof bytes (0x-hex), if available. ONLY used by
   * {@link DisputeSplitIndexer.classifyPayout} for the drained-dispute test;
   * NEVER read as a payout when `remaining == 0`.
   */
  proof?: string;
  /** Source txId, for traceability. */
  txId?: string;
}

/**
 * Per-agent split-rate result. PARITY: Py `SplitRateResult` dataclass.
 */
export interface SplitRateResult {
  /** The agent (provider address) this rate is for. */
  agentId: string;
  /** Number of this agent's disputes that ended in a split (OQ-11: both kinds). */
  splitCount: number;
  /** Total disputes observed for this agent (split + settled). */
  totalDisputes: number;
  /** `splitCount / totalDisputes` in [0,1]; 0 when no disputes. */
  splitRate: number;
}

/**
 * Split-rate result WITH the OQ-11 source breakdown. The headline `splitRate` is
 * unchanged (both sources at identical weight); the sub-counts are diagnostic.
 *
 * PARITY: Py `SplitRateBreakdown` dataclass.
 */
export interface SplitRateBreakdown extends SplitRateResult {
  /** Splits sourced from CompositeMediator `DisputeSplitRecorded`. */
  mediatorSplitCount: number;
  /** Splits sourced from kernel `DISPUTED→CANCELLED` (incl. admin-CANCELLED). */
  adminSplitCount: number;
}

// =====================================================================
// Address helper
// =====================================================================

/** Case-insensitive address equality (checksum-agnostic). @internal */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// =====================================================================
// Indexer
// =====================================================================

/**
 * Aggregates {@link DisputeOutcome} records into per-agent split rates.
 *
 * The indexer is a PURE accumulator over already-decoded outcomes — it does NOT
 * hold a provider/signer. Callers feed it outcomes assembled from
 * `EventMonitor.getDisputeEvents()` (which already surfaces `DisputeSplitRecorded`
 * AND kernel `DISPUTED→CANCELLED`) joined with kernel transaction lookups. This
 * keeps it deterministic + trivially testable against the shared golden fixture,
 * and keeps the ZERO-REMAINING rule enforced in one place.
 *
 * PARITY: Py `DisputeSplitIndexer`.
 */
export class DisputeSplitIndexer {
  private readonly outcomes: DisputeOutcome[] = [];

  /**
   * @param outcomes - optional initial outcomes to seed the indexer.
   */
  constructor(outcomes: DisputeOutcome[] = []) {
    for (const o of outcomes) this.addOutcome(o);
  }

  /** Record a single resolved dispute. PARITY: Py `add_outcome`. */
  addOutcome(outcome: DisputeOutcome): void {
    this.outcomes.push({ remaining: 0n, ...outcome });
  }

  /** Record many resolved disputes. PARITY: Py `add_outcomes`. */
  addOutcomes(outcomes: DisputeOutcome[]): void {
    for (const o of outcomes) this.addOutcome(o);
  }

  /** All recorded outcomes (defensive copy). PARITY: Py `get_outcomes`. */
  getOutcomes(): DisputeOutcome[] {
    return this.outcomes.map((o) => ({ ...o }));
  }

  /** Number of recorded outcomes. PARITY: Py `size`. */
  size(): number {
    return this.outcomes.length;
  }

  /** Clear all recorded outcomes. PARITY: Py `clear`. */
  clear(): void {
    this.outcomes.length = 0;
  }

  /**
   * The HEADLINE split rate for an agent (OQ-11 default).
   *
   * Counts BOTH `disputeSplitRecorded` AND `kernelDisputedToCancelled` (incl.
   * admin-CANCELLED) at IDENTICAL weight over the agent's total disputes. A
   * drained dispute (remaining==0) still counts as a split. PARITY: Py
   * `get_split_rate`.
   *
   * @param agentId - the provider address whose rate to compute.
   */
  getSplitRate(agentId: string): SplitRateResult {
    const mine = this.outcomes.filter((o) => sameAddress(o.provider, agentId));
    const splitRecorded = mine.filter((o) => o.kind === 'disputeSplitRecorded').length;
    const kernelDisputedToCancelled = mine.filter(
      (o) => o.kind === 'kernelDisputedToCancelled'
    ).length;
    const totalDisputes = mine.length;

    // Reuse the P2-5 primitive so the headline arithmetic is identical to the
    // CompositeMediator client's `computeSplitRate` (OQ-11: both at equal weight).
    const splitRate = computeSplitRate(
      splitRecorded,
      kernelDisputedToCancelled,
      totalDisputes
    );

    return {
      agentId,
      splitCount: splitRecorded + kernelDisputedToCancelled,
      totalDisputes,
      splitRate,
    };
  }

  /**
   * The split rate WITH the OQ-11 source breakdown. The headline `splitRate` is
   * identical to {@link getSplitRate} (both sources at equal weight); the
   * sub-counts (`mediatorSplitCount`, `adminSplitCount`) are diagnostic only.
   * PARITY: Py `get_split_rate_breakdown`.
   */
  getSplitRateBreakdown(agentId: string): SplitRateBreakdown {
    const base = this.getSplitRate(agentId);
    const mine = this.outcomes.filter((o) => sameAddress(o.provider, agentId));
    return {
      ...base,
      mediatorSplitCount: mine.filter((o) => o.kind === 'disputeSplitRecorded').length,
      adminSplitCount: mine.filter((o) => o.kind === 'kernelDisputedToCancelled').length,
    };
  }

  /**
   * Classify the ECONOMIC payout of one outcome under the ZERO-REMAINING
   * CONSUMER RULE (AIP-14b §6). Delegates to the P2-5 {@link decodeResolutionProof},
   * which ZEROS both payouts and flags `phantomSentinel` when `remaining == 0`.
   *
   * Used by the drained-dispute test to assert that NO 1-wei payout is ever
   * surfaced. Returns `null` when the outcome carried no proof (split counting
   * does not need it). PARITY: Py `classify_payout`.
   *
   * @throws never for missing proof — returns null instead.
   */
  classifyPayout(outcome: DisputeOutcome): DecodedResolutionProof | null {
    if (outcome.proof === undefined) return null;
    return decodeResolutionProof(outcome.proof, outcome.remaining ?? 0n);
  }
}

/**
 * Build a {@link DisputeOutcome} from a decoded `DisputeSplitRecorded` event.
 * The `remaining` MUST be supplied separately (read from the escrow at
 * resolution time) — it is NOT in the event. PARITY: Py
 * `outcome_from_split_recorded`.
 */
export function outcomeFromSplitRecorded(
  event: DisputeSplitRecorded,
  remaining: bigint = 0n,
  proof?: string
): DisputeOutcome {
  return {
    provider: event.provider,
    requester: event.requester,
    kind: 'disputeSplitRecorded',
    remaining,
    splitBps: event.splitBps,
    proof,
    txId: event.txId,
  };
}
