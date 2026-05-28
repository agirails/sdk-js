import { State } from '../types';
import { ACTPError } from './ACTPError';

// Re-export ACTPError at module level so existing consumers keep working.
export { ACTPError };

/**
 * Transaction Errors
 */

/**
 * @cause USDC balance in your Smart Wallet is below the amount the transaction is trying to lock or transfer.
 * @fix Fund the wallet at `agent.address` with the required USDC. Check `agent.balance` before high-budget calls.
 * @recovery user-action
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

/**
 * @cause The provided txId does not match any transaction in the kernel, or you are querying on the wrong network.
 * @fix Verify `network:` matches the chain the transaction was created on. Re-check txId from the original `createTransaction` return value.
 * @recovery must-investigate
 */
export class TransactionNotFoundError extends ACTPError {
  constructor(txId: string) {
    super(`Transaction ${txId} not found`, 'TRANSACTION_NOT_FOUND', undefined, { txId });
    this.name = 'TransactionNotFoundError';
  }
}

/**
 * @cause The transaction's deadline (set at createTransaction, default 600s) has passed without delivery.
 * @fix For new transactions, increase `deadline_seconds`. For an expired one, the requester can transition to CANCELLED. See /recipes/dispute-flow.
 * @recovery must-investigate
 */
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

/**
 * @cause Attempted state transition not allowed by the ACTP state machine from the current state.
 * @fix Call `getTransaction(txId)` to see the actual state. The error message lists valid transitions. Don't cache transaction state locally; the on-chain state is canonical.
 * @recovery must-investigate
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

/**
 * @cause An EIP-712 signed message (quote, counter-offer, receipt) does not recover to the expected signer address.
 * @fix Verify the signer's keystore is loaded and that chainId in your EIP-712 domain matches the network. Cross-SDK byte-identical encoding is a CI invariant; if it fails it is almost always a config drift on your side.
 * @recovery must-investigate
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

/**
 * @cause A kernel call reverted on-chain. Common: state guard violation, address mismatch, or fee param out of bounds.
 * @fix Read the `reason` field on the error. Use `cast call --trace` or the Basescan tx trace to see the revert reason from the kernel.
 * @recovery must-investigate
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

/**
 * @cause RPC failure, transient connectivity issue, or rate limit on the upstream provider.
 * @fix Retry with backoff; most NetworkErrors are transient. If persistent, switch RPC endpoint (`ACTP_RPC_URL`). Verify Base network status at status.base.org.
 * @recovery retry-safe
 */
export class NetworkError extends ACTPError {
  constructor(network: string, message: string) {
    super(`Network error on ${network}: ${message}`, 'NETWORK_ERROR', undefined, { network });
    this.name = 'NetworkError';
  }
}

/**
 * Validation Errors
 */

/**
 * @cause Input failed shape validation (invalid address, malformed CID, amount out of bounds, etc.).
 * @fix Read the error `details` field for the specific failure. Adjust your inputs to match the schema.
 * @recovery user-action
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

/**
 * @cause IPFS/Arweave upload, download, or pin failed. Could be auth, rate limit, or size cap.
 * @fix For uploads, verify storage credentials and file size. For downloads, the CID may be unreachable; verify pinning status with your provider.
 * @recovery retry-safe
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
 *
 * @cause AgentRegistry contains more than MAX_QUERY_AGENTS (1000) agents; on-chain query disabled to prevent DoS.
 * @fix Migrate to an off-chain indexer: The Graph, Goldsky, or Alchemy Subgraphs. Index `AgentRegistered`, `ServiceTypeUpdated`, and `ActiveStatusUpdated` events.
 * @recovery user-action
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
 * No provider found for the requested service.
 *
 * Thrown when request() cannot find any provider offering the service.
 *
 * @cause AgentRegistry returned no providers for the requested service, or all returned providers failed the filter.
 * @fix Verify the service capability tag matches one declared in /reference/agirails-md-v4. Drop the `filter` constraint or widen budget. If you pinned a provider with `provider: '0x…'`, verify the address is registered.
 * @recovery user-action
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
 * Request timeout error.
 *
 * Thrown when provider doesn't respond within the timeout period.
 *
 * @cause Operation exceeded its configured timeout. Most commonly: provider didn't respond, paymaster bundling slow, or RPC sluggish.
 * @fix Increase `timeout` (seconds in Python, ms in TS). If repeatedly timing out, check provider health or chain network state.
 * @recovery retry-safe
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
 * Provider rejected the job.
 *
 * Thrown when provider explicitly rejects a job (e.g., budget too low).
 *
 * @cause Provider refused your job explicitly: typically budget below `min_acceptable_amount` or service filter failed at their end.
 * @fix Negotiate via AIP-2.1 counter-offer or increase budget. See /recipes/quote-negotiation.
 * @recovery user-action
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
 * Provider failed to deliver result.
 *
 * Thrown when provider transitions to DELIVERED but doesn't provide a valid result.
 *
 * @cause Provider's handler threw before submitting the deliverable; the SDK transitioned the tx but no payload was attached.
 * @fix This is a provider-side bug. Requester can transition to DISPUTED. Provider should examine handler logs and ensure the handler returns or throws cleanly.
 * @recovery must-investigate
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
 * Dispute raised on transaction.
 *
 * Thrown when requester raises a dispute on a delivered result.
 *
 * @cause Counterparty raised a dispute on this transaction. Funds remain in escrow pending mediator decision.
 * @fix Not necessarily a bug; it is a protocol path. See /recipes/dispute-flow for evidence submission and resolution. The disputer has posted bond; respond within the dispute window.
 * @recovery must-investigate
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
 * Service configuration error.
 *
 * Thrown when Agent.provide() is called with invalid service configuration.
 *
 * @cause Agent or service config is missing or incorrect. Often: missing network, missing keystore, capability tag not recognized, or pricing fields out of order.
 * @fix Run `actp deploy:check --strict`. Compare your config to the V4 schema at /reference/agirails-md-v4.
 * @recovery user-action
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
 * Agent lifecycle error.
 *
 * Thrown when invalid agent lifecycle operations are attempted
 * (e.g., calling start() on an already-running agent).
 *
 * @cause `start()`, `stop()`, `pause()`, or `resume()` called in a state where it is not allowed (e.g. stop() on a never-started agent).
 * @fix Read `agent.status` before lifecycle transitions. Don't call `start()` twice; the SDK does not idempotent it.
 * @recovery user-action
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

// ============================================================================
// X402 Errors (re-exported from X402Errors.ts)
// ============================================================================
//
// Re-exported AFTER ACTPError definition to avoid circular-import bootstrap
// issue where X402Errors.ts would see ACTPError as undefined.

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
  isPaymasterGateError,
} from './X402Errors';

