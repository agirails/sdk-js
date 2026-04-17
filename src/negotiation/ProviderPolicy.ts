/**
 * ProviderPolicy — hard guardrails for autonomous provider quoting.
 *
 * Symmetric to BuyerPolicy. Provider configures what they'll deliver,
 * their price floor, and their lifecycle preferences; ProviderPolicyEngine
 * enforces those invariants on every incoming request so the provider
 * never quotes below floor, outside their service menu, or for a
 * transaction they can't realistically complete before the deadline.
 *
 * @module negotiation/ProviderPolicy
 * @see Protocol/aips/AIP-2.1-DRAFT.md §5.2 (ProviderPolicy.ts creation)
 */

// ============================================================================
// Types
// ============================================================================

/**
 * What this agent provides + at what terms.
 *
 * Pricing invariant (enforced at construction):
 *   ideal_price.amount ≥ min_acceptable.amount ≥ PLATFORM_MIN_USDC
 *
 * `currency`/`unit` must be identical across min_acceptable and
 * ideal_price — we compare amounts directly, there's no FX in v1.
 */
export interface ProviderPolicy {
  /**
   * Services this provider offers. Incoming requests for service types
   * NOT in this list get a 'skip' decision (let the tx timeout to
   * CANCELLED; we don't quote for work we don't do).
   */
  services: string[];

  pricing: {
    /** Absolute floor. Any buyer maxPrice below this → skip. */
    min_acceptable: { amount: number; currency: string; unit: string };
    /** Preferred quote amount when buyer's maxPrice ≥ ideal. */
    ideal_price: { amount: number; currency: string; unit: string };
  };

  /** Quote validity window (e.g. "15m"). Governs our QuoteMessage expiresAt. */
  quote_ttl: string;

  /**
   * Minimum time (seconds) we need between now and tx.deadline to
   * realistically deliver. Requests with a tighter deadline get 'skip'.
   * Defaults to 60s if omitted.
   */
  min_deadline_seconds?: number;
}

export type ProviderPolicyViolation =
  | { rule: 'service_not_offered'; detail: string }
  | { rule: 'max_price_below_floor'; detail: string }
  | { rule: 'deadline_too_tight'; detail: string }
  | { rule: 'currency_mismatch'; detail: string };

export interface ProviderPolicyResult {
  allowed: boolean;
  violations: ProviderPolicyViolation[];
  /**
   * When `allowed`, the amount we SHOULD quote per this policy.
   * Rule: quote our ideal if buyer maxPrice ≥ ideal; otherwise quote
   * at buyer maxPrice (still ≥ floor, validated above). Never below
   * min_acceptable.
   */
  recommended_quote_amount?: number;
}

/**
 * Incoming request surface — the minimum the orchestrator needs to
 * decide whether + at what price to quote. Extracted from the
 * on-chain transaction plus any off-chain context the caller has
 * (service type, consumer DID).
 */
export interface IncomingRequest {
  txId: string;
  consumer: string; // DID
  /** Buyer's offered amount in USDC base units (smallest unit, string). */
  offeredAmount: string;
  /** Buyer's ceiling in USDC base units. */
  maxPrice: string;
  /** Unix seconds — tx.deadline from on-chain. */
  deadline: number;
  /** Service identifier (e.g. "code-review"). */
  serviceType: string;
  currency: string; // "USDC"
  unit: string; // "job" | whatever
}

// ============================================================================
// Engine
// ============================================================================

const PLATFORM_MIN_USDC = 0.05;
const DEFAULT_MIN_DEADLINE_SECONDS = 60;

export class ProviderPolicyEngine {
  private readonly policy: ProviderPolicy;

  constructor(policy: ProviderPolicy) {
    // Enforce pricing invariant at construction — fail fast so mis-
    // configured providers don't quote garbage.
    if (policy.pricing.min_acceptable.amount < PLATFORM_MIN_USDC) {
      throw new Error(
        `min_acceptable.amount ($${policy.pricing.min_acceptable.amount}) below platform minimum ($${PLATFORM_MIN_USDC})`,
      );
    }
    if (policy.pricing.ideal_price.amount < policy.pricing.min_acceptable.amount) {
      throw new Error(
        `ideal_price.amount (${policy.pricing.ideal_price.amount}) must be ≥ min_acceptable.amount (${policy.pricing.min_acceptable.amount})`,
      );
    }
    if (policy.pricing.min_acceptable.currency !== policy.pricing.ideal_price.currency) {
      throw new Error('min_acceptable.currency must equal ideal_price.currency');
    }
    if (policy.pricing.min_acceptable.unit !== policy.pricing.ideal_price.unit) {
      throw new Error('min_acceptable.unit must equal ideal_price.unit');
    }
    this.policy = policy;
  }

  /**
   * Evaluate an incoming request against policy. Returns `allowed: true`
   * with `recommended_quote_amount` when we should quote, or `allowed:
   * false` with the specific rule(s) violated.
   */
  evaluate(req: IncomingRequest): ProviderPolicyResult {
    const violations: ProviderPolicyViolation[] = [];

    if (!this.policy.services.includes(req.serviceType)) {
      violations.push({
        rule: 'service_not_offered',
        detail: `We don't offer service "${req.serviceType}". Configured: ${this.policy.services.join(', ')}`,
      });
    }

    if (req.currency.toUpperCase() !== this.policy.pricing.min_acceptable.currency.toUpperCase()) {
      violations.push({
        rule: 'currency_mismatch',
        detail: `Request in ${req.currency}, we quote in ${this.policy.pricing.min_acceptable.currency}`,
      });
    }

    // Amount comparisons convert request base units to USDC (6 decimals).
    const maxPriceUsdc = Number(BigInt(req.maxPrice)) / 1_000_000;
    if (maxPriceUsdc < this.policy.pricing.min_acceptable.amount) {
      violations.push({
        rule: 'max_price_below_floor',
        detail: `Buyer maxPrice $${maxPriceUsdc} below our floor $${this.policy.pricing.min_acceptable.amount}`,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const minDeadlineSeconds = this.policy.min_deadline_seconds ?? DEFAULT_MIN_DEADLINE_SECONDS;
    if (req.deadline - now < minDeadlineSeconds) {
      violations.push({
        rule: 'deadline_too_tight',
        detail: `tx.deadline - now = ${req.deadline - now}s, need ≥ ${minDeadlineSeconds}s`,
      });
    }

    if (violations.length > 0) {
      return { allowed: false, violations };
    }

    // Recommended quote: ideal unless buyer can't afford it, in which
    // case we quote at maxPrice (still above floor — validated above).
    // Never below floor.
    const ideal = this.policy.pricing.ideal_price.amount;
    const recommended = Math.max(
      this.policy.pricing.min_acceptable.amount,
      Math.min(ideal, maxPriceUsdc),
    );

    return {
      allowed: true,
      violations: [],
      recommended_quote_amount: recommended,
    };
  }

  /**
   * Decide whether to accept a buyer's counter-offer.
   *
   * Simple rule: accept if counter ≥ min_acceptable; reject otherwise.
   * Phase 3 will extend this with `counter-counter` strategies.
   */
  evaluateCounter(counterAmountBaseUnits: string): { decision: 'accept' | 'reject'; reason: string } {
    const counter = Number(BigInt(counterAmountBaseUnits)) / 1_000_000;
    if (counter < this.policy.pricing.min_acceptable.amount) {
      return {
        decision: 'reject',
        reason: `Counter $${counter} below our floor $${this.policy.pricing.min_acceptable.amount}`,
      };
    }
    return {
      decision: 'accept',
      reason: `Counter $${counter} meets our floor`,
    };
  }

  /** Expose ttl as seconds for callers building QuoteMessage.expiresAt. */
  get quoteTtlSeconds(): number {
    return parseTtl(this.policy.quote_ttl);
  }
}

/**
 * Parse a short duration string like "15m", "1h", "30s" into seconds.
 * Mirror of PolicyEngine.parseTtl (buyer side) so both sides use the
 * same format in their JSON policies.
 */
export function parseTtl(ttl: string): number {
  const match = ttl.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) {
    throw new Error(`Invalid TTL format: "${ttl}" (expected e.g. "15m", "1h", "30s")`);
  }
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  return n * 3600;
}
