/**
 * BeginnerAdapter - High-level, opinionated API for simple use cases
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
 * @module adapters/BeginnerAdapter
 */
import { BaseAdapter } from './BaseAdapter';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { EASHelper } from '../protocol/EASHelper';
/**
 * Parameters for creating a simple payment.
 *
 * This is the most beginner-friendly interface - minimal required fields.
 */
export interface BeginnerPayParams {
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
export interface BeginnerPayResult {
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
 * BeginnerAdapter - High-level API for simple payment flows.
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
 * const result = await client.beginner.pay({
 *   to: '0xProvider123',
 *   amount: '100',
 * });
 * console.log('Transaction ID:', result.txId);
 * console.log('Amount:', result.amount); // "100.00 USDC"
 *
 * // Check status
 * const status = await client.beginner.checkStatus(result.txId);
 * if (status.canAccept) {
 *   console.log('Provider can accept this transaction');
 * }
 * ```
 */
export declare class BeginnerAdapter extends BaseAdapter {
    private runtime;
    private easHelper?;
    /**
     * Creates a new BeginnerAdapter instance.
     *
     * @param runtime - ACTP runtime implementation (MockRuntime or BlockchainRuntime)
     * @param requesterAddress - The requester's Ethereum address
     * @param easHelper - Optional EAS helper for attestation verification (SECURITY FIX C-4)
     */
    constructor(runtime: IACTPRuntime, requesterAddress: string, easHelper?: EASHelper | undefined);
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
    pay(params: BeginnerPayParams): Promise<BeginnerPayResult>;
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
    checkStatus(txId: string): Promise<{
        state: string;
        canAccept: boolean;
        canComplete: boolean;
        canDispute: boolean;
    }>;
}
//# sourceMappingURL=BeginnerAdapter.d.ts.map