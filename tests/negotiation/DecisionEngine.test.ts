import { DecisionEngine, CandidateStats, ScoringWeights } from '../../src/negotiation/DecisionEngine';

// ============================================================================
// Test Fixtures
// ============================================================================

function makeCandidate(overrides: Partial<CandidateStats> = {}): CandidateStats {
  return {
    slug: 'agent-1',
    unit_price: 0.80,
    reputation_score: 85,
    success_rate: 90,
    avg_completion_time_seconds: 120,
    completed_transactions: 50,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('DecisionEngine', () => {
  // --------------------------------------------------------------------------
  // Default weights
  // --------------------------------------------------------------------------

  describe('default weights', () => {
    it('scores a single candidate', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([makeCandidate()]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe('agent-1');
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].score).toBeLessThanOrEqual(1);
    });

    it('ranks higher reputation above lower', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'low', reputation_score: 50 }),
        makeCandidate({ slug: 'high', reputation_score: 95 }),
      ]);
      expect(results[0].slug).toBe('high');
    });

    it('ranks lower price above higher (same quality)', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'expensive', unit_price: 2.00, reputation_score: 80 }),
        makeCandidate({ slug: 'cheap', unit_price: 0.50, reputation_score: 80 }),
      ]);
      expect(results[0].slug).toBe('cheap');
    });
  });

  // --------------------------------------------------------------------------
  // Custom weights
  // --------------------------------------------------------------------------

  describe('custom weights', () => {
    it('price-only weights rank cheapest first', () => {
      const engine = new DecisionEngine({ quality: 0, price: 1, speed: 0, reliability: 0 });
      const results = engine.rank([
        makeCandidate({ slug: 'a', unit_price: 1.00, reputation_score: 100 }),
        makeCandidate({ slug: 'b', unit_price: 0.10, reputation_score: 10 }),
      ]);
      expect(results[0].slug).toBe('b');
    });

    it('quality-only weights rank best reputation first', () => {
      const engine = new DecisionEngine({ quality: 1, price: 0, speed: 0, reliability: 0 });
      const results = engine.rank([
        makeCandidate({ slug: 'cheap', unit_price: 0.01, reputation_score: 20 }),
        makeCandidate({ slug: 'quality', unit_price: 5.00, reputation_score: 99 }),
      ]);
      expect(results[0].slug).toBe('quality');
    });

    it('normalizes weights that do not sum to 1', () => {
      const engine = new DecisionEngine({ quality: 2, price: 2, speed: 2, reliability: 2 });
      const results = engine.rank([makeCandidate()]);
      // Should still produce valid scores between 0 and 1
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].score).toBeLessThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // maxPrice filtering
  // --------------------------------------------------------------------------

  describe('maxPrice filtering', () => {
    it('filters out candidates exceeding maxPrice', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'ok', unit_price: 0.50 }),
        makeCandidate({ slug: 'too-expensive', unit_price: 2.00 }),
      ], 1.00);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe('ok');
    });

    it('returns empty when all exceed maxPrice', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'a', unit_price: 5.00 }),
        makeCandidate({ slug: 'b', unit_price: 10.00 }),
      ], 1.00);
      expect(results).toHaveLength(0);
    });

    it('includes all when maxPrice not specified', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'a', unit_price: 100 }),
        makeCandidate({ slug: 'b', unit_price: 200 }),
      ]);
      expect(results).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // Speed dimension
  // --------------------------------------------------------------------------

  describe('speed scoring', () => {
    it('penalizes candidates with no completion data', () => {
      const engine = new DecisionEngine({ quality: 0, price: 0, speed: 1, reliability: 0 });
      const results = engine.rank([
        makeCandidate({ slug: 'tracked', avg_completion_time_seconds: 60 }),
        makeCandidate({ slug: 'unknown', avg_completion_time_seconds: null }),
      ]);
      expect(results[0].slug).toBe('tracked');
      expect(results[0].breakdown.speed).toBe(1.0);
      expect(results[1].breakdown.speed).toBe(0.5);
    });

    it('ranks faster candidates higher', () => {
      const engine = new DecisionEngine({ quality: 0, price: 0, speed: 1, reliability: 0 });
      const results = engine.rank([
        makeCandidate({ slug: 'slow', avg_completion_time_seconds: 600 }),
        makeCandidate({ slug: 'fast', avg_completion_time_seconds: 30 }),
      ]);
      expect(results[0].slug).toBe('fast');
    });
  });

  // --------------------------------------------------------------------------
  // Tie-breakers
  // --------------------------------------------------------------------------

  describe('tie-breakers', () => {
    it('breaks ties by lower price', () => {
      // All same quality/speed/reliability — tie on score
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'expensive', unit_price: 1.00, reputation_score: 80, success_rate: 80, avg_completion_time_seconds: 100 }),
        makeCandidate({ slug: 'cheap', unit_price: 0.50, reputation_score: 80, success_rate: 80, avg_completion_time_seconds: 100 }),
      ]);
      // Even if scores differ slightly due to price normalization, the cheaper one should rank first
      const cheapIdx = results.findIndex(r => r.slug === 'cheap');
      const expIdx = results.findIndex(r => r.slug === 'expensive');
      expect(cheapIdx).toBeLessThan(expIdx);
    });

    it('breaks price ties by higher success rate', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'less-reliable', unit_price: 0.50, reputation_score: 80, success_rate: 70, avg_completion_time_seconds: 100 }),
        makeCandidate({ slug: 'more-reliable', unit_price: 0.50, reputation_score: 80, success_rate: 95, avg_completion_time_seconds: 100 }),
      ]);
      const moreIdx = results.findIndex(r => r.slug === 'more-reliable');
      const lessIdx = results.findIndex(r => r.slug === 'less-reliable');
      expect(moreIdx).toBeLessThan(lessIdx);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('returns empty for empty input', () => {
      const engine = new DecisionEngine();
      expect(engine.rank([])).toHaveLength(0);
    });

    it('handles all candidates with same price', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'a', unit_price: 1.00 }),
        makeCandidate({ slug: 'b', unit_price: 1.00 }),
      ]);
      expect(results).toHaveLength(2);
      // Both should get price score of 1.0 (all same price)
      expect(results[0].breakdown.price).toBe(1);
      expect(results[1].breakdown.price).toBe(1);
    });

    it('provides breakdown scores between 0 and 1', () => {
      const engine = new DecisionEngine();
      const results = engine.rank([
        makeCandidate({ slug: 'a' }),
        makeCandidate({ slug: 'b', reputation_score: 10, unit_price: 5, success_rate: 20 }),
      ]);
      for (const r of results) {
        expect(r.breakdown.quality).toBeGreaterThanOrEqual(0);
        expect(r.breakdown.quality).toBeLessThanOrEqual(1);
        expect(r.breakdown.price).toBeGreaterThanOrEqual(0);
        expect(r.breakdown.price).toBeLessThanOrEqual(1);
        expect(r.breakdown.speed).toBeGreaterThanOrEqual(0);
        expect(r.breakdown.speed).toBeLessThanOrEqual(1);
        expect(r.breakdown.reliability).toBeGreaterThanOrEqual(0);
        expect(r.breakdown.reliability).toBeLessThanOrEqual(1);
      }
    });
  });
});
