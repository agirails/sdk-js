import { PolicyEngine, BuyerPolicy, QuoteOffer } from '../../src/negotiation/PolicyEngine';
import { mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DIR = join(tmpdir(), `policy-engine-test-${process.pid}`);

const BASE_POLICY: BuyerPolicy = {
  task: 'translation.fr_en',
  constraints: {
    max_unit_price: { amount: 1.0, currency: 'USDC', unit: 'sentence' },
    max_daily_spend: { amount: 100.0, currency: 'USDC' },
  },
  negotiation: {
    rounds_max: 3,
    quote_ttl: '15m',
  },
  selection: {
    min_reputation: 70,
    prioritize: ['quality', 'price'],
  },
};

function makeOffer(overrides: Partial<QuoteOffer> = {}): QuoteOffer {
  return {
    provider: 'translator-123',
    unit_price: 0.80,
    currency: 'USDC',
    unit: 'sentence',
    reputation_score: 85,
    commerce_session_id: 'session-001',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('PolicyEngine', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // --------------------------------------------------------------------------
  // Guardrail 1: Unit price
  // --------------------------------------------------------------------------

  describe('max_unit_price guardrail', () => {
    it('allows offers within budget', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ unit_price: 0.80 }));
      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('rejects offers exceeding max unit price', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ unit_price: 1.50 }));
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.rule === 'max_unit_price')).toBe(true);
    });

    it('rejects currency mismatch', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ currency: 'ETH' }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].detail).toContain('Currency mismatch');
    });

    it('rejects unit mismatch', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ unit: 'word' }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].detail).toContain('Unit mismatch');
    });
  });

  // --------------------------------------------------------------------------
  // Guardrail 2: Daily spend
  // --------------------------------------------------------------------------

  describe('max_daily_spend guardrail', () => {
    it('tracks cumulative budget', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      engine.reserve('s1', 90, 'USDC');
      const result = engine.validate(makeOffer({ unit_price: 0.50, total_price: 15 }));
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.rule === 'max_daily_spend')).toBe(true);
    });

    it('uses total_price when available', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      // unit_price is fine (0.80) but total_price (120 sentences * 0.80 = 96) + existing = over
      engine.reserve('s1', 10, 'USDC');
      const result = engine.validate(makeOffer({ total_price: 96 }));
      expect(result.allowed).toBe(false);
    });

    it('releases budget on cancel', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      engine.reserve('s1', 90, 'USDC');
      expect(engine.getCommittedToday()).toBe(90);
      engine.release('s1');
      expect(engine.getCommittedToday()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Guardrail 3: Reputation
  // --------------------------------------------------------------------------

  describe('min_reputation guardrail', () => {
    it('rejects providers below min reputation', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ reputation_score: 50 }));
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.rule === 'min_reputation')).toBe(true);
    });

    it('rejects providers with unknown reputation', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ reputation_score: undefined }));
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.rule === 'min_reputation')).toBe(true);
      expect(result.violations[0].detail).toContain('unknown');
    });

    it('allows providers with no min_reputation policy', () => {
      const policy = { ...BASE_POLICY, selection: { ...BASE_POLICY.selection, min_reputation: undefined } };
      const engine = new PolicyEngine(policy, TEST_DIR);
      const result = engine.validate(makeOffer({ reputation_score: undefined }));
      // Should not have a min_reputation violation
      expect(result.violations.filter(v => v.rule === 'min_reputation')).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Guardrail 4: Quote expiry
  // --------------------------------------------------------------------------

  describe('quote_expired guardrail', () => {
    it('rejects expired quotes', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ expires_at: Math.floor(Date.now() / 1000) - 60 }));
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.rule === 'quote_expired')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Guardrail 5: Session ID
  // --------------------------------------------------------------------------

  describe('missing_session_id guardrail', () => {
    it('rejects offers without session ID', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ commerce_session_id: undefined }));
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.rule === 'missing_session_id')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // NaN/Negative bypass prevention
  // --------------------------------------------------------------------------

  describe('NaN/negative price rejection', () => {
    it('rejects NaN unit_price', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ unit_price: NaN }));
      expect(result.allowed).toBe(false);
    });

    it('rejects negative unit_price', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ unit_price: -1 }));
      expect(result.allowed).toBe(false);
    });

    it('rejects Infinity unit_price', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ unit_price: Infinity }));
      expect(result.allowed).toBe(false);
    });

    it('rejects NaN total_price', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      const result = engine.validate(makeOffer({ total_price: NaN }));
      expect(result.allowed).toBe(false);
    });

    it('rejects NaN in reserve()', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      expect(() => engine.reserve('s1', NaN, 'USDC')).toThrow('Invalid reserve amount');
    });

    it('rejects negative in reserve()', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      expect(() => engine.reserve('s1', -5, 'USDC')).toThrow('Invalid reserve amount');
    });

    it('rejects currency mismatch in reserve()', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      expect(() => engine.reserve('s1', 10, 'ETH')).toThrow('Currency mismatch in reserve');
    });

    it('accepts case-insensitive matching currency in reserve()', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      expect(() => engine.reserve('s1', 10, 'usdc')).not.toThrow();
      expect(engine.getCommittedToday()).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // Budget ledger persistence
  // --------------------------------------------------------------------------

  describe('budget ledger persistence', () => {
    it('persists across instances', () => {
      const engine1 = new PolicyEngine(BASE_POLICY, TEST_DIR);
      engine1.reserve('s1', 50, 'USDC');
      expect(engine1.getCommittedToday()).toBe(50);

      // New instance reads from disk
      const engine2 = new PolicyEngine(BASE_POLICY, TEST_DIR);
      expect(engine2.getCommittedToday()).toBe(50);
    });

    it('reserve() enforces budget independently of validate()', () => {
      const engine = new PolicyEngine(BASE_POLICY, TEST_DIR);
      engine.reserve('s1', 95, 'USDC');
      expect(() => engine.reserve('s2', 10, 'USDC')).toThrow('Budget exceeded');
    });
  });

  // --------------------------------------------------------------------------
  // TTL parsing
  // --------------------------------------------------------------------------

  describe('TTL parsing', () => {
    it('parses minutes', () => {
      expect(PolicyEngine.parseTtl('15m')).toBe(900);
    });

    it('parses hours', () => {
      expect(PolicyEngine.parseTtl('2h')).toBe(7200);
    });

    it('parses seconds', () => {
      expect(PolicyEngine.parseTtl('30s')).toBe(30);
    });

    it('rejects invalid format', () => {
      expect(() => PolicyEngine.parseTtl('foo')).toThrow('Invalid TTL format');
    });
  });

  // --------------------------------------------------------------------------
  // Symlink protection
  // --------------------------------------------------------------------------

  describe('symlink protection', () => {
    it('rejects symlink .actp directory', () => {
      const symlinkDir = join(TEST_DIR, 'symlink-actp');
      const realDir = join(TEST_DIR, 'real-target');
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, symlinkDir);

      const engine = new PolicyEngine(BASE_POLICY, symlinkDir);
      expect(() => engine.reserve('s1', 10, 'USDC')).toThrow('not a real directory');
    });

    it('rejects symlink target file', () => {
      const actpDir = join(TEST_DIR, '.actp');
      mkdirSync(actpDir, { recursive: true });
      const target = join(TEST_DIR, 'evil-target.json');
      writeFileSync(target, '{}');
      symlinkSync(target, join(actpDir, 'budget-ledger.json'));

      const engine = new PolicyEngine(BASE_POLICY, actpDir);
      expect(() => engine.reserve('s1', 10, 'USDC')).toThrow('symlink');
    });

    it('rejects symlink tmp file', () => {
      const actpDir = join(TEST_DIR, '.actp');
      mkdirSync(actpDir, { recursive: true });
      const target = join(TEST_DIR, 'evil-tmp.json');
      writeFileSync(target, '{}');
      symlinkSync(target, join(actpDir, 'budget-ledger.json.tmp'));

      const engine = new PolicyEngine(BASE_POLICY, actpDir);
      expect(() => engine.reserve('s1', 10, 'USDC')).toThrow('symlink');
    });
  });
});
