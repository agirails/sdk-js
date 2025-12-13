"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryCapExceededError = exports.SwapExecutionError = exports.InvalidArweaveTxIdError = exports.ArweaveTimeoutError = exports.InsufficientBalanceError = exports.ArweaveDownloadError = exports.ArweaveUploadError = exports.ContentNotFoundError = exports.StorageRateLimitError = exports.StorageAuthenticationError = exports.FileSizeLimitExceededError = exports.DownloadTimeoutError = exports.UploadTimeoutError = exports.InvalidCIDError = exports.StorageError = exports.InvalidAmountError = exports.InvalidAddressError = exports.ValidationError = exports.NetworkError = exports.TransactionRevertedError = exports.SignatureVerificationError = exports.InvalidStateTransitionError = exports.DeadlineExpiredError = exports.TransactionNotFoundError = exports.InsufficientFundsError = exports.ACTPError = void 0;
const types_1 = require("../types");
/**
 * Base ACTP Error
 */
class ACTPError extends Error {
    constructor(message, code, txHash, details) {
        super(message);
        this.code = code;
        this.txHash = txHash;
        this.details = details;
        this.name = 'ACTPError';
        Object.setPrototypeOf(this, ACTPError.prototype);
    }
}
exports.ACTPError = ACTPError;
/**
 * Transaction Errors
 */
class InsufficientFundsError extends ACTPError {
    constructor(required, available) {
        super(`Insufficient funds: need ${required.toString()} wei, have ${available.toString()} wei`, 'INSUFFICIENT_FUNDS', undefined, { required: required.toString(), available: available.toString() });
        this.name = 'InsufficientFundsError';
    }
}
exports.InsufficientFundsError = InsufficientFundsError;
class TransactionNotFoundError extends ACTPError {
    constructor(txId) {
        super(`Transaction ${txId} not found`, 'TRANSACTION_NOT_FOUND', undefined, { txId });
        this.name = 'TransactionNotFoundError';
    }
}
exports.TransactionNotFoundError = TransactionNotFoundError;
class DeadlineExpiredError extends ACTPError {
    constructor(txId, deadline) {
        super(`Transaction ${txId} deadline expired at ${new Date(deadline * 1000).toISOString()}`, 'DEADLINE_EXPIRED', undefined, { txId, deadline });
        this.name = 'DeadlineExpiredError';
    }
}
exports.DeadlineExpiredError = DeadlineExpiredError;
/**
 * State Machine Errors
 */
class InvalidStateTransitionError extends ACTPError {
    constructor(from, to, validTransitions) {
        super(`Invalid state transition: ${types_1.State[from]} → ${types_1.State[to]}. ` +
            `Valid transitions: ${validTransitions.join(', ') || 'none (terminal state)'}`, 'INVALID_STATE_TRANSITION', undefined, { from: types_1.State[from], to: types_1.State[to], validTransitions });
        this.name = 'InvalidStateTransitionError';
    }
}
exports.InvalidStateTransitionError = InvalidStateTransitionError;
/**
 * Signature Errors
 */
class SignatureVerificationError extends ACTPError {
    constructor(expectedSigner, recoveredSigner) {
        super(`Signature verification failed. Expected ${expectedSigner}, got ${recoveredSigner}`, 'SIGNATURE_VERIFICATION_FAILED', undefined, { expectedSigner, recoveredSigner });
        this.name = 'SignatureVerificationError';
    }
}
exports.SignatureVerificationError = SignatureVerificationError;
/**
 * Blockchain Errors
 */
class TransactionRevertedError extends ACTPError {
    constructor(txHash, reason) {
        super(`Transaction reverted: ${reason || 'Unknown reason'}`, 'TRANSACTION_REVERTED', txHash, { reason });
        this.name = 'TransactionRevertedError';
    }
}
exports.TransactionRevertedError = TransactionRevertedError;
class NetworkError extends ACTPError {
    constructor(network, message) {
        super(`Network error on ${network}: ${message}`, 'NETWORK_ERROR', undefined, { network });
        this.name = 'NetworkError';
    }
}
exports.NetworkError = NetworkError;
/**
 * Validation Errors
 */
class ValidationError extends ACTPError {
    constructor(field, message) {
        super(`Validation error for ${field}: ${message}`, 'VALIDATION_ERROR', undefined, { field });
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
class InvalidAddressError extends ValidationError {
    constructor(address) {
        super('address', `Invalid Ethereum address: ${address}`);
        this.name = 'InvalidAddressError';
    }
}
exports.InvalidAddressError = InvalidAddressError;
class InvalidAmountError extends ValidationError {
    constructor(amount) {
        super('amount', `Invalid amount: ${amount} (must be > 0)`);
        this.name = 'InvalidAmountError';
    }
}
exports.InvalidAmountError = InvalidAmountError;
/**
 * Storage Errors (AIP-7)
 */
class StorageError extends ACTPError {
    constructor(operation, message, details) {
        super(`Storage operation failed (${operation}): ${message}`, 'STORAGE_ERROR', undefined, { operation, ...details });
        this.name = 'StorageError';
    }
}
exports.StorageError = StorageError;
class InvalidCIDError extends ValidationError {
    constructor(cid, reason) {
        super('cid', `Invalid IPFS CID: ${cid}${reason ? ` (${reason})` : ''}`);
        this.name = 'InvalidCIDError';
    }
}
exports.InvalidCIDError = InvalidCIDError;
class UploadTimeoutError extends StorageError {
    constructor(timeoutMs) {
        super('upload', `Upload timed out after ${timeoutMs}ms`, { timeoutMs });
        this.name = 'UploadTimeoutError';
    }
}
exports.UploadTimeoutError = UploadTimeoutError;
class DownloadTimeoutError extends StorageError {
    constructor(cid, timeoutMs) {
        super('download', `Download of ${cid} timed out after ${timeoutMs}ms`, { cid, timeoutMs });
        this.name = 'DownloadTimeoutError';
    }
}
exports.DownloadTimeoutError = DownloadTimeoutError;
class FileSizeLimitExceededError extends StorageError {
    constructor(size, maxSize) {
        super('upload', `File size ${size} bytes exceeds maximum ${maxSize} bytes`, { size, maxSize });
        this.name = 'FileSizeLimitExceededError';
    }
}
exports.FileSizeLimitExceededError = FileSizeLimitExceededError;
class StorageAuthenticationError extends StorageError {
    constructor(provider) {
        super('authentication', `Authentication failed for ${provider}`, { provider });
        this.name = 'StorageAuthenticationError';
    }
}
exports.StorageAuthenticationError = StorageAuthenticationError;
class StorageRateLimitError extends StorageError {
    constructor(retryAfter) {
        super('rate-limit', `Rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ''}`, { retryAfter });
        this.name = 'StorageRateLimitError';
    }
}
exports.StorageRateLimitError = StorageRateLimitError;
class ContentNotFoundError extends StorageError {
    constructor(cid) {
        super('download', `Content not found for CID: ${cid}`, { cid });
        this.name = 'ContentNotFoundError';
    }
}
exports.ContentNotFoundError = ContentNotFoundError;
class ArweaveUploadError extends StorageError {
    constructor(message, details) {
        super('upload', `Arweave upload failed: ${message}`, details);
        this.name = 'ArweaveUploadError';
    }
}
exports.ArweaveUploadError = ArweaveUploadError;
class ArweaveDownloadError extends StorageError {
    constructor(txId, message) {
        super('download', `Failed to download from Arweave (${txId}): ${message}`, { txId });
        this.name = 'ArweaveDownloadError';
    }
}
exports.ArweaveDownloadError = ArweaveDownloadError;
class InsufficientBalanceError extends StorageError {
    constructor(required, available, currency) {
        super('funding', `Insufficient Irys balance: need ${required} ${currency}, have ${available} ${currency}`, { required, available, currency });
        this.name = 'InsufficientBalanceError';
    }
}
exports.InsufficientBalanceError = InsufficientBalanceError;
class ArweaveTimeoutError extends StorageError {
    constructor(operation, timeoutMs) {
        super('timeout', `Arweave ${operation} timed out after ${timeoutMs}ms`, { operation, timeoutMs });
        this.name = 'ArweaveTimeoutError';
    }
}
exports.ArweaveTimeoutError = ArweaveTimeoutError;
class InvalidArweaveTxIdError extends ValidationError {
    constructor(txId, reason) {
        super('txId', `Invalid Arweave transaction ID: ${txId}${reason ? ` (${reason})` : ''}`);
        this.name = 'InvalidArweaveTxIdError';
    }
}
exports.InvalidArweaveTxIdError = InvalidArweaveTxIdError;
class SwapExecutionError extends StorageError {
    constructor(message, details) {
        super('swap', `Swap execution failed: ${message}`, details);
        this.name = 'SwapExecutionError';
    }
}
exports.SwapExecutionError = SwapExecutionError;
/**
 * Registry Query Cap Exceeded Error (L-4)
 *
 * Thrown when AgentRegistry.queryAgentsByService() cannot complete because
 * the registry contains more than MAX_QUERY_AGENTS (1000) agents.
 *
 * ## Resolution
 *
 * When this error is thrown, you must migrate to an off-chain indexer:
 *
 * 1. **The Graph**: Deploy a subgraph indexing AgentRegistered events
 *    - https://thegraph.com/docs/en/developing/creating-a-subgraph/
 *
 * 2. **Goldsky**: Mirror-based indexing (faster deployment)
 *    - https://docs.goldsky.com/
 *
 * 3. **Alchemy Subgraphs**: Managed Graph service
 *    - https://docs.alchemy.com/docs/subgraphs-overview
 *
 * ## Events to Index
 *
 * - `AgentRegistered(address indexed agent, string did, string endpoint, uint256 timestamp)`
 * - `ServiceTypeUpdated(address indexed agent, bytes32 serviceTypeHash, bool added, uint256 timestamp)`
 * - `ActiveStatusUpdated(address indexed agent, bool isActive, uint256 timestamp)`
 *
 * @example
 * ```typescript
 * try {
 *   const agents = await registry.queryAgentsByService({ ... });
 * } catch (error) {
 *   if (error instanceof QueryCapExceededError) {
 *     // Switch to off-chain indexer
 *     const agents = await myIndexer.queryAgents({ ... });
 *   }
 * }
 * ```
 */
class QueryCapExceededError extends ACTPError {
    constructor(registrySize, maxQueryAgents = 1000) {
        super(`Registry size (${registrySize}) exceeds query cap (${maxQueryAgents}). ` +
            `On-chain queries are disabled to prevent DoS. Use an off-chain indexer instead.`, 'QUERY_CAP_EXCEEDED', undefined, {
            registrySize,
            maxQueryAgents,
            solution: 'Migrate to off-chain indexer (The Graph, Goldsky, or Alchemy Subgraphs)'
        });
        this.name = 'QueryCapExceededError';
    }
}
exports.QueryCapExceededError = QueryCapExceededError;
//# sourceMappingURL=index.js.map