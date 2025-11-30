import { ethers, Wallet, Signer, id } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import { ACTPKernel } from './protocol/ACTPKernel';
import { EscrowVault } from './protocol/EscrowVault';
import { EventMonitor } from './protocol/EventMonitor';
import { ProofGenerator } from './protocol/ProofGenerator';
import { MessageSigner } from './protocol/MessageSigner';
import { QuoteBuilder } from './builders/QuoteBuilder';
import { NetworkConfig, getNetwork } from './config/networks';
import { NetworkError, ValidationError } from './errors';
import { EASHelper, EASConfig } from './protocol/EASHelper';
import { NonceManager, InMemoryNonceManager } from './utils/NonceManager';
import { IPFSClient } from './utils/IPFSClient';

/**
 * ACTPClient configuration
 * @since v0.1.0
 */
export interface ACTPClientConfig {
  network: 'base-sepolia' | 'base-mainnet';
  privateKey?: string;
  signer?: Signer;
  provider?: JsonRpcProvider;
  rpcUrl?: string;
  contracts?: {
    actpKernel?: string;
    escrowVault?: string;
    usdc?: string;
  };
  gasSettings?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
  eas?: EASConfig;
}

/**
 * ACTPClient - Main entry point for ACTP SDK
 *
 * Example:
 * ```typescript
 * const client = await ACTPClient.create({
 *   network: 'base-sepolia',
 *   privateKey: process.env.PRIVATE_KEY
 * });
 *
 * const txId = await client.kernel.createTransaction({...});
 * ```
 */
export class ACTPClient {
  public readonly kernel: ACTPKernel;
  public readonly escrow: EscrowVault;
  public readonly events: EventMonitor;
  public readonly proofGenerator: ProofGenerator;
  public readonly messageSigner: MessageSigner;
  public readonly quote: QuoteBuilder;
  public readonly eas?: EASHelper;

  private readonly provider: JsonRpcProvider;
  private readonly signer: Signer;
  private readonly networkConfig: NetworkConfig;
  private readonly nonceManager: NonceManager;
  private readonly ipfs?: IPFSClient;

  /**
   * Private constructor - use ACTPClient.create() instead
   */
  private constructor(config: ACTPClientConfig) {
    // Validate config
    this.validateConfig(config);

    // Get network configuration (already cloned in getNetwork)
    this.networkConfig = getNetwork(config.network);

    // Apply overrides immutably (create new objects, don't mutate)
    if (config.contracts) {
      this.networkConfig = {
        ...this.networkConfig,
        contracts: {
          ...this.networkConfig.contracts,
          ...config.contracts
        }
      };
    }

    // Apply gas settings overrides
    if (config.gasSettings) {
      this.networkConfig = {
        ...this.networkConfig,
        gasSettings: {
          ...this.networkConfig.gasSettings,
          ...config.gasSettings
        }
      };
    }

    // Freeze config to prevent accidental mutation
    Object.freeze(this.networkConfig.contracts);
    Object.freeze(this.networkConfig.gasSettings);
    Object.freeze(this.networkConfig);

    // Setup provider
    if (config.provider) {
      this.provider = config.provider;
    } else {
      const rpcUrl = config.rpcUrl || this.networkConfig.rpcUrl;
      this.provider = new ethers.JsonRpcProvider(rpcUrl, this.networkConfig.chainId);
    }

    // Setup signer
    if (config.signer) {
      this.signer = config.signer;
    } else if (config.privateKey) {
      this.signer = new Wallet(config.privateKey, this.provider);
    } else {
      // Attempt to derive signer from provider if possible
      // In ethers v6, getSigner() is async and returns a JsonRpcSigner
      throw new ValidationError('signer', 'Either privateKey or signer must be provided');
    }

    // Initialize shared utilities
    this.nonceManager = new InMemoryNonceManager();

    // Initialize IPFS client if configured
    if (config.rpcUrl) {
      // IPFS configuration could be added to ACTPClientConfig in the future
      // For now, QuoteBuilder can work without IPFS (quotes stored only on-chain)
    }

    // Initialize protocol modules
    this.kernel = new ACTPKernel(
      this.networkConfig.contracts.actpKernel,
      this.signer,
      this.networkConfig.gasSettings
    );

    this.escrow = new EscrowVault(
      this.networkConfig.contracts.escrowVault,
      this.signer,
      this.networkConfig.gasSettings
    );

    this.events = new EventMonitor(
      this.kernel['contract'], // Access private contract field
      this.escrow['contract']
    );

    this.proofGenerator = new ProofGenerator();

    this.messageSigner = new MessageSigner(this.signer);

    // Initialize QuoteBuilder (AIP-2)
    this.quote = new QuoteBuilder(this.signer, this.nonceManager, this.ipfs);

    if (config.eas) {
      this.eas = new EASHelper(this.signer, config.eas);
    }
  }

  /**
   * Create and initialize ACTPClient (async factory pattern)
   * Ensures all async components (EIP-712 domain) are ready before returning
   */
  static async create(config: ACTPClientConfig): Promise<ACTPClient> {
    const client = new ACTPClient(config);
    
    // Initialize EIP-712 domain for message signing
    await client.messageSigner.initDomain(client.networkConfig.contracts.actpKernel);
    
    return client;
  }

  /**
   * @deprecated Use ACTPClient.create() instead
   * Initialize async components (must be called after construction)
   */
  async initialize(): Promise<void> {
    await this.messageSigner.initDomain(this.networkConfig.contracts.actpKernel);
  }

  /**
   * Get signer address
   */
  async getAddress(): Promise<string> {
    return await this.signer.getAddress();
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(): NetworkConfig {
    return this.networkConfig;
  }

  /**
   * Get provider
   */
  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    try {
      return await this.provider.getBlockNumber();
    } catch (error: any) {
      throw new NetworkError(this.networkConfig.name, error.message);
    }
  }

  /**
   * Get gas price (ethers v6: use getFeeData instead)
   */
  async getGasPrice() {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice || 0n;
    } catch (error: any) {
      throw new NetworkError(this.networkConfig.name, error.message);
    }
  }

  /**
   * Release escrow with automatic attestation verification (recommended for security).
   *
   * SECURITY: This method verifies the attestation belongs to the transaction BEFORE
   * releasing escrow. This protects against malicious providers submitting attestations
   * from different transactions.
   *
   * ACTPKernel V1 contract accepts any attestationUID without on-chain validation.
   * This SDK-side verification is the recommended protection until V2 adds on-chain checks.
   *
   * @param txId - Transaction ID to settle
   * @param attestationUID - EAS attestation UID to verify
   * @throws {Error} If EAS is not configured (client.eas is undefined)
   * @throws {Error} If attestation verification fails (revoked, expired, or txId mismatch)
   * @throws {TransactionRevertedError} If escrow release fails
   *
   * @example
   * ```typescript
   * // Get transaction to find attestation UID
   * const tx = await client.kernel.getTransaction(txId);
   *
   * // Verify and release escrow in one call
   * await client.releaseEscrowWithVerification(txId, tx.attestationUID);
   * ```
   */
  async releaseEscrowWithVerification(txId: string, attestationUID: string): Promise<void> {
    // Ensure EAS is configured
    if (!this.eas) {
      throw new Error(
        'EAS is not configured. Initialize ACTPClient with eas config or use kernel.releaseEscrow() directly (unsafe)'
      );
    }

    // Step 1: Verify attestation belongs to this transaction
    await this.eas.verifyDeliveryAttestation(txId, attestationUID);

    // Step 2: Release escrow (verification passed)
    await this.kernel.releaseEscrow(txId);
  }

  /**
   * Fund a transaction by approving USDC and linking escrow.
   *
   * This is a convenience method that combines:
   * 1. Get transaction details (amount + 1% fee)
   * 2. Approve USDC to EscrowVault
   * 3. Generate unique escrow ID
   * 4. Link escrow to transaction (moves to COMMITTED state)
   *
   * @param txId - Transaction ID to fund
   * @returns The escrow ID created
   * @throws {Error} If transaction not found or already funded
   *
   * @example
   * ```typescript
   * // Create transaction first
   * const txId = await client.kernel.createTransaction({...});
   *
   * // Fund it in one call
   * const escrowId = await client.fundTransaction(txId);
   * ```
   */
  async fundTransaction(txId: string): Promise<string> {
    // Get transaction to determine amount
    const tx = await this.kernel.getTransaction(txId);

    // Calculate total with 1% fee
    const fee = (tx.amount * 100n) / 10000n; // 1% = 100 basis points
    const total = tx.amount + fee;

    // Approve USDC to escrow vault
    await this.escrow.approveToken(this.networkConfig.contracts.usdc, total);

    // Generate unique escrow ID
    const escrowId = id(`escrow-${txId}-${Date.now()}`);

    // Link escrow (auto-transitions to COMMITTED)
    await this.kernel.linkEscrow(txId, this.networkConfig.contracts.escrowVault, escrowId);

    return escrowId;
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: ACTPClientConfig): void {
    if (!config.network) {
      throw new ValidationError('network', 'Network is required');
    }

    if (!config.privateKey && !config.signer && !config.provider) {
      throw new ValidationError('auth', 'Provide either privateKey, signer, or provider with signer access');
    }
  }
}
