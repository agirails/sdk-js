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
  | { rule: 'currency_mismatch'; detail: string }
  | { rule: 'unit_mismatch'; detail: string };

export interface ProviderPolicyResult {
  allowed: boolean;
  violations: ProviderPolicyViolation[];
  /**
   * When `allowed`, the amount we SHOULD quote per this policy,
   * expressed in USDC base units (1e6 per $1) as a decimal string.
   * Using string-of-base-units throughout avoids Number/float drift
   * on very large amounts and matches what the QuoteMessage carries.
   *
   * Rule: quote our ideal if buyer maxPrice ≥ ideal; otherwise quote
   * at buyer maxPrice (still ≥ floor, validated above). Never below
   * min_acceptable.
   */
  recommended_quote_amount_base_units?: string;
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

/** Base units per $1 for supported currencies. USDC = 1e6 (6 decimals). */
const BASE_UNITS_PER_USD: Record<string, bigint> = {
  USDC: 1_000_000n,
};
/** Platform minimum in base units — $0.05 × 1e6 for USDC. */
const PLATFORM_MIN_BASE_UNITS: Record<string, bigint> = {
  USDC: 50_000n,
};
const DEFAULT_MIN_DEADLINE_SECONDS = 60;

/** Convert a human amount (e.g. 5, 10.5) to base units (bigint). */
function toBaseUnits(amount: number, currency: string): bigint {
  const perUsd = BASE_UNITS_PER_USD[currency.toUpperCase()];
  if (!perUsd) throw new Error(`Unsupported currency: ${currency}`);
  // Do the scaling as string→BigInt to avoid float drift on amounts
  // that don't fit cleanly in double precision (e.g. 0.1).
  const [whole, frac = ''] = String(amount).split('.');
  const fracPadded = (frac + '000000').slice(0, String(perUsd).length - 1);
  return BigInt(whole) * perUsd + BigInt(fracPadded || '0');
}

/** Format base units back to a human string for error messages. */
function formatFromBaseUnits(baseUnits: bigint, currency: string): string {
  const perUsd = BASE_UNITS_PER_USD[currency.toUpperCase()];
  if (!perUsd) return `${baseUnits} base units`;
  const whole = baseUnits / perUsd;
  const frac = baseUnits % perUsd;
  const fracStr = frac.toString().padStart(String(perUsd).length - 1, '0').replace(/0+$/, '');
  return fracStr ? `$${whole}.${fracStr}` : `$${whole}`;
}

export class ProviderPolicyEngine {
  private readonly policy: ProviderPolicy;
  private readonly floorBaseUnits: bigint;
  private readonly idealBaseUnits: bigint;
  private readonly currency: string;

  constructor(policy: ProviderPolicy) {
    const currency = policy.pricing.min_acceptable.currency;
    const platformMin = PLATFORM_MIN_BASE_UNITS[currency.toUpperCase()];
    if (!platformMin) {
      throw new Error(`Unsupported currency in policy: ${currency}`);
    }

    // Enforce pricing invariants at construction — fail fast so mis-
    // configured providers don't quote garbage.
    const floorBu = toBaseUnits(policy.pricing.min_acceptable.amount, currency);
    const idealBu = toBaseUnits(policy.pricing.ideal_price.amount, currency);

    if (floorBu < platformMin) {
      throw new Error(
        `min_acceptable.amount (${formatFromBaseUnits(floorBu, currency)}) below platform minimum (${formatFromBaseUnits(platformMin, currency)})`,
      );
    }
    if (idealBu < floorBu) {
      throw new Error(
        `ideal_price.amount (${formatFromBaseUnits(idealBu, currency)}) must be ≥ min_acceptable.amount (${formatFromBaseUnits(floorBu, currency)})`,
      );
    }
    if (policy.pricing.min_acceptable.currency !== policy.pricing.ideal_price.currency) {
      throw new Error('min_acceptable.currency must equal ideal_price.currency');
    }
    if (policy.pricing.min_acceptable.unit !== policy.pricing.ideal_price.unit) {
      throw new Error('min_acceptable.unit must equal ideal_price.unit');
    }

    this.policy = policy;
    this.floorBaseUnits = floorBu;
    this.idealBaseUnits = idealBu;
    this.currency = currency;
  }

  /**
   * Evaluate an incoming request against policy. Returns `allowed: true`
   * with `recommended_quote_amount_base_units` (bigint-as-string) when
   * we should quote, or `allowed: false` with the specific rule(s)
   * violated.
   *
   * All numeric comparisons use BigInt on base units — no float drift,
   * no precision loss for large amounts.
   */
  evaluate(req: IncomingRequest): ProviderPolicyResult {
    const violations: ProviderPolicyViolation[] = [];

    if (!this.policy.services.includes(req.serviceType)) {
      violations.push({
        rule: 'service_not_offered',
        detail: `We don't offer service "${req.serviceType}". Configured: ${this.policy.services.join(', ')}`,
      });
    }

    if (req.currency.toUpperCase() !== this.currency.toUpperCase()) {
      violations.push({
        rule: 'currency_mismatch',
        detail: `Request in ${req.currency}, we quote in ${this.currency}`,
      });
    }

    // `unit` is the pricing unit (job, hour, page, request, …).
    // Buyer quoting $5/hour vs provider priced-per-job is a genuine
    // mismatch and must not silently be quoted.
    if (req.unit !== this.policy.pricing.min_acceptable.unit) {
      violations.push({
        rule: 'unit_mismatch',
        detail: `Request unit "${req.unit}" does not match policy unit "${this.policy.pricing.min_acceptable.unit}"`,
      });
    }

    let maxPriceBu: bigint;
    try {
      maxPriceBu = BigInt(req.maxPrice);
    } catch {
      violations.push({
        rule: 'max_price_below_floor',
        detail: `Invalid maxPrice: ${req.maxPrice}`,
      });
      maxPriceBu = 0n;
    }
    if (maxPriceBu < this.floorBaseUnits) {
      violations.push({
        rule: 'max_price_below_floor',
        detail: `Buyer maxPrice ${formatFromBaseUnits(maxPriceBu, this.currency)} below our floor ${formatFromBaseUnits(this.floorBaseUnits, this.currency)}`,
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
    // BigInt min/max via ternary since there's no Math.min for BigInt.
    const ceilingBu = maxPriceBu < this.idealBaseUnits ? maxPriceBu : this.idealBaseUnits;
    const recommendedBu = ceilingBu > this.floorBaseUnits ? ceilingBu : this.floorBaseUnits;

    return {
      allowed: true,
      violations: [],
      recommended_quote_amount_base_units: recommendedBu.toString(),
    };
  }

  /**
   * Decide whether to accept a buyer's counter-offer.
   *
   * Simple rule: accept if counter ≥ min_acceptable; reject otherwise.
   * All arithmetic is BigInt on base units — no float drift.
   * Phase 3 will extend this with `counter-counter` strategies.
   */
  evaluateCounter(counterAmountBaseUnits: string): { decision: 'accept' | 'reject'; reason: string } {
    let counter: bigint;
    try {
      counter = BigInt(counterAmountBaseUnits);
    } catch {
      return { decision: 'reject', reason: `Invalid counter amount: ${counterAmountBaseUnits}` };
    }
    if (counter < this.floorBaseUnits) {
      return {
        decision: 'reject',
        reason: `Counter ${formatFromBaseUnits(counter, this.currency)} below our floor ${formatFromBaseUnits(this.floorBaseUnits, this.currency)}`,
      };
    }
    return {
      decision: 'accept',
      reason: `Counter ${formatFromBaseUnits(counter, this.currency)} meets our floor`,
    };
  }

  /** Expose ttl as seconds for callers building QuoteMessage.expiresAt. */
  get quoteTtlSeconds(): number {
    return parseTtl(this.policy.quote_ttl);
  }

  /** Expose the policy's currency for orchestrator wiring. */
  get policyCurrency(): string {
    return this.currency;
  }

  /** Expose the policy's unit for orchestrator wiring + UI. */
  get policyUnit(): string {
    return this.policy.pricing.min_acceptable.unit;
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
