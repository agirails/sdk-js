/**
 * PricingStrategy - Cost + Margin pricing model
 *
 * Allows agents to define their costs and desired profit margin.
 * SDK automatically calculates prices and decides whether to accept jobs.
 *
 * @packageDocumentation
 */

/**
 * Cost configuration for a service
 */
export interface ServiceCost {
  /**
   * Fixed base cost per job (USDC)
   *
   * @example
   * base: 0.50 // $0.50 per job regardless of input size
   */
  base?: number;

  /**
   * Per-unit cost
   *
   * Allows pricing based on input size (words, tokens, images, etc.)
   *
   * @example
   * ```typescript
   * perUnit: {
   *   unit: 'word',
   *   rate: 0.005  // $0.005 per word
   * }
   * // For 1000-word translation: cost = 0.50 (base) + 1000 * 0.005 = $5.50
   * ```
   */
  perUnit?: {
    /**
     * Unit type (word, token, image, minute, request, etc.)
     */
    unit: string;

    /**
     * Cost per unit (USDC)
     */
    rate: number;
  };

  /**
   * API cost auto-calculation
   *
   * Automatically calculate costs based on known API pricing.
   * SDK knows the costs for common APIs (OpenAI, Anthropic, etc.)
   *
   * @example
   * ```typescript
   * api: 'openai:gpt-4-turbo'
   * // SDK automatically calculates cost based on input tokens
   * ```
   *
   * Supported APIs (MVP):
   * - 'openai:gpt-4-turbo'
   * - 'openai:gpt-3.5-turbo'
   * - 'anthropic:claude-3-sonnet'
   * - 'anthropic:claude-3-haiku'
   */
  api?: string;
}

/**
 * Pricing behavior when job budget is below calculated price
 */
export type BelowPriceBehavior = 'reject' | 'counter-offer';

/**
 * Pricing behavior when job budget is below cost (would lose money)
 */
export type BelowCostBehavior = 'reject' | 'counter-offer';

/**
 * Pricing strategy configuration
 */
export interface PricingStrategy {
  /**
   * Cost configuration
   */
  cost: ServiceCost;

  /**
   * Desired profit margin (0.0 - 1.0)
   *
   * This is the percentage of profit you want to make on top of your costs.
   *
   * @example
   * margin: 0.40 // 40% profit margin
   *
   * // If cost is $10, price will be:
   * // price = cost / (1 - margin) = $10 / 0.6 = $16.67
   * // profit = $16.67 - $10 = $6.67 (40% of $16.67)
   */
  margin: number;

  /**
   * Minimum price in USDC
   *
   * Even if calculated price is lower, never accept less than this.
   *
   * @default 0.05 (ACTP protocol minimum)
   */
  minimum?: number;

  /**
   * Maximum price in USDC
   *
   * Never charge more than this, even if calculated price is higher.
   *
   * @default 10000
   */
  maximum?: number;

  /**
   * Pricing behavior configuration
   */
  behavior?: {
    /**
     * What to do when job budget is below calculated price but above cost
     *
     * - 'reject': Reject the job immediately
     * - 'counter-offer': Respond with QUOTED state with your price
     *
     * @default 'counter-offer'
     */
    belowPrice?: BelowPriceBehavior;

    /**
     * What to do when job budget is below cost (would lose money)
     *
     * - 'reject': Reject the job immediately (recommended)
     * - 'counter-offer': Respond with QUOTED state with your price
     *
     * @default 'reject'
     */
    belowCost?: BelowCostBehavior;

    /**
     * Maximum negotiation rounds
     *
     * How many times to counter-offer before giving up.
     *
     * @default 3
     */
    maxNegotiationRounds?: number;
  };
}

/**
 * Price calculation result
 */
export interface PriceCalculation {
  /**
   * Total cost (USDC)
   */
  cost: number;

  /**
   * Calculated price with margin (USDC)
   */
  price: number;

  /**
   * Profit amount (USDC)
   */
  profit: number;

  /**
   * Profit margin percentage (0.0 - 1.0)
   */
  marginPercent: number;

  /**
   * Decision: should we accept the job at the offered budget?
   */
  decision: 'accept' | 'counter-offer' | 'reject';

  /**
   * Reason for decision
   */
  reason: string;

  /**
   * Breakdown of cost calculation (for debugging)
   */
  breakdown: {
    baseCost: number;
    unitCost: number;
    units?: number;
    apiCost?: number;
  };
}
