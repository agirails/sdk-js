import { State } from '../types';
/**
 * Base ACTP Error
 */
export declare class ACTPError extends Error {
    readonly code: string;
    readonly txHash?: string | undefined;
    readonly details?: any | undefined;
    constructor(message: string, code: string, txHash?: string | undefined, details?: any | undefined);
}
/**
 * Transaction Errors
 */
export declare class InsufficientFundsError extends ACTPError {
    constructor(required: bigint, available: bigint);
}
export declare class TransactionNotFoundError extends ACTPError {
    constructor(txId: string);
}
export declare class DeadlineExpiredError extends ACTPError {
    constructor(txId: string, deadline: number);
}
/**
 * State Machine Errors
 */
export declare class InvalidStateTransitionError extends ACTPError {
    constructor(from: State, to: State, validTransitions: string[]);
}
/**
 * Signature Errors
 */
export declare class SignatureVerificationError extends ACTPError {
    constructor(expectedSigner: string, recoveredSigner: string);
}
/**
 * Blockchain Errors
 */
export declare class TransactionRevertedError extends ACTPError {
    constructor(txHash: string, reason?: string);
}
export declare class NetworkError extends ACTPError {
    constructor(network: string, message: string);
}
/**
 * Validation Errors
 */
export declare class ValidationError extends ACTPError {
    constructor(field: string, message: string);
}
export declare class InvalidAddressError extends ValidationError {
    constructor(address: string);
}
export declare class InvalidAmountError extends ValidationError {
    constructor(amount: string);
}
/**
 * Storage Errors (AIP-7)
 */
export declare class StorageError extends ACTPError {
    constructor(operation: string, message: string, details?: any);
}
export declare class InvalidCIDError extends ValidationError {
    constructor(cid: string, reason?: string);
}
export declare class UploadTimeoutError extends StorageError {
    constructor(timeoutMs: number);
}
export declare class DownloadTimeoutError extends StorageError {
    constructor(cid: string, timeoutMs: number);
}
export declare class FileSizeLimitExceededError extends StorageError {
    constructor(size: number, maxSize: number);
}
export declare class StorageAuthenticationError extends StorageError {
    constructor(provider: string);
}
export declare class StorageRateLimitError extends StorageError {
    constructor(retryAfter?: number);
}
export declare class ContentNotFoundError extends StorageError {
    constructor(cid: string);
}
export declare class ArweaveUploadError extends StorageError {
    constructor(message: string, details?: any);
}
export declare class ArweaveDownloadError extends StorageError {
    constructor(txId: string, message: string);
}
export declare class InsufficientBalanceError extends StorageError {
    constructor(required: string, available: string, currency: string);
}
export declare class ArweaveTimeoutError extends StorageError {
    constructor(operation: string, timeoutMs: number);
}
export declare class InvalidArweaveTxIdError extends ValidationError {
    constructor(txId: string, reason?: string);
}
export declare class SwapExecutionError extends StorageError {
    constructor(message: string, details?: any);
}
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
export declare class QueryCapExceededError extends ACTPError {
    constructor(registrySize: number, maxQueryAgents?: number);
}
//# sourceMappingURL=index.d.ts.map