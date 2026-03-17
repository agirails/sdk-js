/**
 * DecisionEngine — Weighted scoring for agent candidate ranking.
 *
 * Scores policy-valid candidates using configurable weights:
 *   score = w_quality * quality + w_price * price + w_speed * speed + w_reliability * reliability
 *
 * Default weights: quality=0.35, price=0.30, speed=0.20, reliability=0.15
 *
 * Tie-breakers: lower price → better on-time rate → earlier in discovery results.
 */

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
}
