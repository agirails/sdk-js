/**
 * Mock State Type Definitions
 *
 * These interfaces define the structure of the persistent mock blockchain state
 * stored in `.actp/mock-state.json`. This state is shared across CLI commands,
 * SDK library usage, and Dashboard.
 *
 * @module runtime/types/MockState
 * @see ADR-001 (Mock State Persistence Strategy)
 * @see MOCK_STATE_MANAGER_SPEC.md
 */

/**
 * ACTP Transaction State enum matching the smart contract states.
 *
 * State machine:
 * - INITIATED (0) -> QUOTED (1, optional) -> COMMITTED (2) -> IN_PROGRESS (3, optional)
 *                 -> DELIVERED (4) -> SETTLED (5)
 * - Dispute path: DELIVERED -> DISPUTED (6) -> SETTLED
 * - Cancel path: Any pre-DELIVERED state -> CANCELLED (7)
 */
export type TransactionState =
  | 'INITIATED'
  | 'QUOTED'
  | 'COMMITTED'
  | 'IN_PROGRESS'
  | 'DELIVERED'
  | 'SETTLED'
  | 'DISPUTED'
  | 'CANCELLED';

/**
 * Numeric state values matching the smart contract enum.
 */
export const TransactionStateValue: Record<TransactionState, number> = {
  INITIATED: 0,
  QUOTED: 1,
  COMMITTED: 2,
  IN_PROGRESS: 3,
  DELIVERED: 4,
  SETTLED: 5,
  DISPUTED: 6,
  CANCELLED: 7,
};

/**
 * Mock blockchain event recorded during transaction lifecycle.
 *
 * Events are stored for debugging and can be queried to simulate
 * blockchain event subscriptions.
 */
export interface MockEvent {
  /** Event type (e.g., 'TransactionCreated', 'EscrowLinked', 'StateTransitioned') */
  type: string;

  /** Unix timestamp (seconds) when event was emitted */
  timestamp: number;

  /** Block number when event was included */
  blockNumber: number;

  /** Event-specific data payload */
  data: Record<string, unknown>;
}

/**
 * Mock transaction representing an ACTP transaction in the mock blockchain.
 *
 * Mirrors the on-chain Transaction struct but stored as JSON for human-readability.
 * BigNumber values are stored as strings to preserve precision.
 */
export interface MockTransaction {
  /** Unique transaction identifier (bytes32 hex string) */
  id: string;

  /** Requester's Ethereum address (checksummed) */
  requester: string;

  /** Provider's Ethereum address (checksummed) */
  provider: string;

  /** Transaction amount in USDC wei (string for BigNumber precision, 6 decimals) */
  amount: string;

  /** Current transaction state */
  state: TransactionState;

  /** Unix timestamp (seconds) when transaction was created */
  createdAt: number;

  /** Unix timestamp (seconds) when transaction was last updated */
  updatedAt: number;

  /** Unix timestamp (seconds) deadline for transaction acceptance */
  deadline: number;

  /** Dispute window duration in seconds */
  disputeWindow: number;

  /** Unix timestamp (seconds) when transaction was completed (null if not completed) */
  completedAt: number | null;

  /** Linked escrow ID (null if not linked yet) */
  escrowId: string | null;

  /** Service description or metadata hash */
  serviceDescription: string;

  /** Delivery proof hash (null if not delivered) */
  deliveryProof: string | null;

  /** List of events emitted during transaction lifecycle */
  events: MockEvent[];
}

/**
 * Mock escrow representing funds locked for a transaction.
 *
 * In mock mode, escrow is simulated without actual token transfers.
 */
export interface MockEscrow {
  /** Unique escrow identifier */
  id: string;

  /** Current escrow balance in USDC wei (string for BigNumber precision) */
  balance: string;

  /** Whether funds are currently locked (cannot be withdrawn) */
  locked: boolean;

  /** List of transaction IDs using this escrow */
  transactions: string[];

  /** Unix timestamp (seconds) when escrow was created */
  createdAt: number;
}

/**
 * Mock account representing a user's wallet state.
 *
 * Tracks USDC balance for testing without real tokens.
 */
export interface MockAccount {
  /** Ethereum address (checksummed) */
  address: string;

  /** USDC balance in wei (string for BigNumber precision, 6 decimals) */
  usdcBalance: string;

  /** Optional label for easier identification in tests */
  label?: string;
}

/**
 * Mock blockchain state simulating chain parameters.
 *
 * Allows time manipulation and block progression for testing
 * deadline-based logic and dispute windows.
 */
export interface MockBlockchain {
  /** Current simulated Unix timestamp (seconds) */
  currentTime: number;

  /** Current block number */
  blockNumber: number;

  /** Chain ID (84532 for Base Sepolia, 8453 for Base Mainnet) */
  chainId: number;

  /** Average block time in seconds (for time progression calculations) */
  blockTime: number;
}

/**
 * Complete mock state persisted to `.actp/mock-state.json`.
 *
 * This is the root interface for all mock blockchain state.
 * Loaded/saved by MockStateManager.
 */
export interface MockState {
  /** State schema version (e.g., "1.0") for migrations */
  version: string;

  /** Always "mock" for mock mode */
  mode: 'mock';

  /** Simulated blockchain parameters */
  blockchain: MockBlockchain;

  /** All mock transactions indexed by transaction ID */
  transactions: Record<string, MockTransaction>;

  /** All mock escrows indexed by escrow ID */
  escrows: Record<string, MockEscrow>;

  /** All mock accounts indexed by address */
  accounts: Record<string, MockAccount>;

  /**
   * Global event log for all events (optional for backwards compatibility).
   *
   * SECURITY FIX (L-4): Events are now persisted to state file for
   * debugging and audit purposes. This allows event history to survive
   * across CLI invocations.
   */
  events?: MockEvent[];
}

/**
 * Default values for creating new mock state.
 */
export const MOCK_STATE_DEFAULTS = {
  /** Current state schema version */
  VERSION: '1.0',

  /** Default chain ID (Base Sepolia testnet) */
  CHAIN_ID: 84532,

  /** Default starting block number */
  INITIAL_BLOCK_NUMBER: 1000,

  /** Default block time in seconds (Base L2 ~2 seconds) */
  BLOCK_TIME: 2,

  /** Default initial USDC balance for new accounts (10,000 USDC = 10_000_000_000 wei) */
  DEFAULT_USDC_BALANCE: '10000000000',
} as const;
