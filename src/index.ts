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

export {
  X402Adapter,
  X402AdapterConfig,
} from './adapters/X402Adapter';

// x402-specific error types (3.3.0+)
export {
  X402Error,
  X402ConfigError,
  X402PublishRequiredError,
  X402UnsupportedWalletError,
  X402NetworkNotAllowedError,
  X402AmountExceededError,
  X402ApprovalFailedError,
  X402SignatureFailedError,
  X402SettlementProofMissingError,
  X402PaymentFailedError,
} from './errors/X402Errors';

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
export { CounterOfferBuilder } from './builders/CounterOfferBuilder';
export type { CounterOfferMessage, CounterOfferParams } from './builders/CounterOfferBuilder';
export { CounterAcceptBuilder } from './builders/CounterAcceptBuilder';
export type { CounterAcceptMessage, CounterAcceptParams } from './builders/CounterAcceptBuilder';
export { DeliveryProofBuilder } from './builders/DeliveryProofBuilder';

// Transport (AIP-2.1 quote/counter-offer channel)
export {
  QuoteChannelClient,
  QuoteChannelHandler,
  InMemoryDedupStore,
  buildChannelPath,
} from './transport/QuoteChannel';

// Provider-side negotiation (AIP-2.1 §5.2 Phase 2)
export { ProviderOrchestrator } from './negotiation/ProviderOrchestrator';
export { ProviderPolicyEngine } from './negotiation/ProviderPolicy';
export type {
  ProviderOrchestratorConfig,
  QuoteDecision,
  QuoteResult,
  CounterDecision,
  CounterContext,
  CounterDecider,
} from './negotiation/ProviderOrchestrator';
export type {
  ProviderPolicy,
  ProviderPolicyViolation,
  ProviderPolicyResult,
  IncomingRequest,
} from './negotiation/ProviderPolicy';

// Buyer-side negotiation (AIP-2.1 §5.3 Phase 3)
export { BuyerOrchestrator } from './negotiation/BuyerOrchestrator';
export type {
  NegotiationResult,
  RoundResult,
  OrchestratorConfig,
  ProgressEvent,
  BuyerNegotiationContext,
} from './negotiation/BuyerOrchestrator';
export { PolicyEngine } from './negotiation/PolicyEngine';
export type {
  BuyerPolicy,
  QuoteOffer,
  PolicyViolation,
  PolicyResult,
} from './negotiation/PolicyEngine';
export { DecisionEngine } from './negotiation/DecisionEngine';
export type {
  ScoringWeights,
  CandidateStats,
  ScoredCandidate,
  QuoteForEvaluation,
  QuoteEvaluation,
  BuyerQuoteDecider,
} from './negotiation/DecisionEngine';
export { verifyQuoteHashOnChain } from './negotiation/verifyQuoteOnChain';
export type {
  VerifySource,
  VerifyOnChainResult,
} from './negotiation/verifyQuoteOnChain';
export { SessionStore } from './negotiation/SessionStore';
export type { SessionMapping } from './negotiation/SessionStore';

// AIP-2.1 §6 NegotiationChannel — transport abstraction + impls.
// Without these exports developers can't wire up BuyerOrchestrator
// or ProviderOrchestrator with a custom transport, can't implement
// MockChannel-style tests, and can't use the type guards.
export type {
  NegotiationChannel,
  NegotiationMessage,
  Subscription,
  DeliveredMessage,
} from './negotiation/NegotiationChannel';
export {
  isQuoteEnvelope,
  isCounterOfferEnvelope,
  isCounterAcceptEnvelope,
  envelopeTxId,
  envelopeChainId,
} from './negotiation/NegotiationChannel';
export { RelayChannel } from './negotiation/RelayChannel';
export type { RelayChannelConfig } from './negotiation/RelayChannel';
export { MockChannel } from './negotiation/MockChannel';
export type { MockChannelConfig } from './negotiation/MockChannel';
export type {
  ChannelPayload,
  DedupStore,
  HandlerContext,
  HandlerResult,
  QuoteChannelClientConfig,
  QuoteChannelHandlerConfig,
} from './transport/QuoteChannel';

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

// Dispute (AIP-14b) — AIRuling EIP-712 signer (the evidence-bundle serializer
// is exported further below under "Dispute — Evidence Bundle").
// PARITY: mirrors python-sdk-v2 `agirails.types` (dispute) signing surface 1:1.
export {
  Ruling,
  Tier,
  AIRulingTypes,
  RULING_TYPEHASH,
  DOMAIN_TYPEHASH,
  DISPUTE_EVALUATOR_DOMAIN_NAME,
  DISPUTE_EVALUATOR_DOMAIN_VERSION,
  disputeEvaluatorDomain,
  computeRulingDigest,
  computeRulingDomainSeparator,
  computeRulingStructHash,
  signRuling,
  recoverRulingSigner,
} from './types/dispute';
export type { AIRuling, DisputeState } from './types/dispute';

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
// Simple tier - convenience provide/request interface
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
// Dispute — Evidence Bundle canonical serializer (AIP-14b / PRD P2-3)
// =============================================================================

export {
  // Serializer API (1:1 with the Python twin)
  serializeBundle,
  serializeBundleToString,
  bundleHash,
  computeBundleHash,
  validateBundle,
  assertSupportedVersion,
  countBundleTokens,
  enforceTokenCap,
  setBundleTokenizer,
  pinEvidenceBundle,
  // Constants
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SUPPORTED_BUNDLE_MAJOR,
  MAX_BUNDLE_TOKENS,
  // Errors (frozen names — schema §6)
  BundleTooLargeError,
  UnsupportedBundleVersionError,
  InvalidBundleError,
} from './dispute/EvidenceBundle';

export type {
  EvidenceBundle,
  EvidenceBundleSpec,
  EvidenceBundleDelivery,
  EvidenceBundleDispute,
  EvidenceBundleTimelineEvent,
  EvidenceBundleReasoning,
  PinEvidenceBundleResult,
  EvidenceBundlePinner,
  BundleTokenizer,
} from './dispute/EvidenceBundle';

// AIP-14c Schema-2.0.0 IMMUTABLE evidence artifact (D5/D6) — canonical serializer + hash.
export {
  EVIDENCE_ARTIFACT_V2_SCHEMA_VERSION,
  assertArtifactV2Version,
  validateEvidenceArtifactV2,
  serializeArtifactV2,
  serializeArtifactV2ToString,
  computeArtifactV2Hash,
  countArtifactV2Tokens,
  UnsupportedArtifactVersionError,
  InvalidArtifactError,
} from './dispute/EvidenceArtifactV2';

export type {
  EvidenceArtifactV2,
  ArtifactV2Parties,
  ArtifactV2Timestamps,
  ArtifactV2Transaction,
  ArtifactV2Agreement,
  ArtifactV2Delivery,
} from './dispute/EvidenceArtifactV2';

// CompositeMediator read/event client + decoders (PRD P2-5; 1:1 with the Python twin).
export {
  CompositeMediator,
  decodeDisputeSplitRecorded,
  decodeResolutionProof,
  computeSplitRate,
} from './dispute/CompositeMediator';

export type {
  DisputeSplitRecorded,
  DecodedResolutionProof,
} from './dispute/CompositeMediator';

// DisputeEvent union surfaced by EventMonitor (PRD P2-5).
export type { DisputeEvent } from './protocol/EventMonitor';

// =============================================================================
// Dispute — BondEscalation client (AIP-14 §7.1 / PRD P2-4)
// =============================================================================

export {
  BondEscalationClient,
  // Constants (AIP-14 §7.4)
  ESCALATION_INITIAL_BPS,
  MIN_ESCALATION_BOND,
  MAX_ESCALATION_BOND,
  ESCALATION_MULTIPLIER,
  BPS_DENOMINATOR,
} from './dispute/BondEscalation';

export type {
  BondEscalationClientConfig,
  IBondEscalationContract,
} from './dispute/BondEscalation';

// =============================================================================
// Dispute — DisputeClient facade (AIP-14b §3/§9 / PRD P2-9)
// PARITY: mirrors python-sdk-v2 `agirails.dispute.dispute_client` 1:1.
// =============================================================================

export {
  DisputeClient,
  decodeDisputeSubState,
} from './dispute/DisputeClient';

export type {
  DisputeClientConfig,
  DisputeSubState,
  DisputeStatus,
} from './dispute/DisputeClient';

// =============================================================================
// Dispute — UMA self-dispute DVM helper (AIP-14b §8.6 / PRD P2-7)
// PARITY: mirrors python-sdk-v2 `agirails.dispute.uma_helper` 1:1.
// =============================================================================

export {
  UMAHelper,
  // Constants (AIP-14b §8.6 economics)
  UMA_BOND,
  SELF_DISPUTE_TOTAL,
  SELF_DISPUTE_RECOVER,
  SELF_DISPUTE_LOSS,
} from './dispute/UMAHelper';

export type {
  UMAHelperConfig,
  SelfDisputeCost,
  IDisputeContract,
  IERC20Contract,
  IOptimisticOracleV3Contract,
} from './dispute/UMAHelper';

// =============================================================================
// Reputation — DisputeSplitIndexer (AIP-14b §3.4/§3.5, OQ-11, INV-22 / PRD P2-8)
// PARITY: mirrors python-sdk-v2 `agirails.reputation.dispute_split_indexer` 1:1.
// =============================================================================

export {
  DisputeSplitIndexer,
  isSplitKind,
  outcomeFromSplitRecorded,
} from './reputation/DisputeSplitIndexer';

export type {
  DisputeOutcome,
  DisputeOutcomeKind,
  SplitRateResult,
  SplitRateBreakdown,
} from './reputation/DisputeSplitIndexer';

// =============================================================================
// Dispute — off-chain EvaluatorClient (API-CONTRACT.md / AIP-14 §4.7 / PRD P2-6)
// PARITY: mirrors python-sdk-v2 `agirails.dispute.evaluator_client` 1:1.
// =============================================================================

export {
  EvaluatorClient,
  verifyRulingSignatures,
  selectThirdEvaluator,
  EvaluatorClientError,
  QuoteRejectedError,
  EvaluateResponseError,
} from './dispute/EvaluatorClient';

export type {
  EvaluatorClientConfig,
  EvaluatorPaymentClient,
  RequestEvaluationParams,
  EvaluationResult,
  RulingVerification,
  BundleSource,
  ProposeDirectlyRecommendation,
} from './dispute/EvaluatorClient';

// NOTE: SignedEvaluateResponse / ProposeDirectlyEvaluateResponse / EvaluateResponse
// / EvaluatorRuling are INTENTIONALLY NOT re-exported here. They are internal
// HTTP wire-parse shapes (not caller inputs); the Python SDK parses the evaluate
// response as a raw dict and has NO twin, so to keep the public package surface
// symmetric they are de-exported from the package entrypoint. They remain
// `export`ed from ./dispute/EvaluatorClient for intra-module typing. The cross-SDK
// META parity test (tests/dispute-parity.test.ts) asserts each is absent from
// this entrypoint via parity-surface.json `tsOnlyDeExported`, so this de-export
// cannot silently regress.

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
  ReportDisputeSplitParams,
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
  SwapExecutionError,
  QueryCapExceededError,
} from './errors';
