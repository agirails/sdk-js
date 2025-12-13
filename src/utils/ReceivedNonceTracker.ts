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
  expectedMinimum?: string; // bytes32 format
  receivedNonce?: string;   // bytes32 format
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
export class InMemoryReceivedNonceTracker implements IReceivedNonceTracker {
  // Map: sender -> messageType -> highest nonce (as BigInt for comparison)
  private highestNonces: Map<string, Map<string, bigint>> = new Map();

  /**
   * Validate and record a received nonce
   */
  validateAndRecord(sender: string, messageType: string, nonce: string): NonceValidationResult {
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
      senderNonces = new Map<string, bigint>();
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
  hasBeenUsed(sender: string, messageType: string, nonce: string): boolean {
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
  getHighestNonce(sender: string, messageType: string): string | null {
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
  reset(sender: string, messageType: string): void {
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
  clearAll(): void {
    this.highestNonces.clear();
  }

  /**
   * Convert BigInt to bytes32 hex string
   */
  private bigintToBytes32(value: bigint): string {
    return '0x' + value.toString(16).padStart(64, '0');
  }

  /**
   * Get all nonces (for debugging/persistence)
   */
  getAllNonces(): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};

    this.highestNonces.forEach((senderNonces, sender) => {
      result[sender] = {};
      senderNonces.forEach((nonce, messageType) => {
        result[sender][messageType] = this.bigintToBytes32(nonce);
      });
    });

    return result;
  }
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
 * SECURITY FIX (H-2): Rate limiting per sender to prevent flood attacks
 *
 * Trade-off:
 * - Higher memory usage (stores every nonce)
 * - More flexible (allows out-of-order delivery)
 * - Requires periodic cleanup to prevent unbounded growth
 */
export class SetBasedReceivedNonceTracker implements IReceivedNonceTracker {
  // Map: sender -> messageType -> Set of used nonces
  private usedNonces: Map<string, Map<string, Set<string>>> = new Map();

  // SECURITY FIX (NEW-H-2): Maximum entries per sender+messageType
  private readonly maxSizePerType: number;

  // SECURITY FIX (HIGH-2): Global limit across ALL sender+messageType combinations
  private readonly maxTotalEntries: number;
  private totalEntries: number = 0;

  // SECURITY FIX (H-2): Rate limiting per sender
  // Map: sender -> { count: number, windowStart: number }
  private rateLimitState: Map<string, { count: number; windowStart: number }> = new Map();
  private readonly maxNoncesPerMinute: number;
  private readonly rateLimitWindowMs: number = 60000; // 1 minute window

  /**
   * Create set-based tracker with optional max size
   * @param maxSizePerType - Maximum nonces per sender+messageType (default: 10,000)
   * @param maxTotalEntries - Maximum total nonces across all combinations (default: 100,000)
   * @param maxNoncesPerMinute - Maximum nonces per sender per minute (default: 100)
   */
  constructor(
    maxSizePerType: number = 10000,
    maxTotalEntries: number = 100000,
    maxNoncesPerMinute: number = 100
  ) {
    if (maxSizePerType <= 0) {
      throw new Error('maxSizePerType must be positive');
    }
    if (maxTotalEntries <= 0) {
      throw new Error('maxTotalEntries must be positive');
    }
    if (maxNoncesPerMinute <= 0) {
      throw new Error('maxNoncesPerMinute must be positive');
    }
    this.maxSizePerType = maxSizePerType;
    this.maxTotalEntries = maxTotalEntries;
    this.maxNoncesPerMinute = maxNoncesPerMinute;
  }

  /**
   * SECURITY FIX (H-2): Check rate limit for sender
   * @param sender - Sender DID
   * @returns true if rate limit exceeded
   */
  private checkRateLimit(sender: string): boolean {
    const now = Date.now();
    const state = this.rateLimitState.get(sender);

    if (!state) {
      // First nonce from this sender
      this.rateLimitState.set(sender, { count: 1, windowStart: now });
      return false; // Not rate limited
    }

    // Check if window expired (reset counter)
    if (now - state.windowStart >= this.rateLimitWindowMs) {
      state.count = 1;
      state.windowStart = now;
      return false; // Not rate limited
    }

    // Increment counter
    state.count++;

    // Check if rate limit exceeded
    return state.count > this.maxNoncesPerMinute;
  }

  /**
   * SECURITY FIX (H-2): Periodic cleanup of rate limit state
   * Removes expired rate limit entries (older than 5 minutes)
   */
  private cleanupRateLimitState(): void {
    const now = Date.now();
    const expiryThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [sender, state] of this.rateLimitState.entries()) {
      if (now - state.windowStart > expiryThreshold) {
        this.rateLimitState.delete(sender);
      }
    }
  }

  /**
   * Validate and record a received nonce
   *
   * SECURITY FIX (NEW-H-2): Automatic cleanup when max size reached
   * SECURITY FIX (HIGH-2): Global limit check to prevent DoS
   * SECURITY FIX (H-2): Rate limiting per sender (max 100 nonces/minute)
   */
  validateAndRecord(sender: string, messageType: string, nonce: string): NonceValidationResult {
    // Validate nonce format
    if (!/^0x[a-fA-F0-9]{64}$/.test(nonce)) {
      return {
        valid: false,
        reason: 'Invalid nonce format (must be bytes32)',
        receivedNonce: nonce
      };
    }

    // SECURITY FIX (H-2): Rate limit check (BEFORE global limit to avoid unnecessary work)
    if (this.checkRateLimit(sender)) {
      return {
        valid: false,
        reason: `Rate limit exceeded for sender ${sender}: ` +
                `Maximum ${this.maxNoncesPerMinute} nonces per minute allowed. ` +
                `This may indicate a flood attack or misconfigured client. ` +
                `Wait 1 minute before retrying.`,
        receivedNonce: nonce
      };
    }

    // SECURITY FIX (H-2): Periodic cleanup every 100 validations (amortized cost)
    if (this.totalEntries % 100 === 0) {
      this.cleanupRateLimitState();
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
      senderNonces = new Map<string, Set<string>>();
      this.usedNonces.set(sender, senderNonces);
    }

    // Get set of used nonces for this message type
    let usedSet = senderNonces.get(messageType);
    if (!usedSet) {
      usedSet = new Set<string>();
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
  private getCombinationCount(): number {
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
  getMemoryUsage(): { totalEntries: number; combinations: number; maxTotalEntries: number } {
    return {
      totalEntries: this.totalEntries,
      combinations: this.getCombinationCount(),
      maxTotalEntries: this.maxTotalEntries
    };
  }

  /**
   * Check if a nonce has been used
   */
  hasBeenUsed(sender: string, messageType: string, nonce: string): boolean {
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
  getHighestNonce(sender: string, messageType: string): string | null {
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
  reset(sender: string, messageType: string): void {
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
  clearAll(): void {
    this.usedNonces.clear();
    // SECURITY FIX (HIGH-2): Reset global counter
    this.totalEntries = 0;
  }

  /**
   * Get nonce count for sender + message type (for monitoring)
   */
  getNonceCount(sender: string, messageType: string): number {
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
  cleanup(sender: string, messageType: string, keepLast: number = 1000): void {
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

/**
 * Factory function to create a nonce tracker
 * @param strategy - 'memory-efficient' (highest nonce) or 'set-based' (all nonces)
 * @returns IReceivedNonceTracker instance
 */
export function createReceivedNonceTracker(
  strategy: 'memory-efficient' | 'set-based' = 'memory-efficient'
): IReceivedNonceTracker {
  if (strategy === 'set-based') {
    return new SetBasedReceivedNonceTracker();
  }
  return new InMemoryReceivedNonceTracker();
}
