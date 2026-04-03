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

import * as crypto from 'crypto';
import { MockStateManager } from './MockStateManager';
import {
  MockState,
  MockTransaction,
  MockEscrow,
  MockEvent,
  TransactionState,
} from './types/MockState';
import { IACTPRuntime, CreateTransactionParams } from './IACTPRuntime';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Error thrown when a transaction is not found.
 */
export class TransactionNotFoundError extends Error {
  public readonly txId: string;

  constructor(txId: string) {
    super(`Transaction not found: ${txId}`);
    this.name = 'TransactionNotFoundError';
    this.txId = txId;
  }
}

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class InvalidStateTransitionError extends Error {
  public readonly txId: string;
  public readonly currentState: TransactionState;
  public readonly targetState: TransactionState;

  constructor(txId: string, currentState: TransactionState, targetState: TransactionState) {
    super(
      `Invalid state transition for transaction ${txId}: ${currentState} -> ${targetState}`
    );
    this.name = 'InvalidStateTransitionError';
    this.txId = txId;
    this.currentState = currentState;
    this.targetState = targetState;
  }
}

/**
 * Error thrown when there are insufficient funds for an operation.
 */
export class InsufficientBalanceError extends Error {
  public readonly address: string;
  public readonly required: string;
  public readonly available: string;

  constructor(address: string, required: string, available: string) {
    super(
      `Insufficient balance for ${address}: required ${required}, available ${available}`
    );
    this.name = 'InsufficientBalanceError';
    this.address = address;
    this.required = required;
    this.available = available;
  }
}

/**
 * Error thrown when an escrow is not found.
 */
export class EscrowNotFoundError extends Error {
  public readonly escrowId: string;

  constructor(escrowId: string) {
    super(`Escrow not found: ${escrowId}`);
    this.name = 'EscrowNotFoundError';
    this.escrowId = escrowId;
  }
}

/**
 * Error thrown when the deadline has passed.
 */
export class DeadlinePassedError extends Error {
  public readonly txId: string;
  public readonly deadline: number;
  public readonly currentTime: number;

  constructor(txId: string, deadline: number, currentTime: number) {
    super(
      `Deadline passed for transaction ${txId}: deadline ${deadline}, current time ${currentTime}`
    );
    this.name = 'DeadlinePassedError';
    this.txId = txId;
    this.deadline = deadline;
    this.currentTime = currentTime;
  }
}

/**
 * Error thrown when the contract is paused.
 */
export class ContractPausedError extends Error {
  constructor() {
    super('Contract is paused');
    this.name = 'ContractPausedError';
  }
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
export class InvalidAmountError extends Error {
  public readonly amount: string;
  public readonly reason: string;

  constructor(amount: string, reason: string) {
    super(`Invalid amount "${amount}": ${reason}`);
    this.name = 'InvalidAmountError';
    this.amount = amount;
    this.reason = reason;
  }
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
export class DisputeWindowActiveError extends Error {
  public readonly txId: string;
  public readonly windowEnd: number;
  public readonly currentTime: number;

  constructor(txId: string, windowEnd: number, currentTime: number) {
    super(
      `Dispute window still active for transaction ${txId}. ` +
        `Window ends at ${windowEnd}, current time is ${currentTime}. ` +
        `Use time.advanceTime() to simulate waiting.`
    );
    this.name = 'DisputeWindowActiveError';
    this.txId = txId;
    this.windowEnd = windowEnd;
    this.currentTime = currentTime;
  }
}

// ============================================================================
// Types
// ============================================================================

// CreateTransactionParams now imported from IACTPRuntime interface

/**
 * Valid state transitions for the ACTP 8-state machine.
 *
 * AUDIT FIX (2026-02): Synced with on-chain ACTPKernel contract.
 *
 * State machine:
 * - INITIATED -> QUOTED (optional), COMMITTED, CANCELLED
 * - QUOTED -> COMMITTED, CANCELLED
 * - COMMITTED -> IN_PROGRESS, CANCELLED (cannot skip to DELIVERED)
 * - IN_PROGRESS -> DELIVERED, CANCELLED
 * - DELIVERED -> SETTLED, DISPUTED
 * - DISPUTED -> SETTLED, CANCELLED (admin/pauser emergency)
 * - SETTLED (terminal)
 * - CANCELLED (terminal)
 */
const VALID_TRANSITIONS: Record<TransactionState, TransactionState[]> = {
  INITIATED: ['QUOTED', 'COMMITTED', 'CANCELLED'],
  QUOTED: ['COMMITTED', 'CANCELLED'],
  // AUDIT FIX: Cannot skip IN_PROGRESS - must transition through it
  COMMITTED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['SETTLED', 'DISPUTED'],
  // AUDIT FIX: DISPUTED can also be CANCELLED by admin/pauser
  DISPUTED: ['SETTLED', 'CANCELLED'],
  SETTLED: [], // Terminal state
  CANCELLED: [], // Terminal state
};

/**
 * States from which cancellation is allowed.
 */
const CANCELLABLE_STATES: TransactionState[] = [
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
export class MockRuntime implements IACTPRuntime {
  private stateManager: MockStateManager;
  /**
   * In-memory event log, also persisted to state file.
   *
   *Security: Events are now persisted to the state file
   * so they survive across CLI invocations.
   */
  private eventLog: MockEvent[] = [];

  /**
   * Time management interface.
   *
   * SECURITY NOTE: All time-modifying operations are async and use
   * file locking to prevent race conditions.
   */
  public readonly time: {
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
  public readonly events: {
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
  constructor(stateManager?: MockStateManager) {
    this.stateManager = stateManager ?? new MockStateManager();

    // Security: Load persisted events from state file
    this.loadPersistedEvents();

    // Initialize time interface
    // Security: Time operations now use withLock to prevent race conditions
    this.time = {
      now: () => this.getCurrentTime(),
      advanceTime: (seconds: number) => this.advanceTimeWithLock(seconds),
      advanceBlocks: (blocks: number) => this.advanceBlocksWithLock(blocks),
      setTime: (timestamp: number) => this.setTimeWithLock(timestamp),
    };

    // Initialize events interface
    this.events = {
      getAll: () => [...this.eventLog],
      getByType: (type: string) => this.eventLog.filter((e) => e.type === type),
      getByTransaction: (txId: string) => this.getEventsByTransaction(txId),
      clear: () => {
        this.eventLog = [];
        // Also clear persisted events
        this.clearPersistedEvents();
      },
    };
  }

  /**
   * Maximum transaction amount - no limit in mock mode.
   *
   * Mock mode is for testing, so we don't enforce limits.
   * Real blockchain runtimes may have limits for security.
   */
  readonly maxTransactionAmount: number | undefined = undefined;

  /**
   * Load events from persisted state file.
   *
   *Security: Events survive across CLI invocations.
   */
  private loadPersistedEvents(): void {
    try {
      const state = this.stateManager.loadState();
      this.eventLog = state.events ?? [];
    } catch {
      // If state doesn't exist yet, start with empty events
      this.eventLog = [];
    }
  }

  /**
   * Clear persisted events from state file.
   */
  private clearPersistedEvents(): void {
    try {
      const state = this.stateManager.loadState();
      state.events = [];
      this.stateManager.saveState(state);
    } catch {
      // Ignore errors during clear
    }
  }

  /**
   * Persist an event to both in-memory log and state file.
   *
   *Security: Events are persisted for audit trail.
   *
   * @param event - Event to persist
   * @param state - Current state (to avoid re-loading)
   */
  private persistEvent(event: MockEvent, state: MockState): void {
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
  async createTransaction(params: CreateTransactionParams): Promise<string> {
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

      // Security: Generate transaction ID with collision check
      const txId = this.generateTransactionIdWithCollisionCheck(state);

      // Create transaction
      const transaction: MockTransaction = {
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
        agentId: params.agentId,
      };

      // Record event
      const event: MockEvent = {
        type: 'TransactionCreated',
        timestamp: currentTime,
        blockNumber,
        data: {
          txId,
          requester: params.requester,
          provider: params.provider,
          amount: params.amount,
          deadline: params.deadline,
          agentId: params.agentId,
        },
      };

      transaction.events.push(event);
      state.transactions[txId] = transaction;

      // Security: Persist event to state file
      this.persistEvent(event, state);

      return txId;
    });
  }

  /**
   * Gets a transaction by ID.
   *
   * AUTO-RELEASE: If transaction is DELIVERED and dispute window has passed,
   * automatically settles the transaction (lazy auto-release).
   *
   * @param txId - Transaction ID
   * @returns Promise resolving to the transaction or null if not found
   */
  async getTransaction(txId: string): Promise<MockTransaction | null> {
    // First, check if auto-settle is needed
    await this.autoSettleIfReady(txId);
    
    // Then return the (possibly updated) transaction
    const state = this.stateManager.loadState();
    return state.transactions[txId] ?? null;
  }

  /**
   * Auto-settle a transaction if dispute window has passed.
   *
   * This implements "lazy auto-release" - when anyone checks a transaction
   * that is DELIVERED with expired dispute window, it automatically settles.
   *
   * @param txId - Transaction ID to check
   */
  private async autoSettleIfReady(txId: string): Promise<void> {
    const state = this.stateManager.loadState();
    const tx = state.transactions[txId];
    
    if (!tx) return;
    if (tx.state !== 'DELIVERED') return;
    if (tx.completedAt === null) return;
    
    const currentTime = state.blockchain.currentTime;
    const disputeWindowEnd = tx.completedAt + tx.disputeWindow;
    
    // Dispute window still active - don't auto-settle
    if (currentTime < disputeWindowEnd) return;
    
    // Dispute window passed - auto-settle!
    // Find the escrow and release it
    if (tx.escrowId) {
      try {
        await this.releaseEscrow(tx.escrowId);
      } catch {
        // Already settled or other issue - ignore
      }
    }
  }

  /**
   * Sweep all expired DELIVERED transactions for a provider.
   * Called by SettleOnInteract when operating on MockRuntime.
   *
   * @param providerAddress - Provider address to sweep for
   */
  async sweepExpiredDeliveredForProvider(providerAddress: string): Promise<void> {
    const txs = await this.getTransactionsByProvider(providerAddress, 'DELIVERED');
    for (const tx of txs) {
      await this.autoSettleIfReady(tx.id);
    }
  }

  /**
   * Gets all transactions.
   *
   * @returns Promise resolving to array of all transactions
   */
  async getAllTransactions(): Promise<MockTransaction[]> {
    const state = this.stateManager.loadState();
    return Object.values(state.transactions);
  }

  /**
   * Gets transactions filtered by provider address and optionally state.
   *
   *Security: Filtered query to prevent DoS via memory exhaustion.
   * Instead of loading all transactions and filtering client-side, we filter
   * server-side and limit the result set.
   *
   * @param provider - Provider address to filter by
   * @param state - Optional state filter (e.g., 'INITIATED', 'DELIVERED')
   * @param limit - Maximum number of transactions to return (default 100)
   * @returns Promise resolving to filtered transactions
   *
   * @example
   * ```typescript
   * // Get up to 100 INITIATED transactions for this provider
   * const pending = await runtime.getTransactionsByProvider(
   *   providerAddress,
   *   'INITIATED',
   *   100
   * );
   * ```
   */
  async getTransactionsByProvider(
    provider: string,
    state?: TransactionState,
    limit: number = 100
  ): Promise<MockTransaction[]> {
    return this.stateManager.withLock(async (s) => {
      let txs = Object.values(s.transactions).filter(
        (tx) => tx.provider === provider
      );

      if (state) {
        txs = txs.filter((tx) => tx.state === state);
      }

      if (limit > 0) {
        txs = txs.slice(0, limit);
      }

      return txs;
    });
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
   *
   * // With delivery proof
   * await runtime.transitionState(txId, 'DELIVERED', deliveryProofBytes);
   * ```
   */
  async transitionState(txId: string, newState: TransactionState, proof?: string): Promise<void> {
    // Security: Accept optional proof parameter for interface compliance
    // In MockRuntime, proof is stored but not validated (no on-chain verification)
    // This allows testing delivery proof flows without actual blockchain interaction
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
        // Security: Store delivery proof if provided
        // Only set if not already populated (Agent sets deliveryProof before transitioning,
        // and passes disputeWindowProof as the proof param — don't overwrite the real proof)
        if (proof && !tx.deliveryProof) {
          tx.deliveryProof = proof;
        }
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
          const refundEvent: MockEvent = {
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
          // Security: Persist event
          this.persistEvent(refundEvent, state);
        }
      }

      // Record event
      const event: MockEvent = {
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
      // Security: Persist event
      this.persistEvent(event, state);
    });
  }

  /**
   * Accept a provider's quote, updating the transaction amount.
   *
   * Mirrors on-chain acceptQuote() behavior:
   * - Requires QUOTED state
   * - Updates amount to newAmount
   * - Does NOT change state (stays QUOTED)
   * - Emits QuoteAccepted event
   *
   * @param txId - Transaction ID
   * @param newAmount - New amount in USDC wei
   */
  async acceptQuote(txId: string, newAmount: string): Promise<void> {
    return this.stateManager.withLock(async (state) => {
      const tx = state.transactions[txId];
      if (!tx) {
        throw new TransactionNotFoundError(txId);
      }

      // Must be in QUOTED state
      if (tx.state !== 'QUOTED') {
        throw new InvalidStateTransitionError(txId, tx.state, 'QUOTED');
      }

      // Validate amount
      const newAmountBigInt = BigInt(newAmount);
      if (newAmountBigInt <= 0n) {
        throw new InvalidAmountError(newAmount, 'Amount must be positive');
      }

      // Check deadline
      const currentTime = state.blockchain.currentTime;
      if (currentTime > tx.deadline) {
        throw new DeadlinePassedError(txId, tx.deadline, currentTime);
      }

      const oldAmount = tx.amount;
      const blockNumber = state.blockchain.blockNumber;

      // Update amount (state stays QUOTED)
      tx.amount = newAmount;
      tx.updatedAt = currentTime;

      // Record QuoteAccepted event
      const event: MockEvent = {
        type: 'QuoteAccepted',
        timestamp: currentTime,
        blockNumber,
        data: {
          txId,
          oldAmount,
          newAmount,
        },
      };

      tx.events.push(event);
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
  async linkEscrow(txId: string, amount: string): Promise<string> {
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
        throw new InsufficientBalanceError(
          tx.requester,
          amount,
          requesterBalance.toString()
        );
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
      state.accounts[tx.requester].usdcBalance = (
        requesterBalance - amountBigInt
      ).toString();

      // Create escrow
      const escrow: MockEscrow = {
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

      const linkEvent: MockEvent = {
        type: 'EscrowLinked',
        timestamp: currentTime,
        blockNumber,
        data: {
          txId,
          escrowId,
          amount,
        },
      };

      const transitionEvent: MockEvent = {
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
      // Security: Persist events
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
  async releaseEscrow(escrowId: string, _attestationUID?: string): Promise<void> {
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
      const releaseEvent: MockEvent = {
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

      const transitionEvent: MockEvent = {
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
      // Security: Persist events
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
  async getEscrowBalance(escrowId: string): Promise<string> {
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
  async getBalance(address: string): Promise<string> {
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
  async mintTokens(address: string, amount: string): Promise<void> {
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
      const event: MockEvent = {
        type: 'TokensMinted',
        timestamp: state.blockchain.currentTime,
        blockNumber: state.blockchain.blockNumber,
        data: {
          address,
          amount,
          newBalance: state.accounts[address].usdcBalance,
        },
      };

      // Security: Persist event
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
  async transfer(from: string, to: string, amount: string): Promise<void> {
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
      const event: MockEvent = {
        type: 'Transfer',
        timestamp: state.blockchain.currentTime,
        blockNumber: state.blockchain.blockNumber,
        data: {
          from,
          to,
          amount,
        },
      };

      // Security: Persist event
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
  async reset(): Promise<void> {
    this.stateManager.reset();
    this.eventLog = [];
    // Note: reset() on stateManager will also clear persisted events via getDefaultState()
  }

  /**
   * Gets the complete mock state.
   *
   * @returns Current mock state snapshot
   */
  getState(): MockState {
    return this.stateManager.loadState();
  }

  // ============================================================================
  // Private Methods - Time Management
  // ============================================================================

  /**
   * Gets the current mock timestamp.
   */
  private getCurrentTime(): number {
    const state = this.stateManager.loadState();
    return state.blockchain.currentTime;
  }

  /**
   * Advances time by specified seconds (with file locking).
   *
   * Security: Uses withLock to prevent race conditions when
   * multiple processes access the state file concurrently.
   */
  private async advanceTimeWithLock(seconds: number): Promise<void> {
    if (seconds < 0) {
      throw new Error('Cannot advance time by negative amount');
    }

    return this.stateManager.withLock(async (state) => {
      const blockTimeSeconds = state.blockchain.blockTime;

      state.blockchain.currentTime += seconds;
      state.blockchain.blockNumber += Math.floor(seconds / blockTimeSeconds);

      // Record event
      const event: MockEvent = {
        type: 'TimeAdvanced',
        timestamp: state.blockchain.currentTime,
        blockNumber: state.blockchain.blockNumber,
        data: {
          seconds,
          newTime: state.blockchain.currentTime,
          newBlock: state.blockchain.blockNumber,
        },
      };

      // Security: Persist event
      this.persistEvent(event, state);
    });
  }

  /**
   * Advances time by specified blocks (with file locking).
   *
   * Security: Uses withLock to prevent race conditions.
   */
  private async advanceBlocksWithLock(blocks: number): Promise<void> {
    if (blocks < 0) {
      throw new Error('Cannot advance blocks by negative amount');
    }

    return this.stateManager.withLock(async (state) => {
      const blockTimeSeconds = state.blockchain.blockTime;
      const secondsToAdvance = blocks * blockTimeSeconds;

      state.blockchain.blockNumber += blocks;
      state.blockchain.currentTime += secondsToAdvance;

      // Record event
      const event: MockEvent = {
        type: 'BlocksAdvanced',
        timestamp: state.blockchain.currentTime,
        blockNumber: state.blockchain.blockNumber,
        data: {
          blocks,
          newTime: state.blockchain.currentTime,
          newBlock: state.blockchain.blockNumber,
        },
      };

      // Security: Persist event
      this.persistEvent(event, state);
    });
  }

  /**
   * Sets exact timestamp (must be >= current time) (with file locking).
   *
   * Security: Uses withLock to prevent race conditions.
   */
  private async setTimeWithLock(timestamp: number): Promise<void> {
    return this.stateManager.withLock(async (state) => {
      if (timestamp < state.blockchain.currentTime) {
        throw new Error(
          `Cannot move time backwards: ${timestamp} < ${state.blockchain.currentTime}`
        );
      }

      const timeDiff = timestamp - state.blockchain.currentTime;
      const blockTimeSeconds = state.blockchain.blockTime;

      state.blockchain.currentTime = timestamp;
      state.blockchain.blockNumber += Math.floor(timeDiff / blockTimeSeconds);

      // Record event
      const event: MockEvent = {
        type: 'TimeSet',
        timestamp: state.blockchain.currentTime,
        blockNumber: state.blockchain.blockNumber,
        data: {
          newTime: timestamp,
          newBlock: state.blockchain.blockNumber,
        },
      };

      // Security: Persist event
      this.persistEvent(event, state);
    });
  }

  // ============================================================================
  // Private Methods - Event Management
  // ============================================================================

  /**
   * Gets events for a specific transaction from both global log and transaction events.
   */
  private getEventsByTransaction(txId: string): MockEvent[] {
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
   *Security: Now checks for collisions against existing transactions.
   * Uses cryptographically secure random bytes (32 bytes = 256 bits of entropy).
   *
   * @param state - Current mock state to check for collisions
   * @returns Unique transaction ID
   */
  private generateTransactionIdWithCollisionCheck(state: MockState): string {
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const txId = `0x${crypto.randomBytes(32).toString('hex')}`;

      // Check for collision (extremely unlikely with 256 bits of randomness)
      if (!state.transactions[txId]) {
        return txId;
      }
    }

    // This should never happen with 256-bit IDs, but fail safely
    throw new Error(
      'Failed to generate unique transaction ID after multiple attempts. ' +
      'This indicates a critical system issue.'
    );
  }

  /**
   * Generates a unique transaction ID (bytes32 hex string).
   *
   * Note: This version is used when state is not available.
   * Prefer generateTransactionIdWithCollisionCheck when possible.
   */
  private generateTransactionId(): string {
    return `0x${crypto.randomBytes(32).toString('hex')}`;
  }

  /**
   * Generates a unique escrow ID with improved randomness.
   *
   *Security: Uses 16 bytes (128 bits) of cryptographic randomness
   * instead of just 4 bytes. Removes timestamp to prevent predictability.
   *
   * @returns Unique escrow ID
   */
  private generateEscrowId(): string {
    // Use 16 bytes of cryptographic randomness (128 bits of entropy)
    return `escrow-${crypto.randomBytes(16).toString('hex')}`;
  }
}
