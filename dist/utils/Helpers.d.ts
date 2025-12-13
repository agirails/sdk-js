/**
 * Helpers - Common utility functions for ACTP SDK
 *
 * SECURITY FIX (L-7): Convenience methods for common operations
 * to reduce boilerplate and prevent mistakes.
 *
 * @module utils/Helpers
 */
/**
 * USDC amount utilities (6 decimal places)
 */
export declare const USDC: {
    /**
     * USDC decimals
     */
    DECIMALS: number;
    /**
     * Minimum transaction amount in USDC wei ($0.05)
     */
    MIN_AMOUNT_WEI: bigint;
    /**
     * Convert human-readable USDC amount to wei
     *
     * @param amount - Amount as string or number (e.g., "100.50")
     * @returns Amount in USDC wei (6 decimals)
     *
     * @example
     * ```typescript
     * USDC.toWei("100") // 100_000_000n
     * USDC.toWei("100.50") // 100_500_000n
     * USDC.toWei(100) // 100_000_000n
     * ```
     */
    toWei(amount: string | number): bigint;
    /**
     * Convert USDC wei to human-readable string
     *
     * SECURITY FIX (MEDIUM-6): Uses pure BigInt arithmetic to prevent precision loss
     *
     * @param weiAmount - Amount in USDC wei
     * @param decimals - Number of decimal places to show (default: 2)
     * @returns Formatted string (e.g., "100.50")
     *
     * @example
     * ```typescript
     * USDC.fromWei(100_500_000n) // "100.50"
     * USDC.fromWei(100_000_000n) // "100.00"
     * USDC.fromWei(100_126_000n, 4) // "100.1260"
     * ```
     */
    fromWei(weiAmount: bigint | string, decimals?: number): string;
    /**
     * Format USDC amount with currency symbol
     *
     * @param weiAmount - Amount in USDC wei
     * @returns Formatted string with USDC suffix (e.g., "100.50 USDC")
     */
    format(weiAmount: bigint | string): string;
    /**
     * Check if amount meets minimum transaction requirement
     *
     * @param weiAmount - Amount in USDC wei
     * @returns true if amount >= $0.05
     */
    meetsMinimum(weiAmount: bigint | string): boolean;
};
/**
 * Deadline utilities
 */
export declare const Deadline: {
    /**
     * Create deadline N hours from now
     *
     * @param hours - Number of hours from now
     * @returns Unix timestamp in seconds
     *
     * @example
     * ```typescript
     * Deadline.hoursFromNow(24) // timestamp 24 hours from now
     * ```
     */
    hoursFromNow(hours: number): number;
    /**
     * Create deadline N days from now
     *
     * @param days - Number of days from now
     * @returns Unix timestamp in seconds
     *
     * @example
     * ```typescript
     * Deadline.daysFromNow(7) // timestamp 7 days from now
     * ```
     */
    daysFromNow(days: number): number;
    /**
     * Create deadline at specific date
     *
     * @param date - Date object or ISO string
     * @returns Unix timestamp in seconds
     *
     * @example
     * ```typescript
     * Deadline.at(new Date('2025-01-01'))
     * Deadline.at('2025-01-01T00:00:00Z')
     * ```
     */
    at(date: Date | string): number;
    /**
     * Check if deadline has passed
     *
     * @param deadline - Unix timestamp in seconds
     * @returns true if deadline is in the past
     */
    isPast(deadline: number): boolean;
    /**
     * Get time remaining until deadline
     *
     * @param deadline - Unix timestamp in seconds
     * @returns Time remaining in seconds (negative if past)
     */
    timeRemaining(deadline: number): number;
    /**
     * Format deadline as human-readable string
     *
     * @param deadline - Unix timestamp in seconds
     * @returns Human-readable string (e.g., "in 2 hours", "expired 1 day ago")
     */
    format(deadline: number): string;
};
/**
 * Address utilities
 */
export declare const Address: {
    /**
     * Normalize address to lowercase with 0x prefix
     *
     * @param address - Ethereum address
     * @returns Normalized address
     */
    normalize(address: string): string;
    /**
     * Check if two addresses are the same (case-insensitive)
     *
     * @param a - First address
     * @param b - Second address
     * @returns true if addresses match
     */
    equals(a: string, b: string): boolean;
    /**
     * Truncate address for display
     *
     * @param address - Ethereum address
     * @param chars - Characters to show on each side (default: 4)
     * @returns Truncated address (e.g., "0x1234...5678")
     */
    truncate(address: string, chars?: number): string;
    /**
     * Check if string is valid Ethereum address format
     *
     * @param address - String to check
     * @returns true if valid address format
     */
    isValid(address: string): boolean;
    /**
     * Check if address is zero address
     *
     * @param address - Ethereum address
     * @returns true if zero address
     */
    isZero(address: string): boolean;
};
/**
 * Bytes32 utilities
 */
export declare const Bytes32: {
    /**
     * Check if string is valid bytes32 format
     *
     * @param value - String to check
     * @returns true if valid bytes32 format
     */
    isValid(value: string): boolean;
    /**
     * Normalize bytes32 to lowercase
     *
     * @param value - Bytes32 string
     * @returns Normalized lowercase string
     */
    normalize(value: string): string;
    /**
     * Check if two bytes32 values are equal
     *
     * @param a - First value
     * @param b - Second value
     * @returns true if equal
     */
    equals(a: string, b: string): boolean;
    /**
     * Check if bytes32 is zero
     *
     * @param value - Bytes32 string
     * @returns true if zero
     */
    isZero(value: string): boolean;
    /**
     * Create zero bytes32
     *
     * @returns Zero bytes32 string
     */
    zero(): string;
    /**
     * Truncate bytes32 for display
     *
     * @param value - Bytes32 string
     * @param chars - Characters to show on each side (default: 6)
     * @returns Truncated string (e.g., "0x123456...abcdef")
     */
    truncate(value: string, chars?: number): string;
};
/**
 * State machine utilities
 */
export declare const State: {
    /**
     * Valid ACTP states
     */
    STATES: readonly ["INITIATED", "QUOTED", "COMMITTED", "IN_PROGRESS", "DELIVERED", "SETTLED", "DISPUTED", "CANCELLED"];
    /**
     * Terminal states (no further transitions)
     */
    TERMINAL: readonly ["SETTLED", "CANCELLED"];
    /**
     * Check if state is terminal
     *
     * @param state - State to check
     * @returns true if terminal state
     */
    isTerminal(state: string): boolean;
    /**
     * Check if state is valid
     *
     * @param state - State to check
     * @returns true if valid state
     */
    isValid(state: string): boolean;
    /**
     * Get valid next states from current state
     *
     * SECURITY FIX (CRITICAL-1): Must match ACTPKernel contract state machine exactly
     * Per CLAUDE.md §Architecture Overview - ACTP Protocol State Machine
     *
     * @param currentState - Current state
     * @returns Array of valid next states
     */
    validTransitions(currentState: string): string[];
    /**
     * Check if transition is valid
     *
     * @param from - Current state
     * @param to - Target state
     * @returns true if transition is valid
     */
    canTransition(from: string, to: string): boolean;
};
/**
 * Dispute window utilities
 */
export declare const DisputeWindow: {
    /**
     * Default dispute window in seconds (2 days)
     */
    DEFAULT: number;
    /**
     * Minimum dispute window in seconds (1 hour)
     */
    MIN: number;
    /**
     * Maximum dispute window in seconds (30 days)
     */
    MAX: number;
    /**
     * Convert hours to seconds
     */
    hours(h: number): number;
    /**
     * Convert days to seconds
     */
    days(d: number): number;
    /**
     * Check if dispute window is still active
     *
     * @param completedAt - Completion timestamp
     * @param windowSeconds - Dispute window in seconds
     * @returns true if window is still active
     */
    isActive(completedAt: number, windowSeconds: number): boolean;
    /**
     * Get time remaining in dispute window
     *
     * @param completedAt - Completion timestamp
     * @param windowSeconds - Dispute window in seconds
     * @returns Seconds remaining (0 if expired)
     */
    remaining(completedAt: number, windowSeconds: number): number;
};
//# sourceMappingURL=Helpers.d.ts.map