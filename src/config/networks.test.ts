/**
 * Networks Configuration Tests
 *
 * Tests cover:
 * - CDP_API_KEY detection in bundler/paymaster URLs
 * - Pimlico fallback URL construction
 * - Network config validation
 */

import { getNetwork } from './networks';

describe('Networks Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clone env so we can modify safely
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('AA endpoint URLs', () => {
    it('should build Coinbase bundler URL with CDP_API_KEY', () => {
      process.env.CDP_API_KEY = 'test-key-123';
      // Force re-evaluation by clearing module cache
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getNetwork: freshGetNetwork } = require('./networks');
      const config = freshGetNetwork('base-sepolia');
      expect(config.aa?.bundlerUrls.coinbase).toContain('test-key-123');
      expect(config.aa?.bundlerUrls.coinbase).not.toEndWith('/');
    });

    it('should build URL ending with / when CDP_API_KEY is missing', () => {
      delete process.env.CDP_API_KEY;
      delete process.env.CDP_BUNDLER_URL;
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getNetwork: freshGetNetwork } = require('./networks');
      const config = freshGetNetwork('base-sepolia');
      expect(config.aa?.bundlerUrls.coinbase).toEndWith('/');
    });

    it('should set Pimlico URLs when PIMLICO_API_KEY is set', () => {
      process.env.PIMLICO_API_KEY = 'pimlico-test-key';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getNetwork: freshGetNetwork } = require('./networks');
      const config = freshGetNetwork('base-sepolia');
      expect(config.aa?.bundlerUrls.pimlico).toContain('pimlico-test-key');
      expect(config.aa?.paymasterUrls.pimlico).toContain('pimlico-test-key');
    });

    it('should leave Pimlico URLs undefined when PIMLICO_API_KEY is missing', () => {
      delete process.env.PIMLICO_API_KEY;
      delete process.env.PIMLICO_BUNDLER_URL;
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getNetwork: freshGetNetwork } = require('./networks');
      const config = freshGetNetwork('base-sepolia');
      expect(config.aa?.bundlerUrls.pimlico).toBeUndefined();
    });

    it('should prefer CDP_BUNDLER_URL over constructed URL', () => {
      process.env.CDP_BUNDLER_URL = 'https://custom-bundler.example.com';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getNetwork: freshGetNetwork } = require('./networks');
      const config = freshGetNetwork('base-sepolia');
      expect(config.aa?.bundlerUrls.coinbase).toBe('https://custom-bundler.example.com');
    });
  });

  describe('getNetwork()', () => {
    it('should return config for base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(config.chainId).toBe(84532);
      expect(config.aa).toBeDefined();
      expect(config.aa?.entryPoint).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
    });

    it('should return config for base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.chainId).toBe(8453);
      expect(config.aa).toBeDefined();
    });

    it('should throw on unknown network', () => {
      expect(() => getNetwork('ethereum-mainnet')).toThrow('Unknown network');
    });

    it('should return deep clone (no global mutation)', () => {
      const config1 = getNetwork('base-sepolia');
      const config2 = getNetwork('base-sepolia');
      config1.contracts.actpKernel = '0xDEAD';
      expect(config2.contracts.actpKernel).not.toBe('0xDEAD');
    });
  });
});

// Custom matcher
expect.extend({
  toEndWith(received: string, suffix: string) {
    const pass = received.endsWith(suffix);
    return {
      pass,
      message: () => `expected "${received}" ${pass ? 'not ' : ''}to end with "${suffix}"`,
    };
  },
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toEndWith(suffix: string): R;
    }
  }
}
