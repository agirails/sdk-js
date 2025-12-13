/**
 * AGIRAILS SDK - Agent Commerce Transaction Protocol
 *
 * This is the main entry point for the AGIRAILS SDK.
 * The recommended way to use this SDK is through the ACTPClient class.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { ACTPClient } from '@agirails/sdk';
 *
 * // Create client in mock mode
 * const client = await ACTPClient.create({
 *   mode: 'mock',
 *   requesterAddress: '0x1234...',
 * });
 *
 * // Mint some tokens for testing
 * await client.mintTokens(client.getAddress(), '10000000000');
 *
 * // Create a payment
 * const result = await client.beginner.pay({
 *   to: '0xProvider...',
 *   amount: '100',
 * });
 *
 * console.log('Transaction ID:', result.txId);
 * ```
 */

// =============================================================================
// Primary API - ACTPClient
// =============================================================================

export {
  ACTPClient,
  ACTPClientConfig,
  ACTPClientMode,
  ACTPClientInfo,
} from './ACTPClient';

// =============================================================================
// Adapter Layer - Three-Level API
// =============================================================================

export {
  BaseAdapter,
  ValidationError,
  DEFAULT_DISPUTE_WINDOW_SECONDS,
  DEFAULT_DEADLINE_SECONDS,
  MIN_AMOUNT_WEI,
  MAX_DEADLINE_HOURS,
  MAX_DEADLINE_DAYS,
} from './adapters/BaseAdapter';

export {
  BeginnerAdapter,
  BeginnerPayParams,
  BeginnerPayResult,
} from './adapters/BeginnerAdapter';

export {
  IntermediateAdapter,
  IntermediateTransactionParams,
} from './adapters/IntermediateAdapter';

// =============================================================================
// Runtime Layer - Protocol Implementation
// =============================================================================

// Runtime interfaces
export {
  IACTPRuntime,
  IMockRuntime,
  CreateTransactionParams,
} from './runtime/IACTPRuntime';

// MockRuntime (for local development)
export {
  MockRuntime,
  TransactionNotFoundError,
  InvalidStateTransitionError,
  InsufficientBalanceError,
  EscrowNotFoundError,
  DeadlinePassedError,
  ContractPausedError,
  InvalidAmountError,
  DisputeWindowActiveError,
} from './runtime/MockRuntime';

// MockStateManager (for custom state management)
export {
  MockStateManager,
  MockStateCorruptedError,
  MockStateVersionError,
  MockStateLockError,
} from './runtime/MockStateManager';

// BlockchainRuntime (for testnet/mainnet)
export {
  BlockchainRuntime,
  BlockchainRuntimeConfig,
} from './runtime/BlockchainRuntime';

// =============================================================================
// Type Exports
// =============================================================================

export {
  MockState,
  MockTransaction,
  MockEscrow,
  MockAccount,
  MockBlockchain,
  MockEvent,
  TransactionState,
  TransactionStateValue,
  MOCK_STATE_DEFAULTS,
} from './runtime/types/MockState';

// =============================================================================
// Protocol Layer (from sdk-js merge)
// =============================================================================

// Protocol modules
export { ACTPKernel } from './protocol/ACTPKernel';
export { EscrowVault } from './protocol/EscrowVault';
export { EventMonitor } from './protocol/EventMonitor';
export { MessageSigner } from './protocol/MessageSigner';
export { ProofGenerator } from './protocol/ProofGenerator';
export { EASHelper, EASConfig } from './protocol/EASHelper';
export { AgentRegistry } from './protocol/AgentRegistry';
export { DIDManager } from './protocol/DIDManager';
export { DIDResolver } from './protocol/DIDResolver';

// Builders
export { QuoteBuilder } from './builders/QuoteBuilder';
export { DeliveryProofBuilder } from './builders/DeliveryProofBuilder';

// Config
export { getNetwork } from './config/networks';
export type { NetworkConfig } from './config/networks';

// Protocol types
export type {
  State,
  Transaction,
  CreateTransactionParams as ProtocolCreateParams,
  DisputeResolution,
  EconomicParams,
} from './types';

// Utils
export { NonceManager, InMemoryNonceManager } from './utils/NonceManager';
export { IReceivedNonceTracker, InMemoryReceivedNonceTracker } from './utils/ReceivedNonceTracker';
export { IPFSClient } from './utils/IPFSClient';
export { generateSecureNonce, isValidNonce, generateSecureNonces } from './utils/SecureNonce';
