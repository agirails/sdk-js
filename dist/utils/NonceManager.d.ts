/**
 * Nonce Manager Implementation
 * Tracks nonces per DID + message type for AIP-4 delivery proofs
 * Reference: AIP-4 §3.2 (nonce field requirement)
 *
 * SECURITY FIXES:
 * - C-2: Added atomic nonce allocation with locking
 * - H-1: Added persistent nonce storage option
 * - H-5: Added nonce upper bound validation
 */
/**
 * Maximum allowed nonce value.
 * SECURITY FIX (H-5): Prevents nonce overflow attacks.
 * Using Number.MAX_SAFE_INTEGER (2^53 - 1) to ensure safe JavaScript integer operations.
 */
export declare const MAX_NONCE_VALUE: number;
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
 * SECURITY FIXES:
 * - C-2: Added atomic getAndIncrementNonce() to prevent race conditions
 * - H-5: Added nonce upper bound validation
 *
 * ⚠️ WARNING: Nonces are lost on process restart. For production:
 * - Use persistent storage (Redis, PostgreSQL, etc.)
 * - Implement nonce recovery from blockchain events
 * - Add DID-scoped nonce tracking
 */
export declare class InMemoryNonceManager implements NonceManager {
    private nonces;
    private locks;
    /**
     * Create in-memory nonce manager
     * @param initialNonces - Optional initial nonce values (for recovery)
     */
    constructor(initialNonces?: Record<string, number>);
    /**
     * SECURITY FIX (C-2): Acquire lock for message type
     * Ensures atomic nonce operations
     */
    private acquireLock;
    /**
     * SECURITY FIX (C-2): Release lock for message type
     */
    private releaseLock;
    /**
     * Get next nonce for message type
     * @param messageType - Message type identifier
     * @returns Monotonically increasing nonce
     */
    getNextNonce(messageType: string): number;
    /**
     * SECURITY FIX (C-2): Atomic get-and-increment nonce
     * Returns the next nonce and records it atomically to prevent race conditions.
     *
     * @param messageType - Message type identifier
     * @returns Atomically allocated nonce
     */
    getAndIncrementNonce(messageType: string): Promise<number>;
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
    /**
     * Get all nonces (for persistence)
     * @returns Record of all message type nonces
     */
    getAllNonces(): Record<string, number>;
    /**
     * Clear all nonces
     */
    clearAll(): void;
}
/**
 * DID-Scoped Nonce Manager
 * Tracks nonces per DID + message type combination
 * Recommended for multi-agent scenarios
 */
export declare class DIDScopedNonceManager implements NonceManager {
    private nonces;
    private currentDID;
    /**
     * Create DID-scoped nonce manager
     * @param did - DID to track nonces for
     * @param initialNonces - Optional initial nonce values
     */
    constructor(did: string, initialNonces?: Record<string, number>);
    /**
     * Get next nonce for message type (current DID)
     * @param messageType - Message type identifier
     * @returns Monotonically increasing nonce
     */
    getNextNonce(messageType: string): number;
    /**
     * Record nonce usage (current DID)
     * @param messageType - Message type identifier
     * @param nonce - Nonce used
     */
    recordNonce(messageType: string, nonce: number): void;
    /**
     * Get current nonce (current DID)
     * @param messageType - Message type identifier
     * @returns Current nonce or 0 if none used
     */
    getCurrentNonce(messageType: string): number;
    /**
     * Reset nonce for message type (current DID)
     * @param messageType - Message type identifier
     */
    resetNonce(messageType: string): void;
    /**
     * Get next nonce for specific DID + message type
     * @param did - DID identifier
     * @param messageType - Message type identifier
     * @returns Monotonically increasing nonce
     */
    getNextNonceForDID(did: string, messageType: string): number;
    /**
     * Record nonce usage for specific DID + message type
     * @param did - DID identifier
     * @param messageType - Message type identifier
     * @param nonce - Nonce used
     */
    recordNonceForDID(did: string, messageType: string, nonce: number): void;
    /**
     * Get current nonce for specific DID + message type
     * @param did - DID identifier
     * @param messageType - Message type identifier
     * @returns Current nonce or 0 if none used
     */
    getCurrentNonceForDID(did: string, messageType: string): number;
    /**
     * Reset nonce for specific DID + message type
     * @param did - DID identifier
     * @param messageType - Message type identifier
     */
    resetNonceForDID(did: string, messageType: string): void;
    /**
     * Switch current DID context
     * @param did - New DID to track
     */
    switchDID(did: string): void;
    /**
     * Get all nonces for all DIDs (for persistence)
     * @returns Nested record of DID → message type → nonce
     */
    getAllNonces(): Record<string, Record<string, number>>;
    /**
     * Clear all nonces for all DIDs
     */
    clearAll(): void;
}
/**
 * File-based Nonce Manager for Persistent Storage
 *
 * SECURITY FIX (H-1): Persists nonces to disk to survive process restarts.
 * SECURITY FIX (NEW-H-4): File locking to prevent concurrent write corruption.
 * Uses atomic file writes (temp file + rename) for crash safety.
 *
 * @module utils/NonceManager
 */
export declare class FileBasedNonceManager implements NonceManager {
    private inMemory;
    private filePath;
    private fs;
    private path;
    private lockfile;
    /**
     * Create file-based nonce manager
     * @param stateDirectory - Directory to store nonces file
     */
    constructor(stateDirectory: string);
    /**
     * Load nonces from file
     */
    private loadFromFile;
    /**
     * Save nonces to file atomically with file locking
     *
     * SECURITY FIX (NEW-H-4): File locking prevents concurrent write corruption
     */
    private saveToFile;
    getNextNonce(messageType: string): number;
    /**
     * Atomic get and increment with persistence
     */
    getAndIncrementNonce(messageType: string): Promise<number>;
    recordNonce(messageType: string, nonce: number): void;
    getCurrentNonce(messageType: string): number;
    resetNonce(messageType: string): void;
    getAllNonces(): Record<string, number>;
    clearAll(): void;
}
/**
 * Create nonce manager based on environment
 * @param options - Configuration options
 * @returns NonceManager instance
 *
 * @example
 * ```typescript
 * // In-memory (default)
 * const manager = createNonceManager();
 *
 * // DID-scoped
 * const manager = createNonceManager({ did: 'did:ethr:0x...' });
 *
 * // Persistent (survives restarts)
 * const manager = createNonceManager({ stateDirectory: '/path/to/project' });
 * ```
 */
export declare function createNonceManager(options?: {
    did?: string;
    initialNonces?: Record<string, number>;
    stateDirectory?: string;
}): NonceManager;
//# sourceMappingURL=NonceManager.d.ts.map