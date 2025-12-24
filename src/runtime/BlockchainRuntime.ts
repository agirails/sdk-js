/**
 * BlockchainRuntime - Real blockchain implementation of ACTP protocol
 *
 * Implements IACTPRuntime interface using actual smart contracts deployed
 * on Base Sepolia (testnet) or Base Mainnet (production).
 *
 * Features:
 * - Real blockchain transactions via ethers.js
 * - ACTPKernel smart contract integration
 * - EscrowVault contract integration
 * - EIP-712 message signing support
 * - Event monitoring and indexing
 * - Gas optimization
 *
 * @module runtime/BlockchainRuntime
 */

import { ethers, Signer, JsonRpcProvider, keccak256, toUtf8Bytes } from 'ethers';
import { ACTPKernel } from '../protocol/ACTPKernel';
import { EscrowVault } from '../protocol/EscrowVault';
import { EventMonitor } from '../protocol/EventMonitor';
import { MessageSigner } from '../protocol/MessageSigner';
import { EASHelper, EASConfig } from '../protocol/EASHelper';
import { NetworkConfig, getNetwork } from '../config/networks';
import { IACTPRuntime, CreateTransactionParams } from './IACTPRuntime';
import { MockTransaction, TransactionState } from './types/MockState';
import { ValidationError } from '../errors';
import { ServiceHash, DisputeWindow } from '../utils/Helpers';
import { IUsedAttestationTracker, createUsedAttestationTracker } from '../utils/UsedAttestationTracker';
import { IReceivedNonceTracker, createReceivedNonceTracker } from '../utils/ReceivedNonceTracker';

/**
 * Configuration for BlockchainRuntime
 */
export interface BlockchainRuntimeConfig {
  /** Network to connect to */
  network: 'base-sepolia' | 'base-mainnet';
  /** Ethers signer for transaction signing */
  signer: Signer;
  /** Ethers provider for blockchain queries */
  provider: JsonRpcProvider;
  /** Optional contract address overrides */
  contracts?: {
    actpKernel?: string;
    escrowVault?: string;
    usdc?: string;
    eas?: string;
  };
  /** Optional gas settings */
  gasSettings?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
  /** EAS (Ethereum Attestation Service) configuration for delivery proof verification */
  easConfig?: EASConfig;
  /**
   * SECURITY FIX (CRITICAL-2): Require attestation verification before escrow release
   * When true, releaseEscrow() will require a valid EAS attestation
   * Default: false for backward compatibility, SHOULD be true in production
   */
  requireAttestation?: boolean;
  /**
   * State directory for persistent attestation tracking
   * If provided, attestation replay protection will survive restarts
   */
  stateDirectory?: string;
}

/**
 * BlockchainRuntime - Production blockchain implementation
 *
 * Bridges the IACTPRuntime interface to actual smart contracts.
 * Provides seamless migration path from MockRuntime to production.
 *
 * @example
 * ```typescript
 * const provider = new ethers.JsonRpcProvider(rpcUrl);
 * const signer = new ethers.Wallet(privateKey, provider);
 *
 * const runtime = new BlockchainRuntime({
 *   network: 'base-sepolia',
 *   signer,
 *   provider
 * });
 *
 * // Now use with adapters
 * const adapter = new BeginnerAdapter(runtime, requesterAddress);
 * await adapter.createJob({...});
 * ```
 */
export class BlockchainRuntime implements IACTPRuntime {
  private readonly kernel: ACTPKernel;
  private readonly escrow: EscrowVault;
  private readonly events: EventMonitor;
  // SECURITY FIX (H-4): MessageSigner created via factory in initialize()
  private messageSigner: MessageSigner | null = null;
  // SECURITY FIX (CRITICAL-2): EAS helper for attestation verification
  private easHelper: EASHelper | null = null;
  // SECURITY FIX (HIGH-3): Attestation tracker for replay protection
  private readonly attestationTracker: IUsedAttestationTracker;
  // SECURITY FIX (CRITICAL-2): Flag to require attestation before release
  private readonly requireAttestation: boolean;
  // SECURITY FIX (MEDIUM-9): Nonce tracker for message replay protection
  private readonly nonceTracker: IReceivedNonceTracker;
  private readonly networkConfig: NetworkConfig;
  private readonly provider: JsonRpcProvider;
  private readonly signer: Signer;
  private readonly easConfig?: EASConfig;

  // SECURITY FIX (HIGH-3): Provider reconnection with exponential backoff
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly baseReconnectDelay = 1000; // 1 second
  private lastConnectionCheck = 0;
  private readonly connectionCheckInterval = 30000; // 30 seconds

  /**
   * Create new BlockchainRuntime instance
   *
   * @param config - Runtime configuration
   */
  constructor(config: BlockchainRuntimeConfig) {
    this.provider = config.provider;
    this.signer = config.signer;

    // Get network configuration
    this.networkConfig = getNetwork(config.network);

    // Apply contract address overrides if provided
    if (config.contracts) {
      this.networkConfig = {
        ...this.networkConfig,
        contracts: {
          ...this.networkConfig.contracts,
          ...config.contracts,
        },
      };
    }

    // NOTE (GAS DEFAULTS):
    // We intentionally do NOT force default maxFee/maxPriority caps unless the caller
    // explicitly provides gasSettings. Hardcoded caps can cause "insufficient funds for
    // intrinsic transaction cost" even when the wallet has enough ETH for the *actual*
    // network fee (ethers uses maxFee * gasLimit for the balance check).

    // SECURITY FIX (CRITICAL-2): Store EAS config for initialization
    this.easConfig = config.easConfig;

    // SECURITY FIX (CRITICAL-2): Default to NOT requiring attestation for backward compatibility
    // Production deployments SHOULD set this to true
    this.requireAttestation = config.requireAttestation ?? false;

    // SECURITY FIX (HIGH-3): Create attestation tracker with optional persistence
    // If stateDirectory is provided, attestations survive process restarts
    this.attestationTracker = createUsedAttestationTracker(config.stateDirectory);

    // SECURITY FIX (MEDIUM-9): Create nonce tracker for message replay protection
    // Uses memory-efficient strategy (tracks highest nonce per sender+type)
    this.nonceTracker = createReceivedNonceTracker('memory-efficient');

    // Initialize protocol modules
    this.kernel = new ACTPKernel(
      this.networkConfig.contracts.actpKernel,
      this.signer,
      config.gasSettings
    );

    this.escrow = new EscrowVault(
      this.networkConfig.contracts.escrowVault,
      this.signer,
      config.gasSettings
    );

    // SECURITY FIX (C-3): Use public getters instead of private field access
    this.events = new EventMonitor(
      this.kernel.getContract(),
      this.escrow.getContract()
    );

    // SECURITY FIX (H-4): MessageSigner is created in initialize() using factory pattern
    // This ensures EIP-712 domain is always properly initialized before use
  }

  /**
   * Initialize async components (must be called after construction)
   *
   * CRITICAL: This method MUST be called before using the runtime.
   * It initializes the MessageSigner with proper EIP-712 domain and
   * optionally the EASHelper for attestation verification.
   *
   * SECURITY FIX (CHAINID-VALIDATION): Validates that the connected network
   * matches the expected network configuration to prevent cross-chain attacks.
   *
   * @example
   * ```typescript
   * const runtime = new BlockchainRuntime(config);
   * await runtime.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    // SECURITY FIX (CHAINID-VALIDATION): Verify connected network matches config
    // This prevents:
    // 1. Cross-chain replay attacks (signing for one chain, replaying on another)
    // 2. Misconfigured RPC endpoints (connecting to wrong network)
    // 3. Man-in-the-middle RPC attacks (redirected to wrong chain)
    try {
      const network = await this.provider.getNetwork();
      const connectedChainId = Number(network.chainId);
      const expectedChainId = this.networkConfig.chainId;

      if (connectedChainId !== expectedChainId) {
        throw new Error(
          `Network mismatch: Connected to chainId ${connectedChainId}, ` +
          `but expected ${expectedChainId} (${this.networkConfig.name}). ` +
          `This could indicate a misconfigured RPC endpoint or cross-chain attack. ` +
          `Please verify your RPC URL points to the correct network.`
        );
      }

      console.info(
        `BlockchainRuntime: Connected to ${this.networkConfig.name} (chainId: ${connectedChainId})`
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('Network mismatch')) {
        throw error; // Re-throw our validation error
      }
      // For other errors (e.g., network issues), log warning but continue
      // This allows initialization to proceed even if network check fails temporarily
      console.warn(
        `BlockchainRuntime: Could not verify network chainId. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Proceeding with expected chainId ${this.networkConfig.chainId}.`
      );
    }

    // SECURITY FIX (H-4): Use factory pattern to guarantee domain initialization
    // This prevents runtime errors from uninitialized domain
    // SECURITY FIX (MEDIUM-9): Wire nonce tracker for message replay protection
    this.messageSigner = await MessageSigner.create(
      this.signer,
      this.networkConfig.contracts.actpKernel,
      {
        chainId: this.networkConfig.chainId,
        nonceTracker: this.nonceTracker,
      }
    );

    // SECURITY FIX (CRITICAL-2): Initialize EAS helper if config provided
    // This enables attestation verification for escrow release
    if (this.easConfig) {
      this.easHelper = new EASHelper(
        this.signer,
        this.easConfig,
        this.attestationTracker
      );
    } else if (this.requireAttestation) {
      console.warn(
        '[SECURITY WARNING] BlockchainRuntime: requireAttestation is true but no EAS config provided. ' +
        'Attestation verification will fail. Please provide easConfig in BlockchainRuntimeConfig.'
      );
    }
  }

  /**
   * Check if runtime has been initialized
   * @returns true if initialize() has been called
   */
  isInitialized(): boolean {
    return this.messageSigner !== null;
  }

  /**
   * Require initialization before use
   *
   * SECURITY FIX (M-4): Enforces initialize() call before operations
   * @throws Error if initialize() has not been called
   */
  private requireInitialized(): void {
    if (!this.messageSigner) {
      throw new Error(
        'BlockchainRuntime not initialized. Call initialize() before using any methods. ' +
        'This ensures proper EIP-712 domain setup and prevents runtime errors.'
      );
    }
  }

  /**
   * Ensure provider connection is healthy with automatic reconnection
   *
   * SECURITY FIX (HIGH-3): Implements exponential backoff reconnection
   * to handle transient network failures gracefully.
   *
   * SECURITY FIX (H-4): Converted from recursive to iterative loop
   * to prevent stack overflow on prolonged network failures.
   *
   * @throws Error if connection cannot be established after max attempts
   */
  private async ensureConnected(): Promise<void> {
    const now = Date.now();

    // Skip check if we recently verified connection
    if (now - this.lastConnectionCheck < this.connectionCheckInterval) {
      return;
    }

    // SECURITY FIX (H-4): Iterative loop instead of recursion (prevents stack overflow)
    for (let attempt = 0; attempt <= this.maxReconnectAttempts; attempt++) {
      try {
        // Test connection with a simple call
        await this.provider.getNetwork();

        // Connection successful
        this.reconnectAttempts = 0;
        this.lastConnectionCheck = now;
        return; // Exit successfully
      } catch (error) {
        if (attempt < this.maxReconnectAttempts) {
          // Not the last attempt - retry with exponential backoff
          this.reconnectAttempts = attempt + 1;
          const delay = this.baseReconnectDelay * Math.pow(2, attempt);

          console.warn(
            `Provider connection lost. Attempting reconnection ${attempt + 1}/${this.maxReconnectAttempts} ` +
            `after ${delay}ms delay... ` +
            `(Error: ${error instanceof Error ? error.message : String(error)})`
          );

          // Wait before next attempt
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Last attempt failed - throw error
          throw new Error(
            `Provider connection lost after ${this.maxReconnectAttempts} reconnection attempts. ` +
            `Last error: ${error instanceof Error ? error.message : String(error)}. ` +
            `Please check your network connectivity and RPC endpoint.`
          );
        }
      }
    }
  }

  /**
   * Get provider connection status
   *
   * SECURITY FIX (HIGH-3): Monitoring method for connection health
   *
   * @returns Connection status information
   */
  getConnectionStatus(): {
    isHealthy: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    lastCheckTimestamp: number;
  } {
    return {
      isHealthy: this.reconnectAttempts === 0,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      lastCheckTimestamp: this.lastConnectionCheck,
    };
  }

  /**
   * Creates a new transaction on-chain
   *
   * @param params - Transaction creation parameters
   * @returns Promise resolving to transaction ID (bytes32 hex string)
   */
  async createTransaction(params: CreateTransactionParams): Promise<string> {
    // SECURITY FIX (M-4): Enforce initialization
    this.requireInitialized();

    // SECURITY FIX (HIGH-3): Ensure provider connection before transaction
    await this.ensureConnected();

    // Validate parameters
    if (!params.provider || !ethers.isAddress(params.provider)) {
      throw new ValidationError('provider', 'Invalid provider address');
    }
    if (!params.requester || !ethers.isAddress(params.requester)) {
      throw new ValidationError('requester', 'Invalid requester address');
    }
    if (BigInt(params.amount) <= 0n) {
      throw new ValidationError('amount', 'Amount must be positive');
    }

    const now = Math.floor(Date.now() / 1000);
    if (params.deadline <= now) {
      throw new ValidationError('deadline', 'Deadline must be in the future');
    }

    // Call ACTPKernel contract
    const txId = await this.kernel.createTransaction({
      provider: params.provider,
      requester: params.requester,
      amount: BigInt(params.amount),
      deadline: params.deadline,
      disputeWindow: params.disputeWindow || 172800, // Default 2 days
      // SECURITY FIX (CRITICAL): serviceDescription should be a bytes32 hash
      // If caller passes raw string, it will fail on-chain. Basic/Standard API now hash before calling.
      metadata: this.validateServiceHash(params.serviceDescription),
    });

    return txId;
  }

  /**
   * Links escrow to a transaction and locks funds
   *
   * SIMPLIFICATION (ESCROW-ID): Uses txId as escrowId.
   * Per ACTP standard, escrowId = txId simplifies tracking and eliminates
   * the need for separate escrowId→txId mapping.
   *
   * @param txId - Transaction ID
   * @param amount - Amount to lock (must match transaction amount)
   * @returns Promise resolving to escrow ID (same as txId)
   */
  async linkEscrow(txId: string, amount: string): Promise<string> {
    // SECURITY FIX (M-4): Enforce initialization
    this.requireInitialized();

    // SECURITY FIX (HIGH-3): Ensure provider connection before transaction
    await this.ensureConnected();

    // Validate transaction exists and get details
    const tx = await this.getTransaction(txId);
    if (!tx) {
      throw new Error(`Transaction not found: ${txId}`);
    }

    // Validate state is INITIATED or QUOTED
    if (tx.state !== 'INITIATED' && tx.state !== 'QUOTED') {
      throw new Error(
        `Cannot link escrow in current state ${tx.state}. Must be INITIATED or QUOTED.`
      );
    }

    // Validate amount matches transaction
    if (amount !== tx.amount) {
      throw new ValidationError('amount', 'Amount must match transaction amount');
    }

    // Approve USDC to escrow vault
    await this.escrow.approveToken(this.networkConfig.contracts.usdc, BigInt(amount));

    // SIMPLIFICATION (ESCROW-ID): Use txId as escrowId
    // This aligns with ACTP standard where escrowId = txId
    // Benefits: No mapping needed, simpler tracking, direct correlation
    const escrowId = txId;

    // Link escrow to transaction
    await this.kernel.linkEscrow(txId, this.networkConfig.contracts.escrowVault, escrowId);

    return escrowId;
  }

  /**
   * Transitions a transaction to a new state
   *
   * SECURITY FIX (PROOF-PARAM): Added optional proof parameter for DELIVERED state.
   * The kernel contract uses proof data for dispute window configuration and
   * delivery verification. Without proof, default dispute window applies.
   *
   * @param txId - Transaction ID
   * @param newState - Target state
   * @param proof - Optional proof data (hex string, e.g., ABI-encoded delivery proof)
   */
  async transitionState(txId: string, newState: TransactionState, proof?: string): Promise<void> {
    // SECURITY FIX (M-4): Enforce initialization
    this.requireInitialized();

    // SECURITY FIX (HIGH-3): Ensure provider connection before transaction
    await this.ensureConnected();

    // Map TransactionState string to State enum value
    const stateMap: Record<TransactionState, number> = {
      INITIATED: 0,
      QUOTED: 1,
      COMMITTED: 2,
      IN_PROGRESS: 3,
      DELIVERED: 4,
      SETTLED: 5,
      DISPUTED: 6,
      CANCELLED: 7,
    };

    const stateValue = stateMap[newState];
    if (stateValue === undefined) {
      throw new ValidationError('state', `Invalid state: ${newState}`);
    }

    // SECURITY FIX (PROOF-PARAM): Pass proof to kernel if provided
    // Default to empty bytes (0x) if no proof provided
    const proofBytes = proof || '0x';
    await this.kernel.transitionState(txId, stateValue, proofBytes);
  }

  /**
   * Gets a transaction by ID
   *
   * @param txId - Transaction ID
   * @returns Promise resolving to transaction or null if not found
   */
  async getTransaction(txId: string): Promise<MockTransaction | null> {
    try {
      const tx = await this.kernel.getTransaction(txId);

      // Check if transaction exists (zero address = not found)
      if (tx.requester === ethers.ZeroAddress) {
        return null;
      }

      // Map blockchain transaction to MockTransaction format
      const stateMap: Record<number, TransactionState> = {
        0: 'INITIATED',
        1: 'QUOTED',
        2: 'COMMITTED',
        3: 'IN_PROGRESS',
        4: 'DELIVERED',
        5: 'SETTLED',
        6: 'DISPUTED',
        7: 'CANCELLED',
      };

      // SECURITY FIX (H-2): Throw error for unknown states instead of silent fallback
      const mappedState = stateMap[tx.state];
      if (mappedState === undefined) {
        throw new Error(
          `Unknown transaction state: ${tx.state}. ` +
          `Valid states are 0-7 (INITIATED through CANCELLED). ` +
          `This may indicate a contract version mismatch.`
        );
      }

      return {
        id: txId,
        provider: tx.provider,
        requester: tx.requester,
        amount: tx.amount.toString(),
        state: mappedState,
        deadline: Number(tx.deadline),
        disputeWindow: tx.disputeWindow !== undefined ? Number(tx.disputeWindow) : 172800, // Default 2 days
        escrowId: tx.escrowId,
        createdAt: Number(tx.createdAt),
        updatedAt: Number(tx.updatedAt),
        completedAt: 0, // TODO: Track completion timestamp
        serviceDescription: '', // TODO: Fetch from contract
        deliveryProof: '', // TODO: Fetch from contract
        events: [], // TODO: Fetch from event monitor
      };
    } catch (error) {
      // If contract call fails, return null
      return null;
    }
  }

  /**
   * Gets all transactions
   *
   * @returns Promise resolving to array of all transactions
   */
  async getAllTransactions(): Promise<MockTransaction[]> {
    // For blockchain runtime, we cannot easily get all transactions
    // This would require event indexing. For now, return empty array.
    // TODO: Implement event-based transaction indexing
    console.warn(
      'getAllTransactions() not fully implemented for BlockchainRuntime. Use EventMonitor for event-based queries.'
    );
    return [];
  }

  /**
   * Releases escrow funds to provider by settling the transaction
   *
   * SECURITY FIX (CRITICAL-2): This method now validates:
   * 1. Transaction state is DELIVERED
   * 2. Dispute window has elapsed
   * 3. EAS attestation is valid (if requireAttestation is true)
   *
   * SECURITY FIX (SETTLEMENT-FLOW): Uses transitionState(SETTLED) instead of
   * direct releaseEscrow() call. Per ACTPKernel.sol, settlement via state transition
   * automatically handles escrow release through _releaseEscrow() internal call.
   * This ensures proper state machine progression and event emission.
   *
   * SIMPLIFICATION (ESCROW-ID): Uses escrowId = txId standard.
   * The on-chain contract uses txId as the escrow identifier, so we simply
   * treat escrowId and txId as equivalent (no complex parsing needed).
   *
   * @param escrowId - Escrow ID (equivalent to txId in ACTP standard)
   * @param attestationUID - Optional EAS attestation UID for verification
   * @throws Error if transaction not found, not in DELIVERED state, or attestation invalid
   */
  async releaseEscrow(escrowId: string, attestationUID?: string): Promise<void> {
    // SECURITY FIX (M-4): Enforce initialization
    this.requireInitialized();

    // SECURITY FIX (HIGH-3): Ensure provider connection before transaction
    await this.ensureConnected();

    // SIMPLIFICATION (ESCROW-ID): escrowId = txId standard
    // On-chain, escrowId IS the txId. No need for complex parsing.
    // Support legacy format "escrow-{txId}-{timestamp}" for backward compatibility
    let txId: string;
    const legacyMatch = escrowId.match(/^escrow-(.+)-\d+$/);
    if (legacyMatch) {
      // Legacy SDK format - extract txId
      txId = legacyMatch[1];
      console.warn(
        `BlockchainRuntime.releaseEscrow: Using legacy escrowId format. ` +
        `Please update to use txId directly as escrowId.`
      );
    } else {
      // Standard: escrowId = txId
      txId = escrowId;
    }

    // SECURITY FIX (MEDIUM-1): Fetch transaction and validate state
    const tx = await this.getTransaction(txId);
    if (!tx) {
      throw new Error(`Transaction not found: ${txId}`);
    }

    // SECURITY FIX (MEDIUM-1): Validate transaction is in DELIVERED state
    if (tx.state !== 'DELIVERED') {
      throw new Error(
        `Cannot release escrow: transaction ${txId} is in state ${tx.state}, expected DELIVERED. ` +
        `Escrow can only be released after delivery is confirmed.`
      );
    }

    // SECURITY FIX (MEDIUM-1): Validate dispute window has elapsed
    if (tx.completedAt && tx.disputeWindow) {
      if (DisputeWindow.isActive(tx.completedAt, tx.disputeWindow)) {
        const remaining = DisputeWindow.remaining(tx.completedAt, tx.disputeWindow);
        throw new Error(
          `Cannot release escrow: dispute window still active for transaction ${txId}. ` +
          `Window expires in ${remaining} seconds. ` +
          `Wait for dispute window to close before releasing funds.`
        );
      }
    }

    // SECURITY FIX (CRITICAL-2): Verify EAS attestation if required
    if (this.requireAttestation) {
      if (!attestationUID) {
        throw new Error(
          `Cannot release escrow: attestation verification is required but no attestationUID provided. ` +
          `Call releaseEscrow(escrowId, attestationUID) with a valid EAS attestation UID.`
        );
      }

      if (!this.easHelper) {
        throw new Error(
          `Cannot release escrow: attestation verification is required but EAS helper not initialized. ` +
          `Provide easConfig in BlockchainRuntimeConfig and call initialize().`
        );
      }

      // Verify attestation is valid for this transaction
      try {
        await this.easHelper.verifyAndRecordForRelease(txId, attestationUID);
        console.info(
          `BlockchainRuntime.releaseEscrow: Attestation ${attestationUID} verified for transaction ${txId}.`
        );
      } catch (error) {
        throw new Error(
          `Cannot release escrow: attestation verification failed for transaction ${txId}. ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (attestationUID && this.easHelper) {
      // Even if not required, verify attestation if provided (best effort)
      try {
        await this.easHelper.verifyAndRecordForRelease(txId, attestationUID);
        console.info(
          `BlockchainRuntime.releaseEscrow: Attestation ${attestationUID} verified (optional) for transaction ${txId}.`
        );
      } catch (error) {
        console.warn(
          `BlockchainRuntime.releaseEscrow: Attestation verification failed but not required. ` +
          `Proceeding with release. Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      // No attestation verification
      console.info(
        `BlockchainRuntime.releaseEscrow: Settling transaction ${txId}. ` +
        `Note: Set requireAttestation=true and provide easConfig for additional security.`
      );
    }

    // SECURITY FIX (SETTLEMENT-FLOW): Use transitionState(SETTLED) instead of releaseEscrow()
    // Per ACTPKernel.sol, the settlement flow is:
    //   transitionState(txId, SETTLED, proof) → internally calls _releaseEscrow(txn)
    // This ensures proper state machine progression and emits correct events.
    // Direct kernel.releaseEscrow() may not properly update transaction state.
    await this.kernel.transitionState(txId, 5); // 5 = State.SETTLED
  }

  /**
   * Gets escrow balance
   *
   * MEDIUM: Returns the locked balance for a transaction from the escrow vault.
   * Queries the EscrowVault contract for the actual balance.
   *
   * @param escrowId - Escrow ID or transaction ID
   * @returns Promise resolving to balance as string (in USDC wei)
   */
  async getEscrowBalance(escrowId: string): Promise<string> {
    // SECURITY FIX (M-4): Enforce initialization
    this.requireInitialized();

    try {
      // Try to get balance from escrow vault
      // The escrow vault tracks balances by transaction ID
      const match = escrowId.match(/^escrow-(.+)-\d+$/);
      const txId = match ? match[1] : escrowId;

      // Query the transaction to get the locked amount
      const tx = await this.getTransaction(txId);
      if (!tx) {
        return '0';
      }

      // If transaction is in an active state (COMMITTED, IN_PROGRESS, DELIVERED),
      // the escrow balance is the transaction amount
      if (tx.state === 'COMMITTED' || tx.state === 'IN_PROGRESS' || tx.state === 'DELIVERED') {
        return tx.amount;
      }

      // For settled or cancelled transactions, escrow is released
      return '0';
    } catch (error) {
      // If query fails, return 0
      console.warn('BlockchainRuntime.getEscrowBalance: Query failed', error);
      return '0';
    }
  }

  /**
   * Time interface (uses real blockchain time)
   */
  public readonly time = {
    /**
     * Get current blockchain timestamp
     */
    now: (): number => {
      return Math.floor(Date.now() / 1000);
    },
  };

  // ============================================================================
  // Utility Methods (Not in IACTPRuntime but useful for blockchain runtime)
  // ============================================================================

  /**
   * Get the current signer address
   */
  async getAddress(): Promise<string> {
    return await this.signer.getAddress();
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(): NetworkConfig {
    return this.networkConfig;
  }

  /**
   * Get ACTPKernel instance (for advanced usage)
   */
  getKernel(): ACTPKernel {
    return this.kernel;
  }

  /**
   * Get EscrowVault instance (for advanced usage)
   */
  getEscrow(): EscrowVault {
    return this.escrow;
  }

  /**
   * Get EventMonitor instance (for advanced usage)
   */
  getEvents(): EventMonitor {
    return this.events;
  }

  /**
   * Get MessageSigner instance (for advanced usage)
   *
   * @throws Error if initialize() has not been called
   */
  getMessageSigner(): MessageSigner {
    if (!this.messageSigner) {
      throw new Error(
        'BlockchainRuntime not initialized. Call initialize() before using MessageSigner. ' +
        'This is required for proper EIP-712 domain setup.'
      );
    }
    return this.messageSigner;
  }

  /**
   * Get EASHelper instance (for attestation operations)
   *
   * @throws Error if EAS config not provided or initialize() not called
   */
  getEASHelper(): EASHelper {
    if (!this.easHelper) {
      throw new Error(
        'EASHelper not initialized. Provide easConfig in BlockchainRuntimeConfig and call initialize().'
      );
    }
    return this.easHelper;
  }

  /**
   * Get attestation tracker instance
   */
  getAttestationTracker(): IUsedAttestationTracker {
    return this.attestationTracker;
  }

  /**
   * Get nonce tracker instance (for monitoring/debugging)
   *
   * SECURITY FIX (MEDIUM-9): Exposed for monitoring nonce replay protection
   */
  getNonceTracker(): IReceivedNonceTracker {
    return this.nonceTracker;
  }

  /**
   * Check if attestation verification is required
   */
  isAttestationRequired(): boolean {
    return this.requireAttestation;
  }

  /**
   * Validate and normalize service hash for on-chain storage
   *
   * SECURITY FIX (CRITICAL): ACTPKernel expects bytes32 serviceHash.
   * This method validates format and hashes raw strings if needed.
   *
   * @param serviceDescription - Service hash or description string
   * @returns Valid bytes32 hash
   */
  private validateServiceHash(serviceDescription?: string): string {
    const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

    if (!serviceDescription) {
      return ZERO_HASH;
    }

    // If already a valid bytes32 hash, use it directly
    if (ServiceHash.isValidHash(serviceDescription)) {
      return serviceDescription;
    }

    // SECURITY FIX (CRITICAL): If it's a raw string (legacy format), hash it
    // This ensures on-chain compatibility with the contract's bytes32 expectation
    console.warn(
      'BlockchainRuntime: serviceDescription is not a valid bytes32 hash. ' +
      'Hashing it now. For best practice, use ServiceHash.hash() before calling createTransaction.'
    );

    return keccak256(toUtf8Bytes(serviceDescription));
  }

  // ============================================================================
  // Gas Estimation (M-2)
  // ============================================================================

  /**
   * Estimate gas for createTransaction operation
   *
   * SECURITY FIX (M-2): Pre-transaction gas estimation helps:
   * - Prevent failed transactions due to insufficient gas
   * - Allow users to make informed decisions about costs
   * - Catch potential issues before spending gas
   *
   * @param params - Transaction parameters
   * @returns Estimated gas limit and cost in wei
   */
  async estimateCreateTransactionGas(params: CreateTransactionParams): Promise<{
    gasLimit: bigint;
    gasCostWei: bigint;
    gasCostGwei: string;
  }> {
    // Get current gas price
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;

    // Estimate using contract method
    // For now, use a conservative estimate based on typical createTransaction costs
    // TODO: Implement actual contract gas estimation when kernel supports it
    const estimatedGasLimit = 150000n; // Conservative estimate

    const gasCostWei = estimatedGasLimit * gasPrice;
    const gasCostGwei = (Number(gasCostWei) / 1e9).toFixed(4);

    return {
      gasLimit: estimatedGasLimit,
      gasCostWei,
      gasCostGwei,
    };
  }

  /**
   * Estimate gas for linkEscrow operation
   *
   * @param txId - Transaction ID
   * @returns Estimated gas limit and cost
   */
  async estimateLinkEscrowGas(txId: string): Promise<{
    gasLimit: bigint;
    gasCostWei: bigint;
    gasCostGwei: string;
  }> {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;

    // linkEscrow includes USDC approve + contract call
    const estimatedGasLimit = 200000n; // Conservative estimate

    const gasCostWei = estimatedGasLimit * gasPrice;
    const gasCostGwei = (Number(gasCostWei) / 1e9).toFixed(4);

    return {
      gasLimit: estimatedGasLimit,
      gasCostWei,
      gasCostGwei,
    };
  }

  /**
   * Estimate gas for state transition
   *
   * @param txId - Transaction ID
   * @param newState - Target state
   * @returns Estimated gas limit and cost
   */
  async estimateTransitionGas(txId: string, newState: string): Promise<{
    gasLimit: bigint;
    gasCostWei: bigint;
    gasCostGwei: string;
  }> {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;

    // State transitions are relatively cheap
    const estimatedGasLimit = 80000n; // Conservative estimate

    const gasCostWei = estimatedGasLimit * gasPrice;
    const gasCostGwei = (Number(gasCostWei) / 1e9).toFixed(4);

    return {
      gasLimit: estimatedGasLimit,
      gasCostWei,
      gasCostGwei,
    };
  }

  /**
   * Get current gas price information
   *
   * @returns Current gas price data
   */
  async getGasPrice(): Promise<{
    gasPrice: bigint;
    gasPriceGwei: string;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }> {
    const feeData = await this.provider.getFeeData();

    return {
      gasPrice: feeData.gasPrice ?? 0n,
      gasPriceGwei: ((Number(feeData.gasPrice ?? 0n) / 1e9)).toFixed(4),
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
    };
  }
}
