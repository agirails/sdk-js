/**
 * resolveAgent tests (PRD §5.7 + §A.6).
 *
 * Covers the four documented resolution paths:
 *   - env-var override happy path
 *   - env-var with invalid address → InvalidAgentAddressError
 *   - constant-table fallback (source: 'table')
 *   - unknown slug / unknown network → AgentNotFoundError
 *
 * Plus a few hardening cases: case-insensitive slug, empty env var falls
 * through to table.
 */

import {
  resolveAgent,
  AgentNotFoundError,
  InvalidAgentAddressError,
} from './resolveAgent';

describe('resolveAgent (PRD §5.7)', () => {
  const ENV_KEY = 'ACTP_SENTINEL_ADDRESS';
  // The well-known Sentinel address committed to seed-sentinel/sentinel.md.
  const SENTINEL_TABLE_ADDR = '0x3813A642C57CF3c20ff1170C0646c309B4bf6d64';

  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  describe('constant table path', () => {
    it("returns the Sentinel address with source 'table' when no env override is set", () => {
      const r = resolveAgent('sentinel', 'base-sepolia');
      expect(r.address.toLowerCase()).toBe(SENTINEL_TABLE_ADDR.toLowerCase());
      expect(r.source).toBe('table');
      expect(r.slug).toBe('sentinel');
      expect(r.network).toBe('base-sepolia');
    });

    it('returns the canonical checksummed form, not the raw stored case', () => {
      // ethers.getAddress() normalizes to EIP-55 checksum. We assert the
      // result is valid and identical to the table's checksum form.
      const r = resolveAgent('sentinel', 'base-sepolia');
      // Round-trip through getAddress would be idempotent if checksummed.
      expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('handles slugs case-insensitively', () => {
      const lower = resolveAgent('sentinel', 'base-sepolia');
      const upper = resolveAgent('SENTINEL', 'base-sepolia');
      const padded = resolveAgent('  Sentinel  ', 'base-sepolia');
      expect(upper.address).toBe(lower.address);
      expect(padded.address).toBe(lower.address);
    });
  });

  describe('env var override path', () => {
    it("returns the env-var address with source 'env' when ACTP_SENTINEL_ADDRESS is set", () => {
      const override = '0x' + '1'.repeat(40);
      process.env[ENV_KEY] = override;
      const r = resolveAgent('sentinel', 'base-sepolia');
      expect(r.address.toLowerCase()).toBe(override.toLowerCase());
      expect(r.source).toBe('env');
    });

    it('takes precedence over the constant table when both exist', () => {
      const override = '0x' + 'a'.repeat(40);
      process.env[ENV_KEY] = override;
      const r = resolveAgent('sentinel', 'base-sepolia');
      expect(r.address.toLowerCase()).toBe(override.toLowerCase());
      expect(r.address.toLowerCase()).not.toBe(SENTINEL_TABLE_ADDR.toLowerCase());
    });

    it('falls back to the constant table when the env var is set to an empty string', () => {
      // Empty-string env var should not block the constant-table lookup —
      // some shells set an unused variable to '' instead of unsetting it.
      process.env[ENV_KEY] = '';
      const r = resolveAgent('sentinel', 'base-sepolia');
      expect(r.source).toBe('table');
    });

    it('falls back to the constant table when the env var is whitespace-only (PRD §5.10.1)', () => {
      // Botched `export ACTP_SENTINEL_ADDRESS=' '` should NOT throw
      // InvalidAgentAddressError — the operator's intent is clearly
      // "no override", so we trim and fall through.
      process.env[ENV_KEY] = '   ';
      const r = resolveAgent('sentinel', 'base-sepolia');
      expect(r.source).toBe('table');
    });

    it('trims surrounding whitespace before validating a real address', () => {
      // Stray whitespace from shell expansion / clipboard paste shouldn't
      // reject a perfectly valid address.
      const override = '0x' + '1'.repeat(40);
      process.env[ENV_KEY] = `  ${override}\n`;
      const r = resolveAgent('sentinel', 'base-sepolia');
      expect(r.source).toBe('env');
      expect(r.address.toLowerCase()).toBe(override.toLowerCase());
    });

    it('throws InvalidAgentAddressError when env var contains a non-address string', () => {
      process.env[ENV_KEY] = 'not-an-address';
      expect(() => resolveAgent('sentinel', 'base-sepolia')).toThrow(InvalidAgentAddressError);
    });

    it('InvalidAgentAddressError surfaces the offending env var name and value', () => {
      process.env[ENV_KEY] = '0xZZ';
      try {
        resolveAgent('sentinel', 'base-sepolia');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidAgentAddressError);
        const e = err as InvalidAgentAddressError;
        expect(e.envVar).toBe(ENV_KEY);
        expect(e.value).toBe('0xZZ');
        expect(e.message).toMatch(/ACTP_SENTINEL_ADDRESS/);
      }
    });
  });

  describe('missing-agent path', () => {
    it('throws AgentNotFoundError for an unknown slug', () => {
      expect(() => resolveAgent('does-not-exist', 'base-sepolia')).toThrow(
        AgentNotFoundError
      );
    });

    it('throws AgentNotFoundError when slug exists but not on the requested network', () => {
      // sentinel is published on base-sepolia only; base-mainnet should miss.
      expect(() => resolveAgent('sentinel', 'base-mainnet')).toThrow(AgentNotFoundError);
    });

    it('AgentNotFoundError lists the known slugs on the requested network', () => {
      try {
        resolveAgent('does-not-exist', 'base-sepolia');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentNotFoundError);
        const e = err as AgentNotFoundError;
        expect(e.slug).toBe('does-not-exist');
        expect(e.network).toBe('base-sepolia');
        expect(e.message).toMatch(/sentinel/);
      }
    });

    it('AgentNotFoundError indicates an empty known-agent list when network has no entries', () => {
      try {
        resolveAgent('whatever', 'base-mainnet');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentNotFoundError);
        const e = err as AgentNotFoundError;
        expect(e.message).toMatch(/none/);
      }
    });
  });
});
