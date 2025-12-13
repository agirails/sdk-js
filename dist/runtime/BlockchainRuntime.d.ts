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
import { Signer, JsonRpcProvider } from 'ethers';
import { ACTPKernel } from '../protocol/ACTPKernel';
import { EscrowVault } from '../protocol/EscrowVault';
import { EventMonitor } from '../protocol/EventMonitor';
import { MessageSigner } from '../protocol/MessageSigner';
import { NetworkConfig } from '../config/networks';
import { IACTPRuntime, CreateTransactionParams } from './IACTPRuntime';
import { MockTransaction, TransactionState } from './types/MockState';
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
    };
    /** Optional gas settings */
    gasSettings?: {
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
    };
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
export declare class BlockchainRuntime implements IACTPRuntime {
    private readonly kernel;
    private readonly escrow;
    private readonly events;
    private messageSigner;
    private readonly networkConfig;
    private readonly provider;
    private readonly signer;
    private reconnectAttempts;
    private readonly maxReconnectAttempts;
    private readonly baseReconnectDelay;
    private lastConnectionCheck;
    private readonly connectionCheckInterval;
    /**
     * Create new BlockchainRuntime instance
     *
     * @param config - Runtime configuration
     */
    constructor(config: BlockchainRuntimeConfig);
    /**
     * Initialize async components (must be called after construction)
     *
     * CRITICAL: This method MUST be called before using the runtime.
     * It initializes the MessageSigner with proper EIP-712 domain.
     *
     * @example
     * ```typescript
     * const runtime = new BlockchainRuntime(config);
     * await runtime.initialize();
     * ```
     */
    initialize(): Promise<void>;
    /**
     * Check if runtime has been initialized
     * @returns true if initialize() has been called
     */
    isInitialized(): boolean;
    /**
     * Require initialization before use
     *
     * SECURITY FIX (M-4): Enforces initialize() call before operations
     * @throws Error if initialize() has not been called
     */
    private requireInitialized;
    /**
     * Ensure provider connection is healthy with automatic reconnection
     *
     * SECURITY FIX (HIGH-3): Implements exponential backoff reconnection
     * to handle transient network failures gracefully.
     *
     * @throws Error if connection cannot be established after max attempts
     */
    private ensureConnected;
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
    };
    /**
     * Creates a new transaction on-chain
     *
     * @param params - Transaction creation parameters
     * @returns Promise resolving to transaction ID (bytes32 hex string)
     */
    createTransaction(params: CreateTransactionParams): Promise<string>;
    /**
     * Links escrow to a transaction and locks funds
     *
     * @param txId - Transaction ID
     * @param amount - Amount to lock (must match transaction amount)
     * @returns Promise resolving to escrow ID
     */
    linkEscrow(txId: string, amount: string): Promise<string>;
    /**
     * Transitions a transaction to a new state
     *
     * @param txId - Transaction ID
     * @param newState - Target state
     */
    transitionState(txId: string, newState: TransactionState): Promise<void>;
    /**
     * Gets a transaction by ID
     *
     * @param txId - Transaction ID
     * @returns Promise resolving to transaction or null if not found
     */
    getTransaction(txId: string): Promise<MockTransaction | null>;
    /**
     * Gets all transactions
     *
     * @returns Promise resolving to array of all transactions
     */
    getAllTransactions(): Promise<MockTransaction[]>;
    /**
     * Releases escrow funds to provider
     *
     * @param escrowId - Escrow ID (for compatibility; actual implementation uses txId)
     */
    releaseEscrow(escrowId: string): Promise<void>;
    /**
     * Gets escrow balance
     *
     * @param escrowId - Escrow ID
     * @returns Promise resolving to balance as string
     */
    getEscrowBalance(escrowId: string): Promise<string>;
    /**
     * Time interface (uses real blockchain time)
     */
    readonly time: {
        /**
         * Get current blockchain timestamp
         */
        now: () => number;
    };
    /**
     * Get the current signer address
     */
    getAddress(): Promise<string>;
    /**
     * Get current block number
     */
    getBlockNumber(): Promise<number>;
    /**
     * Get network configuration
     */
    getNetworkConfig(): NetworkConfig;
    /**
     * Get ACTPKernel instance (for advanced usage)
     */
    getKernel(): ACTPKernel;
    /**
     * Get EscrowVault instance (for advanced usage)
     */
    getEscrow(): EscrowVault;
    /**
     * Get EventMonitor instance (for advanced usage)
     */
    getEvents(): EventMonitor;
    /**
     * Get MessageSigner instance (for advanced usage)
     *
     * @throws Error if initialize() has not been called
     */
    getMessageSigner(): MessageSigner;
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
    estimateCreateTransactionGas(params: CreateTransactionParams): Promise<{
        gasLimit: bigint;
        gasCostWei: bigint;
        gasCostGwei: string;
    }>;
    /**
     * Estimate gas for linkEscrow operation
     *
     * @param txId - Transaction ID
     * @returns Estimated gas limit and cost
     */
    estimateLinkEscrowGas(txId: string): Promise<{
        gasLimit: bigint;
        gasCostWei: bigint;
        gasCostGwei: string;
    }>;
    /**
     * Estimate gas for state transition
     *
     * @param txId - Transaction ID
     * @param newState - Target state
     * @returns Estimated gas limit and cost
     */
    estimateTransitionGas(txId: string, newState: string): Promise<{
        gasLimit: bigint;
        gasCostWei: bigint;
        gasCostGwei: string;
    }>;
    /**
     * Get current gas price information
     *
     * @returns Current gas price data
     */
    getGasPrice(): Promise<{
        gasPrice: bigint;
        gasPriceGwei: string;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
    }>;
}
//# sourceMappingURL=BlockchainRuntime.d.ts.map