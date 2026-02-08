/**
 * AgentRegistryClient - Thin wrapper for AgentRegistry v2 config operations
 *
 * Provides methods for:
 * - Publishing AGIRAILS.md config (CID + hash) on-chain
 * - Managing launchpad listing visibility
 * - Reading config state for any agent
 *
 * @module registry/AgentRegistryClient
 */

import { Contract, Signer, Provider } from 'ethers';
import AgentRegistryABI from '../abi/AgentRegistry.json';
import { ValidationError, TransactionRevertedError } from '../errors';

// ============================================================================
// Types
// ============================================================================

export interface AgentConfigState {
  configHash: string;
  configCID: string;
  listed: boolean;
  isActive: boolean;
  updatedAt: number;
}

export interface PublishConfigResult {
  txHash: string;
}

interface GasOptions {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

// ============================================================================
// Client
// ============================================================================

export class AgentRegistryClient {
  private contract: Contract;
  private readonlyContract: Contract;

  constructor(
    private readonly registryAddress: string,
    private readonly signer: Signer,
    private readonly gasSettings?: GasOptions
  ) {
    this.contract = new Contract(registryAddress, AgentRegistryABI, signer);
    this.readonlyContract = this.contract;
  }

  /**
   * Create a read-only client (no signer required)
   */
  static readOnly(registryAddress: string, provider: Provider): AgentRegistryClient {
    // Create a minimal signer-like object for the contract
    // but only the readonly contract will be used
    const contract = new Contract(registryAddress, AgentRegistryABI, provider);
    const client = Object.create(AgentRegistryClient.prototype);
    client.registryAddress = registryAddress;
    client.readonlyContract = contract;
    client.contract = null; // Write operations will throw
    return client;
  }

  // ========== WRITE OPERATIONS ==========

  /**
   * Publish config (AGIRAILS.md) on-chain
   *
   * @param cid - IPFS CID pointing to the AGIRAILS.md file
   * @param hash - keccak256 of canonical AGIRAILS.md content (bytes32)
   * @returns Transaction hash
   */
  async publishConfig(cid: string, hash: string): Promise<PublishConfigResult> {
    if (!this.contract) {
      throw new Error('Write operations require a signer. Use AgentRegistryClient constructor, not readOnly().');
    }

    if (!cid || cid.length === 0) {
      throw new ValidationError('cid', 'IPFS CID is required');
    }
    if (cid.length > 128) {
      throw new ValidationError('cid', 'CID too long (max 128 characters)');
    }
    if (!hash || hash === '0x' + '0'.repeat(64)) {
      throw new ValidationError('hash', 'Config hash is required (cannot be zero)');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
      throw new ValidationError('hash', 'Config hash must be a valid bytes32 hex string');
    }

    try {
      const estimatedGas = await this.contract.publishConfig.estimateGas(cid, hash);
      const gasLimit = (estimatedGas * 120n) / 100n; // 20% buffer

      const txOptions: Record<string, unknown> = { gasLimit };
      if (this.gasSettings?.maxFeePerGas) {
        txOptions.maxFeePerGas = this.gasSettings.maxFeePerGas;
      }
      if (this.gasSettings?.maxPriorityFeePerGas) {
        txOptions.maxPriorityFeePerGas = this.gasSettings.maxPriorityFeePerGas;
      }

      const tx = await this.contract.publishConfig(cid, hash, txOptions);
      const receipt = await tx.wait();

      return { txHash: receipt.hash };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('Not registered')) {
        throw new TransactionRevertedError(
          'Agent not registered. Register first using the AgentRegistry before publishing config.',
          'publishConfig'
        );
      }
      throw error;
    }
  }

  /**
   * Set launchpad listing visibility
   *
   * @param listed - Whether agent should be visible on launchpad
   * @returns Transaction hash
   */
  async setListed(listed: boolean): Promise<string> {
    if (!this.contract) {
      throw new Error('Write operations require a signer. Use AgentRegistryClient constructor, not readOnly().');
    }

    try {
      const estimatedGas = await this.contract.setListed.estimateGas(listed);
      const gasLimit = (estimatedGas * 115n) / 100n; // 15% buffer

      const txOptions: Record<string, unknown> = { gasLimit };
      if (this.gasSettings?.maxFeePerGas) {
        txOptions.maxFeePerGas = this.gasSettings.maxFeePerGas;
      }
      if (this.gasSettings?.maxPriorityFeePerGas) {
        txOptions.maxPriorityFeePerGas = this.gasSettings.maxPriorityFeePerGas;
      }

      const tx = await this.contract.setListed(listed, txOptions);
      const receipt = await tx.wait();

      return receipt.hash;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('Not registered')) {
        throw new TransactionRevertedError(
          'Agent not registered. Register first before setting listing status.',
          'setListed'
        );
      }
      throw error;
    }
  }

  // ========== READ OPERATIONS ==========

  /**
   * Get config state for an agent
   *
   * @param agentAddress - Agent's Ethereum address
   * @returns Config state (hash, CID, listed, isActive, updatedAt)
   */
  async getConfig(agentAddress: string): Promise<AgentConfigState> {
    const contract = this.readonlyContract || this.contract;
    const profile = await contract.getAgent(agentAddress);

    return {
      configHash: profile.configHash,
      configCID: profile.configCID,
      listed: profile.listed,
      isActive: profile.isActive,
      updatedAt: Number(profile.updatedAt),
    };
  }

  /**
   * Check if an agent is listed on the launchpad
   *
   * @param agentAddress - Agent's Ethereum address
   * @returns true if agent is listed
   */
  async isListed(agentAddress: string): Promise<boolean> {
    const config = await this.getConfig(agentAddress);
    return config.listed;
  }

  /**
   * Get the on-chain config hash for an agent
   *
   * @param agentAddress - Agent's Ethereum address
   * @returns Config hash (bytes32) or zero hash if not published
   */
  async getConfigHash(agentAddress: string): Promise<string> {
    const config = await this.getConfig(agentAddress);
    return config.configHash;
  }
}
