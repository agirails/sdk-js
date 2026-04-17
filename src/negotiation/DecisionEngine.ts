/**
 * DecisionEngine — Weighted scoring for agent candidate ranking + per-quote
 * negotiation decisions.
 *
 * Two responsibilities:
 *   rank(candidates, maxPrice?)         — pick who to quote-request
 *   evaluateQuote(quote, policy, …)     — AIP-2.1: decide accept|counter|reject
 *                                         given a provider's signed QuoteMessage
 *
 * Scores policy-valid candidates using configurable weights:
 *   score = w_quality * quality + w_price * price + w_speed * speed + w_reliability * reliability
 *
 * Default weights: quality=0.35, price=0.30, speed=0.20, reliability=0.15
 *
 * Tie-breakers: lower price → better on-time rate → earlier in discovery results.
 */

import type { BuyerPolicy } from './PolicyEngine';

// ============================================================================
// Types
// ============================================================================

export interface ScoringWeights {
  quality?: number;
  price?: number;
  speed?: number;
  reliability?: number;
}

export interface CandidateStats {
  slug: string;
  unit_price: number;
  reputation_score: number; // 0-100
  success_rate: number; // 0-100
  avg_completion_time_seconds: number | null;
  completed_transactions: number;
}

export interface ScoredCandidate {
  slug: string;
  score: number;
  breakdown: {
    quality: number;
    price: number;
    speed: number;
    reliability: number;
  };
}

// ============================================================================
// AIP-2.1 evaluateQuote types
// ============================================================================

/**
 * Minimal quote shape evaluateQuote operates on. Keeps DecisionEngine
 * decoupled from the full QuoteMessage type + signature verification
 * (that's BuyerOrchestrator's job).
 */
export interface QuoteForEvaluation {
  /** Base units as string (bigint-safe). */
  quotedAmount: string;
  /** Base units as string. */
  originalAmount: string;
  /** Base units as string. */
  maxPrice: string;
  /** `true` when the provider flags this as their final offer. */
  final_offer?: boolean;
}

/**
 * Decision for a single incoming provider quote.
 *
 * - accept  → caller calls acceptQuote(txId, provider's quotedAmount)
 *             then linkEscrow. Commits at provider's price.
 * - counter → caller builds + sends a CounterOfferMessage at
 *             `amountBaseUnits`. On provider's acceptance, caller
 *             calls acceptQuote at the counter amount + linkEscrow.
 * - reject  → caller transitions CANCELLED and tries next candidate.
 */
export type QuoteEvaluation =
  | { action: 'accept'; reason: string }
  | { action: 'counter'; amountBaseUnits: string; reason: string }
  | { action: 'reject'; reason: string };

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_WEIGHTS: Required<ScoringWeights> = {
  quality: 0.35,
  price: 0.30,
  speed: 0.20,
  reliability: 0.15,
};

// ============================================================================
// DecisionEngine
// ============================================================================

export class DecisionEngine {
  private weights: Required<ScoringWeights>;

  constructor(weights?: ScoringWeights) {
    this.weights = {
      quality: weights?.quality ?? DEFAULT_WEIGHTS.quality,
      price: weights?.price ?? DEFAULT_WEIGHTS.price,
      speed: weights?.speed ?? DEFAULT_WEIGHTS.speed,
      reliability: weights?.reliability ?? DEFAULT_WEIGHTS.reliability,
    };

    // Normalize weights to sum to 1.0
    const total = this.weights.quality + this.weights.price + this.weights.speed + this.weights.reliability;
    if (total > 0 && Math.abs(total - 1.0) > 0.001) {
      this.weights.quality /= total;
      this.weights.price /= total;
      this.weights.speed /= total;
      this.weights.reliability /= total;
    }
  }

  /**
   * Score and rank candidates. Returns sorted by score descending.
   * If maxPrice is provided, candidates exceeding it are filtered out.
   */
  rank(candidates: CandidateStats[], maxPrice?: number): ScoredCandidate[] {
    // Filter out over-budget candidates
    const eligible = maxPrice != null
      ? candidates.filter((c) => c.unit_price <= maxPrice)
      : candidates;

    if (eligible.length === 0) return [];

    // Compute min/max for normalization
    const prices = eligible.map((c) => c.unit_price);
    const times = eligible
      .map((c) => c.avg_completion_time_seconds)
      .filter((t): t is number => t != null);

    const minPrice = Math.min(...prices);
    const maxPriceVal = Math.max(...prices);
    const priceRange = maxPriceVal - minPrice;

    const minTime = times.length > 0 ? Math.min(...times) : 0;
    const maxTime = times.length > 0 ? Math.max(...times) : 1;
    const timeRange = maxTime - minTime;

    const scored = eligible.map((c): ScoredCandidate => {
      // Quality: reputation_score normalized to 0-1
      const quality = c.reputation_score / 100;

      // Price: inverted (lower is better), normalized to 0-1
      const price = priceRange > 0
        ? 1 - (c.unit_price - minPrice) / priceRange
        : 1; // all same price → all get max score

      // Speed: inverted (faster is better), normalized to 0-1
      // Agents with no completion data are penalized (0.5) vs those with data (1.0 when equal)
      let speed: number;
      if (c.avg_completion_time_seconds != null) {
        speed = timeRange > 0
          ? 1 - (c.avg_completion_time_seconds - minTime) / timeRange
          : 1.0; // all candidates with data are equal on speed
      } else {
        speed = 0.5; // no data — penalized vs agents with track record
      }

      // Reliability: success_rate normalized to 0-1
      const reliability = c.success_rate / 100;

      const score =
        this.weights.quality * quality +
        this.weights.price * price +
        this.weights.speed * speed +
        this.weights.reliability * reliability;

      return {
        slug: c.slug,
        score,
        breakdown: { quality, price, speed, reliability },
      };
    });

    // Sort by score descending, then tie-breakers
    scored.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.001) return b.score - a.score;

      // Tie-breaker 1: lower price
      const aCandidate = eligible.find((c) => c.slug === a.slug)!;
      const bCandidate = eligible.find((c) => c.slug === b.slug)!;
      if (aCandidate.unit_price !== bCandidate.unit_price) {
        return aCandidate.unit_price - bCandidate.unit_price;
      }

      // Tie-breaker 2: higher success rate (on-time proxy)
      if (aCandidate.success_rate !== bCandidate.success_rate) {
        return bCandidate.success_rate - aCandidate.success_rate;
      }

      // Tie-breaker 3: original order (earlier in discovery results)
      return 0;
    });

    return scored;
  }

  /**
   * AIP-2.1 §5.2 — decide whether to accept a provider's quote,
   * counter at a better price, or reject outright.
   *
   * Decision tree (all arithmetic in BigInt base units; no float drift):
   *
   * 1. Quote exceeds maxPrice               → reject
   * 2. Provider flagged final_offer         → accept if ≤ max; else reject
   * 3. Quote ≤ target                        → accept (we'd take this
   *                                            without negotiating)
   * 4. Rounds budget exhausted              → accept if ≤ max; else reject
   * 5. counter_strategy === 'walk'          → reject (no counter-offers)
   * 6. Otherwise                             → counter at strategy amount
   *
   * Defaults when policy fields are omitted:
   *   rounds_per_provider    = 1          (original fixed-price flow)
   *   counter_strategy       = 'walk'     (no counter unless opted in)
   *   target_unit_price      = 50% of max (conservative — prefer accept)
   *
   * @param quote    - minimal shape of the provider's signed quote
   * @param policy   - buyer policy; defaults applied inline
   * @param roundsUsedSoFar - how many rounds we've already spent with
   *                   THIS provider on THIS txId (0 on first evaluation)
   */
  evaluateQuote(
    quote: QuoteForEvaluation,
    policy: BuyerPolicy,
    roundsUsedSoFar = 0,
  ): QuoteEvaluation {
    let quoted: bigint;
    let max: bigint;
    try {
      quoted = BigInt(quote.quotedAmount);
      max = BigInt(quote.maxPrice);
    } catch {
      return { action: 'reject', reason: 'Quote has non-numeric amount fields' };
    }

    if (quoted > max) {
      return { action: 'reject', reason: `Quote ${quoted} exceeds maxPrice ${max}` };
    }

    // Target unit price — defaults to half of max when policy omits it.
    // Convert via string-based scaling (no Number * 1e6 round-trip)
    // so big amounts ($9q+ in base units) stay precise. Default-half
    // path uses BigInt division which is also exact.
    const maxHumanRaw = policy.constraints.max_unit_price.amount;
    const targetBu = policy.target_unit_price
      ? humanToBaseUnits(policy.target_unit_price.amount, 1_000_000n)
      : humanToBaseUnits(maxHumanRaw, 1_000_000n) / 2n;

    if (quote.final_offer === true) {
      // Provider flagged last round — accept if we can afford it,
      // otherwise walk. No point trying to counter something marked
      // "take it or leave it".
      return quoted <= max
        ? { action: 'accept', reason: 'Final offer from provider, within max' }
        : { action: 'reject', reason: 'Final offer exceeds max (should already be filtered above, defense-in-depth)' };
    }

    if (quoted <= targetBu) {
      return { action: 'accept', reason: `Quote ${quoted} ≤ target ${targetBu}` };
    }

    const roundsPerProvider = policy.negotiation.rounds_per_provider ?? 1;
    if (roundsUsedSoFar + 1 >= roundsPerProvider) {
      // We're on our last permitted round with this provider. Accept if
      // affordable rather than walk away; the alternative is starting
      // over with a worse-ranked candidate.
      return quoted <= max
        ? { action: 'accept', reason: `Rounds budget exhausted; accepting ${quoted} ≤ max ${max}` }
        : { action: 'reject', reason: 'Rounds budget exhausted and quote > max' };
    }

    const strategy = policy.negotiation.counter_strategy ?? 'walk';
    if (strategy === 'walk') {
      return { action: 'reject', reason: 'Quote above target and counter_strategy=walk' };
    }

    // Compute counter amount per strategy. Never below platform minimum
    // ($0.05 = 50_000 base units) — that's a QuoteBuilder invariant too,
    // so we front-load the check to avoid handing the builder garbage.
    const PLATFORM_MIN = 50_000n;
    let counterBu: bigint;
    if (strategy === 'undercut') {
      // Go straight to our target; provider can take it or counter-back.
      counterBu = targetBu;
    } else {
      // midpoint: halfway between quoted and target.
      counterBu = (quoted + targetBu) / 2n;
    }
    if (counterBu < PLATFORM_MIN) counterBu = PLATFORM_MIN;
    if (counterBu >= quoted) {
      // Counter must be strictly below quote for CounterOfferBuilder to
      // accept it (otherwise "just accept the quote"). Fall back to
      // accepting the provider's quote if our strategy math doesn't
      // yield a lower amount.
      return { action: 'accept', reason: 'Counter math would not undercut — accepting provider quote' };
    }

    return {
      action: 'counter',
      amountBaseUnits: counterBu.toString(),
      reason: `counter_strategy=${strategy}: counter at ${counterBu} vs quote ${quoted}`,
    };
  }
}

/**
 * Convert a human amount (e.g. 5, 10.5) to base units as bigint
 * using string parsing — never goes through Number * 1e6, so amounts
 * past the JavaScript safe-integer range still scale exactly (within
 * what JavaScript's Number can represent).
 *
 * `perUsd` should equal 10^decimals for the target currency
 * (1_000_000n for USDC's 6 decimals).
 *
 * Uses Number.toLocaleString to force decimal notation: `String(1e21)`
 * yields `"1e+21"` which BigInt() rejects, so we instead emit
 * `"1000000000000000000000"` and parse cleanly. Negatives and
 * non-finite values fail loud.
 */
function humanToBaseUnits(amount: number, perUsd: bigint): bigint {
  if (!Number.isFinite(amount)) {
    throw new Error(`humanToBaseUnits: amount must be finite (got ${amount})`);
  }
  if (amount < 0) {
    throw new Error(`humanToBaseUnits: amount must be non-negative (got ${amount})`);
  }
  const decimalsLen = String(perUsd).length - 1;
  // toLocaleString returns fixed (decimal) notation even when the
  // number's default String() coercion would use scientific notation.
  // useGrouping:false strips thousands separators (",") so the parser
  // sees a single contiguous numeric run.
  const fixed = amount.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: decimalsLen,
  });
  const [whole, frac = ''] = fixed.split('.');
  const fracPadded = (frac + '0'.repeat(decimalsLen)).slice(0, decimalsLen);
  const wholeBu = BigInt(whole) * perUsd;
  const fracBu = fracPadded ? BigInt(fracPadded) : 0n;
  return wholeBu + fracBu;
}
