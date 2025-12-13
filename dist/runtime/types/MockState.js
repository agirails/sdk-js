"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOCK_STATE_DEFAULTS = exports.TransactionStateValue = void 0;
/**
 * Numeric state values matching the smart contract enum.
 */
exports.TransactionStateValue = {
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
 * Default values for creating new mock state.
 */
exports.MOCK_STATE_DEFAULTS = {
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
};
//# sourceMappingURL=MockState.js.map