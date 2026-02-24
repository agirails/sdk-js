/**
 * Convention-Over-Config Defaults Tests
 *
 * @module config/defaults.test
 */

import { V4_DEFAULTS, V4_CONSTRAINTS, computeDisplayFee } from './defaults';

// ============================================================================
// V4_DEFAULTS
// ============================================================================

describe('V4_DEFAULTS', () => {
  test('pricing defaults to USDC per-job non-negotiable', () => {
    expect(V4_DEFAULTS.pricing.currency).toBe('USDC');
    expect(V4_DEFAULTS.pricing.unit).toBe('job');
    expect(V4_DEFAULTS.pricing.negotiable).toBe(false);
  });

  test('network defaults to mock', () => {
    expect(V4_DEFAULTS.network).toBe('mock');
  });

  test('SLA has sensible defaults', () => {
    expect(V4_DEFAULTS.sla.response).toBe('2h');
    expect(V4_DEFAULTS.sla.delivery).toBe('24h');
    expect(V4_DEFAULTS.sla.concurrency).toBe(10);
    expect(V4_DEFAULTS.sla.dispute_window).toBe('48h');
  });

  test('payment defaults to actp', () => {
    expect(V4_DEFAULTS.payment.modes).toEqual(['actp']);
  });
});

// ============================================================================
// V4_CONSTRAINTS
// ============================================================================

describe('V4_CONSTRAINTS', () => {
  test('MIN_PRICE is $0.05', () => {
    expect(V4_CONSTRAINTS.MIN_PRICE).toBe(0.05);
  });

  test('MAX_SLUG_LENGTH is 64', () => {
    expect(V4_CONSTRAINTS.MAX_SLUG_LENGTH).toBe(64);
  });

  test('SLUG_PATTERN accepts valid slugs', () => {
    expect(V4_CONSTRAINTS.SLUG_PATTERN.test('code-reviewer')).toBe(true);
    expect(V4_CONSTRAINTS.SLUG_PATTERN.test('a')).toBe(true);
    expect(V4_CONSTRAINTS.SLUG_PATTERN.test('agent42')).toBe(true);
  });

  test('SLUG_PATTERN rejects invalid slugs', () => {
    expect(V4_CONSTRAINTS.SLUG_PATTERN.test('-leading')).toBe(false);
    expect(V4_CONSTRAINTS.SLUG_PATTERN.test('trailing-')).toBe(false);
    expect(V4_CONSTRAINTS.SLUG_PATTERN.test('UPPER')).toBe(false);
  });

  test('KNOWN_SERVICES contains expected types', () => {
    expect(V4_CONSTRAINTS.KNOWN_SERVICES).toContain('code-review');
    expect(V4_CONSTRAINTS.KNOWN_SERVICES).toContain('translation');
    expect(V4_CONSTRAINTS.KNOWN_SERVICES).toContain('security-audit');
    expect(V4_CONSTRAINTS.KNOWN_SERVICES.length).toBe(7);
  });

  test('VALID_NETWORKS are mock, testnet, mainnet', () => {
    expect(V4_CONSTRAINTS.VALID_NETWORKS).toEqual(['mock', 'testnet', 'mainnet']);
  });
});

// ============================================================================
// computeDisplayFee
// ============================================================================

describe('computeDisplayFee', () => {
  test('returns 1% for amounts where 1% > $0.05', () => {
    // $10 USDC = 10_000_000 wei → 1% = 100_000 wei ($0.10)
    const fee = computeDisplayFee(10_000_000n);
    expect(fee).toBe(100_000n);
  });

  test('returns minimum $0.05 for small amounts', () => {
    // $1 USDC = 1_000_000 wei → 1% = 10_000 wei ($0.01) < $0.05 minimum
    const fee = computeDisplayFee(1_000_000n);
    expect(fee).toBe(50_000n); // $0.05 minimum
  });

  test('returns minimum $0.05 for zero amount', () => {
    const fee = computeDisplayFee(0n);
    expect(fee).toBe(50_000n);
  });

  test('1% exactly equals minimum at $5 USDC', () => {
    // $5 USDC = 5_000_000 wei → 1% = 50_000 wei = $0.05 exactly
    const fee = computeDisplayFee(5_000_000n);
    expect(fee).toBe(50_000n);
  });

  test('returns 1% for $100 USDC', () => {
    // $100 = 100_000_000 wei → 1% = 1_000_000 wei ($1.00)
    const fee = computeDisplayFee(100_000_000n);
    expect(fee).toBe(1_000_000n);
  });

  test('fee is always a bigint', () => {
    const fee = computeDisplayFee(7_500_000n);
    expect(typeof fee).toBe('bigint');
  });
});
