"use strict";
/**
 * Helpers - Common utility functions for ACTP SDK
 *
 * SECURITY FIX (L-7): Convenience methods for common operations
 * to reduce boilerplate and prevent mistakes.
 *
 * @module utils/Helpers
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputeWindow = exports.State = exports.Bytes32 = exports.Address = exports.Deadline = exports.USDC = void 0;
/**
 * USDC amount utilities (6 decimal places)
 */
exports.USDC = {
    /**
     * USDC decimals
     */
    DECIMALS: 6,
    /**
     * Minimum transaction amount in USDC wei ($0.05)
     */
    MIN_AMOUNT_WEI: 50000n,
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
    toWei(amount) {
        const amountStr = String(amount).replace(/[,$\s]/g, '');
        const parts = amountStr.split('.');
        const wholePart = parts[0] || '0';
        const decimalPart = (parts[1] || '').padEnd(6, '0').slice(0, 6);
        return BigInt(wholePart) * 1000000n + BigInt(decimalPart);
    },
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
    fromWei(weiAmount, decimals = 2) {
        const amount = typeof weiAmount === 'string' ? BigInt(weiAmount) : weiAmount;
        // SECURITY FIX (MEDIUM-6): Use pure BigInt arithmetic for precision
        // Calculate divisor and multiplier using BigInt to avoid floating point
        const divisorExponent = 6 - decimals;
        const divisor = divisorExponent >= 0 ? BigInt(10 ** divisorExponent) : 1n;
        const maxDecimal = BigInt(10 ** decimals);
        // SECURITY FIX (MEDIUM-6): Round using BigInt arithmetic
        // Add half divisor before division for proper rounding (banker's rounding alternative)
        const roundedAmount = divisorExponent >= 0
            ? (amount + divisor / 2n) / divisor
            : amount * BigInt(10 ** (-divisorExponent));
        const wholePart = roundedAmount / maxDecimal;
        const decimalPart = roundedAmount % maxDecimal;
        // Handle overflow from rounding (e.g., 999999 rounds to 1000000)
        if (decimalPart < 0n) {
            // This shouldn't happen with positive amounts, but handle defensive
            return `${wholePart}.${decimalPart.toString().slice(1).padStart(decimals, '0')}`;
        }
        return `${wholePart}.${decimalPart.toString().padStart(decimals, '0')}`;
    },
    /**
     * Format USDC amount with currency symbol
     *
     * @param weiAmount - Amount in USDC wei
     * @returns Formatted string with USDC suffix (e.g., "100.50 USDC")
     */
    format(weiAmount) {
        return `${exports.USDC.fromWei(weiAmount)} USDC`;
    },
    /**
     * Check if amount meets minimum transaction requirement
     *
     * @param weiAmount - Amount in USDC wei
     * @returns true if amount >= $0.05
     */
    meetsMinimum(weiAmount) {
        const amount = typeof weiAmount === 'string' ? BigInt(weiAmount) : weiAmount;
        return amount >= exports.USDC.MIN_AMOUNT_WEI;
    },
};
/**
 * Deadline utilities
 */
exports.Deadline = {
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
    hoursFromNow(hours) {
        return Math.floor(Date.now() / 1000) + hours * 3600;
    },
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
    daysFromNow(days) {
        return Math.floor(Date.now() / 1000) + days * 86400;
    },
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
    at(date) {
        const d = typeof date === 'string' ? new Date(date) : date;
        return Math.floor(d.getTime() / 1000);
    },
    /**
     * Check if deadline has passed
     *
     * @param deadline - Unix timestamp in seconds
     * @returns true if deadline is in the past
     */
    isPast(deadline) {
        return deadline <= Math.floor(Date.now() / 1000);
    },
    /**
     * Get time remaining until deadline
     *
     * @param deadline - Unix timestamp in seconds
     * @returns Time remaining in seconds (negative if past)
     */
    timeRemaining(deadline) {
        return deadline - Math.floor(Date.now() / 1000);
    },
    /**
     * Format deadline as human-readable string
     *
     * @param deadline - Unix timestamp in seconds
     * @returns Human-readable string (e.g., "in 2 hours", "expired 1 day ago")
     */
    format(deadline) {
        const remaining = exports.Deadline.timeRemaining(deadline);
        if (remaining <= 0) {
            const ago = Math.abs(remaining);
            if (ago < 60)
                return `expired ${ago} seconds ago`;
            if (ago < 3600)
                return `expired ${Math.floor(ago / 60)} minutes ago`;
            if (ago < 86400)
                return `expired ${Math.floor(ago / 3600)} hours ago`;
            return `expired ${Math.floor(ago / 86400)} days ago`;
        }
        if (remaining < 60)
            return `in ${remaining} seconds`;
        if (remaining < 3600)
            return `in ${Math.floor(remaining / 60)} minutes`;
        if (remaining < 86400)
            return `in ${Math.floor(remaining / 3600)} hours`;
        return `in ${Math.floor(remaining / 86400)} days`;
    },
};
/**
 * Address utilities
 */
exports.Address = {
    /**
     * Normalize address to lowercase with 0x prefix
     *
     * @param address - Ethereum address
     * @returns Normalized address
     */
    normalize(address) {
        return address.toLowerCase();
    },
    /**
     * Check if two addresses are the same (case-insensitive)
     *
     * @param a - First address
     * @param b - Second address
     * @returns true if addresses match
     */
    equals(a, b) {
        return a.toLowerCase() === b.toLowerCase();
    },
    /**
     * Truncate address for display
     *
     * @param address - Ethereum address
     * @param chars - Characters to show on each side (default: 4)
     * @returns Truncated address (e.g., "0x1234...5678")
     */
    truncate(address, chars = 4) {
        if (address.length <= 2 + chars * 2) {
            return address;
        }
        return `${address.slice(0, 2 + chars)}...${address.slice(-chars)}`;
    },
    /**
     * Check if string is valid Ethereum address format
     *
     * @param address - String to check
     * @returns true if valid address format
     */
    isValid(address) {
        return /^0x[0-9a-fA-F]{40}$/.test(address);
    },
    /**
     * Check if address is zero address
     *
     * @param address - Ethereum address
     * @returns true if zero address
     */
    isZero(address) {
        return address.toLowerCase() === '0x0000000000000000000000000000000000000000';
    },
};
/**
 * Bytes32 utilities
 */
exports.Bytes32 = {
    /**
     * Check if string is valid bytes32 format
     *
     * @param value - String to check
     * @returns true if valid bytes32 format
     */
    isValid(value) {
        return /^0x[0-9a-fA-F]{64}$/.test(value);
    },
    /**
     * Normalize bytes32 to lowercase
     *
     * @param value - Bytes32 string
     * @returns Normalized lowercase string
     */
    normalize(value) {
        return value.toLowerCase();
    },
    /**
     * Check if two bytes32 values are equal
     *
     * @param a - First value
     * @param b - Second value
     * @returns true if equal
     */
    equals(a, b) {
        return a.toLowerCase() === b.toLowerCase();
    },
    /**
     * Check if bytes32 is zero
     *
     * @param value - Bytes32 string
     * @returns true if zero
     */
    isZero(value) {
        return value.toLowerCase() === '0x' + '0'.repeat(64);
    },
    /**
     * Create zero bytes32
     *
     * @returns Zero bytes32 string
     */
    zero() {
        return '0x' + '0'.repeat(64);
    },
    /**
     * Truncate bytes32 for display
     *
     * @param value - Bytes32 string
     * @param chars - Characters to show on each side (default: 6)
     * @returns Truncated string (e.g., "0x123456...abcdef")
     */
    truncate(value, chars = 6) {
        if (value.length <= 2 + chars * 2) {
            return value;
        }
        return `${value.slice(0, 2 + chars)}...${value.slice(-chars)}`;
    },
};
/**
 * State machine utilities
 */
exports.State = {
    /**
     * Valid ACTP states
     */
    STATES: [
        'INITIATED',
        'QUOTED',
        'COMMITTED',
        'IN_PROGRESS',
        'DELIVERED',
        'SETTLED',
        'DISPUTED',
        'CANCELLED',
    ],
    /**
     * Terminal states (no further transitions)
     */
    TERMINAL: ['SETTLED', 'CANCELLED'],
    /**
     * Check if state is terminal
     *
     * @param state - State to check
     * @returns true if terminal state
     */
    isTerminal(state) {
        return exports.State.TERMINAL.includes(state);
    },
    /**
     * Check if state is valid
     *
     * @param state - State to check
     * @returns true if valid state
     */
    isValid(state) {
        return exports.State.STATES.includes(state);
    },
    /**
     * Get valid next states from current state
     *
     * SECURITY FIX (CRITICAL-1): Must match ACTPKernel contract state machine exactly
     * Per CLAUDE.md §Architecture Overview - ACTP Protocol State Machine
     *
     * @param currentState - Current state
     * @returns Array of valid next states
     */
    validTransitions(currentState) {
        const transitions = {
            INITIATED: ['QUOTED', 'COMMITTED', 'CANCELLED'],
            QUOTED: ['COMMITTED', 'CANCELLED'],
            // Can skip IN_PROGRESS and go directly to DELIVERED
            COMMITTED: ['IN_PROGRESS', 'DELIVERED', 'CANCELLED'],
            // No DISPUTED from IN_PROGRESS - only after DELIVERED
            IN_PROGRESS: ['DELIVERED', 'CANCELLED'],
            DELIVERED: ['SETTLED', 'DISPUTED'],
            // Disputes can only resolve to SETTLED (no CANCELLED)
            DISPUTED: ['SETTLED'],
            SETTLED: [],
            CANCELLED: [],
        };
        return transitions[currentState] || [];
    },
    /**
     * Check if transition is valid
     *
     * @param from - Current state
     * @param to - Target state
     * @returns true if transition is valid
     */
    canTransition(from, to) {
        return exports.State.validTransitions(from).includes(to);
    },
};
/**
 * Dispute window utilities
 */
exports.DisputeWindow = {
    /**
     * Default dispute window in seconds (2 days)
     */
    DEFAULT: 172800,
    /**
     * Minimum dispute window in seconds (1 hour)
     */
    MIN: 3600,
    /**
     * Maximum dispute window in seconds (30 days)
     */
    MAX: 30 * 24 * 3600,
    /**
     * Convert hours to seconds
     */
    hours(h) {
        return h * 3600;
    },
    /**
     * Convert days to seconds
     */
    days(d) {
        return d * 86400;
    },
    /**
     * Check if dispute window is still active
     *
     * @param completedAt - Completion timestamp
     * @param windowSeconds - Dispute window in seconds
     * @returns true if window is still active
     */
    isActive(completedAt, windowSeconds) {
        const expiresAt = completedAt + windowSeconds;
        return Math.floor(Date.now() / 1000) < expiresAt;
    },
    /**
     * Get time remaining in dispute window
     *
     * @param completedAt - Completion timestamp
     * @param windowSeconds - Dispute window in seconds
     * @returns Seconds remaining (0 if expired)
     */
    remaining(completedAt, windowSeconds) {
        const expiresAt = completedAt + windowSeconds;
        const now = Math.floor(Date.now() / 1000);
        return Math.max(0, expiresAt - now);
    },
};
//# sourceMappingURL=Helpers.js.map