/**
 * IAdapter - Common interface for all payment adapters.
 *
 * This interface defines the contract that all payment adapters must implement,
 * enabling the AdapterRouter to select and use any adapter interchangeably.
 *
 * CRITICAL ACTP COMPLIANCE:
 * - pay() creates transaction + locks escrow -> state = COMMITTED
 * - Caller must transition to IN_PROGRESS before work
 * - Caller must transition to DELIVERED with proof after work
 * - Caller must call release() to settle (NO auto-settle)
 *
 * @module adapters/IAdapter
 */

import {
  AdapterMetadata,
  UnifiedPayParams,
  UnifiedPayResult,
} from '../types/adapter';

// ============================================================================
// TransactionStatus - Adapter-agnostic status
// ============================================================================

/**
 * Valid transaction states across all adapters.
 */
export type AdapterTransactionState =
  | 'INITIATED'
  | 'COMMITTED'
  | 'IN_PROGRESS'
  | 'DELIVERED'
  | 'SETTLED'
  | 'DISPUTED'
  | 'CANCELLED';

/**
 * Transaction status returned by getStatus().
 *
 * Provides a consistent view of transaction state across different
 * adapter implementations with action hints for what can be done next.
 */
export interface TransactionStatus {
  /** Current transaction state */
  state: AdapterTransactionState;

  /** Can provider start work? (COMMITTED -> IN_PROGRESS) */
  canStartWork: boolean;

  /** Can provider mark as delivered? (IN_PROGRESS -> DELIVERED) */
  canDeliver: boolean;

  /** Can escrow be released? (DELIVERED + dispute window expired) */
  canRelease: boolean;

  /** Can requester dispute? (DELIVERED, within dispute window) */
  canDispute: boolean;

  /** Transaction amount (formatted string) */
  amount: string;

  /** Deadline as ISO 8601 string (optional) */
  deadline?: string;

  /** Dispute window end as ISO 8601 string (optional) */
  disputeWindowEnds?: string;

  /** Provider address */
  provider: string;

  /** Requester address */
  requester: string;
}

// ============================================================================
// IAdapter Interface
// ============================================================================

/**
 * Common interface for all payment adapters.
 *
 * Implementations include:
 * - BasicAdapter: High-level, opinionated API
 * - StandardAdapter: Balanced control API
 * - X402Adapter: HTTP 402 Payment Required protocol (Phase 1 Step 2)
 * - ERC8004Adapter: Identity-based payments (Phase 1 Step 3)
 *
 * @example
 * ```typescript
 * class CustomAdapter implements IAdapter {
 *   readonly metadata: AdapterMetadata = {
 *     id: 'custom',
 *     name: 'Custom Adapter',
 *     usesEscrow: true,
 *     supportsDisputes: true,
 *     requiresIdentity: false,
 *     settlementMode: 'explicit',
 *     priority: 50,
 *   };
 *
 *   async pay(params: UnifiedPayParams): Promise<UnifiedPayResult> {
 *     // Implementation...
 *   }
 *
 *   canHandle(params: UnifiedPayParams): boolean {
 *     return true; // Can handle all params
 *   }
 *
 *   validate(params: UnifiedPayParams): void {
 *     // Throw if invalid
 *   }
 * }
 * ```
 */
export interface IAdapter {
  /**
   * Adapter metadata describing capabilities.
   *
   * Used by AdapterRouter for selection and by developers
   * to understand adapter behavior.
   */
  readonly metadata: AdapterMetadata;

  /**
   * Execute payment through this adapter.
   *
   * IMPORTANT: Returns with state=COMMITTED, NOT settled.
   * Caller must follow ACTP lifecycle:
   * 1. pay() -> COMMITTED
   * 2. startWork() -> IN_PROGRESS
   * 3. deliver() -> DELIVERED
   * 4. release() -> SETTLED (explicit!)
   *
   * @param params - Unified payment parameters
   * @returns Promise resolving to payment result
   * @throws {ValidationError} If params are invalid
   *
   * @example
   * ```typescript
   * const result = await adapter.pay({
   *   to: '0xProvider...',
   *   amount: '100',
   *   deadline: '+24h',
   * });
   * console.log(result.state); // 'COMMITTED'
   * console.log(result.releaseRequired); // true
   * ```
   */
  pay(params: UnifiedPayParams): Promise<UnifiedPayResult>;

  /**
   * Check if this adapter can handle the given parameters.
   *
   * Used by AdapterRouter to filter adapters that are capable
   * of processing a specific payment request.
   *
   * @param params - Payment parameters to check
   * @returns True if adapter can handle these params
   *
   * @example
   * ```typescript
   * if (adapter.canHandle({ to: 'https://api.example.com', amount: '10' })) {
   *   // This adapter supports HTTP endpoints
   * }
   * ```
   */
  canHandle(params: UnifiedPayParams): boolean;

  /**
   * Validate parameters before execution.
   *
   * Called by AdapterRouter before routing to ensure
   * parameters are valid for this specific adapter.
   *
   * @param params - Parameters to validate
   * @throws {ValidationError} If params are invalid
   *
   * @example
   * ```typescript
   * try {
   *   adapter.validate(params);
   * } catch (error) {
   *   console.error('Invalid params:', error.message);
   * }
   * ```
   */
  validate(params: UnifiedPayParams): void;

  /**
   * Get transaction status by ID.
   *
   * Returns current state plus action hints indicating
   * what operations are available.
   *
   * @param txId - Transaction ID
   * @returns Promise resolving to transaction status
   * @throws {Error} If transaction not found
   *
   * @example
   * ```typescript
   * const status = await adapter.getStatus(txId);
   * if (status.canRelease) {
   *   await adapter.release(escrowId);
   * }
   * ```
   */
  getStatus(txId: string): Promise<TransactionStatus>;

  /**
   * Transition to IN_PROGRESS state (provider starts work).
   *
   * Must be called by provider after accepting the transaction.
   * ACTP requires this explicit transition.
   *
   * @param txId - Transaction ID
   * @throws {Error} If transaction not found or wrong state
   *
   * @example
   * ```typescript
   * // Provider acknowledges and starts work
   * await adapter.startWork(txId);
   * ```
   */
  startWork(txId: string): Promise<void>;

  /**
   * Transition to DELIVERED state (provider completes work).
   *
   * @param txId - Transaction ID
   * @param proof - AIP-14c 64-byte delivery proof: `abi.encode(uint256 window,
   *                bytes32 resultHash)`. The v2 kernel rejects the legacy
   *                32-byte window-only proof.
   * @throws {Error} If transaction not found or wrong state
   *
   * @example
   * ```typescript
   * // Provider marks work as delivered with a 2-hour dispute window
   * const proof = ethers.AbiCoder.defaultAbiCoder()
   *   .encode(['uint256', 'bytes32'], [7200, resultHash]);
   * await adapter.deliver(txId, proof);
   * ```
   */
  deliver(txId: string, proof: string): Promise<void>;

  /**
   * Release escrow funds (EXPLICIT settlement).
   *
   * MUST be called after dispute window expires or requester approves.
   * This is the ONLY way to settle - NO auto-settle.
   *
   * @param escrowId - Escrow ID (usually same as txId)
   * @param attestationUID - Optional attestation UID for verification
   * @throws {Error} If escrow not found or dispute window active
   *
   * @example
   * ```typescript
   * // After dispute window expires
   * await adapter.release(result.escrowId);
   * // Transaction is now SETTLED
   * ```
   */
  release(escrowId: string, attestationUID?: string): Promise<void>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if an object implements IAdapter.
 *
 * @param obj - Object to check
 * @returns True if object implements IAdapter
 */
export function isAdapter(obj: unknown): obj is IAdapter {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const adapter = obj as Partial<IAdapter>;

  return (
    typeof adapter.metadata === 'object' &&
    adapter.metadata !== null &&
    typeof adapter.metadata.id === 'string' &&
    typeof adapter.pay === 'function' &&
    typeof adapter.canHandle === 'function' &&
    typeof adapter.validate === 'function' &&
    typeof adapter.getStatus === 'function' &&
    typeof adapter.startWork === 'function' &&
    typeof adapter.deliver === 'function' &&
    typeof adapter.release === 'function'
  );
}
