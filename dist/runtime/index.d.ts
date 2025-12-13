/**
 * Runtime module exports.
 *
 * Provides both the runtime interface and concrete implementations.
 *
 * @module runtime
 */
export { IACTPRuntime, IMockRuntime, CreateTransactionParams } from './IACTPRuntime';
export { MockRuntime } from './MockRuntime';
export { MockStateManager } from './MockStateManager';
export { BlockchainRuntime, BlockchainRuntimeConfig } from './BlockchainRuntime';
export * from './types/MockState';
export { TransactionNotFoundError, InvalidStateTransitionError, InsufficientBalanceError, EscrowNotFoundError, DeadlinePassedError, ContractPausedError, InvalidAmountError, DisputeWindowActiveError, } from './MockRuntime';
//# sourceMappingURL=index.d.ts.map