"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockRuntime = exports.DisputeWindowActiveError = exports.InvalidAmountError = exports.ContractPausedError = exports.DeadlinePassedError = exports.EscrowNotFoundError = exports.InsufficientBalanceError = exports.InvalidStateTransitionError = exports.TransactionNotFoundError = void 0;
const crypto = __importStar(require("crypto"));
const MockStateManager_1 = require("./MockStateManager");
// ============================================================================
// Custom Error Classes
// ============================================================================
/**
 * Error thrown when a transaction is not found.
 */
class TransactionNotFoundError extends Error {
    constructor(txId) {
        super(`Transaction not found: ${txId}`);
        this.name = 'TransactionNotFoundError';
        this.txId = txId;
    }
}
exports.TransactionNotFoundError = TransactionNotFoundError;
/**
 * Error thrown when an invalid state transition is attempted.
 */
class InvalidStateTransitionError extends Error {
    constructor(txId, currentState, targetState) {
        super(`Invalid state transition for transaction ${txId}: ${currentState} -> ${targetState}`);
        this.name = 'InvalidStateTransitionError';
        this.txId = txId;
        this.currentState = currentState;
        this.targetState = targetState;
    }
}
exports.InvalidStateTransitionError = InvalidStateTransitionError;
/**
 * Error thrown when there are insufficient funds for an operation.
 */
class InsufficientBalanceError extends Error {
    constructor(address, required, available) {
        super(`Insufficient balance for ${address}: required ${required}, available ${available}`);
        this.name = 'InsufficientBalanceError';
        this.address = address;
        this.required = required;
        this.available = available;
    }
}
exports.InsufficientBalanceError = InsufficientBalanceError;
/**
 * Error thrown when an escrow is not found.
 */
class EscrowNotFoundError extends Error {
    constructor(escrowId) {
        super(`Escrow not found: ${escrowId}`);
        this.name = 'EscrowNotFoundError';
        this.escrowId = escrowId;
    }
}
exports.EscrowNotFoundError = EscrowNotFoundError;
/**
 * Error thrown when the deadline has passed.
 */
class DeadlinePassedError extends Error {
    constructor(txId, deadline, currentTime) {
        super(`Deadline passed for transaction ${txId}: deadline ${deadline}, current time ${currentTime}`);
        this.name = 'DeadlinePassedError';
        this.txId = txId;
        this.deadline = deadline;
        this.currentTime = currentTime;
    }
}
exports.DeadlinePassedError = DeadlinePassedError;
/**
 * Error thrown when the contract is paused.
 */
class ContractPausedError extends Error {
    constructor() {
        super('Contract is paused');
        this.name = 'ContractPausedError';
    }
}
exports.ContractPausedError = ContractPausedError;
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
class InvalidAmountError extends Error {
    constructor(amount, reason) {
        super(`Invalid amount "${amount}": ${reason}`);
        this.name = 'InvalidAmountError';
        this.amount = amount;
        this.reason = reason;
    }
}
exports.InvalidAmountError = InvalidAmountError;
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
class DisputeWindowActiveError extends Error {
    constructor(txId, windowEnd, currentTime) {
        super(`Dispute window still active for transaction ${txId}. ` +
            `Window ends at ${windowEnd}, current time is ${currentTime}. ` +
            `Use time.advanceTime() to simulate waiting.`);
        this.name = 'DisputeWindowActiveError';
        this.txId = txId;
        this.windowEnd = windowEnd;
        this.currentTime = currentTime;
    }
}
exports.DisputeWindowActiveError = DisputeWindowActiveError;
// ============================================================================
// Types
// ============================================================================
// CreateTransactionParams now imported from IACTPRuntime interface
/**
 * Valid state transitions for the ACTP 8-state machine.
 *
 * State machine:
 * - INITIATED -> QUOTED (optional), COMMITTED, CANCELLED
 * - QUOTED -> COMMITTED, CANCELLED
 * - COMMITTED -> IN_PROGRESS (optional), DELIVERED, CANCELLED
 * - IN_PROGRESS -> DELIVERED, CANCELLED
 * - DELIVERED -> SETTLED, DISPUTED
 * - DISPUTED -> SETTLED
 * - SETTLED (terminal)
 * - CANCELLED (terminal)
 */
const VALID_TRANSITIONS = {
    INITIATED: ['QUOTED', 'COMMITTED', 'CANCELLED'],
    QUOTED: ['COMMITTED', 'CANCELLED'],
    COMMITTED: ['IN_PROGRESS', 'DELIVERED', 'CANCELLED'],
    IN_PROGRESS: ['DELIVERED', 'CANCELLED'],
    DELIVERED: ['SETTLED', 'DISPUTED'],
    DISPUTED: ['SETTLED'],
    SETTLED: [], // Terminal state
    CANCELLED: [], // Terminal state
};
/**
 * States from which cancellation is allowed.
 */
const CANCELLABLE_STATES = [
    'INITIATED',
    'QUOTED',
    'COMMITTED',
    'IN_PROGRESS',
];
// ============================================================================
// MockRuntime Class
// ============================================================================
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
class MockRuntime {
    /**
     * Creates a new MockRuntime instance.
     *
     * @param stateManager - Optional custom state manager (default: creates new one)
     */
    constructor(stateManager) {
        /**
         * In-memory event log, also persisted to state file.
         *
         * SECURITY FIX (L-4): Events are now persisted to the state file
         * so they survive across CLI invocations.
         */
        this.eventLog = [];
        this.stateManager = stateManager ?? new MockStateManager_1.MockStateManager();
        // SECURITY FIX (L-4): Load persisted events from state file
        this.loadPersistedEvents();
        // Initialize time interface
        // SECURITY FIX: Time operations now use withLock to prevent race conditions
        this.time = {
            now: () => this.getCurrentTime(),
            advanceTime: (seconds) => this.advanceTimeWithLock(seconds),
            advanceBlocks: (blocks) => this.advanceBlocksWithLock(blocks),
            setTime: (timestamp) => this.setTimeWithLock(timestamp),
        };
        // Initialize events interface
        this.events = {
            getAll: () => [...this.eventLog],
            getByType: (type) => this.eventLog.filter((e) => e.type === type),
            getByTransaction: (txId) => this.getEventsByTransaction(txId),
            clear: () => {
                this.eventLog = [];
                // Also clear persisted events
                this.clearPersistedEvents();
            },
        };
    }
    /**
     * Load events from persisted state file.
     *
     * SECURITY FIX (L-4): Events survive across CLI invocations.
     */
    loadPersistedEvents() {
        try {
            const state = this.stateManager.loadState();
            this.eventLog = state.events ?? [];
        }
        catch {
            // If state doesn't exist yet, start with empty events
            this.eventLog = [];
        }
    }
    /**
     * Clear persisted events from state file.
     */
    clearPersistedEvents() {
        try {
            const state = this.stateManager.loadState();
            state.events = [];
            this.stateManager.saveState(state);
        }
        catch {
            // Ignore errors during clear
        }
    }
    /**
     * Persist an event to both in-memory log and state file.
     *
     * SECURITY FIX (L-4): Events are persisted for audit trail.
     *
     * @param event - Event to persist
     * @param state - Current state (to avoid re-loading)
     */
    persistEvent(event, state) {
        this.eventLog.push(event);
        // Ensure events array exists
        if (!state.events) {
            state.events = [];
        }
        state.events.push(event);
    }
    // ============================================================================
    // Transaction Operations
    // ============================================================================
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
    async createTransaction(params) {
        return this.stateManager.withLock(async (state) => {
            const currentTime = state.blockchain.currentTime;
            const blockNumber = state.blockchain.blockNumber;
            // Validate amount (Issue #2 fix)
            const amountBigInt = BigInt(params.amount);
            if (amountBigInt <= 0n) {
                throw new InvalidAmountError(params.amount, 'Amount must be positive');
            }
            // Validate deadline
            if (params.deadline <= currentTime) {
                throw new DeadlinePassedError('new', params.deadline, currentTime);
            }
            // SECURITY FIX (M-4): Generate transaction ID with collision check
            const txId = this.generateTransactionIdWithCollisionCheck(state);
            // Create transaction
            const transaction = {
                id: txId,
                requester: params.requester,
                provider: params.provider,
                amount: params.amount,
                state: 'INITIATED',
                createdAt: currentTime,
                updatedAt: currentTime,
                deadline: params.deadline,
                disputeWindow: params.disputeWindow ?? 172800, // Default 2 days
                completedAt: null,
                escrowId: null,
                serviceDescription: params.serviceDescription ?? '',
                deliveryProof: null,
                events: [],
            };
            // Record event
            const event = {
                type: 'TransactionCreated',
                timestamp: currentTime,
                blockNumber,
                data: {
                    txId,
                    requester: params.requester,
                    provider: params.provider,
                    amount: params.amount,
                    deadline: params.deadline,
                },
            };
            transaction.events.push(event);
            state.transactions[txId] = transaction;
            // SECURITY FIX (L-4): Persist event to state file
            this.persistEvent(event, state);
            return txId;
        });
    }
    /**
     * Gets a transaction by ID.
     *
     * @param txId - Transaction ID
     * @returns Promise resolving to the transaction or null if not found
     */
    async getTransaction(txId) {
        const state = this.stateManager.loadState();
        return state.transactions[txId] ?? null;
    }
    /**
     * Gets all transactions.
     *
     * @returns Promise resolving to array of all transactions
     */
    async getAllTransactions() {
        const state = this.stateManager.loadState();
        return Object.values(state.transactions);
    }
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
    async transitionState(txId, newState) {
        return this.stateManager.withLock(async (state) => {
            const tx = state.transactions[txId];
            if (!tx) {
                throw new TransactionNotFoundError(txId);
            }
            const currentState = tx.state;
            const currentTime = state.blockchain.currentTime;
            const blockNumber = state.blockchain.blockNumber;
            // Validate transition
            const validTargets = VALID_TRANSITIONS[currentState];
            if (!validTargets.includes(newState)) {
                throw new InvalidStateTransitionError(txId, currentState, newState);
            }
            // For cancellation before deadline, check deadline hasn't passed
            if (newState === 'CANCELLED' && CANCELLABLE_STATES.includes(currentState)) {
                // Allow cancellation if deadline passed OR if before deadline
                // (This matches real contract behavior - can cancel anytime before DELIVERED)
            }
            // Update state
            const oldState = tx.state;
            tx.state = newState;
            tx.updatedAt = currentTime;
            // Record completion time for DELIVERED state
            if (newState === 'DELIVERED') {
                tx.completedAt = currentTime;
            }
            // Handle escrow refund on CANCELLED state (Issue #1 fix)
            if (newState === 'CANCELLED' && tx.escrowId !== null) {
                const escrow = state.escrows[tx.escrowId];
                if (escrow && BigInt(escrow.balance) > 0n) {
                    const refundAmount = BigInt(escrow.balance);
                    // Create requester account if doesn't exist
                    if (!state.accounts[tx.requester]) {
                        state.accounts[tx.requester] = {
                            address: tx.requester,
                            usdcBalance: '0',
                        };
                    }
                    // Return funds to requester
                    const requesterBalance = BigInt(state.accounts[tx.requester].usdcBalance);
                    state.accounts[tx.requester].usdcBalance = (requesterBalance + refundAmount).toString();
                    // Clear escrow balance
                    escrow.balance = '0';
                    escrow.locked = false;
                    // Record EscrowRefunded event
                    const refundEvent = {
                        type: 'EscrowRefunded',
                        timestamp: currentTime,
                        blockNumber,
                        data: {
                            txId,
                            escrowId: tx.escrowId,
                            requester: tx.requester,
                            amount: refundAmount.toString(),
                        },
                    };
                    tx.events.push(refundEvent);
                    // SECURITY FIX (L-4): Persist event
                    this.persistEvent(refundEvent, state);
                }
            }
            // Record event
            const event = {
                type: 'StateTransitioned',
                timestamp: currentTime,
                blockNumber,
                data: {
                    txId,
                    oldState,
                    newState,
                },
            };
            tx.events.push(event);
            // SECURITY FIX (L-4): Persist event
            this.persistEvent(event, state);
        });
    }
    // ============================================================================
    // Escrow Operations
    // ============================================================================
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
    async linkEscrow(txId, amount) {
        return this.stateManager.withLock(async (state) => {
            // Validate amount (Issue #2 fix)
            const amountBigInt = BigInt(amount);
            if (amountBigInt <= 0n) {
                throw new InvalidAmountError(amount, 'Amount must be positive');
            }
            const tx = state.transactions[txId];
            if (!tx) {
                throw new TransactionNotFoundError(txId);
            }
            // Validate state - can only link from INITIATED or QUOTED
            if (tx.state !== 'INITIATED' && tx.state !== 'QUOTED') {
                throw new InvalidStateTransitionError(txId, tx.state, 'COMMITTED');
            }
            // Check deadline
            const currentTime = state.blockchain.currentTime;
            if (currentTime > tx.deadline) {
                throw new DeadlinePassedError(txId, tx.deadline, currentTime);
            }
            // Check requester balance
            const requesterAccount = state.accounts[tx.requester];
            const requesterBalance = BigInt(requesterAccount?.usdcBalance ?? '0');
            if (requesterBalance < amountBigInt) {
                throw new InsufficientBalanceError(tx.requester, amount, requesterBalance.toString());
            }
            // Generate escrow ID
            const escrowId = this.generateEscrowId();
            // Create or update requester account
            if (!state.accounts[tx.requester]) {
                state.accounts[tx.requester] = {
                    address: tx.requester,
                    usdcBalance: '0',
                };
            }
            // Deduct from requester
            state.accounts[tx.requester].usdcBalance = (requesterBalance - amountBigInt).toString();
            // Create escrow
            const escrow = {
                id: escrowId,
                balance: amount,
                locked: true,
                transactions: [txId],
                createdAt: currentTime,
            };
            state.escrows[escrowId] = escrow;
            // Link to transaction and auto-transition to COMMITTED
            const oldState = tx.state;
            tx.escrowId = escrowId;
            tx.state = 'COMMITTED';
            tx.updatedAt = currentTime;
            // Record events
            const blockNumber = state.blockchain.blockNumber;
            const linkEvent = {
                type: 'EscrowLinked',
                timestamp: currentTime,
                blockNumber,
                data: {
                    txId,
                    escrowId,
                    amount,
                },
            };
            const transitionEvent = {
                type: 'StateTransitioned',
                timestamp: currentTime,
                blockNumber,
                data: {
                    txId,
                    oldState,
                    newState: 'COMMITTED',
                },
            };
            tx.events.push(linkEvent, transitionEvent);
            // SECURITY FIX (L-4): Persist events
            this.persistEvent(linkEvent, state);
            this.persistEvent(transitionEvent, state);
            return escrowId;
        });
    }
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
    async releaseEscrow(escrowId) {
        return this.stateManager.withLock(async (state) => {
            const escrow = state.escrows[escrowId];
            if (!escrow) {
                throw new EscrowNotFoundError(escrowId);
            }
            // Get linked transaction (assume single transaction per escrow for now)
            const txId = escrow.transactions[0];
            const tx = state.transactions[txId];
            if (!tx) {
                throw new TransactionNotFoundError(txId);
            }
            // Validate state
            if (tx.state !== 'DELIVERED') {
                throw new InvalidStateTransitionError(txId, tx.state, 'SETTLED');
            }
            const currentTime = state.blockchain.currentTime;
            const blockNumber = state.blockchain.blockNumber;
            // Enforce dispute window (Issue #3 fix)
            if (tx.completedAt !== null) {
                const disputeWindowEnd = tx.completedAt + tx.disputeWindow;
                if (currentTime < disputeWindowEnd) {
                    throw new DisputeWindowActiveError(txId, disputeWindowEnd, currentTime);
                }
            }
            const amount = BigInt(escrow.balance);
            // Create or update provider account
            if (!state.accounts[tx.provider]) {
                state.accounts[tx.provider] = {
                    address: tx.provider,
                    usdcBalance: '0',
                };
            }
            // Transfer to provider
            const providerBalance = BigInt(state.accounts[tx.provider].usdcBalance);
            state.accounts[tx.provider].usdcBalance = (providerBalance + amount).toString();
            // Clear escrow balance
            escrow.balance = '0';
            escrow.locked = false;
            // Transition to SETTLED
            const oldState = tx.state;
            tx.state = 'SETTLED';
            tx.updatedAt = currentTime;
            // Record events
            const releaseEvent = {
                type: 'EscrowReleased',
                timestamp: currentTime,
                blockNumber,
                data: {
                    txId,
                    escrowId,
                    provider: tx.provider,
                    amount: amount.toString(),
                },
            };
            const transitionEvent = {
                type: 'StateTransitioned',
                timestamp: currentTime,
                blockNumber,
                data: {
                    txId,
                    oldState,
                    newState: 'SETTLED',
                },
            };
            tx.events.push(releaseEvent, transitionEvent);
            // SECURITY FIX (L-4): Persist events
            this.persistEvent(releaseEvent, state);
            this.persistEvent(transitionEvent, state);
        });
    }
    /**
     * Gets the balance of an escrow.
     *
     * @param escrowId - Escrow ID
     * @returns Promise resolving to the balance as string
     *
     * @throws {EscrowNotFoundError} If escrow doesn't exist
     */
    async getEscrowBalance(escrowId) {
        const state = this.stateManager.loadState();
        const escrow = state.escrows[escrowId];
        if (!escrow) {
            throw new EscrowNotFoundError(escrowId);
        }
        return escrow.balance;
    }
    // ============================================================================
    // Account Operations
    // ============================================================================
    /**
     * Gets the USDC balance of an address.
     *
     * @param address - Ethereum address
     * @returns Promise resolving to the balance as string (0 if account doesn't exist)
     */
    async getBalance(address) {
        const state = this.stateManager.loadState();
        return state.accounts[address]?.usdcBalance ?? '0';
    }
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
    async mintTokens(address, amount) {
        return this.stateManager.withLock(async (state) => {
            // Create account if doesn't exist
            if (!state.accounts[address]) {
                state.accounts[address] = {
                    address,
                    usdcBalance: '0',
                };
            }
            const currentBalance = BigInt(state.accounts[address].usdcBalance);
            const mintAmount = BigInt(amount);
            state.accounts[address].usdcBalance = (currentBalance + mintAmount).toString();
            // Record event
            const event = {
                type: 'TokensMinted',
                timestamp: state.blockchain.currentTime,
                blockNumber: state.blockchain.blockNumber,
                data: {
                    address,
                    amount,
                    newBalance: state.accounts[address].usdcBalance,
                },
            };
            // SECURITY FIX (L-4): Persist event
            this.persistEvent(event, state);
        });
    }
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
    async transfer(from, to, amount) {
        return this.stateManager.withLock(async (state) => {
            // Check sender balance
            const fromAccount = state.accounts[from];
            const fromBalance = BigInt(fromAccount?.usdcBalance ?? '0');
            const transferAmount = BigInt(amount);
            if (fromBalance < transferAmount) {
                throw new InsufficientBalanceError(from, amount, fromBalance.toString());
            }
            // Create receiver account if doesn't exist
            if (!state.accounts[to]) {
                state.accounts[to] = {
                    address: to,
                    usdcBalance: '0',
                };
            }
            // Create sender account if doesn't exist (shouldn't happen but be safe)
            if (!state.accounts[from]) {
                state.accounts[from] = {
                    address: from,
                    usdcBalance: '0',
                };
            }
            // Transfer
            state.accounts[from].usdcBalance = (fromBalance - transferAmount).toString();
            const toBalance = BigInt(state.accounts[to].usdcBalance);
            state.accounts[to].usdcBalance = (toBalance + transferAmount).toString();
            // Record event
            const event = {
                type: 'Transfer',
                timestamp: state.blockchain.currentTime,
                blockNumber: state.blockchain.blockNumber,
                data: {
                    from,
                    to,
                    amount,
                },
            };
            // SECURITY FIX (L-4): Persist event
            this.persistEvent(event, state);
        });
    }
    // ============================================================================
    // State Management
    // ============================================================================
    /**
     * Resets the runtime to initial state.
     *
     * Clears all transactions, escrows, accounts, and events.
     */
    async reset() {
        this.stateManager.reset();
        this.eventLog = [];
        // Note: reset() on stateManager will also clear persisted events via getDefaultState()
    }
    /**
     * Gets the complete mock state.
     *
     * @returns Current mock state snapshot
     */
    getState() {
        return this.stateManager.loadState();
    }
    // ============================================================================
    // Private Methods - Time Management
    // ============================================================================
    /**
     * Gets the current mock timestamp.
     */
    getCurrentTime() {
        const state = this.stateManager.loadState();
        return state.blockchain.currentTime;
    }
    /**
     * Advances time by specified seconds (with file locking).
     *
     * SECURITY FIX: Uses withLock to prevent race conditions when
     * multiple processes access the state file concurrently.
     */
    async advanceTimeWithLock(seconds) {
        if (seconds < 0) {
            throw new Error('Cannot advance time by negative amount');
        }
        return this.stateManager.withLock(async (state) => {
            const blockTimeSeconds = state.blockchain.blockTime;
            state.blockchain.currentTime += seconds;
            state.blockchain.blockNumber += Math.floor(seconds / blockTimeSeconds);
            // Record event
            const event = {
                type: 'TimeAdvanced',
                timestamp: state.blockchain.currentTime,
                blockNumber: state.blockchain.blockNumber,
                data: {
                    seconds,
                    newTime: state.blockchain.currentTime,
                    newBlock: state.blockchain.blockNumber,
                },
            };
            // SECURITY FIX (L-4): Persist event
            this.persistEvent(event, state);
        });
    }
    /**
     * Advances time by specified blocks (with file locking).
     *
     * SECURITY FIX: Uses withLock to prevent race conditions.
     */
    async advanceBlocksWithLock(blocks) {
        if (blocks < 0) {
            throw new Error('Cannot advance blocks by negative amount');
        }
        return this.stateManager.withLock(async (state) => {
            const blockTimeSeconds = state.blockchain.blockTime;
            const secondsToAdvance = blocks * blockTimeSeconds;
            state.blockchain.blockNumber += blocks;
            state.blockchain.currentTime += secondsToAdvance;
            // Record event
            const event = {
                type: 'BlocksAdvanced',
                timestamp: state.blockchain.currentTime,
                blockNumber: state.blockchain.blockNumber,
                data: {
                    blocks,
                    newTime: state.blockchain.currentTime,
                    newBlock: state.blockchain.blockNumber,
                },
            };
            // SECURITY FIX (L-4): Persist event
            this.persistEvent(event, state);
        });
    }
    /**
     * Sets exact timestamp (must be >= current time) (with file locking).
     *
     * SECURITY FIX: Uses withLock to prevent race conditions.
     */
    async setTimeWithLock(timestamp) {
        return this.stateManager.withLock(async (state) => {
            if (timestamp < state.blockchain.currentTime) {
                throw new Error(`Cannot move time backwards: ${timestamp} < ${state.blockchain.currentTime}`);
            }
            const timeDiff = timestamp - state.blockchain.currentTime;
            const blockTimeSeconds = state.blockchain.blockTime;
            state.blockchain.currentTime = timestamp;
            state.blockchain.blockNumber += Math.floor(timeDiff / blockTimeSeconds);
            // Record event
            const event = {
                type: 'TimeSet',
                timestamp: state.blockchain.currentTime,
                blockNumber: state.blockchain.blockNumber,
                data: {
                    newTime: timestamp,
                    newBlock: state.blockchain.blockNumber,
                },
            };
            // SECURITY FIX (L-4): Persist event
            this.persistEvent(event, state);
        });
    }
    // ============================================================================
    // Private Methods - Event Management
    // ============================================================================
    /**
     * Gets events for a specific transaction from both global log and transaction events.
     */
    getEventsByTransaction(txId) {
        const state = this.stateManager.loadState();
        const tx = state.transactions[txId];
        if (!tx) {
            return [];
        }
        // Return transaction-specific events
        return [...tx.events];
    }
    // ============================================================================
    // Private Methods - ID Generation
    // ============================================================================
    /**
     * Generates a unique transaction ID (bytes32 hex string).
     *
     * SECURITY FIX (M-4): Now checks for collisions against existing transactions.
     * Uses cryptographically secure random bytes (32 bytes = 256 bits of entropy).
     *
     * @param state - Current mock state to check for collisions
     * @returns Unique transaction ID
     */
    generateTransactionIdWithCollisionCheck(state) {
        const maxAttempts = 10;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const txId = `0x${crypto.randomBytes(32).toString('hex')}`;
            // Check for collision (extremely unlikely with 256 bits of randomness)
            if (!state.transactions[txId]) {
                return txId;
            }
        }
        // This should never happen with 256-bit IDs, but fail safely
        throw new Error('Failed to generate unique transaction ID after multiple attempts. ' +
            'This indicates a critical system issue.');
    }
    /**
     * Generates a unique transaction ID (bytes32 hex string).
     *
     * Note: This version is used when state is not available.
     * Prefer generateTransactionIdWithCollisionCheck when possible.
     */
    generateTransactionId() {
        return `0x${crypto.randomBytes(32).toString('hex')}`;
    }
    /**
     * Generates a unique escrow ID with improved randomness.
     *
     * SECURITY FIX (L-5): Uses 16 bytes (128 bits) of cryptographic randomness
     * instead of just 4 bytes. Removes timestamp to prevent predictability.
     *
     * @returns Unique escrow ID
     */
    generateEscrowId() {
        // Use 16 bytes of cryptographic randomness (128 bits of entropy)
        return `escrow-${crypto.randomBytes(16).toString('hex')}`;
    }
}
exports.MockRuntime = MockRuntime;
//# sourceMappingURL=MockRuntime.js.map