/**
 * MockRuntime - Core mock blockchain engine for ACTP protocol testing
 *
 * Provides a complete mock blockchain environment for testing ACTP transactions
 * without real blockchain interactions. Implements the 8-state ACTP transaction
 * lifecycle with strict state machine validation.
 *
 * Features:
 * - 8-state transaction lifecycle (INITIATED -> QUOTED -> COMMITTED -> IN_PROGRESS -> DELIVERED -> SETTLED)
 * - Time manipulation (advanceTime, setTime, advanceBlocks)
 * - Balance management (mint, transfer)
 * - Event recording and querying
 * - Escrow operations (link, release, balance tracking)
 *
 * @module runtime/MockRuntime
 * @see ADR-004 (Mock Blockchain Emulation Scope)
 * @see MOCK_MODE_SPECIFICATION.md
 */
import { MockStateManager } from './MockStateManager';
import { MockState, MockTransaction, MockEvent, TransactionState } from './types/MockState';
import { IACTPRuntime, CreateTransactionParams } from './IACTPRuntime';
/**
 * Error thrown when a transaction is not found.
 */
export declare class TransactionNotFoundError extends Error {
    readonly txId: string;
    constructor(txId: string);
}
/**
 * Error thrown when an invalid state transition is attempted.
 */
export declare class InvalidStateTransitionError extends Error {
    readonly txId: string;
    readonly currentState: TransactionState;
    readonly targetState: TransactionState;
    constructor(txId: string, currentState: TransactionState, targetState: TransactionState);
}
/**
 * Error thrown when there are insufficient funds for an operation.
 */
export declare class InsufficientBalanceError extends Error {
    readonly address: string;
    readonly required: string;
    readonly available: string;
    constructor(address: string, required: string, available: string);
}
/**
 * Error thrown when an escrow is not found.
 */
export declare class EscrowNotFoundError extends Error {
    readonly escrowId: string;
    constructor(escrowId: string);
}
/**
 * Error thrown when the deadline has passed.
 */
export declare class DeadlinePassedError extends Error {
    readonly txId: string;
    readonly deadline: number;
    readonly currentTime: number;
    constructor(txId: string, deadline: number, currentTime: number);
}
/**
 * Error thrown when the contract is paused.
 */
export declare class ContractPausedError extends Error {
    constructor();
}
/**
 * Error thrown when an invalid amount is provided.
 *
 * Thrown when zero or negative amounts are passed to transaction
 * or escrow operations.
 *
 * @example
 * ```typescript
 * // This will throw InvalidAmountError
 * await runtime.createTransaction({
 *   provider: '0x...',
 *   requester: '0x...',
 *   amount: '0', // Invalid - must be positive
 *   deadline: Date.now() + 86400
 * });
 * ```
 */
export declare class InvalidAmountError extends Error {
    readonly amount: string;
    readonly reason: string;
    constructor(amount: string, reason: string);
}
/**
 * Error thrown when dispute window is still active.
 *
 * Thrown when attempting to release escrow funds before the dispute
 * window has expired. Use `runtime.time.advanceTime()` in tests to
 * simulate waiting for the window to close.
 *
 * @example
 * ```typescript
 * // Transaction delivered, but dispute window still active
 * await runtime.releaseEscrow(escrowId);
 * // Throws: DisputeWindowActiveError
 *
 * // Solution: advance time past the dispute window
 * runtime.time.advanceTime(tx.disputeWindow + 1);
 * await runtime.releaseEscrow(escrowId); // Now works
 * ```
 */
export declare class DisputeWindowActiveError extends Error {
    readonly txId: string;
    readonly windowEnd: number;
    readonly currentTime: number;
    constructor(txId: string, windowEnd: number, currentTime: number);
}
/**
 * MockRuntime - Core mock blockchain engine for ACTP protocol testing.
 *
 * Implements the IACTPRuntime interface for mock/testing mode.
 * Provides a complete mock blockchain environment with:
 * - Transaction state machine (8 states)
 * - Time manipulation
 * - Balance management
 * - Event recording
 *
 * @example
 * ```typescript
 * const runtime = new MockRuntime();
 *
 * // Mint initial funds
 * await runtime.mintTokens('0xRequester', '10000000000'); // 10,000 USDC
 *
 * // Create transaction
 * const txId = await runtime.createTransaction({
 *   provider: '0xProvider',
 *   requester: '0xRequester',
 *   amount: '1000000', // 1 USDC
 *   deadline: runtime.time.now() + 86400,
 * });
 *
 * // Advance time and process
 * runtime.time.advanceTime(3600);
 * ```
 */
export declare class MockRuntime implements IACTPRuntime {
    private stateManager;
    /**
     * In-memory event log, also persisted to state file.
     *
     * SECURITY FIX (L-4): Events are now persisted to the state file
     * so they survive across CLI invocations.
     */
    private eventLog;
    /**
     * Time management interface.
     *
     * SECURITY NOTE: All time-modifying operations are async and use
     * file locking to prevent race conditions.
     */
    readonly time: {
        /** Get current mock timestamp (seconds) */
        now: () => number;
        /** Advance time by specified seconds (async for locking) */
        advanceTime: (seconds: number) => Promise<void>;
        /** Advance time by specified blocks (block time * blocks) (async for locking) */
        advanceBlocks: (blocks: number) => Promise<void>;
        /** Set exact timestamp (must be >= current time) (async for locking) */
        setTime: (timestamp: number) => Promise<void>;
    };
    /**
     * Event access interface.
     */
    readonly events: {
        /** Get all recorded events */
        getAll: () => MockEvent[];
        /** Get events filtered by type */
        getByType: (type: string) => MockEvent[];
        /** Get events for a specific transaction */
        getByTransaction: (txId: string) => MockEvent[];
        /** Clear all events */
        clear: () => void;
    };
    /**
     * Creates a new MockRuntime instance.
     *
     * @param stateManager - Optional custom state manager (default: creates new one)
     */
    constructor(stateManager?: MockStateManager);
    /**
     * Load events from persisted state file.
     *
     * SECURITY FIX (L-4): Events survive across CLI invocations.
     */
    private loadPersistedEvents;
    /**
     * Clear persisted events from state file.
     */
    private clearPersistedEvents;
    /**
     * Persist an event to both in-memory log and state file.
     *
     * SECURITY FIX (L-4): Events are persisted for audit trail.
     *
     * @param event - Event to persist
     * @param state - Current state (to avoid re-loading)
     */
    private persistEvent;
    /**
     * Creates a new transaction.
     *
     * @param params - Transaction creation parameters
     * @returns Promise resolving to the transaction ID (bytes32 hex string)
     *
     * @throws {DeadlinePassedError} If deadline is in the past
     *
     * @example
     * ```typescript
     * const txId = await runtime.createTransaction({
     *   provider: '0xProvider',
     *   requester: '0xRequester',
     *   amount: '1000000', // 1 USDC
     *   deadline: runtime.time.now() + 86400,
     * });
     * ```
     */
    createTransaction(params: CreateTransactionParams): Promise<string>;
    /**
     * Gets a transaction by ID.
     *
     * @param txId - Transaction ID
     * @returns Promise resolving to the transaction or null if not found
     */
    getTransaction(txId: string): Promise<MockTransaction | null>;
    /**
     * Gets all transactions.
     *
     * @returns Promise resolving to array of all transactions
     */
    getAllTransactions(): Promise<MockTransaction[]>;
    /**
     * Transitions a transaction to a new state.
     *
     * Validates the transition against the ACTP 8-state machine:
     * - INITIATED -> QUOTED, COMMITTED, CANCELLED
     * - QUOTED -> COMMITTED, CANCELLED
     * - COMMITTED -> IN_PROGRESS, DELIVERED, CANCELLED
     * - IN_PROGRESS -> DELIVERED, CANCELLED
     * - DELIVERED -> SETTLED, DISPUTED
     * - DISPUTED -> SETTLED
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
     * // Transition to DELIVERED state
     * await runtime.transitionState(txId, 'DELIVERED');
     * ```
     */
    transitionState(txId: string, newState: TransactionState): Promise<void>;
    /**
     * Links an escrow to a transaction and locks funds.
     *
     * Automatically transitions INITIATED or QUOTED -> COMMITTED (per ACTP spec).
     * Deducts funds from requester and adds to escrow balance.
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
     * // Ensure requester has funds
     * await runtime.mintTokens(requester, '10000000');
     *
     * // Link escrow
     * const escrowId = await runtime.linkEscrow(txId, '1000000');
     * ```
     */
    linkEscrow(txId: string, amount: string): Promise<string>;
    /**
     * Releases escrow funds to the provider and settles the transaction.
     *
     * Can only be called when transaction is in DELIVERED state.
     *
     * @param escrowId - Escrow ID
     *
     * @throws {EscrowNotFoundError} If escrow doesn't exist
     * @throws {TransactionNotFoundError} If linked transaction doesn't exist
     * @throws {InvalidStateTransitionError} If transaction not in DELIVERED state
     *
     * @example
     * ```typescript
     * // After delivery is confirmed
     * await runtime.releaseEscrow(escrowId);
     *
     * // Provider now has funds
     * const balance = await runtime.getBalance(provider);
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
     */
    getEscrowBalance(escrowId: string): Promise<string>;
    /**
     * Gets the USDC balance of an address.
     *
     * @param address - Ethereum address
     * @returns Promise resolving to the balance as string (0 if account doesn't exist)
     */
    getBalance(address: string): Promise<string>;
    /**
     * Mints USDC tokens to an address (testing only).
     *
     * @param address - Ethereum address to receive tokens
     * @param amount - Amount to mint in USDC wei
     *
     * @example
     * ```typescript
     * // Mint 10,000 USDC (6 decimals)
     * await runtime.mintTokens('0xRequester', '10000000000');
     * ```
     */
    mintTokens(address: string, amount: string): Promise<void>;
    /**
     * Transfers USDC tokens between addresses.
     *
     * @param from - Sender address
     * @param to - Recipient address
     * @param amount - Amount to transfer in USDC wei
     *
     * @throws {InsufficientBalanceError} If sender has insufficient funds
     *
     * @example
     * ```typescript
     * await runtime.transfer('0xFrom', '0xTo', '1000000');
     * ```
     */
    transfer(from: string, to: string, amount: string): Promise<void>;
    /**
     * Resets the runtime to initial state.
     *
     * Clears all transactions, escrows, accounts, and events.
     */
    reset(): Promise<void>;
    /**
     * Gets the complete mock state.
     *
     * @returns Current mock state snapshot
     */
    getState(): MockState;
    /**
     * Gets the current mock timestamp.
     */
    private getCurrentTime;
    /**
     * Advances time by specified seconds (with file locking).
     *
     * SECURITY FIX: Uses withLock to prevent race conditions when
     * multiple processes access the state file concurrently.
     */
    private advanceTimeWithLock;
    /**
     * Advances time by specified blocks (with file locking).
     *
     * SECURITY FIX: Uses withLock to prevent race conditions.
     */
    private advanceBlocksWithLock;
    /**
     * Sets exact timestamp (must be >= current time) (with file locking).
     *
     * SECURITY FIX: Uses withLock to prevent race conditions.
     */
    private setTimeWithLock;
    /**
     * Gets events for a specific transaction from both global log and transaction events.
     */
    private getEventsByTransaction;
    /**
     * Generates a unique transaction ID (bytes32 hex string).
     *
     * SECURITY FIX (M-4): Now checks for collisions against existing transactions.
     * Uses cryptographically secure random bytes (32 bytes = 256 bits of entropy).
     *
     * @param state - Current mock state to check for collisions
     * @returns Unique transaction ID
     */
    private generateTransactionIdWithCollisionCheck;
    /**
     * Generates a unique transaction ID (bytes32 hex string).
     *
     * Note: This version is used when state is not available.
     * Prefer generateTransactionIdWithCollisionCheck when possible.
     */
    private generateTransactionId;
    /**
     * Generates a unique escrow ID with improved randomness.
     *
     * SECURITY FIX (L-5): Uses 16 bytes (128 bits) of cryptographic randomness
     * instead of just 4 bytes. Removes timestamp to prevent predictability.
     *
     * @returns Unique escrow ID
     */
    private generateEscrowId;
}
//# sourceMappingURL=MockRuntime.d.ts.map