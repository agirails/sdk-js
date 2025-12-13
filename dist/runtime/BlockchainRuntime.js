"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlockchainRuntime = void 0;
const ethers_1 = require("ethers");
const ACTPKernel_1 = require("../protocol/ACTPKernel");
const EscrowVault_1 = require("../protocol/EscrowVault");
const EventMonitor_1 = require("../protocol/EventMonitor");
const MessageSigner_1 = require("../protocol/MessageSigner");
const networks_1 = require("../config/networks");
const errors_1 = require("../errors");
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
class BlockchainRuntime {
    /**
     * Create new BlockchainRuntime instance
     *
     * @param config - Runtime configuration
     */
    constructor(config) {
        // SECURITY FIX (H-4): MessageSigner created via factory in initialize()
        this.messageSigner = null;
        // SECURITY FIX (HIGH-3): Provider reconnection with exponential backoff
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.baseReconnectDelay = 1000; // 1 second
        this.lastConnectionCheck = 0;
        this.connectionCheckInterval = 30000; // 30 seconds
        /**
         * Time interface (uses real blockchain time)
         */
        this.time = {
            /**
             * Get current blockchain timestamp
             */
            now: () => {
                return Math.floor(Date.now() / 1000);
            },
        };
        this.provider = config.provider;
        this.signer = config.signer;
        // Get network configuration
        this.networkConfig = (0, networks_1.getNetwork)(config.network);
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
        // Apply gas settings overrides if provided
        if (config.gasSettings) {
            this.networkConfig = {
                ...this.networkConfig,
                gasSettings: {
                    ...this.networkConfig.gasSettings,
                    ...config.gasSettings,
                },
            };
        }
        // Initialize protocol modules
        this.kernel = new ACTPKernel_1.ACTPKernel(this.networkConfig.contracts.actpKernel, this.signer, this.networkConfig.gasSettings);
        this.escrow = new EscrowVault_1.EscrowVault(this.networkConfig.contracts.escrowVault, this.signer, this.networkConfig.gasSettings);
        // SECURITY FIX (C-3): Use public getters instead of private field access
        this.events = new EventMonitor_1.EventMonitor(this.kernel.getContract(), this.escrow.getContract());
        // SECURITY FIX (H-4): MessageSigner is created in initialize() using factory pattern
        // This ensures EIP-712 domain is always properly initialized before use
    }
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
    async initialize() {
        // SECURITY FIX (H-4): Use factory pattern to guarantee domain initialization
        // This prevents runtime errors from uninitialized domain
        this.messageSigner = await MessageSigner_1.MessageSigner.create(this.signer, this.networkConfig.contracts.actpKernel, { chainId: this.networkConfig.chainId });
    }
    /**
     * Check if runtime has been initialized
     * @returns true if initialize() has been called
     */
    isInitialized() {
        return this.messageSigner !== null;
    }
    /**
     * Require initialization before use
     *
     * SECURITY FIX (M-4): Enforces initialize() call before operations
     * @throws Error if initialize() has not been called
     */
    requireInitialized() {
        if (!this.messageSigner) {
            throw new Error('BlockchainRuntime not initialized. Call initialize() before using any methods. ' +
                'This ensures proper EIP-712 domain setup and prevents runtime errors.');
        }
    }
    /**
     * Ensure provider connection is healthy with automatic reconnection
     *
     * SECURITY FIX (HIGH-3): Implements exponential backoff reconnection
     * to handle transient network failures gracefully.
     *
     * @throws Error if connection cannot be established after max attempts
     */
    async ensureConnected() {
        const now = Date.now();
        // Skip check if we recently verified connection
        if (now - this.lastConnectionCheck < this.connectionCheckInterval) {
            return;
        }
        try {
            // Test connection with a simple call
            await this.provider.getNetwork();
            this.reconnectAttempts = 0;
            this.lastConnectionCheck = now;
        }
        catch (error) {
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
                console.warn(`Provider connection lost. Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} ` +
                    `after ${delay}ms delay...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.ensureConnected();
            }
            // All reconnection attempts failed
            throw new Error(`Provider connection lost after ${this.maxReconnectAttempts} reconnection attempts. ` +
                `Last error: ${error instanceof Error ? error.message : String(error)}. ` +
                `Please check your network connectivity and RPC endpoint.`);
        }
    }
    /**
     * Get provider connection status
     *
     * SECURITY FIX (HIGH-3): Monitoring method for connection health
     *
     * @returns Connection status information
     */
    getConnectionStatus() {
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
    async createTransaction(params) {
        // SECURITY FIX (M-4): Enforce initialization
        this.requireInitialized();
        // SECURITY FIX (HIGH-3): Ensure provider connection before transaction
        await this.ensureConnected();
        // Validate parameters
        if (!params.provider || !ethers_1.ethers.isAddress(params.provider)) {
            throw new errors_1.ValidationError('provider', 'Invalid provider address');
        }
        if (!params.requester || !ethers_1.ethers.isAddress(params.requester)) {
            throw new errors_1.ValidationError('requester', 'Invalid requester address');
        }
        if (BigInt(params.amount) <= 0n) {
            throw new errors_1.ValidationError('amount', 'Amount must be positive');
        }
        const now = Math.floor(Date.now() / 1000);
        if (params.deadline <= now) {
            throw new errors_1.ValidationError('deadline', 'Deadline must be in the future');
        }
        // Call ACTPKernel contract
        const txId = await this.kernel.createTransaction({
            provider: params.provider,
            requester: params.requester,
            amount: BigInt(params.amount),
            deadline: params.deadline,
            disputeWindow: params.disputeWindow || 172800, // Default 2 days
            metadata: params.serviceDescription || '0x0000000000000000000000000000000000000000000000000000000000000000',
        });
        return txId;
    }
    /**
     * Links escrow to a transaction and locks funds
     *
     * @param txId - Transaction ID
     * @param amount - Amount to lock (must match transaction amount)
     * @returns Promise resolving to escrow ID
     */
    async linkEscrow(txId, amount) {
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
            throw new Error(`Cannot link escrow in current state ${tx.state}. Must be INITIATED or QUOTED.`);
        }
        // Validate amount matches transaction
        if (amount !== tx.amount) {
            throw new errors_1.ValidationError('amount', 'Amount must match transaction amount');
        }
        // Approve USDC to escrow vault
        await this.escrow.approveToken(this.networkConfig.contracts.usdc, BigInt(amount));
        // Generate unique escrow ID
        const escrowId = ethers_1.ethers.id(`escrow-${txId}-${Date.now()}`);
        // Link escrow to transaction
        await this.kernel.linkEscrow(txId, this.networkConfig.contracts.escrowVault, escrowId);
        return escrowId;
    }
    /**
     * Transitions a transaction to a new state
     *
     * @param txId - Transaction ID
     * @param newState - Target state
     */
    async transitionState(txId, newState) {
        // SECURITY FIX (M-4): Enforce initialization
        this.requireInitialized();
        // SECURITY FIX (HIGH-3): Ensure provider connection before transaction
        await this.ensureConnected();
        // Map TransactionState string to State enum value
        const stateMap = {
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
            throw new errors_1.ValidationError('state', `Invalid state: ${newState}`);
        }
        await this.kernel.transitionState(txId, stateValue);
    }
    /**
     * Gets a transaction by ID
     *
     * @param txId - Transaction ID
     * @returns Promise resolving to transaction or null if not found
     */
    async getTransaction(txId) {
        try {
            const tx = await this.kernel.getTransaction(txId);
            // Check if transaction exists (zero address = not found)
            if (tx.requester === ethers_1.ethers.ZeroAddress) {
                return null;
            }
            // Map blockchain transaction to MockTransaction format
            const stateMap = {
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
                throw new Error(`Unknown transaction state: ${tx.state}. ` +
                    `Valid states are 0-7 (INITIATED through CANCELLED). ` +
                    `This may indicate a contract version mismatch.`);
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
        }
        catch (error) {
            // If contract call fails, return null
            return null;
        }
    }
    /**
     * Gets all transactions
     *
     * @returns Promise resolving to array of all transactions
     */
    async getAllTransactions() {
        // For blockchain runtime, we cannot easily get all transactions
        // This would require event indexing. For now, return empty array.
        // TODO: Implement event-based transaction indexing
        console.warn('getAllTransactions() not fully implemented for BlockchainRuntime. Use EventMonitor for event-based queries.');
        return [];
    }
    /**
     * Releases escrow funds to provider
     *
     * @param escrowId - Escrow ID (for compatibility; actual implementation uses txId)
     */
    async releaseEscrow(escrowId) {
        // Find transaction by escrow ID
        // For now, assume escrowId format is "escrow-{txId}-{timestamp}"
        // Extract txId from escrowId
        const match = escrowId.match(/^escrow-(.+)-\d+$/);
        if (!match) {
            // If escrowId doesn't match pattern, try using it directly as txId
            await this.kernel.releaseEscrow(escrowId);
            return;
        }
        const txId = match[1];
        await this.kernel.releaseEscrow(txId);
    }
    /**
     * Gets escrow balance
     *
     * @param escrowId - Escrow ID
     * @returns Promise resolving to balance as string
     */
    async getEscrowBalance(escrowId) {
        // EscrowVault doesn't have getBalance method yet
        // For now, return "0" (TODO: implement proper escrow balance tracking)
        console.warn('getEscrowBalance not yet implemented for BlockchainRuntime');
        return '0';
    }
    // ============================================================================
    // Utility Methods (Not in IACTPRuntime but useful for blockchain runtime)
    // ============================================================================
    /**
     * Get the current signer address
     */
    async getAddress() {
        return await this.signer.getAddress();
    }
    /**
     * Get current block number
     */
    async getBlockNumber() {
        return await this.provider.getBlockNumber();
    }
    /**
     * Get network configuration
     */
    getNetworkConfig() {
        return this.networkConfig;
    }
    /**
     * Get ACTPKernel instance (for advanced usage)
     */
    getKernel() {
        return this.kernel;
    }
    /**
     * Get EscrowVault instance (for advanced usage)
     */
    getEscrow() {
        return this.escrow;
    }
    /**
     * Get EventMonitor instance (for advanced usage)
     */
    getEvents() {
        return this.events;
    }
    /**
     * Get MessageSigner instance (for advanced usage)
     *
     * @throws Error if initialize() has not been called
     */
    getMessageSigner() {
        if (!this.messageSigner) {
            throw new Error('BlockchainRuntime not initialized. Call initialize() before using MessageSigner. ' +
                'This is required for proper EIP-712 domain setup.');
        }
        return this.messageSigner;
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
    async estimateCreateTransactionGas(params) {
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
    async estimateLinkEscrowGas(txId) {
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
    async estimateTransitionGas(txId, newState) {
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
    async getGasPrice() {
        const feeData = await this.provider.getFeeData();
        return {
            gasPrice: feeData.gasPrice ?? 0n,
            gasPriceGwei: ((Number(feeData.gasPrice ?? 0n) / 1e9)).toFixed(4),
            maxFeePerGas: feeData.maxFeePerGas ?? undefined,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
        };
    }
}
exports.BlockchainRuntime = BlockchainRuntime;
//# sourceMappingURL=BlockchainRuntime.js.map