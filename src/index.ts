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
 * const result = await client.basic.pay({
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
  DEFAULT_DISPUTE_WINDOW_SECONDS,
  DEFAULT_DEADLINE_SECONDS,
  MIN_AMOUNT_WEI,
  MAX_DEADLINE_HOURS,
  MAX_DEADLINE_DAYS,
} from './adapters/BaseAdapter';

export {
  BasicAdapter,
  BasicPayParams,
  BasicPayResult,
} from './adapters/BasicAdapter';

export {
  StandardAdapter,
  StandardTransactionParams,
} from './adapters/StandardAdapter';

export { AdapterRegistry } from './adapters/AdapterRegistry';

export {
  AdapterRouter,
  AdapterSelectionResult,
} from './adapters/AdapterRouter';

export {
  IAdapter,
  TransactionStatus,
  AdapterTransactionState,
  isAdapter,
} from './adapters/IAdapter';

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
  InsufficientBalanceError,
  EscrowNotFoundError,
  DeadlinePassedError,
  ContractPausedError,
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
export { ProofGenerator, URLValidationConfig } from './protocol/ProofGenerator';
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
// Note: IPFSClient is not exported from main index to avoid ESM compatibility issues
// Import directly from '@agirails/sdk/utils/IPFSClient' if needed
export type { IPFSClient, IPFSClientConfig } from './utils/IPFSClient';
export { generateSecureNonce, isValidNonce, generateSecureNonces } from './utils/SecureNonce';
export { Semaphore, RateLimiter } from './utils/Semaphore';
export {
  IUsedAttestationTracker,
  InMemoryUsedAttestationTracker,
  FileBasedUsedAttestationTracker,
  createUsedAttestationTracker,
} from './utils/UsedAttestationTracker';

// Wallet
export { resolvePrivateKey, getCachedAddress } from './wallet/keystore';
export type {
  IWalletProvider,
  TransactionRequest as WalletTransactionRequest,
  TransactionReceipt as WalletTransactionReceipt,
  WalletInfo,
  WalletTier,
  BatchedPayParams,
  BatchedPayResult,
} from './wallet/IWalletProvider';
export { EOAWalletProvider } from './wallet/EOAWalletProvider';
export { AutoWalletProvider } from './wallet/AutoWalletProvider';
export type { AutoWalletConfig } from './wallet/AutoWalletProvider';

// Helper utilities
export {
  USDC,
  Deadline,
  Address,
  Bytes32,
  State as StateHelpers,
  DisputeWindow,
  parseUSDC,
  formatUSDC,
  shortenAddress,
  ServiceHash,
  hashServiceMetadata,
} from './utils/Helpers';
export type { ServiceMetadata } from './utils/Helpers';

// =============================================================================
// Basic API - Simple provide/request interface
// =============================================================================

export { provide, request, serviceDirectory } from './level0';
export type {
  Provider,
  ProviderStatus,
  ProviderStats,
  ProviderBalance,
} from './level0';

// =============================================================================
// Standard API - Agent-based interface
// =============================================================================

export { Agent, calculatePrice, DEFAULT_PRICING_STRATEGY } from './level1';
export type {
  AgentConfig,
  AgentStatus,
  AgentStats,
  AgentBalance,
  ServiceConfig,
  Job,
  JobHandler,
  JobContext,
  ProvideOptions,
  RequestOptions,
  RequestResult,
  RequestStatus,
  WalletOption,
  NetworkOption,
  PricingStrategy,
  ServiceCost,
  BelowPriceBehavior,
  BelowCostBehavior,
  PriceCalculation,
} from './level1';

// =============================================================================
// Storage Layer (AIP-7 §4) - Hybrid IPFS + Arweave
// =============================================================================

// Storage clients
export { FilebaseClient } from './storage/FilebaseClient';
export { ArweaveClient } from './storage/ArweaveClient';

// Archive bundle builder
export {
  ArchiveBundleBuilder,
  computeContentHash,
  validateArchiveBundle,
} from './storage/ArchiveBundleBuilder';

// Storage types
export type {
  FilebaseConfig,
  ArweaveConfig,
  IrysCurrency,
  IrysNetwork,
  ArchiveBundle,
  ArchiveChainId,
  ArchiveFinalState,
  ArchiveParticipants,
  ArchiveReferences,
  ArchiveHashes,
  ArchiveSignatures,
  ArchiveAttestation,
  ArchiveSettlement,
  EscrowRelease,
  ArchiveTags,
  IPFSUploadResult,
  ArweaveUploadResult,
  DownloadResult,
} from './storage/types';

// Storage constants
export { ARCHIVE_BUNDLE_TYPE } from './storage/types';

// =============================================================================
// ERC-8004 Integration
// =============================================================================

export {
  ERC8004Bridge,
  ReputationReporter,
  ERC8004Error,
  ERC8004ErrorCode,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  ERC8004_DEFAULT_RPC,
  ACTP_FEEDBACK_TAGS,
} from './erc8004';

export type {
  ERC8004BridgeConfig,
  ReputationReporterConfig,
  ReportSettlementParams,
  ReportDisputeParams,
  ReportResult,
  ERC8004Network,
  ERC8004Agent,
  ERC8004AgentMetadata,
  ReputationFeedback,
  ReputationSummary,
  ACTPFeedbackTag,
} from './erc8004';

// =============================================================================
// Enhanced Error Exports
// =============================================================================

export {
  ACTPError,
  InsufficientFundsError,
  TransactionNotFoundError,
  DeadlineExpiredError,
  InvalidStateTransitionError,
  SignatureVerificationError,
  TransactionRevertedError,
  NetworkError,
  ValidationError,
  InvalidAddressError,
  InvalidAmountError,
  // Basic/Standard API errors
  NoProviderFoundError,
  TimeoutError,
  ProviderRejectedError,
  DeliveryFailedError,
  DisputeRaisedError,
  ServiceConfigError,
  AgentLifecycleError,
  // Storage errors (AIP-7)
  StorageError,
  StorageAuthenticationError,
  StorageRateLimitError,
  UploadTimeoutError,
  DownloadTimeoutError,
  ContentNotFoundError,
  FileSizeLimitExceededError,
  InvalidCIDError,
  ArweaveUploadError,
  ArweaveDownloadError,
  ArweaveTimeoutError,
  InvalidArweaveTxIdError,
  InsufficientBalanceError as StorageInsufficientBalanceError,
} from './errors';
