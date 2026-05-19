/**
 * Networks Configuration Tests
 *
 * Tests cover:
 * - CDP/Pimlico API key detection in bundler/paymaster URLs
 * - Fallback URL construction when env vars are missing
 * - Network config validation
 *
 * NOTE: AA endpoint URL tests use jest.isolateModules() because networks.ts
 * evaluates env vars at module load time. Each test needs a fully isolated
 * module evaluation with controlled env vars.
 */

import { getNetwork } from './networks';

// Keys that affect networks.ts module-level evaluation
const ENV_KEYS = [
  'CDP_API_KEY',
  'CDP_BUNDLER_URL',
  'CDP_PAYMASTER_URL',
  'PIMLICO_API_KEY',
  'PIMLICO_BUNDLER_URL',
  'PIMLICO_PAYMASTER_URL',
  'BASE_SEPOLIA_RPC',
  'BASE_MAINNET_RPC',
];

describe('Networks Config', () => {
  // Save real env values
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });
  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  /** Clear all AA env vars, then set overrides, then require fresh networks module */
  function freshConfig(overrides: Record<string, string> = {}) {
    // Clear
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    // Apply overrides
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }

    let config: ReturnType<typeof getNetwork>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./networks');
      config = mod.getNetwork('base-sepolia');
    });
    return config!;
  }

  describe('AA endpoint URLs', () => {
    it('should build Coinbase bundler URL with CDP_API_KEY', () => {
      const config = freshConfig({ CDP_API_KEY: 'test-key-123' });
      expect(config.aa?.bundlerUrls.coinbase).toContain('test-key-123');
    });

    it('should use hardcoded default key when CDP_API_KEY is missing', () => {
      const config = freshConfig();
      expect(config.aa?.bundlerUrls.coinbase).toContain('api.developer.coinbase.com');
      expect(config.aa?.bundlerUrls.coinbase).not.toContain('undefined');
    });

    it('should set Pimlico URLs when PIMLICO_API_KEY is set', () => {
      const config = freshConfig({ PIMLICO_API_KEY: 'pimlico-test-key' });
      expect(config.aa?.bundlerUrls.pimlico).toContain('pimlico-test-key');
      expect(config.aa?.paymasterUrls.pimlico).toContain('pimlico-test-key');
    });

    it('should use hardcoded Pimlico key when PIMLICO_API_KEY is missing', () => {
      const config = freshConfig();
      expect(config.aa?.bundlerUrls.pimlico).toContain('api.pimlico.io');
      expect(config.aa?.bundlerUrls.pimlico).not.toContain('undefined');
    });

    it('should prefer CDP_BUNDLER_URL over constructed URL', () => {
      const config = freshConfig({
        CDP_BUNDLER_URL: 'https://custom-bundler.example.com',
      });
      expect(config.aa?.bundlerUrls.coinbase).toBe('https://custom-bundler.example.com');
    });

    it('should support custom Pimlico URL without PIMLICO_API_KEY', () => {
      const config = freshConfig({
        PIMLICO_BUNDLER_URL: 'https://pimlico-custom.example.com/rpc',
      });
      expect(config.aa?.bundlerUrls.pimlico).toBe('https://pimlico-custom.example.com/rpc');
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

    // Sanity checks: deployed contract addresses must match known deployments
    it('should have correct AgentRegistry on base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(config.contracts.agentRegistry).toBe('0xD91F9aBfBf60b4a2Fd5317ab0cDF3F44faB5D656');
    });

    it('should have correct AgentRegistry on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.agentRegistry).toBe('0x64Cb18bfb3CC1aCb1370a3B01613391D3561a009');
    });

    it('should have correct ACTPKernel on base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(config.contracts.actpKernel).toBe('0x9d25A874f046185d9237Cd4954C88D2B74B0021b');
    });

    it('should have correct ACTPKernel on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.actpKernel).toBe('0x048c811352e8a3fECd5b0Ec4AA2c2b94083CC842');
    });

    it('should have correct EscrowVault on base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(config.contracts.escrowVault).toBe('0x7dF07327090efcA73DCBa70414aA3131Fc6d2efB');
    });

    it('should have correct EscrowVault on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.escrowVault).toBe('0x262D5912A9612F0c66dA5d13B4E678D50ebC44b5');
    });

    it('should have correct X402Relay on base-sepolia (deprecated but still set)', () => {
      const config = getNetwork('base-sepolia');
      expect(config.contracts.x402Relay).toBe('0x110b25bb3d45c40dfcf34bb451aa7069b2a1cb3b');
    });

    it('should NOT have X402Relay on base-mainnet (deprecated, no mainnet redeploy)', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.x402Relay).toBeUndefined();
    });

    it('should throw on unknown network', () => {
      expect(() => getNetwork('ethereum-mainnet')).toThrow('Unknown network');
    });

    it('should have actpKernelDeploymentBlock on base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(typeof config.actpKernelDeploymentBlock).toBe('number');
      expect(config.actpKernelDeploymentBlock).toBeGreaterThan(0);
    });

    it('should have actpKernelDeploymentBlock on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(typeof config.actpKernelDeploymentBlock).toBe('number');
      expect(config.actpKernelDeploymentBlock).toBeGreaterThan(0);
    });

    it('should preserve maxTransactionAmount through deep clone', () => {
      const config = getNetwork('base-mainnet');
      expect(config.maxTransactionAmount).toBe(1000);
    });

    it('should have undefined maxTransactionAmount on testnet', () => {
      const config = getNetwork('base-sepolia');
      expect(config.maxTransactionAmount).toBeUndefined();
    });

    it('should return deep clone (no global mutation)', () => {
      const config1 = getNetwork('base-sepolia');
      const config2 = getNetwork('base-sepolia');
      config1.contracts.actpKernel = '0xDEAD';
      expect(config2.contracts.actpKernel).not.toBe('0xDEAD');
    });
  });
});
