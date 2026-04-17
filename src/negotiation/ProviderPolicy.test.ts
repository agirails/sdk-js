/**
 * ProviderPolicyEngine tests — construction invariants + evaluate()
 * decision matrix + counter-offer verdict.
 */

import {
  ProviderPolicy,
  ProviderPolicyEngine,
  IncomingRequest,
  parseTtl,
} from './ProviderPolicy';

function basePolicy(overrides: Partial<ProviderPolicy> = {}): ProviderPolicy {
  return {
    services: ['code-review'],
    pricing: {
      min_acceptable: { amount: 5, currency: 'USDC', unit: 'job' },
      ideal_price: { amount: 10, currency: 'USDC', unit: 'job' },
    },
    quote_ttl: '15m',
    ...overrides,
  };
}

function req(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    txId: '0x' + 'a'.repeat(64),
    consumer: 'did:ethr:84532:0x2222222222222222222222222222222222222222',
    offeredAmount: '5000000',
    maxPrice: '10000000',
    deadline: Math.floor(Date.now() / 1000) + 3600,
    serviceType: 'code-review',
    currency: 'USDC',
    unit: 'job',
    ...overrides,
  };
}

describe('ProviderPolicyEngine', () => {
  describe('construction invariants', () => {
    it('rejects min_acceptable below platform $0.05', () => {
      expect(() => new ProviderPolicyEngine(basePolicy({
        pricing: {
          min_acceptable: { amount: 0.01, currency: 'USDC', unit: 'job' },
          ideal_price: { amount: 10, currency: 'USDC', unit: 'job' },
        },
      }))).toThrow(/platform minimum/);
    });

    it('rejects ideal_price below min_acceptable', () => {
      expect(() => new ProviderPolicyEngine(basePolicy({
        pricing: {
          min_acceptable: { amount: 10, currency: 'USDC', unit: 'job' },
          ideal_price: { amount: 5, currency: 'USDC', unit: 'job' },
        },
      }))).toThrow(/must be ≥ min_acceptable/);
    });

    it('rejects currency mismatch between floor and ideal', () => {
      expect(() => new ProviderPolicyEngine(basePolicy({
        pricing: {
          min_acceptable: { amount: 5, currency: 'USDC', unit: 'job' },
          ideal_price: { amount: 10, currency: 'EUR' as 'USDC', unit: 'job' },
        },
      }))).toThrow(/currency/);
    });
  });

  describe('evaluate()', () => {
    it('allows a happy-path request with maxPrice ≥ ideal → quote at ideal', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const r = engine.evaluate(req({ maxPrice: '15000000' })); // $15
      expect(r.allowed).toBe(true);
      expect(r.recommended_quote_amount).toBe(10); // ideal
    });

    it('quotes at maxPrice when it falls between floor and ideal', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const r = engine.evaluate(req({ maxPrice: '7000000' })); // $7
      expect(r.allowed).toBe(true);
      expect(r.recommended_quote_amount).toBe(7);
    });

    it('skips requests for services we don\'t offer', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const r = engine.evaluate(req({ serviceType: 'translation' }));
      expect(r.allowed).toBe(false);
      expect(r.violations.some((v) => v.rule === 'service_not_offered')).toBe(true);
    });

    it('skips when buyer maxPrice is below our floor', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const r = engine.evaluate(req({ maxPrice: '3000000' })); // $3 < $5 floor
      expect(r.allowed).toBe(false);
      expect(r.violations.some((v) => v.rule === 'max_price_below_floor')).toBe(true);
    });

    it('skips when deadline is too tight', () => {
      const engine = new ProviderPolicyEngine(basePolicy({ min_deadline_seconds: 300 }));
      const now = Math.floor(Date.now() / 1000);
      const r = engine.evaluate(req({ deadline: now + 60 })); // only 60s
      expect(r.allowed).toBe(false);
      expect(r.violations.some((v) => v.rule === 'deadline_too_tight')).toBe(true);
    });

    it('skips on currency mismatch', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const r = engine.evaluate(req({ currency: 'EUR' }));
      expect(r.allowed).toBe(false);
      expect(r.violations.some((v) => v.rule === 'currency_mismatch')).toBe(true);
    });

    it('accumulates multiple violations in one pass', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const r = engine.evaluate(req({
        serviceType: 'translation',
        maxPrice: '1000000', // $1
      }));
      expect(r.allowed).toBe(false);
      const rules = r.violations.map((v) => v.rule);
      expect(rules).toContain('service_not_offered');
      expect(rules).toContain('max_price_below_floor');
    });
  });

  describe('evaluateCounter()', () => {
    it('accepts a counter ≥ floor', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const verdict = engine.evaluateCounter('5000000'); // $5 exactly floor
      expect(verdict.decision).toBe('accept');
    });

    it('rejects a counter below floor', () => {
      const engine = new ProviderPolicyEngine(basePolicy());
      const verdict = engine.evaluateCounter('4000000'); // $4 < floor
      expect(verdict.decision).toBe('reject');
    });
  });

  describe('quoteTtlSeconds', () => {
    it('exposes parsed TTL as seconds', () => {
      const engine = new ProviderPolicyEngine(basePolicy({ quote_ttl: '30m' }));
      expect(engine.quoteTtlSeconds).toBe(1800);
    });
  });
});

describe('parseTtl', () => {
  it('parses s/m/h', () => {
    expect(parseTtl('30s')).toBe(30);
    expect(parseTtl('15m')).toBe(900);
    expect(parseTtl('1h')).toBe(3600);
  });

  it('handles whitespace', () => {
    expect(parseTtl('  15 m  ')).toBe(900);
  });

  it('rejects malformed strings', () => {
    expect(() => parseTtl('forever')).toThrow(/Invalid TTL format/);
    expect(() => parseTtl('15')).toThrow();
    expect(() => parseTtl('15d')).toThrow();
  });
});
