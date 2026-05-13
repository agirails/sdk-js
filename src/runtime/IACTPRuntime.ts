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
import type { QuoteMessage } from '../builders/QuoteBuilder';

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
  /**
   * ERC-8004 agent ID (optional).
   * If set, enables reputation reporting after settlement.
   * Stored in transaction for later use by ReputationReporter.
   */
  agentId?: string;
  /** AIP-14: Requester's ERC-8004 agent ID (0 or omit if requester is not an agent) */
  requesterAgentId?: string;
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
 * const adapter = new BasicAdapter(runtime, requesterAddress);
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
   *Security: Added optional proof parameter for DELIVERED state.
   * The kernel contract uses proof data for dispute window configuration and
   * delivery verification. Without proof, default dispute window applies.
   *
   * @param txId - Transaction ID
   * @param newState - Target state
   * @param proof - Optional proof data (required for DELIVERED, used for DISPUTED/SETTLED)
   *
   * @throws {TransactionNotFoundError} If transaction doesn't exist
   * @throws {InvalidStateTransitionError} If transition is not valid
   * @throws {DeadlinePassedError} If deadline passed (for CANCELLED transition)
   *
   * @example
   * ```typescript
   * // Simple transition
   * await runtime.transitionState(txId, 'DELIVERED');
   *
   * // With delivery proof
   * await runtime.transitionState(txId, 'DELIVERED', deliveryProofBytes);
   * ```
   */
  transitionState(txId: string, newState: TransactionState, proof?: string): Promise<void>;

  /**
   * Accepts a provider's quote, updating the transaction amount.
   *
   * Does NOT change state (stays QUOTED). After acceptQuote, call linkEscrow.
   *
   * @param txId - Transaction ID
   * @param newAmount - New amount in USDC wei (string for BigNumber precision)
   */
  acceptQuote(txId: string, newAmount: string): Promise<void>;

  /**
   * Submit an AIP-2 price quote, transitioning INITIATED → QUOTED.
   *
   * Wraps `transitionState(txId, 'QUOTED', proof)` with a strict proof
   * construction: the canonical keccak256 hash of the signed
   * AIP-2 QuoteMessage, ABI-encoded as bytes32. That hash is what the
   * on-chain contract stores in `txn.metadata` (ACTPKernel.sol:248) so
   * any receiver can cross-reference the off-chain quote message with
   * what was committed on-chain.
   *
   * AIP-2.1 makes this the single canonical entry point for reaching
   * QUOTED — provider code should NOT call `transitionState(QUOTED, …)`
   * with a hand-rolled proof. The builder hash is the only format the
   * buyer-side verifier will accept (see AIP-2.1-DRAFT §3.5 Option D1
   * and §3.6 for the legacy-hash migration plan).
   *
   * Preconditions: transaction exists, is in INITIATED state, caller is
   * the transaction's provider.
   *
   * @param txId - Transaction ID (bytes32 hex)
   * @param quote - Signed QuoteMessage. Callers must build + sign it
   *                via QuoteBuilder before passing here; this method
   *                never signs, only transitions.
   *
   * @throws {TransactionNotFoundError} If transaction doesn't exist
   * @throws {InvalidStateTransitionError} If not in INITIATED state
   *
   * @example
   * ```typescript
   * const quote = await quoteBuilder.build({ … });
   * await runtime.submitQuote(txId, quote);
   * ```
   */
  submitQuote(txId: string, quote: QuoteMessage): Promise<void>;

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
   * Gets transactions filtered by provider address and optional state.
   *
   * Provider comparison is case-insensitive — implementations normalize both
   * the stored and queried addresses to lowercase before comparing, so callers
   * may pass either checksummed or lowercase forms.
   *
   * Implementations:
   * - MockRuntime: queries in-memory state.
   * - BlockchainRuntime: composes EventMonitor.getTransactionHistory over a
   *   bounded fromBlock window + hydrates each result via getTransaction()
   *   (full implementation lands with §5.2 of PRD-event-driven-provider-listening).
   *
   * @param provider - Provider Ethereum address (any case)
   * @param state - Optional state filter (e.g., 'INITIATED'); omit for all states
   * @param limit - Maximum results (default 100, 0 = unlimited)
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
  getTransactionsByProvider(
    provider: string,
    state?: TransactionState,
    limit?: number
  ): Promise<MockTransaction[]>;

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
  releaseEscrow(escrowId: string, attestationUID?: string): Promise<void>;

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

  /**
   * Maximum transaction amount in USDC (human-readable, e.g., 100 = $100).
   *
   * SECURITY: Limits exposure on unaudited contracts.
   * Returns undefined if no limit is enforced (testnet/mock mode).
   *
   * @example
   * ```typescript
   * const limit = runtime.maxTransactionAmount;
   * if (limit && amount > limit) {
   *   throw new Error(`Amount exceeds limit of $${limit}`);
   * }
   * ```
   */
  maxTransactionAmount?: number;
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
