/**
 * ACTP SDK - Protocol SDK for Agent Commerce
 * @packageDocumentation
 */

// Main client
export { ACTPClient, ACTPClientConfig } from './ACTPClient';

// Protocol modules
export { ACTPKernel } from './protocol/ACTPKernel';
export { EscrowVault } from './protocol/EscrowVault';
export { EventMonitor } from './protocol/EventMonitor';
export { ProofGenerator } from './protocol/ProofGenerator';
export { MessageSigner } from './protocol/MessageSigner';
export { EASHelper, EASConfig } from './protocol/EASHelper';
export { QuoteBuilder, QuoteParams, QuoteMessage } from './protocol/QuoteBuilder';

// Types
export {
  State,
  StateMachine,
  Transaction,
  CreateTransactionParams,
  DisputeResolution,
  EconomicParams,
  CreateEscrowParams,
  Escrow,
  ACTPMessage,
  QuoteRequest,
  QuoteResponse,
  DeliveryProof,
  DeliveryProofMessage,
  EASAttestationData
} from './types';

// EIP-712 types
export {
  EIP712Domain,
  AIP4DeliveryProofTypes,
  AIP4DeliveryProofData,
  DeliveryProofTypes,
  DeliveryProofData
} from './types/eip712';

// Builders
export {
  DeliveryProofBuilder,
  DeliveryProofParams,
  AGIRAILS_DELIVERY_SCHEMA_UID
} from './builders';

// Utilities
export {
  canonicalJsonStringify,
  computeCanonicalHash,
  computeResultHash
} from './utils/canonicalJson';

export {
  IPFSClient,
  IPFSHTTPClientImpl,
  IPFSClientConfig,
  createIPFSClient,
  IPFS_CONFIGS
} from './utils/IPFSClient';

export {
  NonceManager,
  InMemoryNonceManager,
  DIDScopedNonceManager,
  createNonceManager
} from './utils/NonceManager';

// V4 Security: Nonce Replay Protection
export {
  IReceivedNonceTracker,
  InMemoryReceivedNonceTracker,
  SetBasedReceivedNonceTracker,
  createReceivedNonceTracker,
  NonceValidationResult
} from './utils/ReceivedNonceTracker';

// Validation utilities
export {
  validateAddress,
  validateAmount,
  validateDeadline,
  validateDisputeWindow,
  validateTxId
} from './utils/validation';

// Errors
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
  InvalidAmountError
} from './errors';

// Configuration
export { NetworkConfig, NETWORKS, getNetwork, isValidNetwork } from './config/networks';
