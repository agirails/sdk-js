"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileBasedNonceManager = exports.DIDScopedNonceManager = exports.InMemoryNonceManager = exports.MAX_NONCE_VALUE = void 0;
exports.createNonceManager = createNonceManager;
/**
 * Maximum allowed nonce value.
 * SECURITY FIX (H-5): Prevents nonce overflow attacks.
 * Using Number.MAX_SAFE_INTEGER (2^53 - 1) to ensure safe JavaScript integer operations.
 */
exports.MAX_NONCE_VALUE = Number.MAX_SAFE_INTEGER;
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
class InMemoryNonceManager {
    /**
     * Create in-memory nonce manager
     * @param initialNonces - Optional initial nonce values (for recovery)
     */
    constructor(initialNonces) {
        this.nonces = new Map();
        // SECURITY FIX (C-2): Mutex for atomic nonce operations
        this.locks = new Map();
        if (initialNonces) {
            Object.entries(initialNonces).forEach(([messageType, nonce]) => {
                // SECURITY FIX (H-5): Validate initial nonces
                if (nonce > exports.MAX_NONCE_VALUE) {
                    throw new Error(`Initial nonce ${nonce} for ${messageType} exceeds maximum allowed value ${exports.MAX_NONCE_VALUE}`);
                }
                this.nonces.set(messageType, nonce);
            });
        }
    }
    /**
     * SECURITY FIX (C-2): Acquire lock for message type
     * Ensures atomic nonce operations
     */
    async acquireLock(messageType) {
        while (this.locks.has(messageType)) {
            await this.locks.get(messageType);
        }
        let releaseLock;
        const lockPromise = new Promise((resolve) => {
            releaseLock = resolve;
        });
        this.locks.set(messageType, lockPromise);
        return;
    }
    /**
     * SECURITY FIX (C-2): Release lock for message type
     */
    releaseLock(messageType) {
        this.locks.delete(messageType);
    }
    /**
     * Get next nonce for message type
     * @param messageType - Message type identifier
     * @returns Monotonically increasing nonce
     */
    getNextNonce(messageType) {
        const current = this.nonces.get(messageType) || 0;
        const next = current + 1;
        // SECURITY FIX (H-5): Check upper bound
        if (next > exports.MAX_NONCE_VALUE) {
            throw new Error(`Nonce overflow: next nonce ${next} exceeds maximum allowed value ${exports.MAX_NONCE_VALUE}. ` +
                `Consider resetting nonces or using a larger storage type.`);
        }
        return next;
    }
    /**
     * SECURITY FIX (C-2): Atomic get-and-increment nonce
     * Returns the next nonce and records it atomically to prevent race conditions.
     *
     * @param messageType - Message type identifier
     * @returns Atomically allocated nonce
     */
    async getAndIncrementNonce(messageType) {
        await this.acquireLock(messageType);
        try {
            const current = this.nonces.get(messageType) || 0;
            const next = current + 1;
            // SECURITY FIX (H-5): Check upper bound
            if (next > exports.MAX_NONCE_VALUE) {
                throw new Error(`Nonce overflow: next nonce ${next} exceeds maximum allowed value ${exports.MAX_NONCE_VALUE}`);
            }
            this.nonces.set(messageType, next);
            return next;
        }
        finally {
            this.releaseLock(messageType);
        }
    }
    /**
     * Record nonce usage
     * @param messageType - Message type identifier
     * @param nonce - Nonce used
     */
    recordNonce(messageType, nonce) {
        const current = this.nonces.get(messageType) || 0;
        // SECURITY FIX (H-5): Check upper bound
        if (nonce > exports.MAX_NONCE_VALUE) {
            throw new Error(`Nonce ${nonce} exceeds maximum allowed value ${exports.MAX_NONCE_VALUE}`);
        }
        // Ensure monotonic increase
        if (nonce <= current) {
            throw new Error(`Nonce must be strictly increasing: attempted ${nonce}, current is ${current}`);
        }
        this.nonces.set(messageType, nonce);
    }
    /**
     * Get current nonce (last used)
     * @param messageType - Message type identifier
     * @returns Current nonce or 0 if none used
     */
    getCurrentNonce(messageType) {
        return this.nonces.get(messageType) || 0;
    }
    /**
     * Reset nonce for message type
     * @param messageType - Message type identifier
     */
    resetNonce(messageType) {
        this.nonces.delete(messageType);
    }
    /**
     * Get all nonces (for persistence)
     * @returns Record of all message type nonces
     */
    getAllNonces() {
        return Object.fromEntries(this.nonces.entries());
    }
    /**
     * Clear all nonces
     */
    clearAll() {
        this.nonces.clear();
    }
}
exports.InMemoryNonceManager = InMemoryNonceManager;
/**
 * DID-Scoped Nonce Manager
 * Tracks nonces per DID + message type combination
 * Recommended for multi-agent scenarios
 */
class DIDScopedNonceManager {
    /**
     * Create DID-scoped nonce manager
     * @param did - DID to track nonces for
     * @param initialNonces - Optional initial nonce values
     */
    constructor(did, initialNonces) {
        this.nonces = new Map();
        this.currentDID = did;
        if (initialNonces) {
            const didNonces = new Map();
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
    getNextNonce(messageType) {
        return this.getNextNonceForDID(this.currentDID, messageType);
    }
    /**
     * Record nonce usage (current DID)
     * @param messageType - Message type identifier
     * @param nonce - Nonce used
     */
    recordNonce(messageType, nonce) {
        this.recordNonceForDID(this.currentDID, messageType, nonce);
    }
    /**
     * Get current nonce (current DID)
     * @param messageType - Message type identifier
     * @returns Current nonce or 0 if none used
     */
    getCurrentNonce(messageType) {
        return this.getCurrentNonceForDID(this.currentDID, messageType);
    }
    /**
     * Reset nonce for message type (current DID)
     * @param messageType - Message type identifier
     */
    resetNonce(messageType) {
        this.resetNonceForDID(this.currentDID, messageType);
    }
    /**
     * Get next nonce for specific DID + message type
     * @param did - DID identifier
     * @param messageType - Message type identifier
     * @returns Monotonically increasing nonce
     */
    getNextNonceForDID(did, messageType) {
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
    recordNonceForDID(did, messageType, nonce) {
        let didNonces = this.nonces.get(did);
        if (!didNonces) {
            didNonces = new Map();
            this.nonces.set(did, didNonces);
        }
        const current = didNonces.get(messageType) || 0;
        // Ensure monotonic increase
        if (nonce <= current) {
            throw new Error(`Nonce must be strictly increasing for ${did}: attempted ${nonce}, current is ${current}`);
        }
        didNonces.set(messageType, nonce);
    }
    /**
     * Get current nonce for specific DID + message type
     * @param did - DID identifier
     * @param messageType - Message type identifier
     * @returns Current nonce or 0 if none used
     */
    getCurrentNonceForDID(did, messageType) {
        const didNonces = this.nonces.get(did);
        return didNonces?.get(messageType) || 0;
    }
    /**
     * Reset nonce for specific DID + message type
     * @param did - DID identifier
     * @param messageType - Message type identifier
     */
    resetNonceForDID(did, messageType) {
        const didNonces = this.nonces.get(did);
        if (didNonces) {
            didNonces.delete(messageType);
        }
    }
    /**
     * Switch current DID context
     * @param did - New DID to track
     */
    switchDID(did) {
        this.currentDID = did;
    }
    /**
     * Get all nonces for all DIDs (for persistence)
     * @returns Nested record of DID → message type → nonce
     */
    getAllNonces() {
        const result = {};
        this.nonces.forEach((didNonces, did) => {
            result[did] = Object.fromEntries(didNonces.entries());
        });
        return result;
    }
    /**
     * Clear all nonces for all DIDs
     */
    clearAll() {
        this.nonces.clear();
    }
}
exports.DIDScopedNonceManager = DIDScopedNonceManager;
/**
 * File-based Nonce Manager for Persistent Storage
 *
 * SECURITY FIX (H-1): Persists nonces to disk to survive process restarts.
 * SECURITY FIX (NEW-H-4): File locking to prevent concurrent write corruption.
 * Uses atomic file writes (temp file + rename) for crash safety.
 *
 * @module utils/NonceManager
 */
class FileBasedNonceManager {
    /**
     * Create file-based nonce manager
     * @param stateDirectory - Directory to store nonces file
     */
    constructor(stateDirectory) {
        this.fs = require('fs');
        this.path = require('path');
        // SECURITY FIX (NEW-H-4): File locking to prevent race conditions
        this.lockfile = require('proper-lockfile');
        // Ensure .actp directory exists
        const actpDir = this.path.join(stateDirectory, '.actp');
        if (!this.fs.existsSync(actpDir)) {
            this.fs.mkdirSync(actpDir, { recursive: true, mode: 0o755 });
        }
        this.filePath = this.path.join(actpDir, 'nonces.json');
        // Load existing nonces
        const initialNonces = this.loadFromFile();
        this.inMemory = new InMemoryNonceManager(initialNonces);
    }
    /**
     * Load nonces from file
     */
    loadFromFile() {
        if (!this.fs.existsSync(this.filePath)) {
            return undefined;
        }
        try {
            const data = JSON.parse(this.fs.readFileSync(this.filePath, 'utf-8'));
            return data;
        }
        catch {
            // File corrupted, start fresh
            return undefined;
        }
    }
    /**
     * Save nonces to file atomically with file locking
     *
     * SECURITY FIX (NEW-H-4): File locking prevents concurrent write corruption
     */
    async saveToFile() {
        const data = this.inMemory.getAllNonces();
        const tempPath = `${this.filePath}.tmp`;
        // SECURITY FIX (NEW-H-4): Acquire file lock before writing
        const release = await this.lockfile.lock(this.filePath, {
            stale: 10000, // Lock expires after 10 seconds if process crashes
            retries: {
                retries: 5,
                minTimeout: 100,
                maxTimeout: 500
            }
        });
        try {
            // Atomic write: temp file + rename
            this.fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), {
                encoding: 'utf-8',
                mode: 0o644
            });
            this.fs.renameSync(tempPath, this.filePath);
        }
        finally {
            // Always release lock
            await release();
        }
    }
    getNextNonce(messageType) {
        return this.inMemory.getNextNonce(messageType);
    }
    /**
     * Atomic get and increment with persistence
     */
    async getAndIncrementNonce(messageType) {
        const nonce = await this.inMemory.getAndIncrementNonce(messageType);
        // SECURITY FIX (NEW-H-4): saveToFile is now async
        await this.saveToFile();
        return nonce;
    }
    recordNonce(messageType, nonce) {
        this.inMemory.recordNonce(messageType, nonce);
        // Fire-and-forget to maintain sync interface
        this.saveToFile().catch((err) => {
            console.error('Failed to save nonce manager state:', err);
        });
    }
    getCurrentNonce(messageType) {
        return this.inMemory.getCurrentNonce(messageType);
    }
    resetNonce(messageType) {
        this.inMemory.resetNonce(messageType);
        // Fire-and-forget to maintain sync interface
        this.saveToFile().catch((err) => {
            console.error('Failed to save nonce manager state:', err);
        });
    }
    getAllNonces() {
        return this.inMemory.getAllNonces();
    }
    clearAll() {
        this.inMemory.clearAll();
        if (this.fs.existsSync(this.filePath)) {
            this.fs.unlinkSync(this.filePath);
        }
    }
}
exports.FileBasedNonceManager = FileBasedNonceManager;
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
function createNonceManager(options) {
    // SECURITY FIX (H-1): Support persistent storage
    if (options?.stateDirectory) {
        return new FileBasedNonceManager(options.stateDirectory);
    }
    if (options?.did) {
        return new DIDScopedNonceManager(options.did, options?.initialNonces);
    }
    return new InMemoryNonceManager(options?.initialNonces);
}
//# sourceMappingURL=NonceManager.js.map