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

// ============================================================================
// Constants
// ============================================================================

/**
 * Default dispute window in seconds (2 days).
 * Used when no dispute window is specified in transaction parameters.
 */
export const DEFAULT_DISPUTE_WINDOW_SECONDS = 172800;

/**
 * Minimum dispute window in seconds (1 hour).
 * Ensures requesters have reasonable time to dispute.
 *
 * SECURITY: Prevents providers from setting windows too short
 * to avoid dispute detection.
 */
export const MIN_DISPUTE_WINDOW_SECONDS = 3600; // 1 hour

/**
 * Maximum dispute window in seconds (30 days).
 * Prevents excessively long fund locks.
 *
 * SECURITY: Prevents DoS via indefinite fund locking.
 */
export const MAX_DISPUTE_WINDOW_SECONDS = 30 * 24 * 3600; // 30 days

/**
 * Default deadline offset in seconds (24 hours).
 * Used when no deadline is specified in transaction parameters.
 */
export const DEFAULT_DEADLINE_SECONDS = 86400;

/**
 * Minimum transaction amount in USDC wei (6 decimals).
 * $0.05 minimum per AGIRAILS protocol specification.
 */
export const MIN_AMOUNT_WEI = 50_000n; // $0.05 USDC

/**
 * Maximum deadline in hours (10 years).
 * Prevents integer overflow in deadline calculations.
 */
export const MAX_DEADLINE_HOURS = 87600; // 10 years

/**
 * Maximum deadline in days (10 years).
 * Prevents integer overflow in deadline calculations.
 */
export const MAX_DEADLINE_DAYS = 3650; // 10 years

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
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
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
export abstract class BaseAdapter {
  /**
   * Creates a new BaseAdapter instance.
   *
   * @param requesterAddress - The requester's Ethereum address
   */
  constructor(protected requesterAddress: string) {}

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
  protected parseAmount(amount: string | number): bigint {
    // Issue #3 Fix: Normalize input - handle all Unicode whitespace
    // Converts all Unicode whitespace to regular spaces, then strip currency symbols
    let normalized = String(amount)
      .replace(/[\s\u00A0\u2000-\u200B\uFEFF]/g, ' ') // Replace all Unicode whitespace with regular space
      .replace(/^[\$]/, '') // Strip leading $
      .replace(/\s*(USDC|usdc)$/, '') // Strip trailing USDC
      .replace(/,/g, '') // Strip thousands separators
      .replace(/\s+/g, '') // Remove ALL whitespace (including normalized Unicode spaces)
      .trim(); // Final trim for edge cases

    // Check for negative
    if (normalized.startsWith('-')) {
      throw new ValidationError('Amount cannot be negative');
    }

    // Validate format (integer or decimal with up to 6 decimal places)
    if (!/^\d+(\.\d{1,6})?$/.test(normalized)) {
      throw new ValidationError(
        `Invalid amount format: "${amount}". Expected number like "100" or "100.50"`
      );
    }

    // Parse to bigint with 6 decimals
    try {
      const parts = normalized.split('.');
      const wholePart = parts[0];
      const decimalPart = (parts[1] || '').padEnd(6, '0'); // Pad to 6 decimals

      const wholeAmount = BigInt(wholePart) * 1_000_000n;
      const decimalAmount = BigInt(decimalPart);

      const totalAmount = wholeAmount + decimalAmount;

      // M1 Fix: Enforce minimum amount ($0.05 USDC = 50,000 wei)
      if (totalAmount < MIN_AMOUNT_WEI) {
        throw new ValidationError(
          `Amount too small: "${amount}". Minimum transaction is $0.05 USDC`
        );
      }

      return totalAmount;
    } catch (error) {
      // Re-throw ValidationError as-is
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(
        `Failed to parse amount: "${amount}". Please use format like "100" or "100.50"`
      );
    }
  }

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
  protected validateAddress(address: string, paramName: string): string {
    if (typeof address !== 'string') {
      throw new ValidationError(
        `Invalid ${paramName} address: expected string, got ${typeof address}`
      );
    }

    // Check 0x prefix
    if (!address.startsWith('0x')) {
      throw new ValidationError(
        `Invalid ${paramName} address: "${address}". Expected 0x-prefixed hex string.`
      );
    }

    // Check length (0x + 40 hex chars = 42 total)
    if (address.length !== 42) {
      throw new ValidationError(
        `Invalid ${paramName} address: "${address}". Expected 42 characters (0x + 40 hex).`
      );
    }

    // Check hex format
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new ValidationError(
        `Invalid ${paramName} address: "${address}". Contains invalid hex characters.`
      );
    }

    // Issue #2 Fix: Normalize to lowercase for consistency
    // This prevents case-sensitivity issues when comparing addresses
    return address.toLowerCase();
  }

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
  protected parseDeadline(deadline?: string | number, currentTime?: number): number {
    const now = currentTime ?? Math.floor(Date.now() / 1000);

    if (deadline === undefined) {
      // Default: 24 hours from now
      return now + DEFAULT_DEADLINE_SECONDS;
    }

    if (typeof deadline === 'number') {
      return deadline;
    }

    // Parse relative time
    const match = deadline.match(/^\+(\d+)(h|d)$/);
    if (!match) {
      throw new ValidationError(
        `Invalid deadline format: "${deadline}". Expected Unix timestamp or relative time (e.g., "+24h", "+7d")`
      );
    }

    const [, amountStr, unit] = match;
    const amount = parseInt(amountStr, 10);

    // H1 Fix: Add bounds check to prevent integer overflow
    if (unit === 'h' && amount > MAX_DEADLINE_HOURS) {
      throw new ValidationError(
        `Deadline too far in future: "${deadline}". Maximum is 10 years (${MAX_DEADLINE_HOURS}h)`
      );
    }
    if (unit === 'd' && amount > MAX_DEADLINE_DAYS) {
      throw new ValidationError(
        `Deadline too far in future: "${deadline}". Maximum is 10 years (${MAX_DEADLINE_DAYS}d)`
      );
    }

    const multiplier = unit === 'h' ? 3600 : 86400;

    return now + amount * multiplier;
  }

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
  protected validateDisputeWindow(disputeWindow?: number): number {
    if (disputeWindow === undefined) {
      return DEFAULT_DISPUTE_WINDOW_SECONDS;
    }

    if (disputeWindow < MIN_DISPUTE_WINDOW_SECONDS) {
      throw new ValidationError(
        `Dispute window too short: ${disputeWindow} seconds. ` +
        `Minimum is ${MIN_DISPUTE_WINDOW_SECONDS} seconds (1 hour).`
      );
    }

    if (disputeWindow > MAX_DISPUTE_WINDOW_SECONDS) {
      throw new ValidationError(
        `Dispute window too long: ${disputeWindow} seconds. ` +
        `Maximum is ${MAX_DISPUTE_WINDOW_SECONDS} seconds (30 days).`
      );
    }

    return disputeWindow;
  }

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
  protected validateBytes32(value: string, paramName: string): string {
    if (typeof value !== 'string') {
      throw new ValidationError(
        `Invalid ${paramName}: expected string, got ${typeof value}`
      );
    }

    // Check 0x prefix
    if (!value.startsWith('0x')) {
      throw new ValidationError(
        `Invalid ${paramName}: "${value}". Expected 0x-prefixed bytes32 (66 characters total).`
      );
    }

    // Check length (0x + 64 hex chars = 66 total)
    if (value.length !== 66) {
      throw new ValidationError(
        `Invalid ${paramName}: "${value}". Expected 66 characters (0x + 64 hex), got ${value.length}.`
      );
    }

    // Check hex format
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new ValidationError(
        `Invalid ${paramName}: "${value}". Contains invalid hex characters.`
      );
    }

    // Normalize to lowercase
    return value.toLowerCase();
  }

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
  protected validateTimestamp(timestamp: number, paramName: string): number {
    // Check it's a number
    if (typeof timestamp !== 'number' || isNaN(timestamp)) {
      throw new ValidationError(
        `Invalid ${paramName}: expected number, got ${typeof timestamp}`
      );
    }

    // Check it's positive
    if (timestamp <= 0) {
      throw new ValidationError(
        `Invalid ${paramName}: timestamp must be positive`
      );
    }

    // Check it's not in the past (with 1 minute buffer)
    const now = Math.floor(Date.now() / 1000);
    const oneMinuteAgo = now - 60;

    // Only apply this check if it looks like a deadline/future timestamp
    // (e.g., createdAt can be in the past)
    // For now, just validate it's reasonable

    // Check for overflow (year 3000 = ~32503680000)
    const year3000 = 32503680000;
    if (timestamp > year3000) {
      throw new ValidationError(
        `Invalid ${paramName}: timestamp ${timestamp} is too far in the future (overflow prevention)`
      );
    }

    return timestamp;
  }

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
  protected formatAmount(amount: bigint | string): string {
    const amountBigInt = typeof amount === 'string' ? BigInt(amount) : amount;

    // Convert from 6 decimals to decimal string
    const wholePart = amountBigInt / 1_000_000n;
    const decimalPart = amountBigInt % 1_000_000n;

    // M3 Fix: Proper rounding to 2 decimal places (round half up)
    // decimalPart is 0-999999, we need to round to nearest 10000 (cents)
    const decimalNum = Number(decimalPart);
    const roundedCents = Math.round(decimalNum / 10000); // 6 decimals → 2 decimals

    // Handle case where rounding causes overflow (e.g., 99.999999 → 100.00)
    if (roundedCents >= 100) {
      return `${wholePart + 1n}.00 USDC`;
    }

    const formattedDecimal = roundedCents.toString().padStart(2, '0');
    return `${wholePart}.${formattedDecimal} USDC`;
  }
}
