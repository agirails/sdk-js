/**
 * AIP-7 Environment Sanity Tests (Phase 1A)
 *
 * Purpose: Validate that all required contracts are deployed and accessible
 * on Base Sepolia before running integration tests.
 *
 * These tests are:
 * - Read-only (no state changes)
 * - Fast and deterministic
 * - Safe to run repeatedly
 *
 * References:
 * - AIP-7: Agent Identity, Registry & Storage System
 * - Base Sepolia chainId: 84532
 */

import { ACTPClient } from '../../ACTPClient';
import { BASE_SEPOLIA } from '../../config/networks';

// Expected AgentRegistry address (deployed 2025-12-11)
const EXPECTED_AGENT_REGISTRY = '0xFed6914Aa70c0a53E9c7Cc4d2Ae159e4748fb09D';

// Zero address constant
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Dummy private key for read-only tests (no funds needed for view calls)
const READONLY_PRIVATE_KEY = '0x' + '1'.repeat(64);

describe('AIP-7 Environment Sanity Tests', () => {
  let client: ACTPClient;

  beforeAll(async () => {
    client = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: READONLY_PRIVATE_KEY
    });
  }, 30000);

  describe('Network Configuration', () => {
    it('should be configured for Base Sepolia (chainId 84532)', () => {
      expect(BASE_SEPOLIA.chainId).toBe(84532);
      expect(BASE_SEPOLIA.name).toBe('Base Sepolia');
    });

    it('should connect to correct chain', async () => {
      const provider = client.getProvider();
      const network = await provider.getNetwork();
      expect(Number(network.chainId)).toBe(84532);
    });
  });

  describe('Contract Address Verification', () => {
    it('should have non-zero ACTPKernel address', () => {
      expect(BASE_SEPOLIA.contracts.actpKernel).not.toBe(ZERO_ADDRESS);
      expect(BASE_SEPOLIA.contracts.actpKernel).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should have non-zero EscrowVault address', () => {
      expect(BASE_SEPOLIA.contracts.escrowVault).not.toBe(ZERO_ADDRESS);
      expect(BASE_SEPOLIA.contracts.escrowVault).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should have non-zero MockUSDC address', () => {
      expect(BASE_SEPOLIA.contracts.usdc).not.toBe(ZERO_ADDRESS);
      expect(BASE_SEPOLIA.contracts.usdc).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should have non-zero EAS address', () => {
      expect(BASE_SEPOLIA.contracts.eas).not.toBe(ZERO_ADDRESS);
      expect(BASE_SEPOLIA.contracts.eas).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should have non-zero EAS SchemaRegistry address', () => {
      expect(BASE_SEPOLIA.contracts.easSchemaRegistry).not.toBe(ZERO_ADDRESS);
      expect(BASE_SEPOLIA.contracts.easSchemaRegistry).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should have non-zero AgentRegistry address matching expected deployment', () => {
      expect(BASE_SEPOLIA.contracts.agentRegistry).not.toBe(ZERO_ADDRESS);
      expect(BASE_SEPOLIA.contracts.agentRegistry).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(BASE_SEPOLIA.contracts.agentRegistry?.toLowerCase()).toBe(
        EXPECTED_AGENT_REGISTRY.toLowerCase()
      );
    });
  });

  describe('Contract Bytecode Verification', () => {
    // Timeout for RPC calls
    jest.setTimeout(30000);

    it('should have bytecode deployed at ACTPKernel address', async () => {
      const provider = client.getProvider();
      const code = await provider.getCode(BASE_SEPOLIA.contracts.actpKernel);
      expect(code).not.toBe('0x');
      expect(code.length).toBeGreaterThan(10);
    });

    it('should have bytecode deployed at EscrowVault address', async () => {
      const provider = client.getProvider();
      const code = await provider.getCode(BASE_SEPOLIA.contracts.escrowVault);
      expect(code).not.toBe('0x');
      expect(code.length).toBeGreaterThan(10);
    });

    it('should have bytecode deployed at MockUSDC address', async () => {
      const provider = client.getProvider();
      const code = await provider.getCode(BASE_SEPOLIA.contracts.usdc);
      expect(code).not.toBe('0x');
      expect(code.length).toBeGreaterThan(10);
    });

    it('should have bytecode deployed at EAS address', async () => {
      const provider = client.getProvider();
      const code = await provider.getCode(BASE_SEPOLIA.contracts.eas);
      expect(code).not.toBe('0x');
      expect(code.length).toBeGreaterThan(10);
    });

    it('should have bytecode deployed at EAS SchemaRegistry address', async () => {
      const provider = client.getProvider();
      const code = await provider.getCode(BASE_SEPOLIA.contracts.easSchemaRegistry);
      expect(code).not.toBe('0x');
      expect(code.length).toBeGreaterThan(10);
    });

    it('should have bytecode deployed at AgentRegistry address', async () => {
      const provider = client.getProvider();
      const code = await provider.getCode(EXPECTED_AGENT_REGISTRY);
      expect(code).not.toBe('0x');
      expect(code.length).toBeGreaterThan(10);
    });
  });

  describe('AgentRegistry Module Verification', () => {
    it('should have registry module initialized in client', () => {
      expect(client.registry).toBeDefined();
    });

    it('should have correct registry address in client', () => {
      expect(client.registry?.getAddress().toLowerCase()).toBe(
        EXPECTED_AGENT_REGISTRY.toLowerCase()
      );
    });

    it('should respond to chainId() via registry module', async () => {
      if (!client.registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      const chainId = await client.registry.getChainId();
      expect(chainId).toBe(84532);
    });

    it('should build correct DID format', async () => {
      if (!client.registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      const testAddress = '0x1234567890123456789012345678901234567890';
      const did = await client.registry.buildDID(testAddress);
      expect(did).toBe(`did:ethr:84532:${testAddress.toLowerCase()}`);
    });

    it('should compute service type hash deterministically', () => {
      if (!client.registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      const hash1 = client.registry.computeServiceTypeHash('text-generation');
      const hash2 = client.registry.computeServiceTypeHash('text-generation');

      expect(hash1).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(hash1).toBe(hash2);

      // Different input = different hash
      const hash3 = client.registry.computeServiceTypeHash('code-review');
      expect(hash3).not.toBe(hash1);
    });
  });
});
