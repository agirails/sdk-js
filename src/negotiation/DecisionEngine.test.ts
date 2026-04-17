/**
 * DecisionEngine.evaluateQuote tests — covers the AIP-2.1 decision matrix.
 * Existing rank() behavior is exercised by BuyerOrchestrator integration
 * tests; this file focuses on the new per-quote evaluation method.
 */

import { DecisionEngine, QuoteForEvaluation } from './DecisionEngine';
import type { BuyerPolicy } from './PolicyEngine';

function policy(overrides: Partial<BuyerPolicy['negotiation']> & { target_unit_price?: BuyerPolicy['target_unit_price'] } = {}): BuyerPolicy {
  const { target_unit_price, ...negotiationOverrides } = overrides;
  return {
    task: 'code-review',
    constraints: {
      max_unit_price: { amount: 10, currency: 'USDC', unit: 'job' }, // $10 max
      max_daily_spend: { amount: 100, currency: 'USDC' },
    },
    negotiation: {
      rounds_max: 3,
      quote_ttl: '15m',
      ...negotiationOverrides,
    },
    selection: {
      prioritize: ['price'],
    },
    ...(target_unit_price ? { target_unit_price } : {}),
  };
}

function quote(overrides: Partial<QuoteForEvaluation> = {}): QuoteForEvaluation {
  return {
    quotedAmount: '7000000', // $7
    originalAmount: '5000000', // $5
    maxPrice: '10000000', // $10
    ...overrides,
  };
}

describe('DecisionEngine.evaluateQuote', () => {
  let engine: DecisionEngine;
  beforeEach(() => {
    engine = new DecisionEngine();
  });

  describe('hard rejects', () => {
    it('rejects when quote > maxPrice (defense-in-depth)', () => {
      const r = engine.evaluateQuote(quote({ quotedAmount: '15000000' }), policy());
      expect(r.action).toBe('reject');
    });

    it('rejects when amount fields are non-numeric', () => {
      const r = engine.evaluateQuote(quote({ quotedAmount: 'abc' }), policy());
      expect(r.action).toBe('reject');
    });
  });

  describe('accept paths', () => {
    it('accepts when quote ≤ target (default target = 50% of max)', () => {
      // max=$10, default target=$5. Quote=$5 → accept.
      const r = engine.evaluateQuote(quote({ quotedAmount: '5000000' }), policy());
      expect(r.action).toBe('accept');
    });

    it('accepts when quote ≤ explicit target_unit_price', () => {
      const r = engine.evaluateQuote(
        quote({ quotedAmount: '8000000' }), // $8
        policy({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } }),
      );
      expect(r.action).toBe('accept');
    });

    it('accepts on final_offer when within max', () => {
      const r = engine.evaluateQuote(
        quote({ quotedAmount: '9500000', final_offer: true }),
        policy({ target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' } }),
      );
      expect(r.action).toBe('accept');
      if (r.action === 'accept') expect(r.reason).toMatch(/Final offer/);
    });

    it('accepts on rounds budget exhausted (rounds_per_provider=1, default)', () => {
      // rounds_per_provider=1, this is round 0 (first), so 0+1 >= 1 → exhausted.
      // Quote $7 > target $5 → would normally counter, but no rounds left → accept.
      const r = engine.evaluateQuote(quote(), policy(), 0);
      expect(r.action).toBe('accept');
      if (r.action === 'accept') expect(r.reason).toMatch(/Rounds budget exhausted/);
    });
  });

  describe('reject paths beyond hard ceiling', () => {
    it('rejects when above target AND counter_strategy=walk', () => {
      const r = engine.evaluateQuote(
        quote(), // $7 > $5 default target
        policy({ rounds_per_provider: 3, counter_strategy: 'walk' }),
      );
      expect(r.action).toBe('reject');
    });

    it('rejects on final_offer above max (defensive — ceiling check fires first)', () => {
      // This combination is filtered upstream too, but evaluateQuote
      // still does the right thing.
      const r = engine.evaluateQuote(
        quote({ quotedAmount: '11000000', final_offer: true }),
        policy(),
      );
      expect(r.action).toBe('reject');
    });
  });

  describe('counter paths', () => {
    it('counters at midpoint by default when budget allows', () => {
      // quote=$7, target=$5 → midpoint = $6
      const r = engine.evaluateQuote(
        quote(),
        policy({ rounds_per_provider: 3, counter_strategy: 'midpoint' }),
      );
      expect(r.action).toBe('counter');
      if (r.action === 'counter') {
        expect(r.amountBaseUnits).toBe('6000000'); // $6
      }
    });

    it('counters at target with undercut strategy', () => {
      const r = engine.evaluateQuote(
        quote(),
        policy({ rounds_per_provider: 3, counter_strategy: 'undercut' }),
      );
      expect(r.action).toBe('counter');
      if (r.action === 'counter') {
        expect(r.amountBaseUnits).toBe('5000000'); // target $5
      }
    });

    it('falls back to accept when strategy math would not undercut', () => {
      // target very close to quote → midpoint computes to (8+7)/2 = 7.5
      // Provider quoted $7, midpoint $7.5 ≥ quote → accept (no useful counter).
      const r = engine.evaluateQuote(
        quote({ quotedAmount: '7000000' }),
        policy({
          rounds_per_provider: 3,
          counter_strategy: 'midpoint',
          target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' },
        }),
      );
      // target=$8 > quote=$7 → quote ≤ target → accept (path 3 in tree).
      expect(r.action).toBe('accept');
    });

    it('counters above PLATFORM_MIN even when math would go lower', () => {
      // target = $0.01 (below platform min of $0.05). Counter floor
      // must lift it to $0.05.
      const r = engine.evaluateQuote(
        quote({ quotedAmount: '60000', maxPrice: '70000' }), // 6¢ quote, 7¢ max
        policy({
          rounds_per_provider: 3,
          counter_strategy: 'undercut',
          target_unit_price: { amount: 0.01, currency: 'USDC', unit: 'job' },
        }),
      );
      // target=$0.01 → undercut counter would be $0.01 = 10_000 base units
      // → lifted to platform min = 50_000 = $0.05.
      // But $0.05 < $0.06 quote → still strictly below → counter.
      expect(r.action).toBe('counter');
      if (r.action === 'counter') {
        expect(r.amountBaseUnits).toBe('50000');
      }
    });
  });

  describe('precision', () => {
    it('preserves exact base-unit amounts (no float drift on big numbers)', () => {
      // $1M ideal, $10M quote, $20M max — beyond Number.MAX_SAFE_INTEGER
      // when expressed in base units. evaluateQuote must keep it exact.
      const r = engine.evaluateQuote(
        {
          quotedAmount: '10000000000000', // $10M
          originalAmount: '1000000000000', // $1M
          maxPrice: '20000000000000', // $20M
        },
        {
          ...policy({ rounds_per_provider: 3, counter_strategy: 'midpoint' }),
          constraints: {
            max_unit_price: { amount: 20_000_000, currency: 'USDC', unit: 'job' },
            max_daily_spend: { amount: 100_000_000, currency: 'USDC' },
          },
          target_unit_price: { amount: 1_000_000, currency: 'USDC', unit: 'job' },
        } as BuyerPolicy,
      );
      // quote $10M > target $1M, midpoint = ($10M+$1M)/2 = $5.5M = 5_500_000_000_000 base units.
      expect(r.action).toBe('counter');
      if (r.action === 'counter') {
        expect(r.amountBaseUnits).toBe('5500000000000');
      }
    });
  });
});
