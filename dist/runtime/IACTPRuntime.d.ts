/**
 * Runtime interface for ACTP protocol operations.
 *
 * Implemented by:
 * - MockRuntime (for local development and testing)
 * - BlockchainRuntime (future, for real blockchain)
 *
 * This abstraction allows adapters to work with any runtime implementation,
 * enabling seamless transition from mock mode to production blockchain mode.
 *
 * @module runtime/IACTPRuntime
 */
import { MockTransaction, TransactionState } from './types/MockState';
/**
 * Parameters for creating a new transaction.
 */
export interface CreateTransactionParams {
    /** Provider's Ethereum address */
    provider: string;
    /** Requester's Ethereum address */
    requester: string;
    /** Transaction amount in USDC wei (string for BigNumber precision) */
    amount: string;
    /** Unix timestamp deadline for transaction acceptance */
    deadline: number;
    /** Dispute window duration in seconds (default: 172800 = 2 days) */
    disputeWindow?: number;
    /** Service description or metadata hash */
    serviceDescription?: string;
}
/**
 * Runtime interface for ACTP protocol operations.
 *
 * Defines the contract that all runtime implementations must follow,
 * enabling adapters to work with both mock and real blockchain backends.
 *
 * @example
 * ```typescript
 * // Using with MockRuntime
 * const runtime: IACTPRuntime = new MockRuntime();
 *
 * // Using with BlockchainRuntime (future)
 * const runtime: IACTPRuntime = new BlockchainRuntime({
 *   provider: ethersProvider,
 *   kernelAddress: '0x...',
 * });
 *
 * // Adapters work with either implementation
 * const adapter = new BeginnerAdapter(runtime, requesterAddress);
 * ```
 */
export interface IACTPRuntime {
    /**
     * Creates a new transaction.
     *
     * @param params - Transaction creation parameters
     * @returns Promise resolving to the transaction ID (bytes32 hex string)
     *
     * @throws {DeadlinePassedError} If deadline is in the past
     * @throws {InvalidAmountError} If amount is zero or negative
     *
     * @example
     * ```typescript
     * const txId = await runtime.createTransaction({
     *   provider: '0xProvider',
     *   requester: '0xRequester',
     *   amount: '1000000', // 1 USDC
     *   deadline: Math.floor(Date.now() / 1000) + 86400,
     * });
     * ```
     */
    createTransaction(params: CreateTransactionParams): Promise<string>;
    /**
     * Links an escrow to a transaction and locks funds.
     *
     * Automatically transitions INITIATED or QUOTED → COMMITTED (per ACTP spec).
     *
     * @param txId - Transaction ID
     * @param amount - Amount to lock (must match transaction amount)
     * @returns Promise resolving to the escrow ID
     *
     * @throws {TransactionNotFoundError} If transaction doesn't exist
     * @throws {InvalidStateTransitionError} If not in INITIATED or QUOTED state
     * @throws {InsufficientBalanceError} If requester has insufficient funds
     *
     * @example
     * ```typescript
     * const escrowId = await runtime.linkEscrow(txId, '1000000');
     * ```
     */
    linkEscrow(txId: string, amount: string): Promise<string>;
    /**
     * Transitions a transaction to a new state.
     *
     * Validates the transition against the ACTP 8-state machine.
     *
     * @param txId - Transaction ID
     * @param newState - Target state
     *
     * @throws {TransactionNotFoundError} If transaction doesn't exist
     * @throws {InvalidStateTransitionError} If transition is not valid
     * @throws {DeadlinePassedError} If deadline passed (for CANCELLED transition)
     *
     * @example
     * ```typescript
     * await runtime.transitionState(txId, 'DELIVERED');
     * ```
     */
    transitionState(txId: string, newState: TransactionState): Promise<void>;
    /**
     * Gets a transaction by ID.
     *
     * @param txId - Transaction ID
     * @returns Promise resolving to the transaction or null if not found
     *
     * @example
     * ```typescript
     * const tx = await runtime.getTransaction(txId);
     * if (tx) {
     *   console.log('State:', tx.state);
     * }
     * ```
     */
    getTransaction(txId: string): Promise<MockTransaction | null>;
    /**
     * Gets all transactions.
     *
     * @returns Promise resolving to array of all transactions
     *
     * @example
     * ```typescript
     * const transactions = await runtime.getAllTransactions();
     * for (const tx of transactions) {
     *   console.log(tx.id, tx.state);
     * }
     * ```
     */
    getAllTransactions(): Promise<MockTransaction[]>;
    /**
     * Releases escrow funds to the provider and settles the transaction.
     *
     * Can only be called when transaction is in DELIVERED state
     * and dispute window has expired.
     *
     * @param escrowId - Escrow ID
     *
     * @throws {EscrowNotFoundError} If escrow doesn't exist
     * @throws {TransactionNotFoundError} If linked transaction doesn't exist
     * @throws {InvalidStateTransitionError} If transaction not in DELIVERED state
     * @throws {DisputeWindowActiveError} If dispute window still active
     *
     * @example
     * ```typescript
     * await runtime.releaseEscrow(escrowId);
     * ```
     */
    releaseEscrow(escrowId: string): Promise<void>;
    /**
     * Gets the balance of an escrow.
     *
     * @param escrowId - Escrow ID
     * @returns Promise resolving to the balance as string
     *
     * @throws {EscrowNotFoundError} If escrow doesn't exist
     *
     * @example
     * ```typescript
     * const balance = await runtime.getEscrowBalance(escrowId);
     * console.log('Escrow balance:', balance);
     * ```
     */
    getEscrowBalance(escrowId: string): Promise<string>;
    /**
     * Time management interface.
     *
     * Provides access to current blockchain time and time manipulation
     * (for testing in mock mode).
     */
    time: {
        /** Get current timestamp in seconds */
        now(): number;
    };
}
/**
 * Extended runtime interface for mock mode.
 *
 * Includes testing utilities not available in production runtimes.
 * Only implemented by MockRuntime, not by blockchain runtimes.
 *
 * @example
 * ```typescript
 * // Type guard to check if runtime is MockRuntime
 * function isMockRuntime(runtime: IACTPRuntime): runtime is IMockRuntime {
 *   return 'reset' in runtime;
 * }
 *
 * // Safe usage
 * if (isMockRuntime(client.runtime)) {
 *   await client.runtime.reset();
 *   client.runtime.time.advanceTime(3600);
 * }
 * ```
 */
export interface IMockRuntime extends IACTPRuntime {
    /**
     * Reset state to default.
     *
     * Clears all transactions, escrows, balances, and events.
     * Only available in mock mode for testing.
     *
     * @example
     * ```typescript
     * await mockRuntime.reset();
     * ```
     */
    reset(): Promise<void>;
    /**
     * Mint tokens to an address.
     *
     * Only available in mock mode. Useful for funding test accounts.
     *
     * @param address - Address to mint tokens to
     * @param amount - Amount to mint in USDC wei
     *
     * @example
     * ```typescript
     * await mockRuntime.mintTokens('0x123...', '1000000000'); // 1000 USDC
     * ```
     */
    mintTokens(address: string, amount: string): Promise<void>;
    /**
     * Get balance of an address.
     *
     * @param address - Address to check
     * @returns Promise resolving to balance in USDC wei
     *
     * @example
     * ```typescript
     * const balance = await mockRuntime.getBalance('0x123...');
     * ```
     */
    getBalance(address: string): Promise<string>;
    /**
     * Extended time interface with manipulation methods.
     *
     * Provides time control for testing scenarios.
     *
     * SECURITY NOTE: All time-modifying methods are async and use
     * file locking to prevent race conditions in concurrent access.
     */
    time: {
        /** Get current timestamp in seconds */
        now(): number;
        /** Advance time by specified seconds (async for locking) */
        advanceTime(seconds: number): Promise<void>;
        /** Advance time by specified blocks (async for locking) */
        advanceBlocks(blocks: number): Promise<void>;
        /** Set exact timestamp (must be >= current time) (async for locking) */
        setTime(timestamp: number): Promise<void>;
    };
}
//# sourceMappingURL=IACTPRuntime.d.ts.map