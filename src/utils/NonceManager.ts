/**
 * Nonce Manager Implementation
 * Tracks nonces per DID + message type for AIP-4 delivery proofs
 * Reference: AIP-4 §3.2 (nonce field requirement)
 */

/**
 * Nonce Manager Interface (from DeliveryProofBuilder)
 */
export interface NonceManager {
  /**
   * Get next nonce for message type
   * @param messageType - Message type identifier (e.g., "agirails.delivery.v1")
   * @returns Monotonically increasing nonce
   */
  getNextNonce(messageType: string): number;

  /**
   * Record nonce usage
   * @param messageType - Message type identifier
   * @param nonce - Nonce used
   */
  recordNonce(messageType: string, nonce: number): void;

  /**
   * Get current nonce (last used)
   * @param messageType - Message type identifier
   * @returns Current nonce or 0 if none used
   */
  getCurrentNonce(messageType: string): number;

  /**
   * Reset nonce for message type
   * @param messageType - Message type identifier
   */
  resetNonce(messageType: string): void;
}

/**
 * In-Memory Nonce Manager
 * Simple implementation using Map for per-message-type nonce tracking
 *
 * ⚠️ WARNING: Nonces are lost on process restart. For production:
 * - Use persistent storage (Redis, PostgreSQL, etc.)
 * - Implement nonce recovery from blockchain events
 * - Add DID-scoped nonce tracking
 */
export class InMemoryNonceManager implements NonceManager {
  private nonces: Map<string, number> = new Map();

  /**
   * Create in-memory nonce manager
   * @param initialNonces - Optional initial nonce values (for recovery)
   */
  constructor(initialNonces?: Record<string, number>) {
    if (initialNonces) {
      Object.entries(initialNonces).forEach(([messageType, nonce]) => {
        this.nonces.set(messageType, nonce);
      });
    }
  }

  /**
   * Get next nonce for message type
   * @param messageType - Message type identifier
   * @returns Monotonically increasing nonce
   */
  getNextNonce(messageType: string): number {
    const current = this.nonces.get(messageType) || 0;
    return current + 1;
  }

  /**
   * Record nonce usage
   * @param messageType - Message type identifier
   * @param nonce - Nonce used
   */
  recordNonce(messageType: string, nonce: number): void {
    const current = this.nonces.get(messageType) || 0;

    // Ensure monotonic increase
    if (nonce <= current) {
      throw new Error(
        `Nonce must be strictly increasing: attempted ${nonce}, current is ${current}`
      );
    }

    this.nonces.set(messageType, nonce);
  }

  /**
   * Get current nonce (last used)
   * @param messageType - Message type identifier
   * @returns Current nonce or 0 if none used
   */
  getCurrentNonce(messageType: string): number {
    return this.nonces.get(messageType) || 0;
  }

  /**
   * Reset nonce for message type
   * @param messageType - Message type identifier
   */
  resetNonce(messageType: string): void {
    this.nonces.delete(messageType);
  }

  /**
   * Get all nonces (for persistence)
   * @returns Record of all message type nonces
   */
  getAllNonces(): Record<string, number> {
    return Object.fromEntries(this.nonces.entries());
  }

  /**
   * Clear all nonces
   */
  clearAll(): void {
    this.nonces.clear();
  }
}

/**
 * DID-Scoped Nonce Manager
 * Tracks nonces per DID + message type combination
 * Recommended for multi-agent scenarios
 */
export class DIDScopedNonceManager implements NonceManager {
  private nonces: Map<string, Map<string, number>> = new Map();
  private currentDID: string;

  /**
   * Create DID-scoped nonce manager
   * @param did - DID to track nonces for
   * @param initialNonces - Optional initial nonce values
   */
  constructor(did: string, initialNonces?: Record<string, number>) {
    this.currentDID = did;

    if (initialNonces) {
      const didNonces = new Map<string, number>();
      Object.entries(initialNonces).forEach(([messageType, nonce]) => {
        didNonces.set(messageType, nonce);
      });
      this.nonces.set(did, didNonces);
    }
  }

  /**
   * Get next nonce for message type (current DID)
   * @param messageType - Message type identifier
   * @returns Monotonically increasing nonce
   */
  getNextNonce(messageType: string): number {
    return this.getNextNonceForDID(this.currentDID, messageType);
  }

  /**
   * Record nonce usage (current DID)
   * @param messageType - Message type identifier
   * @param nonce - Nonce used
   */
  recordNonce(messageType: string, nonce: number): void {
    this.recordNonceForDID(this.currentDID, messageType, nonce);
  }

  /**
   * Get current nonce (current DID)
   * @param messageType - Message type identifier
   * @returns Current nonce or 0 if none used
   */
  getCurrentNonce(messageType: string): number {
    return this.getCurrentNonceForDID(this.currentDID, messageType);
  }

  /**
   * Reset nonce for message type (current DID)
   * @param messageType - Message type identifier
   */
  resetNonce(messageType: string): void {
    this.resetNonceForDID(this.currentDID, messageType);
  }

  /**
   * Get next nonce for specific DID + message type
   * @param did - DID identifier
   * @param messageType - Message type identifier
   * @returns Monotonically increasing nonce
   */
  getNextNonceForDID(did: string, messageType: string): number {
    const didNonces = this.nonces.get(did);
    if (!didNonces) {
      return 1;
    }
    const current = didNonces.get(messageType) || 0;
    return current + 1;
  }

  /**
   * Record nonce usage for specific DID + message type
   * @param did - DID identifier
   * @param messageType - Message type identifier
   * @param nonce - Nonce used
   */
  recordNonceForDID(did: string, messageType: string, nonce: number): void {
    let didNonces = this.nonces.get(did);

    if (!didNonces) {
      didNonces = new Map<string, number>();
      this.nonces.set(did, didNonces);
    }

    const current = didNonces.get(messageType) || 0;

    // Ensure monotonic increase
    if (nonce <= current) {
      throw new Error(
        `Nonce must be strictly increasing for ${did}: attempted ${nonce}, current is ${current}`
      );
    }

    didNonces.set(messageType, nonce);
  }

  /**
   * Get current nonce for specific DID + message type
   * @param did - DID identifier
   * @param messageType - Message type identifier
   * @returns Current nonce or 0 if none used
   */
  getCurrentNonceForDID(did: string, messageType: string): number {
    const didNonces = this.nonces.get(did);
    return didNonces?.get(messageType) || 0;
  }

  /**
   * Reset nonce for specific DID + message type
   * @param did - DID identifier
   * @param messageType - Message type identifier
   */
  resetNonceForDID(did: string, messageType: string): void {
    const didNonces = this.nonces.get(did);
    if (didNonces) {
      didNonces.delete(messageType);
    }
  }

  /**
   * Switch current DID context
   * @param did - New DID to track
   */
  switchDID(did: string): void {
    this.currentDID = did;
  }

  /**
   * Get all nonces for all DIDs (for persistence)
   * @returns Nested record of DID → message type → nonce
   */
  getAllNonces(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};

    this.nonces.forEach((didNonces, did) => {
      result[did] = Object.fromEntries(didNonces.entries());
    });

    return result;
  }

  /**
   * Clear all nonces for all DIDs
   */
  clearAll(): void {
    this.nonces.clear();
  }
}

/**
 * Create nonce manager based on environment
 * @param did - Optional DID for scoped tracking
 * @param initialNonces - Optional initial nonces
 * @returns NonceManager instance
 */
export function createNonceManager(
  did?: string,
  initialNonces?: Record<string, number>
): NonceManager {
  if (did) {
    return new DIDScopedNonceManager(did, initialNonces);
  }
  return new InMemoryNonceManager(initialNonces);
}
