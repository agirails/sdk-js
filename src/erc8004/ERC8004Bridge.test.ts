/**
 * ERC8004Bridge Unit Tests
 *
 * Tests the ERC-8004 Identity Registry bridge:
 * - verifyAgent() - Check agent existence
 * - getAgentWallet() - Get payment wallet
 * - resolveAgent() - Full agent resolution
 * - Caching behavior
 * - Error handling
 *
 * @module erc8004/ERC8004Bridge.test
 */

import {
  ERC8004Bridge,
  ERC8004BridgeConfig,
  IERC8004IdentityRegistry,
} from './ERC8004Bridge';
import { ERC8004Error, ERC8004ErrorCode } from '../types/erc8004';

// ============================================================================
// Mock Setup
// ============================================================================

/**
 * Create a mock identity registry for testing.
 */
function createMockRegistry(): jest.Mocked<IERC8004IdentityRegistry> {
  return {
    ownerOf: jest.fn(),
    getAgentURI: jest.fn(),
    balanceOf: jest.fn(),
    tokenOfOwnerByIndex: jest.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ERC8004Bridge', () => {
  const validAgentId = '12345';
  // Valid checksummed Ethereum addresses for testing
  const validOwner = '0x1234567890123456789012345678901234567890';
  const validAgentURI = 'https://example.com/agent/12345.json';

  let mockRegistry: jest.Mocked<IERC8004IdentityRegistry>;
  let mockFetch: jest.Mock;
  let bridge: ERC8004Bridge;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRegistry = createMockRegistry();
    mockFetch = jest.fn();

    bridge = new ERC8004Bridge({
      network: 'base-sepolia',
      registryAddress: '0x1234567890123456789012345678901234567890',
      fetchFn: mockFetch,
      cacheTimeMs: 1000, // 1 second cache for testing
      _testContract: mockRegistry,
    });
  });

  describe('verifyAgent()', () => {
    it('returns true for existing agent', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);

      const exists = await bridge.verifyAgent(validAgentId);

      expect(exists).toBe(true);
      expect(mockRegistry.ownerOf).toHaveBeenCalledWith(validAgentId);
    });

    it('returns false for non-existent agent', async () => {
      mockRegistry.ownerOf.mockRejectedValue(new Error('ERC721: nonexistent token'));

      const exists = await bridge.verifyAgent('99999');

      expect(exists).toBe(false);
    });

    it('returns false for invalid agentId format', async () => {
      // Ethereum address - not a valid agentId
      const exists = await bridge.verifyAgent('0x1234567890123456789012345678901234567890');
      expect(exists).toBe(false);

      // URL - not a valid agentId
      const exists2 = await bridge.verifyAgent('https://example.com');
      expect(exists2).toBe(false);

      // Non-numeric string
      const exists3 = await bridge.verifyAgent('not-a-number');
      expect(exists3).toBe(false);
    });

    it('returns false for zero address owner', async () => {
      mockRegistry.ownerOf.mockResolvedValue('0x0000000000000000000000000000000000000000');

      const exists = await bridge.verifyAgent(validAgentId);

      expect(exists).toBe(false);
    });
  });

  describe('getAgentWallet()', () => {
    it('returns metadata.paymentAddress if present', async () => {
      const paymentAddress = '0x2222222222222222222222222222222222222222';

      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'Test Agent',
          paymentAddress,
        }),
      });

      const wallet = await bridge.getAgentWallet(validAgentId);

      expect(wallet).toBe(paymentAddress);
    });

    it('returns metadata.wallet as fallback', async () => {
      const walletAddress = '0x3333333333333333333333333333333333333333';

      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'Test Agent',
          wallet: walletAddress, // No paymentAddress, but has wallet
        }),
      });

      const wallet = await bridge.getAgentWallet(validAgentId);

      expect(wallet).toBe(walletAddress);
    });

    it('returns owner address as final fallback', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'Test Agent',
          // No paymentAddress or wallet
        }),
      });

      const wallet = await bridge.getAgentWallet(validAgentId);

      expect(wallet).toBe(validOwner);
    });

    it('throws for non-existent agent', async () => {
      mockRegistry.ownerOf.mockRejectedValue(new Error('ERC721: nonexistent token'));

      await expect(bridge.getAgentWallet('99999')).rejects.toThrow(ERC8004Error);
      await expect(bridge.getAgentWallet('99999')).rejects.toMatchObject({
        code: ERC8004ErrorCode.AGENT_NOT_FOUND,
      });
    });
  });

  describe('resolveAgent()', () => {
    it('fetches owner and agentURI from registry', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'Test Agent' }),
      });

      const agent = await bridge.resolveAgent(validAgentId);

      expect(agent.agentId).toBe(validAgentId);
      expect(agent.owner).toBe(validOwner);
      expect(agent.agentURI).toBe(validAgentURI);
      expect(agent.network).toBe('base-sepolia');
    });

    it('fetches and parses metadata from agentURI', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      const metadata = {
        name: 'Test Agent',
        description: 'A test agent',
        capabilities: ['code_generation', 'data_analysis'],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => metadata,
      });

      const agent = await bridge.resolveAgent(validAgentId);

      expect(agent.metadata).toEqual(metadata);
    });

    it('handles IPFS URIs', async () => {
      const ipfsURI = 'ipfs://QmTest1234567890';
      const expectedHttpURI = 'https://ipfs.io/ipfs/QmTest1234567890';

      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(ipfsURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'IPFS Agent' }),
      });

      await bridge.resolveAgent(validAgentId);

      expect(mockFetch).toHaveBeenCalledWith(
        expectedHttpURI,
        expect.objectContaining({
          headers: { Accept: 'application/json' },
        })
      );
    });

    it('caches results', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'Cached Agent' }),
      });

      // First call - should hit registry
      const agent1 = await bridge.resolveAgent(validAgentId);

      // Second call - should use cache
      const agent2 = await bridge.resolveAgent(validAgentId);

      // Registry should only be called once
      expect(mockRegistry.ownerOf).toHaveBeenCalledTimes(1);
      expect(agent1).toEqual(agent2);
    });

    it('throws for invalid agentId format', async () => {
      await expect(bridge.resolveAgent('not-a-number')).rejects.toMatchObject({
        code: ERC8004ErrorCode.INVALID_AGENT_ID,
      });
    });

    it('throws for non-existent agent', async () => {
      mockRegistry.ownerOf.mockRejectedValue(new Error('invalid token'));

      await expect(bridge.resolveAgent('99999')).rejects.toMatchObject({
        code: ERC8004ErrorCode.AGENT_NOT_FOUND,
      });
    });

    it('handles metadata fetch failure gracefully', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      // Should not throw, just return undefined metadata
      const agent = await bridge.resolveAgent(validAgentId);

      expect(agent.metadata).toBeUndefined();
      expect(agent.wallet).toBe(validOwner); // Fallback to owner
    });
  });

  describe('getAgentsByOwner()', () => {
    it('returns all agent IDs for owner', async () => {
      mockRegistry.balanceOf.mockResolvedValue(3n);
      mockRegistry.tokenOfOwnerByIndex
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(200n)
        .mockResolvedValueOnce(300n);

      const agents = await bridge.getAgentsByOwner(validOwner);

      expect(agents).toEqual(['100', '200', '300']);
    });

    it('returns empty array if no agents', async () => {
      mockRegistry.balanceOf.mockResolvedValue(0n);

      const agents = await bridge.getAgentsByOwner(validOwner);

      expect(agents).toEqual([]);
    });

    it('returns empty array for invalid address', async () => {
      const agents = await bridge.getAgentsByOwner('not-an-address');

      expect(agents).toEqual([]);
    });
  });

  describe('caching', () => {
    it('expires cache after cacheTimeMs', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'Cached Agent' }),
      });

      // First call
      await bridge.resolveAgent(validAgentId);

      // Wait for cache to expire (cacheTimeMs = 1000)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Second call - should hit registry again
      await bridge.resolveAgent(validAgentId);

      expect(mockRegistry.ownerOf).toHaveBeenCalledTimes(2);
    });

    it('clearCache() invalidates all entries', async () => {
      mockRegistry.ownerOf.mockResolvedValue(validOwner);
      mockRegistry.getAgentURI.mockResolvedValue(validAgentURI);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'Cached Agent' }),
      });

      // First call
      await bridge.resolveAgent(validAgentId);

      // Clear cache
      bridge.clearCache();

      // Second call - should hit registry again
      await bridge.resolveAgent(validAgentId);

      expect(mockRegistry.ownerOf).toHaveBeenCalledTimes(2);
    });
  });
});
