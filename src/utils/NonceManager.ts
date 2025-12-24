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

import { assertSafeFileForRead, ensureSafeDir, ensureSafeFile } from './fsSafe';

/**
 * Maximum allowed nonce value.
 * SECURITY FIX (H-5): Prevents nonce overflow attacks.
 * Using Number.MAX_SAFE_INTEGER (2^53 - 1) to ensure safe JavaScript integer operations.
 */
export const MAX_NONCE_VALUE = Number.MAX_SAFE_INTEGER;

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
export class InMemoryNonceManager implements NonceManager {
  private nonces: Map<string, number> = new Map();
  // SECURITY FIX (C-2): Mutex for atomic nonce operations
  // Store both the promise and its resolver for proper lock release
  private locks: Map<string, { promise: Promise<void>; resolve: () => void }> = new Map();

  /**
   * Create in-memory nonce manager
   * @param initialNonces - Optional initial nonce values (for recovery)
   */
  constructor(initialNonces?: Record<string, number>) {
    if (initialNonces) {
      Object.entries(initialNonces).forEach(([messageType, nonce]) => {
        // SECURITY FIX (H-5): Validate initial nonces
        if (nonce > MAX_NONCE_VALUE) {
          throw new Error(
            `Initial nonce ${nonce} for ${messageType} exceeds maximum allowed value ${MAX_NONCE_VALUE}`
          );
        }
        this.nonces.set(messageType, nonce);
      });
    }
  }

  /**
   * SECURITY FIX (C-2 + DEADLOCK-FIX): Acquire lock for message type
   * Ensures atomic nonce operations.
   *
   * FIXED: Previous implementation had a deadlock bug where:
   * - The resolver was stored in a closure but never accessible to releaseLock()
   * - releaseLock() just deleted the entry without resolving waiting Promises
   *
   * New implementation stores both promise AND resolver together.
   */
  private async acquireLock(messageType: string): Promise<void> {
    // Wait for any existing lock to be released
    while (this.locks.has(messageType)) {
      const existingLock = this.locks.get(messageType);
      if (existingLock) {
        await existingLock.promise;
      }
    }

    // Create new lock with stored resolver
    let resolver: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    this.locks.set(messageType, { promise: lockPromise, resolve: resolver });
  }

  /**
   * SECURITY FIX (C-2 + DEADLOCK-FIX): Release lock for message type
   *
   * FIXED: Now properly resolves the Promise before deleting,
   * so any waiting acquireLock() calls can proceed.
   */
  private releaseLock(messageType: string): void {
    const lock = this.locks.get(messageType);
    if (lock) {
      lock.resolve(); // Resolve the promise first
      this.locks.delete(messageType); // Then delete the entry
    }
  }

  /**
   * Get next nonce for message type
   * @param messageType - Message type identifier
   * @returns Monotonically increasing nonce
   */
  getNextNonce(messageType: string): number {
    const current = this.nonces.get(messageType) || 0;
    const next = current + 1;

    // SECURITY FIX (H-5): Check upper bound
    if (next > MAX_NONCE_VALUE) {
      throw new Error(
        `Nonce overflow: next nonce ${next} exceeds maximum allowed value ${MAX_NONCE_VALUE}. ` +
        `Consider resetting nonces or using a larger storage type.`
      );
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
  async getAndIncrementNonce(messageType: string): Promise<number> {
    await this.acquireLock(messageType);
    try {
      const current = this.nonces.get(messageType) || 0;
      const next = current + 1;

      // SECURITY FIX (H-5): Check upper bound
      if (next > MAX_NONCE_VALUE) {
        throw new Error(
          `Nonce overflow: next nonce ${next} exceeds maximum allowed value ${MAX_NONCE_VALUE}`
        );
      }

      this.nonces.set(messageType, next);
      return next;
    } finally {
      this.releaseLock(messageType);
    }
  }

  /**
   * Record nonce usage
   * @param messageType - Message type identifier
   * @param nonce - Nonce used
   */
  recordNonce(messageType: string, nonce: number): void {
    const current = this.nonces.get(messageType) || 0;

    // SECURITY FIX (H-5): Check upper bound
    if (nonce > MAX_NONCE_VALUE) {
      throw new Error(
        `Nonce ${nonce} exceeds maximum allowed value ${MAX_NONCE_VALUE}`
      );
    }

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
 * File-based Nonce Manager for Persistent Storage
 *
 * SECURITY FIX (H-1): Persists nonces to disk to survive process restarts.
 * SECURITY FIX (NEW-H-4): File locking to prevent concurrent write corruption.
 * Uses atomic file writes (temp file + rename) for crash safety.
 *
 * @module utils/NonceManager
 */
export class FileBasedNonceManager implements NonceManager {
  private inMemory: InMemoryNonceManager;
  private filePath: string;
  private fs: typeof import('fs');
  private path: typeof import('path');
  private lockfile: typeof import('proper-lockfile');

  /**
   * Create file-based nonce manager
   * @param stateDirectory - Directory to store nonces file
   */
  constructor(stateDirectory: string) {
    this.fs = require('fs');
    this.path = require('path');
    // SECURITY FIX (NEW-H-4): File locking to prevent race conditions
    this.lockfile = require('proper-lockfile');

    // Ensure .actp directory exists
    const actpDir = this.path.join(stateDirectory, '.actp');
    ensureSafeDir(actpDir, 0o755);

    this.filePath = this.path.join(actpDir, 'nonces.json');

    // Load existing nonces
    const initialNonces = this.loadFromFile();
    this.inMemory = new InMemoryNonceManager(initialNonces);
  }

  /**
   * Load nonces from file
   */
  private loadFromFile(): Record<string, number> | undefined {
    if (!this.fs.existsSync(this.filePath)) {
      return undefined;
    }

    try {
      // SECURITY: Refuse to read from symlinked nonce files
      assertSafeFileForRead(this.filePath);

      const MAX_NONCE_FILE_SIZE = 5 * 1024 * 1024; // 5MB
      const st = this.fs.statSync(this.filePath);
      if (st.size > MAX_NONCE_FILE_SIZE) {
        throw new Error(
          `nonces.json exceeds ${MAX_NONCE_FILE_SIZE / 1024 / 1024}MB limit: ${this.filePath}`
        );
      }

      const data = JSON.parse(this.fs.readFileSync(this.filePath, 'utf-8'));
      return data as Record<string, number>;
    } catch (e: any) {
      // Fail closed: nonce resets can enable replay.
      throw new Error(
        `Failed to parse nonces.json (replay protection would be weakened). ` +
          `Fix/delete the file: ${this.filePath}. Error: ${e?.message || String(e)}`
      );
    }
  }

  /**
   * Save nonces to file atomically with file locking
   *
   * SECURITY FIX (NEW-H-4): File locking prevents concurrent write corruption
   */
  private async saveToFile(): Promise<void> {
    const data = this.inMemory.getAllNonces();
    const tempPath = `${this.filePath}.tmp`;

    // SECURITY FIX: Ensure file exists before locking (proper-lockfile requirement)
    ensureSafeFile(this.filePath, '{}', 0o644);

    // SECURITY FIX (NEW-H-4): Acquire file lock before writing
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.lockfile.lock(this.filePath, {
        stale: 10000, // Lock expires after 10 seconds if process crashes
        retries: {
          retries: 5,
          minTimeout: 100,
          maxTimeout: 500
        }
      });

      // Atomic write: temp file + rename
      if (this.fs.existsSync(tempPath)) {
        this.fs.unlinkSync(tempPath);
      }
      this.fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: 0o644,
        flag: 'wx'
      });
      this.fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      // Clean up temp file on error
      if (this.fs.existsSync(tempPath)) {
        try {
          this.fs.unlinkSync(tempPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      throw error;
    } finally {
      if (release) {
        await release();
      }
    }
  }

  getNextNonce(messageType: string): number {
    return this.inMemory.getNextNonce(messageType);
  }

  /**
   * Atomic get and increment with persistence
   */
  async getAndIncrementNonce(messageType: string): Promise<number> {
    const nonce = await this.inMemory.getAndIncrementNonce(messageType);
    // SECURITY FIX (NEW-H-4): saveToFile is now async
    await this.saveToFile();
    return nonce;
  }

  recordNonce(messageType: string, nonce: number): void {
    this.inMemory.recordNonce(messageType, nonce);
    // Fire-and-forget to maintain sync interface
    this.saveToFile().catch((err) => {
      console.error('Failed to save nonce manager state:', err);
    });
  }

  getCurrentNonce(messageType: string): number {
    return this.inMemory.getCurrentNonce(messageType);
  }

  resetNonce(messageType: string): void {
    this.inMemory.resetNonce(messageType);
    // Fire-and-forget to maintain sync interface
    this.saveToFile().catch((err) => {
      console.error('Failed to save nonce manager state:', err);
    });
  }

  getAllNonces(): Record<string, number> {
    return this.inMemory.getAllNonces();
  }

  clearAll(): void {
    this.inMemory.clearAll();
    if (this.fs.existsSync(this.filePath)) {
      this.fs.unlinkSync(this.filePath);
    }
  }
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
export function createNonceManager(
  options?: {
    did?: string;
    initialNonces?: Record<string, number>;
    stateDirectory?: string;
  }
): NonceManager {
  // SECURITY FIX (H-1): Support persistent storage
  if (options?.stateDirectory) {
    return new FileBasedNonceManager(options.stateDirectory);
  }

  if (options?.did) {
    return new DIDScopedNonceManager(options.did, options?.initialNonces);
  }

  return new InMemoryNonceManager(options?.initialNonces);
}
