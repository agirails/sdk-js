/**
 * BaseAdapter - Abstract base class for all adapter implementations
 *
 * Provides shared utility methods for parsing user-friendly inputs into
 * protocol-level types. All adapters extend this class to ensure consistent
 * behavior across the Three-Level API.
 *
 * Key Responsibilities:
 * - Amount parsing (string → bigint with 6 decimals for USDC)
 * - Address validation (0x-prefixed hex)
 * - Deadline parsing ("+24h" → Unix timestamp)
 * - User-friendly error messages
 *
 * @module adapters/BaseAdapter
 */
/**
 * Default dispute window in seconds (2 days).
 * Used when no dispute window is specified in transaction parameters.
 */
export declare const DEFAULT_DISPUTE_WINDOW_SECONDS = 172800;
/**
 * Minimum dispute window in seconds (1 hour).
 * Ensures requesters have reasonable time to dispute.
 *
 * SECURITY: Prevents providers from setting windows too short
 * to avoid dispute detection.
 */
export declare const MIN_DISPUTE_WINDOW_SECONDS = 3600;
/**
 * Maximum dispute window in seconds (30 days).
 * Prevents excessively long fund locks.
 *
 * SECURITY: Prevents DoS via indefinite fund locking.
 */
export declare const MAX_DISPUTE_WINDOW_SECONDS: number;
/**
 * Default deadline offset in seconds (24 hours).
 * Used when no deadline is specified in transaction parameters.
 */
export declare const DEFAULT_DEADLINE_SECONDS = 86400;
/**
 * Minimum transaction amount in USDC wei (6 decimals).
 * $0.05 minimum per AGIRAILS protocol specification.
 */
export declare const MIN_AMOUNT_WEI = 50000n;
/**
 * Maximum deadline in hours (10 years).
 * Prevents integer overflow in deadline calculations.
 */
export declare const MAX_DEADLINE_HOURS = 87600;
/**
 * Maximum deadline in days (10 years).
 * Prevents integer overflow in deadline calculations.
 */
export declare const MAX_DEADLINE_DAYS = 3650;
/**
 * Custom error for validation failures.
 *
 * Thrown when user input is invalid (e.g., malformed address, negative amount).
 * Provides descriptive error messages for end-user debugging.
 *
 * @example
 * ```typescript
 * throw new ValidationError('Invalid amount format: "abc". Expected number like "100" or "100.50"');
 * ```
 */
export declare class ValidationError extends Error {
    constructor(message: string);
}
/**
 * Abstract base adapter with shared parsing utilities.
 *
 * Provides common functionality for all adapter implementations:
 * - Amount parsing (USDC has 6 decimals)
 * - Address validation
 * - Deadline parsing (relative time or Unix timestamp)
 * - Amount formatting
 *
 * @abstract
 */
export declare abstract class BaseAdapter {
    protected requesterAddress: string;
    /**
     * Creates a new BaseAdapter instance.
     *
     * @param requesterAddress - The requester's Ethereum address
     */
    constructor(requesterAddress: string);
    /**
     * Parse user-friendly amount string to bigint (USDC has 6 decimals).
     *
     * Accepts multiple input formats:
     * - "100" → 100_000_000n (100.00 USDC)
     * - "100.50" → 100_500_000n (100.50 USDC)
     * - "100 USDC" → 100_000_000n (strips currency suffix)
     * - "$100" → 100_000_000n (strips $ prefix)
     * - 100 (number) → 100_000_000n
     *
     * Rejects:
     * - "abc" → throws ValidationError
     * - "" → throws ValidationError
     * - "-100" → throws ValidationError (negative amounts)
     * - "100.1234567" → throws ValidationError (too many decimals)
     *
     * @param amount - Amount as string or number
     * @returns Amount as bigint with 6 decimals
     * @throws {ValidationError} If amount format is invalid
     *
     * @example
     * ```typescript
     * const amount = this.parseAmount("100.50"); // 100_500_000n
     * const amount = this.parseAmount("100 USDC"); // 100_000_000n
     * ```
     */
    protected parseAmount(amount: string | number): bigint;
    /**
     * Validate Ethereum address format.
     *
     * Checks that address:
     * - Is a string
     * - Starts with "0x"
     * - Is exactly 42 characters (0x + 40 hex chars)
     * - Contains only valid hex characters
     *
     * Note: Does not validate checksum (EIP-55) in mock mode.
     *
     * @param address - Address to validate
     * @param paramName - Parameter name for error message
     * @returns Validated address (unchanged)
     * @throws {ValidationError} If address format is invalid
     *
     * @example
     * ```typescript
     * const provider = this.validateAddress(params.to, 'to');
     * ```
     */
    protected validateAddress(address: string, paramName: string): string;
    /**
     * Parse deadline from relative time expression or Unix timestamp.
     *
     * Accepts multiple formats:
     * - undefined → now + 24 hours (default)
     * - 1734076400 (number) → passed through as Unix timestamp
     * - "+1h" → now + 1 hour
     * - "+24h" → now + 24 hours
     * - "+7d" → now + 7 days
     *
     * Rejects:
     * - "invalid" → throws ValidationError
     * - "-24h" → throws ValidationError (negative time)
     *
     * @param deadline - Deadline as relative time string, Unix timestamp, or undefined
     * @param currentTime - Current time in seconds (defaults to Date.now() / 1000)
     * @returns Unix timestamp in seconds
     * @throws {ValidationError} If deadline format is invalid
     *
     * @example
     * ```typescript
     * const deadline = this.parseDeadline("+24h"); // now + 86400
     * const deadline = this.parseDeadline(1734076400); // 1734076400
     * const deadline = this.parseDeadline(); // now + 86400 (default)
     * ```
     */
    protected parseDeadline(deadline?: string | number, currentTime?: number): number;
    /**
     * Validate and normalize dispute window.
     *
     * SECURITY FIX (L-1): Enforces bounds on dispute window:
     * - Minimum: 1 hour (prevents skipping disputes)
     * - Maximum: 30 days (prevents indefinite fund locking)
     *
     * @param disputeWindow - Dispute window in seconds (undefined uses default)
     * @returns Validated dispute window in seconds
     * @throws {ValidationError} If window is outside allowed bounds
     *
     * @example
     * ```typescript
     * this.validateDisputeWindow(3600); // 1 hour - OK
     * this.validateDisputeWindow(86400); // 1 day - OK
     * this.validateDisputeWindow(100); // Too short - throws
     * this.validateDisputeWindow(31 * 86400); // Too long - throws
     * ```
     */
    protected validateDisputeWindow(disputeWindow?: number): number;
    /**
     * Validate bytes32 hex string format.
     *
     * SECURITY FIX (L-2): Validates that a string is a valid bytes32 hex.
     * Used for transaction IDs, escrow IDs, attestation UIDs, etc.
     *
     * @param value - Value to validate
     * @param paramName - Parameter name for error message
     * @returns Validated bytes32 string (normalized to lowercase)
     * @throws {ValidationError} If format is invalid
     *
     * @example
     * ```typescript
     * const txId = this.validateBytes32(id, 'transactionId');
     * ```
     */
    protected validateBytes32(value: string, paramName: string): string;
    /**
     * Validate Unix timestamp is reasonable.
     *
     * SECURITY FIX (L-6): Validates timestamps to prevent overflow/underflow.
     *
     * @param timestamp - Unix timestamp in seconds
     * @param paramName - Parameter name for error message
     * @returns Validated timestamp
     * @throws {ValidationError} If timestamp is invalid
     */
    protected validateTimestamp(timestamp: number, paramName: string): number;
    /**
     * Format bigint amount to human-readable string.
     *
     * Converts USDC wei (6 decimals) to formatted string with 2 decimal places.
     * Uses proper rounding (round half up) for display purposes.
     *
     * @param amount - Amount as bigint (6 decimals) or string
     * @returns Formatted string like "100.00 USDC"
     *
     * @example
     * ```typescript
     * this.formatAmount(100_000_000n); // "100.00 USDC"
     * this.formatAmount(100_500_000n); // "100.50 USDC"
     * this.formatAmount(100_126_000n); // "100.13 USDC" (rounded)
     * ```
     */
    protected formatAmount(amount: bigint | string): string;
}
//# sourceMappingURL=BaseAdapter.d.ts.map