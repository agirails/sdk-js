/**
 * ReceivedNonceTracker - Replay Attack Prevention for Message Receivers
 *
 * This utility tracks nonces of received messages to prevent replay attacks.
 * It works in conjunction with NonceManager (for senders) but serves the receiver side.
 *
 * Reference: V4 Security Vulnerability (EIP-712 Replay Attack)
 *
 * Usage Pattern:
 * - Sender: Uses NonceManager to generate monotonically increasing nonces
 * - Receiver: Uses ReceivedNonceTracker to validate and track received nonces
 *
 * Security Properties:
 * 1. Nonces must be monotonically increasing per sender + message type
 * 2. Duplicate nonces are rejected (replay attack prevention)
 * 3. Nonces that are lower than the highest seen are rejected (old replay prevention)
 *
 * ⚠️ WARNING: In-memory tracking only. For production:
 * - Use persistent storage (Redis, PostgreSQL, etc.)
 * - Implement nonce recovery from transaction history
 * - Consider nonce expiry for long-running processes
 */
/**
 * Nonce validation result
 */
export interface NonceValidationResult {
    valid: boolean;
    reason?: string;
    expectedMinimum?: string;
    receivedNonce?: string;
}
/**
 * Interface for tracking received nonces
 */
export interface IReceivedNonceTracker {
    /**
     * Validate and record a received nonce
     * @param sender - Sender DID (e.g., "did:ethr:0x...")
     * @param messageType - Message type (e.g., "agirails.delivery.v1")
     * @param nonce - Nonce value (bytes32 format: "0x...")
     * @returns Validation result
     */
    validateAndRecord(sender: string, messageType: string, nonce: string): NonceValidationResult;
    /**
     * Check if a nonce has been used (without recording)
     * @param sender - Sender DID
     * @param messageType - Message type
     * @param nonce - Nonce value (bytes32 format)
     * @returns true if nonce was already used
     */
    hasBeenUsed(sender: string, messageType: string, nonce: string): boolean;
    /**
     * Get highest nonce seen for sender + message type
     * @param sender - Sender DID
     * @param messageType - Message type
     * @returns Highest nonce (bytes32 format) or null if none seen
     */
    getHighestNonce(sender: string, messageType: string): string | null;
    /**
     * Reset tracking for a specific sender + message type
     * @param sender - Sender DID
     * @param messageType - Message type
     */
    reset(sender: string, messageType: string): void;
    /**
     * Clear all tracked nonces
     */
    clearAll(): void;
}
/**
 * In-Memory Received Nonce Tracker
 *
 * Strategy: Track highest nonce seen per sender + message type
 * - Accept nonces that are strictly greater than the highest seen
 * - Reject nonces that are <= highest seen (replay attack)
 *
 * Trade-off:
 * - Memory efficient (one value per sender + type)
 * - Requires ordered nonce sequences
 * - Cannot skip nonces (nonce gaps are rejected)
 */
export declare class InMemoryReceivedNonceTracker implements IReceivedNonceTracker {
    private highestNonces;
    /**
     * Validate and record a received nonce
     */
    validateAndRecord(sender: string, messageType: string, nonce: string): NonceValidationResult;
    /**
     * Check if a nonce has been used (non-mutating)
     */
    hasBeenUsed(sender: string, messageType: string, nonce: string): boolean;
    /**
     * Get highest nonce seen
     */
    getHighestNonce(sender: string, messageType: string): string | null;
    /**
     * Reset tracking for sender + message type
     */
    reset(sender: string, messageType: string): void;
    /**
     * Clear all tracked nonces
     */
    clearAll(): void;
    /**
     * Convert BigInt to bytes32 hex string
     */
    private bigintToBytes32;
    /**
     * Get all nonces (for debugging/persistence)
     */
    getAllNonces(): Record<string, Record<string, string>>;
}
/**
 * Set-Based Received Nonce Tracker
 *
 * Strategy: Track exact set of used nonces per sender + message type
 * - Accept nonces that haven't been seen before
 * - Reject duplicate nonces (replay attack)
 * - Allows non-sequential nonces (nonce gaps are OK)
 *
 * SECURITY FIX (NEW-H-2): Max size enforcement to prevent memory exhaustion
 * SECURITY FIX (HIGH-2): Global total entries limit to prevent DoS via many sender combinations
 *
 * Trade-off:
 * - Higher memory usage (stores every nonce)
 * - More flexible (allows out-of-order delivery)
 * - Requires periodic cleanup to prevent unbounded growth
 */
export declare class SetBasedReceivedNonceTracker implements IReceivedNonceTracker {
    private usedNonces;
    private readonly maxSizePerType;
    private readonly maxTotalEntries;
    private totalEntries;
    /**
     * Create set-based tracker with optional max size
     * @param maxSizePerType - Maximum nonces per sender+messageType (default: 10,000)
     * @param maxTotalEntries - Maximum total nonces across all combinations (default: 100,000)
     */
    constructor(maxSizePerType?: number, maxTotalEntries?: number);
    /**
     * Validate and record a received nonce
     *
     * SECURITY FIX (NEW-H-2): Automatic cleanup when max size reached
     * SECURITY FIX (HIGH-2): Global limit check to prevent DoS
     */
    validateAndRecord(sender: string, messageType: string, nonce: string): NonceValidationResult;
    /**
     * Get number of sender+messageType combinations (for monitoring)
     * SECURITY FIX (HIGH-2): Monitoring method
     */
    private getCombinationCount;
    /**
     * Get memory usage statistics
     * SECURITY FIX (HIGH-2): Monitoring method for DoS detection
     */
    getMemoryUsage(): {
        totalEntries: number;
        combinations: number;
        maxTotalEntries: number;
    };
    /**
     * Check if a nonce has been used
     */
    hasBeenUsed(sender: string, messageType: string, nonce: string): boolean;
    /**
     * Get highest nonce seen (for this strategy, compute from set)
     */
    getHighestNonce(sender: string, messageType: string): string | null;
    /**
     * Reset tracking for sender + message type
     */
    reset(sender: string, messageType: string): void;
    /**
     * Clear all tracked nonces
     */
    clearAll(): void;
    /**
     * Get nonce count for sender + message type (for monitoring)
     */
    getNonceCount(sender: string, messageType: string): number;
    /**
     * Cleanup old nonces (keep only last N)
     * This prevents unbounded memory growth
     */
    cleanup(sender: string, messageType: string, keepLast?: number): void;
}
/**
 * Factory function to create a nonce tracker
 * @param strategy - 'memory-efficient' (highest nonce) or 'set-based' (all nonces)
 * @returns IReceivedNonceTracker instance
 */
export declare function createReceivedNonceTracker(strategy?: 'memory-efficient' | 'set-based'): IReceivedNonceTracker;
//# sourceMappingURL=ReceivedNonceTracker.d.ts.map