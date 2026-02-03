/**
 * BasicAdapter - High-level, opinionated API for simple use cases
 *
 * Provides the simplest possible interface for creating and checking transactions.
 * Designed for developers who want to "just make it work" without deep protocol knowledge.
 *
 * Key Features:
 * - Smart defaults (24h deadline, 2-day dispute window)
 * - Inferred requester (from constructor)
 * - User-friendly input (strings, no BigInt)
 * - User-friendly output (formatted amounts, ISO dates)
 *
 * @module adapters/BasicAdapter
 */

import { BaseAdapter, ValidationError } from './BaseAdapter';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { EASHelper } from '../protocol/EASHelper';

/**
 * Parameters for creating a simple payment.
 *
 * This is the most user-friendly interface - minimal required fields.
 */
export interface BasicPayParams {
  /** Recipient address (provider) */
  to: string;

  /** Amount in user-friendly format ("100", "100.50", "100 USDC", "$100") */
  amount: string | number;

  /** Optional: Deadline as relative time ("+24h") or Unix timestamp. Defaults to +24h */
  deadline?: string | number;

  /** Optional: Dispute window in seconds. Defaults to 172800 (2 days) */
  disputeWindow?: number;
}

/**
 * Result of creating a payment.
 *
 * Provides user-friendly formatted data (not raw protocol types).
 */
export interface BasicPayResult {
  /** Transaction ID (bytes32 hex string) */
  txId: string;

  /** Provider address */
  provider: string;

  /** Requester address (caller) */
  requester: string;

  /** Amount in USDC (human-readable, e.g., "100.00 USDC") */
  amount: string;

  /** Deadline as ISO 8601 timestamp */
  deadline: string;

  /** Transaction state */
  state: string;
}

/**
 * BasicAdapter - High-level API for simple payment flows.
 *
 * This adapter provides the simplest possible interface:
 * - `pay()` - Create and fund a transaction in one call
 * - `checkStatus()` - Get transaction status with action hints
 *
 * All complexity is hidden behind smart defaults.
 *
 * @example
 * ```typescript
 * const client = await ACTPClient.create({ mode: 'mock' });
 *
 * // Simple payment (all defaults)
 * const result = await client.basic.pay({
 *   to: '0xProvider123',
 *   amount: '100',
 * });
 * console.log('Transaction ID:', result.txId);
 * console.log('Amount:', result.amount); // "100.00 USDC"
 *
 * // Check status
 * const status = await client.basic.checkStatus(result.txId);
 * if (status.canAccept) {
 *   console.log('Provider can accept this transaction');
 * }
 * ```
 */
export class BasicAdapter extends BaseAdapter {
  /**
   * Creates a new BasicAdapter instance.
   *
   * @param runtime - ACTP runtime implementation (MockRuntime or BlockchainRuntime)
   * @param requesterAddress - The requester's Ethereum address
   * @param easHelper - Optional EAS helper for attestation verification (SECURITY FIX C-4)
   */
  constructor(
    private runtime: IACTPRuntime,
    requesterAddress: string,
    private easHelper?: EASHelper
  ) {
    super(requesterAddress);
  }

  /**
   * Create a payment transaction with smart defaults.
   *
   * This is the simplest way to create a transaction - just specify
   * recipient and amount. All other parameters use sensible defaults.
   *
   * Smart defaults:
   * - Requester: Inferred from constructor
   * - Deadline: 24 hours from now
   * - Dispute window: 2 days (172800 seconds)
   *
   * Validations performed:
   * - Address format (0x-prefixed hex)
   * - Amount format (positive number)
   * - Deadline in future
   * - Cannot pay yourself
   *
   * @param params - Payment parameters
   * @returns User-friendly payment result
   * @throws {ValidationError} If inputs are invalid
   *
   * @example
   * ```typescript
   * const result = await adapter.pay({
   *   to: '0xProvider123',
   *   amount: '100.50',
   *   deadline: '+7d', // Optional: 7 days from now
   * });
   * ```
   */
  async pay(params: BasicPayParams): Promise<BasicPayResult> {
    // Validate and parse inputs
    const provider = this.validateAddress(params.to, 'to');
    const amount = this.parseAmount(params.amount);
    const currentTime = this.runtime.time.now();
    const deadline = this.parseDeadline(params.deadline, currentTime);
    // SECURITY FIX (L-1): Validate dispute window bounds
    const disputeWindow = this.validateDisputeWindow(params.disputeWindow);

    const requester = this.requesterAddress;

    // Additional validations
    if (requester.toLowerCase() === provider.toLowerCase()) {
      throw new ValidationError('Cannot pay yourself (requester equals provider)');
    }

    if (deadline <= currentTime) {
      throw new ValidationError('Deadline must be in the future');
    }

    // SECURITY: Enforce transaction amount limit on unaudited mainnet contracts
    const maxAmount = this.runtime.maxTransactionAmount;
    const amountInUsdc = Number(amount) / 1_000_000; // Convert from wei to USDC
    if (maxAmount !== undefined && amountInUsdc > maxAmount) {
      throw new ValidationError(
        `Transaction amount $${amountInUsdc.toFixed(2)} exceeds maximum allowed $${maxAmount}. ` +
        `This limit exists because contracts have not been formally audited. ` +
        `For larger amounts, please contact support@agirails.io.`
      );
    }

    // Create transaction
    const txId = await this.runtime.createTransaction({
      provider,
      requester,
      amount: amount.toString(),
      deadline,
      disputeWindow,
    });

    // Link escrow (auto-transitions to COMMITTED)
    await this.runtime.linkEscrow(txId, amount.toString());

    // Fetch transaction details for user-friendly response
    const tx = await this.runtime.getTransaction(txId);

    if (!tx) {
      throw new Error(`Transaction ${txId} not found after creation`);
    }

    return {
      txId,
      provider,
      requester,
      amount: this.formatAmount(amount),
      deadline: new Date(deadline * 1000).toISOString(),
      state: tx.state,
    };
  }

  /**
   * Check payment status by transaction ID.
   *
   * Returns current state plus action hints (what can be done next).
   *
   * Action hints:
   * - `canAccept`: Provider can accept (INITIATED state, before deadline)
   * - `canComplete`: Provider can mark as delivered (COMMITTED state)
   * - `canDispute`: Requester can dispute (DELIVERED state, within dispute window)
   *
   * @param txId - Transaction ID to check
   * @returns Status with action hints
   * @throws {Error} If transaction not found
   *
   * @example
   * ```typescript
   * const status = await adapter.checkStatus(txId);
   * console.log('State:', status.state); // "COMMITTED"
   * if (status.canComplete) {
   *   // Provider can deliver now
   * }
   * ```
   */
  async checkStatus(txId: string): Promise<{
    state: string;
    canAccept: boolean;
    canComplete: boolean;
    canDispute: boolean;
  }> {
    const tx = await this.runtime.getTransaction(txId);

    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    const now = this.runtime.time.now();

    return {
      state: tx.state,
      canAccept: tx.state === 'INITIATED' && tx.deadline > now,
      canComplete: tx.state === 'COMMITTED' || tx.state === 'IN_PROGRESS',
      canDispute: tx.state === 'DELIVERED' && tx.completedAt !== null && tx.completedAt + tx.disputeWindow > now,
    };
  }
}
