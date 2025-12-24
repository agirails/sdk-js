import { State } from '../types';

/**
 * Base ACTP Error
 */
export class ACTPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly txHash?: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'ACTPError';
    // Ensure `instanceof` works for subclasses (TS + Error inheritance quirk)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Transaction Errors
 */
export class InsufficientFundsError extends ACTPError {
  constructor(required: bigint, available: bigint) {
    super(
      `Insufficient funds: need ${required.toString()} wei, have ${available.toString()} wei`,
      'INSUFFICIENT_FUNDS',
      undefined,
      { required: required.toString(), available: available.toString() }
    );
    this.name = 'InsufficientFundsError';
  }
}

export class TransactionNotFoundError extends ACTPError {
  constructor(txId: string) {
    super(`Transaction ${txId} not found`, 'TRANSACTION_NOT_FOUND', undefined, { txId });
    this.name = 'TransactionNotFoundError';
  }
}

export class DeadlineExpiredError extends ACTPError {
  constructor(txId: string, deadline: number) {
    super(
      `Transaction ${txId} deadline expired at ${new Date(deadline * 1000).toISOString()}`,
      'DEADLINE_EXPIRED',
      undefined,
      { txId, deadline }
    );
    this.name = 'DeadlineExpiredError';
  }
}

/**
 * State Machine Errors
 */
export class InvalidStateTransitionError extends ACTPError {
  constructor(from: State, to: State, validTransitions: string[]) {
    super(
      `Invalid state transition: ${State[from]} → ${State[to]}. ` +
        `Valid transitions: ${validTransitions.join(', ') || 'none (terminal state)'}`,
      'INVALID_STATE_TRANSITION',
      undefined,
      { from: State[from], to: State[to], validTransitions }
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Signature Errors
 */
export class SignatureVerificationError extends ACTPError {
  constructor(expectedSigner: string, recoveredSigner: string) {
    super(
      `Signature verification failed. Expected ${expectedSigner}, got ${recoveredSigner}`,
      'SIGNATURE_VERIFICATION_FAILED',
      undefined,
      { expectedSigner, recoveredSigner }
    );
    this.name = 'SignatureVerificationError';
  }
}

/**
 * Blockchain Errors
 */
export class TransactionRevertedError extends ACTPError {
  constructor(txHash: string, reason?: string) {
    super(
      `Transaction reverted: ${reason || 'Unknown reason'}`,
      'TRANSACTION_REVERTED',
      txHash,
      { reason }
    );
    this.name = 'TransactionRevertedError';
  }
}

export class NetworkError extends ACTPError {
  constructor(network: string, message: string) {
    super(`Network error on ${network}: ${message}`, 'NETWORK_ERROR', undefined, { network });
    this.name = 'NetworkError';
  }
}

/**
 * Validation Errors
 */
export class ValidationError extends ACTPError {
  constructor(field: string, message: string) {
    super(`Validation error for ${field}: ${message}`, 'VALIDATION_ERROR', undefined, { field });
    this.name = 'ValidationError';
  }
}

export class InvalidAddressError extends ValidationError {
  constructor(address: string) {
    super('address', `Invalid Ethereum address: ${address}`);
    this.name = 'InvalidAddressError';
  }
}

export class InvalidAmountError extends ValidationError {
  constructor(amount: string) {
    super('amount', `Invalid amount: ${amount} (must be > 0)`);
    this.name = 'InvalidAmountError';
  }
}

/**
 * Storage Errors (AIP-7)
 */
export class StorageError extends ACTPError {
  constructor(operation: string, message: string, details?: any) {
    super(
      `Storage operation failed (${operation}): ${message}`,
      'STORAGE_ERROR',
      undefined,
      { operation, ...details }
    );
    this.name = 'StorageError';
  }
}

export class InvalidCIDError extends ValidationError {
  constructor(cid: string, reason?: string) {
    super('cid', `Invalid IPFS CID: ${cid}${reason ? ` (${reason})` : ''}`);
    this.name = 'InvalidCIDError';
  }
}

export class UploadTimeoutError extends StorageError {
  constructor(timeoutMs: number) {
    super('upload', `Upload timed out after ${timeoutMs}ms`, { timeoutMs });
    this.name = 'UploadTimeoutError';
  }
}

export class DownloadTimeoutError extends StorageError {
  constructor(cid: string, timeoutMs: number) {
    super('download', `Download of ${cid} timed out after ${timeoutMs}ms`, { cid, timeoutMs });
    this.name = 'DownloadTimeoutError';
  }
}

export class FileSizeLimitExceededError extends StorageError {
  constructor(size: number, maxSize: number) {
    super(
      'upload',
      `File size ${size} bytes exceeds maximum ${maxSize} bytes`,
      { size, maxSize }
    );
    this.name = 'FileSizeLimitExceededError';
  }
}

export class StorageAuthenticationError extends StorageError {
  constructor(provider: string) {
    super('authentication', `Authentication failed for ${provider}`, { provider });
    this.name = 'StorageAuthenticationError';
  }
}

export class StorageRateLimitError extends StorageError {
  constructor(retryAfter?: number) {
    super(
      'rate-limit',
      `Rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      { retryAfter }
    );
    this.name = 'StorageRateLimitError';
  }
}

export class ContentNotFoundError extends StorageError {
  constructor(cid: string) {
    super('download', `Content not found for CID: ${cid}`, { cid });
    this.name = 'ContentNotFoundError';
  }
}

export class ArweaveUploadError extends StorageError {
  constructor(message: string, details?: any) {
    super('upload', `Arweave upload failed: ${message}`, details);
    this.name = 'ArweaveUploadError';
  }
}

export class ArweaveDownloadError extends StorageError {
  constructor(txId: string, message: string) {
    super('download', `Failed to download from Arweave (${txId}): ${message}`, { txId });
    this.name = 'ArweaveDownloadError';
  }
}

export class InsufficientBalanceError extends StorageError {
  constructor(required: string, available: string, currency: string) {
    super(
      'funding',
      `Insufficient Irys balance: need ${required} ${currency}, have ${available} ${currency}`,
      { required, available, currency }
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class ArweaveTimeoutError extends StorageError {
  constructor(operation: string, timeoutMs: number) {
    super('timeout', `Arweave ${operation} timed out after ${timeoutMs}ms`, { operation, timeoutMs });
    this.name = 'ArweaveTimeoutError';
  }
}

export class InvalidArweaveTxIdError extends ValidationError {
  constructor(txId: string, reason?: string) {
    super('txId', `Invalid Arweave transaction ID: ${txId}${reason ? ` (${reason})` : ''}`);
    this.name = 'InvalidArweaveTxIdError';
  }
}

export class SwapExecutionError extends StorageError {
  constructor(message: string, details?: any) {
    super('swap', `Swap execution failed: ${message}`, details);
    this.name = 'SwapExecutionError';
  }
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
export class QueryCapExceededError extends ACTPError {
  constructor(registrySize: number, maxQueryAgents: number = 1000) {
    super(
      `Registry size (${registrySize}) exceeds query cap (${maxQueryAgents}). ` +
        `On-chain queries are disabled to prevent DoS. Use an off-chain indexer instead.`,
      'QUERY_CAP_EXCEEDED',
      undefined,
      {
        registrySize,
        maxQueryAgents,
        solution: 'Migrate to off-chain indexer (The Graph, Goldsky, or Alchemy Subgraphs)'
      }
    );
    this.name = 'QueryCapExceededError';
  }
}

/**
 * Agent/Job Errors (Basic & Standard API)
 */

/**
 * No provider found for the requested service
 *
 * Thrown when request() cannot find any provider offering the service.
 */
export class NoProviderFoundError extends ACTPError {
  constructor(service: string, details?: any) {
    super(
      `No provider found for service "${service}". ` +
        `Ensure at least one agent is providing this service.`,
      'NO_PROVIDER_FOUND',
      undefined,
      { service, ...details }
    );
    this.name = 'NoProviderFoundError';
  }
}

/**
 * Request timeout error
 *
 * Thrown when provider doesn't respond within the timeout period.
 */
export class TimeoutError extends ACTPError {
  constructor(timeoutMs: number, operation?: string) {
    super(
      `Operation timed out after ${timeoutMs}ms${operation ? ` (${operation})` : ''}`,
      'TIMEOUT',
      undefined,
      { timeoutMs, operation }
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Provider rejected the job
 *
 * Thrown when provider explicitly rejects a job (e.g., budget too low).
 */
export class ProviderRejectedError extends ACTPError {
  constructor(provider: string, reason?: string, details?: any) {
    super(
      `Provider ${provider} rejected the job${reason ? `: ${reason}` : ''}`,
      'PROVIDER_REJECTED',
      undefined,
      { provider, reason, ...details }
    );
    this.name = 'ProviderRejectedError';
  }
}

/**
 * Provider failed to deliver result
 *
 * Thrown when provider transitions to DELIVERED but doesn't provide valid result.
 */
export class DeliveryFailedError extends ACTPError {
  constructor(txId: string, reason?: string) {
    super(
      `Delivery failed for transaction ${txId}${reason ? `: ${reason}` : ''}`,
      'DELIVERY_FAILED',
      undefined,
      { txId, reason }
    );
    this.name = 'DeliveryFailedError';
  }
}

/**
 * Dispute raised on transaction
 *
 * Thrown when requester raises a dispute on a delivered result.
 */
export class DisputeRaisedError extends ACTPError {
  constructor(txId: string, reason?: string) {
    super(
      `Dispute raised for transaction ${txId}${reason ? `: ${reason}` : ''}`,
      'DISPUTE_RAISED',
      undefined,
      { txId, reason }
    );
    this.name = 'DisputeRaisedError';
  }
}

/**
 * Service configuration error
 *
 * Thrown when Agent.provide() is called with invalid service configuration.
 */
export class ServiceConfigError extends ACTPError {
  constructor(field: string, message: string, details?: any) {
    super(
      `Service configuration error (${field}): ${message}`,
      'SERVICE_CONFIG_ERROR',
      undefined,
      { field, ...details }
    );
    this.name = 'ServiceConfigError';
  }
}

/**
 * Agent lifecycle error
 *
 * Thrown when invalid agent lifecycle operations are attempted
 * (e.g., calling start() on already running agent).
 */
export class AgentLifecycleError extends ACTPError {
  constructor(currentState: string, attemptedAction: string) {
    super(
      `Cannot ${attemptedAction} agent in ${currentState} state`,
      'AGENT_LIFECYCLE_ERROR',
      undefined,
      { currentState, attemptedAction }
    );
    this.name = 'AgentLifecycleError';
  }
}

