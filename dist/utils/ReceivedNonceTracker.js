"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetBasedReceivedNonceTracker = exports.InMemoryReceivedNonceTracker = void 0;
exports.createReceivedNonceTracker = createReceivedNonceTracker;
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
class InMemoryReceivedNonceTracker {
    constructor() {
        // Map: sender -> messageType -> highest nonce (as BigInt for comparison)
        this.highestNonces = new Map();
    }
    /**
     * Validate and record a received nonce
     */
    validateAndRecord(sender, messageType, nonce) {
        // Validate nonce format (must be bytes32: 0x + 64 hex chars)
        if (!/^0x[a-fA-F0-9]{64}$/.test(nonce)) {
            return {
                valid: false,
                reason: 'Invalid nonce format (must be bytes32)',
                receivedNonce: nonce
            };
        }
        // Convert nonce to BigInt for comparison
        const nonceValue = BigInt(nonce);
        // Get sender's nonce map
        let senderNonces = this.highestNonces.get(sender);
        if (!senderNonces) {
            senderNonces = new Map();
            this.highestNonces.set(sender, senderNonces);
        }
        // Get highest nonce for this message type
        const highestNonce = senderNonces.get(messageType);
        if (highestNonce === undefined) {
            // First message from this sender for this type
            senderNonces.set(messageType, nonceValue);
            return { valid: true };
        }
        // Nonce must be strictly greater than highest seen
        if (nonceValue <= highestNonce) {
            const expectedMinimum = '0x' + (highestNonce + BigInt(1)).toString(16).padStart(64, '0');
            return {
                valid: false,
                reason: `Nonce replay detected: nonce must be > ${this.bigintToBytes32(highestNonce)}`,
                expectedMinimum,
                receivedNonce: nonce
            };
        }
        // Valid nonce - record it
        senderNonces.set(messageType, nonceValue);
        return { valid: true };
    }
    /**
     * Check if a nonce has been used (non-mutating)
     */
    hasBeenUsed(sender, messageType, nonce) {
        const nonceValue = BigInt(nonce);
        const senderNonces = this.highestNonces.get(sender);
        if (!senderNonces) {
            return false; // No nonces seen from this sender
        }
        const highestNonce = senderNonces.get(messageType);
        if (highestNonce === undefined) {
            return false; // No nonces seen for this message type
        }
        // If the provided nonce is <= highest seen, it's been "used"
        return nonceValue <= highestNonce;
    }
    /**
     * Get highest nonce seen
     */
    getHighestNonce(sender, messageType) {
        const senderNonces = this.highestNonces.get(sender);
        if (!senderNonces) {
            return null;
        }
        const highestNonce = senderNonces.get(messageType);
        if (highestNonce === undefined) {
            return null;
        }
        return this.bigintToBytes32(highestNonce);
    }
    /**
     * Reset tracking for sender + message type
     */
    reset(sender, messageType) {
        const senderNonces = this.highestNonces.get(sender);
        if (senderNonces) {
            senderNonces.delete(messageType);
            // Clean up sender map if empty
            if (senderNonces.size === 0) {
                this.highestNonces.delete(sender);
            }
        }
    }
    /**
     * Clear all tracked nonces
     */
    clearAll() {
        this.highestNonces.clear();
    }
    /**
     * Convert BigInt to bytes32 hex string
     */
    bigintToBytes32(value) {
        return '0x' + value.toString(16).padStart(64, '0');
    }
    /**
     * Get all nonces (for debugging/persistence)
     */
    getAllNonces() {
        const result = {};
        this.highestNonces.forEach((senderNonces, sender) => {
            result[sender] = {};
            senderNonces.forEach((nonce, messageType) => {
                result[sender][messageType] = this.bigintToBytes32(nonce);
            });
        });
        return result;
    }
}
exports.InMemoryReceivedNonceTracker = InMemoryReceivedNonceTracker;
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
class SetBasedReceivedNonceTracker {
    /**
     * Create set-based tracker with optional max size
     * @param maxSizePerType - Maximum nonces per sender+messageType (default: 10,000)
     * @param maxTotalEntries - Maximum total nonces across all combinations (default: 100,000)
     */
    constructor(maxSizePerType = 10000, maxTotalEntries = 100000) {
        // Map: sender -> messageType -> Set of used nonces
        this.usedNonces = new Map();
        this.totalEntries = 0;
        if (maxSizePerType <= 0) {
            throw new Error('maxSizePerType must be positive');
        }
        if (maxTotalEntries <= 0) {
            throw new Error('maxTotalEntries must be positive');
        }
        this.maxSizePerType = maxSizePerType;
        this.maxTotalEntries = maxTotalEntries;
    }
    /**
     * Validate and record a received nonce
     *
     * SECURITY FIX (NEW-H-2): Automatic cleanup when max size reached
     * SECURITY FIX (HIGH-2): Global limit check to prevent DoS
     */
    validateAndRecord(sender, messageType, nonce) {
        // Validate nonce format
        if (!/^0x[a-fA-F0-9]{64}$/.test(nonce)) {
            return {
                valid: false,
                reason: 'Invalid nonce format (must be bytes32)',
                receivedNonce: nonce
            };
        }
        // SECURITY FIX (HIGH-2): Check global limit BEFORE adding
        if (this.totalEntries >= this.maxTotalEntries) {
            return {
                valid: false,
                reason: `Global nonce tracker limit reached (${this.maxTotalEntries} entries). ` +
                    `This may indicate a DoS attack or need for cleanup. ` +
                    `Current usage: ${this.totalEntries} entries across ${this.getCombinationCount()} sender+type combinations.`,
                receivedNonce: nonce
            };
        }
        // Get sender's nonce map
        let senderNonces = this.usedNonces.get(sender);
        if (!senderNonces) {
            senderNonces = new Map();
            this.usedNonces.set(sender, senderNonces);
        }
        // Get set of used nonces for this message type
        let usedSet = senderNonces.get(messageType);
        if (!usedSet) {
            usedSet = new Set();
            senderNonces.set(messageType, usedSet);
        }
        // Check if nonce was already used
        if (usedSet.has(nonce)) {
            return {
                valid: false,
                reason: 'Nonce replay detected: this nonce has already been used',
                receivedNonce: nonce
            };
        }
        // SECURITY FIX (NEW-H-2): Auto-cleanup if max size per type reached
        if (usedSet.size >= this.maxSizePerType) {
            // Keep only last 80% of entries (sorted by nonce value)
            const keepCount = Math.floor(this.maxSizePerType * 0.8);
            const sortedNonces = Array.from(usedSet).sort((a, b) => {
                const aVal = BigInt(a);
                const bVal = BigInt(b);
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            });
            const removedCount = usedSet.size - keepCount;
            usedSet = new Set(sortedNonces.slice(-keepCount));
            senderNonces.set(messageType, usedSet);
            // SECURITY FIX (HIGH-2): Update global counter
            this.totalEntries -= removedCount;
        }
        // Valid nonce - record it
        usedSet.add(nonce);
        // SECURITY FIX (HIGH-2): Update global counter
        this.totalEntries++;
        return { valid: true };
    }
    /**
     * Get number of sender+messageType combinations (for monitoring)
     * SECURITY FIX (HIGH-2): Monitoring method
     */
    getCombinationCount() {
        let count = 0;
        this.usedNonces.forEach(senderMap => {
            count += senderMap.size;
        });
        return count;
    }
    /**
     * Get memory usage statistics
     * SECURITY FIX (HIGH-2): Monitoring method for DoS detection
     */
    getMemoryUsage() {
        return {
            totalEntries: this.totalEntries,
            combinations: this.getCombinationCount(),
            maxTotalEntries: this.maxTotalEntries
        };
    }
    /**
     * Check if a nonce has been used
     */
    hasBeenUsed(sender, messageType, nonce) {
        const senderNonces = this.usedNonces.get(sender);
        if (!senderNonces) {
            return false;
        }
        const usedSet = senderNonces.get(messageType);
        if (!usedSet) {
            return false;
        }
        return usedSet.has(nonce);
    }
    /**
     * Get highest nonce seen (for this strategy, compute from set)
     */
    getHighestNonce(sender, messageType) {
        const senderNonces = this.usedNonces.get(sender);
        if (!senderNonces) {
            return null;
        }
        const usedSet = senderNonces.get(messageType);
        if (!usedSet || usedSet.size === 0) {
            return null;
        }
        // Find maximum nonce in set
        let maxNonce = BigInt(0);
        usedSet.forEach(nonce => {
            const value = BigInt(nonce);
            if (value > maxNonce) {
                maxNonce = value;
            }
        });
        return '0x' + maxNonce.toString(16).padStart(64, '0');
    }
    /**
     * Reset tracking for sender + message type
     */
    reset(sender, messageType) {
        const senderNonces = this.usedNonces.get(sender);
        if (senderNonces) {
            const usedSet = senderNonces.get(messageType);
            if (usedSet) {
                // SECURITY FIX (HIGH-2): Update global counter
                this.totalEntries -= usedSet.size;
            }
            senderNonces.delete(messageType);
            if (senderNonces.size === 0) {
                this.usedNonces.delete(sender);
            }
        }
    }
    /**
     * Clear all tracked nonces
     */
    clearAll() {
        this.usedNonces.clear();
        // SECURITY FIX (HIGH-2): Reset global counter
        this.totalEntries = 0;
    }
    /**
     * Get nonce count for sender + message type (for monitoring)
     */
    getNonceCount(sender, messageType) {
        const senderNonces = this.usedNonces.get(sender);
        if (!senderNonces) {
            return 0;
        }
        const usedSet = senderNonces.get(messageType);
        return usedSet ? usedSet.size : 0;
    }
    /**
     * Cleanup old nonces (keep only last N)
     * This prevents unbounded memory growth
     */
    cleanup(sender, messageType, keepLast = 1000) {
        const senderNonces = this.usedNonces.get(sender);
        if (!senderNonces) {
            return;
        }
        const usedSet = senderNonces.get(messageType);
        if (!usedSet || usedSet.size <= keepLast) {
            return;
        }
        // Convert to array and sort by nonce value
        const sortedNonces = Array.from(usedSet).sort((a, b) => {
            const aVal = BigInt(a);
            const bVal = BigInt(b);
            return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        });
        // Keep only the last N nonces
        const removedCount = usedSet.size - keepLast;
        const toKeep = new Set(sortedNonces.slice(-keepLast));
        senderNonces.set(messageType, toKeep);
        // SECURITY FIX (HIGH-2): Update global counter
        this.totalEntries -= removedCount;
    }
}
exports.SetBasedReceivedNonceTracker = SetBasedReceivedNonceTracker;
/**
 * Factory function to create a nonce tracker
 * @param strategy - 'memory-efficient' (highest nonce) or 'set-based' (all nonces)
 * @returns IReceivedNonceTracker instance
 */
function createReceivedNonceTracker(strategy = 'memory-efficient') {
    if (strategy === 'set-based') {
        return new SetBasedReceivedNonceTracker();
    }
    return new InMemoryReceivedNonceTracker();
}
//# sourceMappingURL=ReceivedNonceTracker.js.map