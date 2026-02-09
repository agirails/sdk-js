/**
 * ERC-8004 Identity Bridge
 *
 * READ-ONLY access to ERC-8004 Identity Registry.
 * Resolves agent IDs to wallet addresses for ACTP payments.
 *
 * SECURITY NOTES:
 * - All operations are view functions (no gas costs)
 * - Safe to call without signer
 * - Caches results to minimize RPC calls
 * - Handles network errors gracefully
 *
 * @example
 * ```typescript
 * const bridge = new ERC8004Bridge({ network: 'base-sepolia' });
 *
 * // Check if agent exists
 * const exists = await bridge.verifyAgent('12345');
 *
 * // Get wallet for payment
 * const wallet = await bridge.getAgentWallet('12345');
 *
 * // Get full agent info
 * const agent = await bridge.resolveAgent('12345');
 * ```
 *
 * @module erc8004/ERC8004Bridge
 */

import { ethers } from 'ethers';
import {
  ERC8004Agent,
  ERC8004AgentMetadata,
  ERC8004Network,
  ERC8004Error,
  ERC8004ErrorCode,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_IDENTITY_ABI,
  ERC8004_DEFAULT_RPC,
} from '../types/erc8004';
import { sdkLogger } from '../utils/Logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Interface for ERC-8004 Identity Registry contract.
 * Used for testing with mock implementations.
 */
export interface IERC8004IdentityRegistry {
  ownerOf(agentId: string): Promise<string>;
  getAgentURI(agentId: string): Promise<string>;
  balanceOf(owner: string): Promise<bigint>;
  tokenOfOwnerByIndex(owner: string, index: number): Promise<bigint>;
}

/**
 * Configuration for ERC8004Bridge.
 */
export interface ERC8004BridgeConfig {
  /** Target network */
  network: ERC8004Network;

  /** Custom RPC URL (optional, uses default if not provided) */
  rpcUrl?: string;

  /** Override registry address (optional, for testing) */
  registryAddress?: string;

  /** Custom fetch function (optional, for testing) */
  fetchFn?: typeof fetch;

  /** Cache TTL in milliseconds (default: 60000 = 1 minute) */
  cacheTimeMs?: number;

  /** Metadata fetch timeout in milliseconds (default: 10000 = 10 seconds) */
  metadataTimeoutMs?: number;

  /**
   * Injected contract instance (optional, for testing).
   * If provided, skips creating a real ethers Contract.
   * @internal
   */
  _testContract?: IERC8004IdentityRegistry;
}

/**
 * Cached agent entry.
 */
interface CachedAgent {
  agent: ERC8004Agent;
  expiresAt: number;
}

// ============================================================================
// ERC8004Bridge
// ============================================================================

/**
 * Bridge for reading from ERC-8004 Identity Registry.
 *
 * Provides methods to:
 * - Verify agent existence
 * - Get agent wallet address for payments
 * - Resolve full agent info including metadata
 * - List agents owned by an address
 */
export class ERC8004Bridge {
  private readonly provider: ethers.JsonRpcProvider | null;
  private readonly registry: IERC8004IdentityRegistry;
  private readonly cache: Map<string, CachedAgent>;
  private readonly fetchFn: typeof fetch;
  private readonly cacheTimeMs: number;
  private readonly metadataTimeoutMs: number;
  private readonly network: ERC8004Network;

  constructor(config: ERC8004BridgeConfig) {
    this.network = config.network;
    this.fetchFn = config.fetchFn ?? fetch;
    this.cacheTimeMs = config.cacheTimeMs ?? 60000;
    this.metadataTimeoutMs = config.metadataTimeoutMs ?? 10000;
    this.cache = new Map();

    // Use injected contract for testing
    if (config._testContract) {
      this.provider = null;
      this.registry = config._testContract;
      return;
    }

    // Setup provider
    const rpcUrl = config.rpcUrl ?? ERC8004_DEFAULT_RPC[config.network];
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    // Setup registry contract
    const registryAddress =
      config.registryAddress ?? ERC8004_IDENTITY_REGISTRY[config.network];

    if (registryAddress === ethers.ZeroAddress) {
      sdkLogger.warn(
        `[ERC8004] Registry not deployed on ${config.network}. Using zero address.`
      );
    }

    this.registry = new ethers.Contract(
      registryAddress,
      ERC8004_IDENTITY_ABI,
      this.provider
    ) as unknown as IERC8004IdentityRegistry;
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Verify agent exists in ERC-8004 Identity Registry.
   *
   * Safe to call frequently - uses cache and is a view function.
   *
   * @param agentId - ERC-8004 agent ID (uint256 as string)
   * @returns true if agent exists, false otherwise
   */
  async verifyAgent(agentId: string): Promise<boolean> {
    // Validate format first
    if (!this.isValidAgentId(agentId)) {
      return false;
    }

    // Check cache
    const cached = this.cache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) {
      return true;
    }

    try {
      const owner = await this.registry.ownerOf(agentId);
      return owner !== ethers.ZeroAddress;
    } catch {
      // ownerOf reverts for non-existent tokens (ERC-721 standard)
      return false;
    }
  }

  /**
   * Get wallet address for receiving payments.
   *
   * Wallet priority:
   * 1. metadata.paymentAddress (explicit payment destination)
   * 2. metadata.wallet (alternative field name)
   * 3. owner address (fallback)
   *
   * @param agentId - ERC-8004 agent ID
   * @returns Checksummed wallet address
   * @throws ERC8004Error if agent not found
   */
  async getAgentWallet(agentId: string): Promise<string> {
    const agent = await this.resolveAgent(agentId);
    return agent.wallet;
  }

  /**
   * Resolve full agent info from ERC-8004.
   *
   * Fetches on-chain data (owner, agentURI) and off-chain metadata.
   * Results are cached for cacheTimeMs.
   *
   * @param agentId - ERC-8004 agent ID
   * @returns Full agent info including metadata
   * @throws ERC8004Error if agent not found or invalid ID
   */
  async resolveAgent(agentId: string): Promise<ERC8004Agent> {
    // Check cache first
    const cached = this.cache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.agent;
    }

    // Validate format
    if (!this.isValidAgentId(agentId)) {
      throw new ERC8004Error(
        `Invalid agent ID format: "${agentId}"`,
        ERC8004ErrorCode.INVALID_AGENT_ID,
        agentId
      );
    }

    // Fetch on-chain data
    let owner: string;
    let agentURI: string;

    try {
      [owner, agentURI] = await Promise.all([
        this.registry.ownerOf(agentId),
        this.registry.getAgentURI(agentId),
      ]);
    } catch (error) {
      // Check if it's a "nonexistent token" error
      const isNotFound =
        error instanceof Error &&
        (error.message.includes('nonexistent') ||
          error.message.includes('ERC721') ||
          error.message.includes('invalid token'));

      if (isNotFound) {
        throw new ERC8004Error(
          `Agent ${agentId} not found in ERC-8004 registry`,
          ERC8004ErrorCode.AGENT_NOT_FOUND,
          agentId
        );
      }

      throw new ERC8004Error(
        `Failed to fetch agent ${agentId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ERC8004ErrorCode.NETWORK_ERROR,
        agentId,
        error instanceof Error ? error : undefined
      );
    }

    // Check owner is valid
    if (owner === ethers.ZeroAddress) {
      throw new ERC8004Error(
        `Agent ${agentId} not found in ERC-8004 registry`,
        ERC8004ErrorCode.AGENT_NOT_FOUND,
        agentId
      );
    }

    // Fetch metadata (may return undefined if fetch fails)
    const metadata = await this.fetchMetadata(agentURI, agentId);

    // Determine wallet address
    // Priority: paymentAddress > wallet > owner
    let walletAddress = owner;

    if (metadata?.paymentAddress && this.isValidAddress(metadata.paymentAddress)) {
      walletAddress = metadata.paymentAddress;
    } else if (metadata?.wallet && this.isValidAddress(metadata.wallet)) {
      walletAddress = metadata.wallet;
    }

    // Build agent object
    const agent: ERC8004Agent = {
      agentId,
      owner: ethers.getAddress(owner), // Checksummed
      wallet: ethers.getAddress(walletAddress), // Checksummed
      agentURI,
      metadata,
      network: this.network,
    };

    // Cache result
    this.cache.set(agentId, {
      agent,
      expiresAt: Date.now() + this.cacheTimeMs,
    });

    return agent;
  }

  /**
   * Get all agent IDs owned by an address.
   *
   * @param owner - Owner address to query
   * @returns Array of agent IDs (may be empty)
   */
  async getAgentsByOwner(owner: string): Promise<string[]> {
    if (!this.isValidAddress(owner)) {
      return [];
    }

    try {
      const balance = await this.registry.balanceOf(owner);
      const balanceNum = Number(balance);

      if (balanceNum === 0) {
        return [];
      }

      const agentIds: string[] = [];

      for (let i = 0; i < balanceNum; i++) {
        const agentId = await this.registry.tokenOfOwnerByIndex(owner, i);
        agentIds.push(agentId.toString());
      }

      return agentIds;
    } catch (error) {
      sdkLogger.warn(`[ERC8004] Failed to get agents for owner ${owner}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /**
   * Clear all cached entries.
   * Useful for testing or forcing fresh data.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics (for debugging).
   */
  getCacheStats(): { size: number; network: ERC8004Network } {
    return {
      size: this.cache.size,
      network: this.network,
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Validate agent ID format.
   * Agent IDs are uint256 values (0 to 2^256-1).
   */
  private isValidAgentId(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') {
      return false;
    }

    // Must not look like an Ethereum address or URL
    if (agentId.startsWith('0x') || agentId.includes('://')) {
      return false;
    }

    try {
      const bn = BigInt(agentId);
      return bn >= 0n && bn < 2n ** 256n;
    } catch {
      return false;
    }
  }

  /**
   * Validate Ethereum address format.
   */
  private isValidAddress(address: string): boolean {
    try {
      ethers.getAddress(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch and parse metadata from agentURI.
   *
   * Handles:
   * - IPFS URIs (ipfs://...)
   * - HTTPS URIs
   * - Timeout protection
   * - Parse errors
   *
   * Returns undefined on any failure (never throws).
   */
  private async fetchMetadata(
    agentURI: string,
    agentId: string
  ): Promise<ERC8004AgentMetadata | undefined> {
    if (!agentURI) {
      return undefined;
    }

    try {
      // Convert IPFS URI to HTTP gateway
      let url = agentURI;
      if (url.startsWith('ipfs://')) {
        const cid = url.slice(7);
        url = `https://ipfs.io/ipfs/${cid}`;
      }

      // Validate URL
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        sdkLogger.warn(`[ERC8004] Invalid agentURI scheme for ${agentId}: ${url}`);
        return undefined;
      }

      // Fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.metadataTimeoutMs);

      try {
        const response = await this.fetchFn(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          sdkLogger.warn(
            `[ERC8004] Metadata fetch failed for ${agentId}: HTTP ${response.status}`
          );
          return undefined;
        }

        const data = await response.json();
        return data as ERC8004AgentMetadata;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // Log but don't throw - metadata is optional
      const errorMessage =
        error instanceof Error
          ? error.name === 'AbortError'
            ? 'timeout'
            : error.message
          : 'unknown error';

      sdkLogger.warn(`[ERC8004] Metadata fetch failed for ${agentId}: ${errorMessage}`);
      return undefined;
    }
  }
}
