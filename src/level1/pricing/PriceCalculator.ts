/**
 * PriceCalculator - Calculate prices based on cost + margin model
 *
 * Implements the pricing logic for AGIRAILS agents to automatically
 * calculate service prices and decide whether to accept jobs.
 *
 * @packageDocumentation
 */

import { PricingStrategy, PriceCalculation } from './PricingStrategy';
import { Job } from '../types/Job';

/**
 * Calculate price for a job based on pricing strategy
 *
 * This function calculates the total cost (base + per-unit), applies the
 * desired profit margin, enforces min/max bounds, and determines whether
 * to accept, counter-offer, or reject the job.
 *
 * @param strategy - Pricing strategy configuration
 * @param job - Job to calculate price for
 * @returns Price calculation result with decision
 *
 * @example
 * ```typescript
 * const strategy: PricingStrategy = {
 *   cost: {
 *     base: 0.50,
 *     perUnit: { unit: 'word', rate: 0.005 }
 *   },
 *   margin: 0.40, // 40% profit margin
 *   minimum: 0.05,
 *   maximum: 10000
 * };
 *
 * const job: Job = {
 *   id: '0x1234',
 *   service: 'translation',
 *   input: { text: 'Hello world' }, // 2 words
 *   budget: 10,
 *   deadline: new Date(),
 *   requester: '0xRequester',
 *   metadata: {}
 * };
 *
 * const calc = calculatePrice(strategy, job);
 * // calc.cost = 0.50 + (2 * 0.005) = 0.51
 * // calc.price = 0.51 / (1 - 0.40) = 0.85
 * // calc.profit = 0.85 - 0.51 = 0.34
 * // calc.marginPercent = 0.34 / 0.85 = 0.40 (40%)
 * // calc.decision = 'accept' (budget $10 >= price $0.85)
 * ```
 */
export function calculatePrice(strategy: PricingStrategy, job: Job): PriceCalculation {
  // Calculate base cost
  const baseCost = strategy.cost.base ?? 0;

  // Calculate per-unit cost
  let unitCost = 0;
  let units: number | undefined;
  if (strategy.cost.perUnit) {
    units = estimateUnits(job, strategy.cost.perUnit.unit);
    unitCost = units * strategy.cost.perUnit.rate;
  }

  // Calculate API cost (future enhancement, not in MVP)
  let apiCost: number | undefined;
  if (strategy.cost.api) {
    apiCost = estimateApiCost(strategy.cost.api, job);
    // Add API cost to total cost
  }

  // Total cost = base + per-unit + api
  const totalCost = baseCost + unitCost + (apiCost ?? 0);

  // Apply margin: price = cost / (1 - margin)
  // Example: cost=$10, margin=40% → price = $10 / 0.6 = $16.67
  const margin = Math.max(0, Math.min(1, strategy.margin)); // Clamp to [0, 1]
  let price = totalCost / (1 - margin);

  // Enforce min/max bounds
  const minimum = strategy.minimum ?? 0.05; // ACTP protocol minimum
  const maximum = strategy.maximum ?? 10000;
  price = Math.max(minimum, Math.min(maximum, price));

  // Calculate actual profit and margin
  const profit = price - totalCost;
  const marginPercent = price > 0 ? profit / price : 0;

  // Decide whether to accept the job based on budget
  let decision: 'accept' | 'counter-offer' | 'reject';
  let reason: string;

  if (job.budget >= price) {
    // Budget meets or exceeds our price - accept immediately
    decision = 'accept';
    reason = `Budget $${job.budget.toFixed(2)} >= price $${price.toFixed(2)}`;
  } else if (job.budget >= totalCost) {
    // Budget is below price but above cost (reduced profit)
    // Use behavior configuration to decide
    const belowPriceBehavior = strategy.behavior?.belowPrice ?? 'counter-offer';
    decision = belowPriceBehavior;
    reason = `Budget $${job.budget.toFixed(2)} below price $${price.toFixed(2)} but above cost $${totalCost.toFixed(2)}`;
  } else {
    // Budget is below cost (would lose money)
    // Use behavior configuration to decide
    const belowCostBehavior = strategy.behavior?.belowCost ?? 'reject';
    decision = belowCostBehavior;
    reason = `Budget $${job.budget.toFixed(2)} below cost $${totalCost.toFixed(2)} (would lose money)`;
  }

  return {
    cost: totalCost,
    price,
    profit,
    marginPercent,
    decision,
    reason,
    breakdown: {
      baseCost,
      unitCost,
      units,
      apiCost,
    },
  };
}

/**
 * Estimate number of units in job input
 *
 * Supports different unit types (word, token, etc.) and extracts
 * the relevant data from the job input.
 *
 * @param job - Job to estimate units for
 * @param unit - Unit type (word, token, image, etc.)
 * @returns Estimated number of units
 *
 * @internal
 */
function estimateUnits(job: Job, unit: string): number {
  const input = job.input;

  switch (unit.toLowerCase()) {
    case 'word':
      // Count words in text field
      if (typeof input?.text === 'string') {
        return input.text.split(/\s+/).filter((word: string) => word.length > 0).length;
      }
      // Fallback: count words in JSON string
      return JSON.stringify(input).split(/\s+/).length;

    case 'token':
      // Rough estimate: 1 token ≈ 4 characters
      if (typeof input?.text === 'string') {
        return Math.ceil(input.text.length / 4);
      }
      return Math.ceil(JSON.stringify(input).length / 4);

    case 'character':
    case 'char':
      // Count characters
      if (typeof input?.text === 'string') {
        return input.text.length;
      }
      return JSON.stringify(input).length;

    case 'image':
    case 'img':
      // Count number of images
      if (Array.isArray(input?.images)) {
        return input.images.length;
      }
      if (input?.image || input?.imageUrl) {
        return 1;
      }
      return 1; // Default to 1 image

    case 'minute':
    case 'min':
      // Duration in minutes
      if (typeof input?.duration === 'number') {
        return input.duration;
      }
      if (typeof input?.durationMinutes === 'number') {
        return input.durationMinutes;
      }
      return 1; // Default to 1 minute

    case 'request':
    case 'job':
      // Flat per-request pricing
      return 1;

    default:
      // Unknown unit type - default to 1
      return 1;
  }
}

/**
 * Estimate API cost for a job
 *
 * MVP: Returns 0 for all APIs (placeholder for future implementation)
 *
 * Future implementation will include pricing for:
 * - openai:gpt-4-turbo
 * - openai:gpt-3.5-turbo
 * - anthropic:claude-3-sonnet
 * - anthropic:claude-3-haiku
 *
 * @param api - API identifier (e.g., 'openai:gpt-4-turbo')
 * @param job - Job to estimate cost for
 * @returns Estimated API cost in USDC
 *
 * @internal
 */
function estimateApiCost(api: string, job: Job): number {
  // MVP: Placeholder implementation
  // TODO: Implement actual API cost calculation in future release

  // Example future implementation:
  // const [provider, model] = api.split(':');
  // if (provider === 'openai') {
  //   const inputTokens = estimateUnits(job, 'token');
  //   const pricing = {
  //     'gpt-4-turbo': { input: 0.01 / 1000, output: 0.03 / 1000 },
  //     'gpt-3.5-turbo': { input: 0.0005 / 1000, output: 0.0015 / 1000 }
  //   };
  //   return inputTokens * pricing[model].input * 2; // Assume 2x for output
  // }

  return 0;
}

/**
 * Default pricing strategy
 *
 * Provides a sensible default for services that don't specify pricing.
 * - Base cost: $0.05 (ACTP minimum)
 * - Margin: 40% (healthy profit margin)
 * - Behavior: Counter-offer when below price, reject when below cost
 */
export const DEFAULT_PRICING_STRATEGY: PricingStrategy = {
  cost: {
    base: 0.05, // ACTP protocol minimum
  },
  margin: 0.4, // 40% profit margin
  minimum: 0.05,
  maximum: 10000,
  behavior: {
    belowPrice: 'counter-offer',
    belowCost: 'reject',
    maxNegotiationRounds: 3,
  },
};
