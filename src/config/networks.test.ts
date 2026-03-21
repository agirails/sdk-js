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
      expect(config.contracts.agentRegistry).toBe('0x55e7F23AB5700fD0D9f83294be2d0F2eC84013E1');
    });

    it('should have correct AgentRegistry on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.agentRegistry).toBe('0x6fB222CF3DDdf37Bcb248EE7BBBA42Fb41901de8');
    });

    it('should have correct ACTPKernel on base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(config.contracts.actpKernel).toBe('0x0ba0b17554601b30F5406e74d2208f567C12CcFE');
    });

    it('should have correct ACTPKernel on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.actpKernel).toBe('0x132B9eB321dBB57c828B083844287171BDC92d29');
    });

    it('should have correct EscrowVault on base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(config.contracts.escrowVault).toBe('0xedC62264301A119207f1f89C6bDE4Fd7a7A4CeB4');
    });

    it('should have correct EscrowVault on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.escrowVault).toBe('0x6aAF45882c4b0dD34130ecC790bb5Ec6be7fFb99');
    });

    it('should have correct X402Relay on base-sepolia', () => {
      const config = getNetwork('base-sepolia');
      expect(config.contracts.x402Relay).toBe('0x4DCD02b276Dbeab57c265B72435e90507b6Ac81A');
    });

    it('should have correct X402Relay on base-mainnet', () => {
      const config = getNetwork('base-mainnet');
      expect(config.contracts.x402Relay).toBe('0x81DFb954A3D58FEc24Fc9c946aC2C71a911609F8');
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
