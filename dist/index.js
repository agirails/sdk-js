"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSecureNonces = exports.isValidNonce = exports.generateSecureNonce = exports.InMemoryReceivedNonceTracker = exports.InMemoryNonceManager = exports.getNetwork = exports.DeliveryProofBuilder = exports.QuoteBuilder = exports.DIDResolver = exports.DIDManager = exports.AgentRegistry = exports.EASHelper = exports.ProofGenerator = exports.MessageSigner = exports.EventMonitor = exports.EscrowVault = exports.ACTPKernel = exports.MOCK_STATE_DEFAULTS = exports.TransactionStateValue = exports.BlockchainRuntime = exports.MockStateLockError = exports.MockStateVersionError = exports.MockStateCorruptedError = exports.MockStateManager = exports.DisputeWindowActiveError = exports.InvalidAmountError = exports.ContractPausedError = exports.DeadlinePassedError = exports.EscrowNotFoundError = exports.InsufficientBalanceError = exports.InvalidStateTransitionError = exports.TransactionNotFoundError = exports.MockRuntime = exports.IntermediateAdapter = exports.BeginnerAdapter = exports.MAX_DEADLINE_DAYS = exports.MAX_DEADLINE_HOURS = exports.MIN_AMOUNT_WEI = exports.DEFAULT_DEADLINE_SECONDS = exports.DEFAULT_DISPUTE_WINDOW_SECONDS = exports.ValidationError = exports.BaseAdapter = exports.ACTPClient = void 0;
// =============================================================================
// Primary API - ACTPClient
// =============================================================================
var ACTPClient_1 = require("./ACTPClient");
Object.defineProperty(exports, "ACTPClient", { enumerable: true, get: function () { return ACTPClient_1.ACTPClient; } });
// =============================================================================
// Adapter Layer - Three-Level API
// =============================================================================
var BaseAdapter_1 = require("./adapters/BaseAdapter");
Object.defineProperty(exports, "BaseAdapter", { enumerable: true, get: function () { return BaseAdapter_1.BaseAdapter; } });
Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function () { return BaseAdapter_1.ValidationError; } });
Object.defineProperty(exports, "DEFAULT_DISPUTE_WINDOW_SECONDS", { enumerable: true, get: function () { return BaseAdapter_1.DEFAULT_DISPUTE_WINDOW_SECONDS; } });
Object.defineProperty(exports, "DEFAULT_DEADLINE_SECONDS", { enumerable: true, get: function () { return BaseAdapter_1.DEFAULT_DEADLINE_SECONDS; } });
Object.defineProperty(exports, "MIN_AMOUNT_WEI", { enumerable: true, get: function () { return BaseAdapter_1.MIN_AMOUNT_WEI; } });
Object.defineProperty(exports, "MAX_DEADLINE_HOURS", { enumerable: true, get: function () { return BaseAdapter_1.MAX_DEADLINE_HOURS; } });
Object.defineProperty(exports, "MAX_DEADLINE_DAYS", { enumerable: true, get: function () { return BaseAdapter_1.MAX_DEADLINE_DAYS; } });
var BeginnerAdapter_1 = require("./adapters/BeginnerAdapter");
Object.defineProperty(exports, "BeginnerAdapter", { enumerable: true, get: function () { return BeginnerAdapter_1.BeginnerAdapter; } });
var IntermediateAdapter_1 = require("./adapters/IntermediateAdapter");
Object.defineProperty(exports, "IntermediateAdapter", { enumerable: true, get: function () { return IntermediateAdapter_1.IntermediateAdapter; } });
// MockRuntime (for local development)
var MockRuntime_1 = require("./runtime/MockRuntime");
Object.defineProperty(exports, "MockRuntime", { enumerable: true, get: function () { return MockRuntime_1.MockRuntime; } });
Object.defineProperty(exports, "TransactionNotFoundError", { enumerable: true, get: function () { return MockRuntime_1.TransactionNotFoundError; } });
Object.defineProperty(exports, "InvalidStateTransitionError", { enumerable: true, get: function () { return MockRuntime_1.InvalidStateTransitionError; } });
Object.defineProperty(exports, "InsufficientBalanceError", { enumerable: true, get: function () { return MockRuntime_1.InsufficientBalanceError; } });
Object.defineProperty(exports, "EscrowNotFoundError", { enumerable: true, get: function () { return MockRuntime_1.EscrowNotFoundError; } });
Object.defineProperty(exports, "DeadlinePassedError", { enumerable: true, get: function () { return MockRuntime_1.DeadlinePassedError; } });
Object.defineProperty(exports, "ContractPausedError", { enumerable: true, get: function () { return MockRuntime_1.ContractPausedError; } });
Object.defineProperty(exports, "InvalidAmountError", { enumerable: true, get: function () { return MockRuntime_1.InvalidAmountError; } });
Object.defineProperty(exports, "DisputeWindowActiveError", { enumerable: true, get: function () { return MockRuntime_1.DisputeWindowActiveError; } });
// MockStateManager (for custom state management)
var MockStateManager_1 = require("./runtime/MockStateManager");
Object.defineProperty(exports, "MockStateManager", { enumerable: true, get: function () { return MockStateManager_1.MockStateManager; } });
Object.defineProperty(exports, "MockStateCorruptedError", { enumerable: true, get: function () { return MockStateManager_1.MockStateCorruptedError; } });
Object.defineProperty(exports, "MockStateVersionError", { enumerable: true, get: function () { return MockStateManager_1.MockStateVersionError; } });
Object.defineProperty(exports, "MockStateLockError", { enumerable: true, get: function () { return MockStateManager_1.MockStateLockError; } });
// BlockchainRuntime (for testnet/mainnet)
var BlockchainRuntime_1 = require("./runtime/BlockchainRuntime");
Object.defineProperty(exports, "BlockchainRuntime", { enumerable: true, get: function () { return BlockchainRuntime_1.BlockchainRuntime; } });
// =============================================================================
// Type Exports
// =============================================================================
var MockState_1 = require("./runtime/types/MockState");
Object.defineProperty(exports, "TransactionStateValue", { enumerable: true, get: function () { return MockState_1.TransactionStateValue; } });
Object.defineProperty(exports, "MOCK_STATE_DEFAULTS", { enumerable: true, get: function () { return MockState_1.MOCK_STATE_DEFAULTS; } });
// =============================================================================
// Protocol Layer (from sdk-js merge)
// =============================================================================
// Protocol modules
var ACTPKernel_1 = require("./protocol/ACTPKernel");
Object.defineProperty(exports, "ACTPKernel", { enumerable: true, get: function () { return ACTPKernel_1.ACTPKernel; } });
var EscrowVault_1 = require("./protocol/EscrowVault");
Object.defineProperty(exports, "EscrowVault", { enumerable: true, get: function () { return EscrowVault_1.EscrowVault; } });
var EventMonitor_1 = require("./protocol/EventMonitor");
Object.defineProperty(exports, "EventMonitor", { enumerable: true, get: function () { return EventMonitor_1.EventMonitor; } });
var MessageSigner_1 = require("./protocol/MessageSigner");
Object.defineProperty(exports, "MessageSigner", { enumerable: true, get: function () { return MessageSigner_1.MessageSigner; } });
var ProofGenerator_1 = require("./protocol/ProofGenerator");
Object.defineProperty(exports, "ProofGenerator", { enumerable: true, get: function () { return ProofGenerator_1.ProofGenerator; } });
var EASHelper_1 = require("./protocol/EASHelper");
Object.defineProperty(exports, "EASHelper", { enumerable: true, get: function () { return EASHelper_1.EASHelper; } });
var AgentRegistry_1 = require("./protocol/AgentRegistry");
Object.defineProperty(exports, "AgentRegistry", { enumerable: true, get: function () { return AgentRegistry_1.AgentRegistry; } });
var DIDManager_1 = require("./protocol/DIDManager");
Object.defineProperty(exports, "DIDManager", { enumerable: true, get: function () { return DIDManager_1.DIDManager; } });
var DIDResolver_1 = require("./protocol/DIDResolver");
Object.defineProperty(exports, "DIDResolver", { enumerable: true, get: function () { return DIDResolver_1.DIDResolver; } });
// Builders
var QuoteBuilder_1 = require("./builders/QuoteBuilder");
Object.defineProperty(exports, "QuoteBuilder", { enumerable: true, get: function () { return QuoteBuilder_1.QuoteBuilder; } });
var DeliveryProofBuilder_1 = require("./builders/DeliveryProofBuilder");
Object.defineProperty(exports, "DeliveryProofBuilder", { enumerable: true, get: function () { return DeliveryProofBuilder_1.DeliveryProofBuilder; } });
// Config
var networks_1 = require("./config/networks");
Object.defineProperty(exports, "getNetwork", { enumerable: true, get: function () { return networks_1.getNetwork; } });
// Utils
var NonceManager_1 = require("./utils/NonceManager");
Object.defineProperty(exports, "InMemoryNonceManager", { enumerable: true, get: function () { return NonceManager_1.InMemoryNonceManager; } });
var ReceivedNonceTracker_1 = require("./utils/ReceivedNonceTracker");
Object.defineProperty(exports, "InMemoryReceivedNonceTracker", { enumerable: true, get: function () { return ReceivedNonceTracker_1.InMemoryReceivedNonceTracker; } });
var SecureNonce_1 = require("./utils/SecureNonce");
Object.defineProperty(exports, "generateSecureNonce", { enumerable: true, get: function () { return SecureNonce_1.generateSecureNonce; } });
Object.defineProperty(exports, "isValidNonce", { enumerable: true, get: function () { return SecureNonce_1.isValidNonce; } });
Object.defineProperty(exports, "generateSecureNonces", { enumerable: true, get: function () { return SecureNonce_1.generateSecureNonces; } });
//# sourceMappingURL=index.js.map