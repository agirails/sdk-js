/**
 * UsedAttestationTracker - Prevents EAS Attestation Replay Attacks (C-1)
 *
 * Tracks which attestation UIDs have been used for which transaction IDs.
 * This prevents a malicious provider from reusing an attestation from
 * Transaction A to settle Transaction B.
 *
 * SECURITY: ACTPKernel V1 contract accepts any attestationUID without validation.
 * This tracker provides SDK-side protection until contract is upgraded.
 *
 * @module utils/UsedAttestationTracker
 */

import { assertSafeFileForRead, ensureSafeDir, ensureSafeFile } from './fsSafe';

/**
 * Interface for tracking used attestations
 */
export interface IUsedAttestationTracker {
  /**
   * Record that an attestation was used for a transaction
   * @param attestationUID - EAS attestation UID (bytes32)
   * @param txId - Transaction ID (bytes32)
   * @returns true if recorded, false if already used for different transaction
   *
   * SECURITY FIX (HIGH-1): This method is now async to ensure persistence completes
   * before returning. Use recordUsageSync() for fire-and-forget behavior.
   */
  recordUsage(attestationUID: string, txId: string): Promise<boolean>;

  /**
   * Check if attestation has been used
   * @param attestationUID - EAS attestation UID (bytes32)
   * @returns Transaction ID if used, null if not used
   */
  getUsageForAttestation(attestationUID: string): string | null;

  /**
   * Check if attestation is valid for transaction
   * @param attestationUID - EAS attestation UID
   * @param txId - Transaction ID
   * @returns true if attestation is unused or already used for this txId
   */
  isValidForTransaction(attestationUID: string, txId: string): boolean;

  /**
   * Clear all tracked attestations
   */
  clear(): void;
}

/**
 * In-Memory Used Attestation Tracker
 *
 * SECURITY FIX (C-1): Prevents attestation replay attacks by tracking
 * which attestation UIDs have been used for which transactions.
 *
 * SECURITY FIX (NEW-H-2): LRU-style cache with max size to prevent DoS
 *
 * WARNING: In-memory only. For production:
 * - Use persistent storage (Redis, PostgreSQL, etc.)
 * - Implement recovery from blockchain events
 */
export class InMemoryUsedAttestationTracker implements IUsedAttestationTracker {
  // Map: attestationUID -> txId
  private usedAttestations: Map<string, string> = new Map();

  // SECURITY FIX (NEW-H-2): Maximum size to prevent memory exhaustion DoS
  private readonly maxSize: number;

  /**
   * Create in-memory tracker with optional max size
   * @param maxSize - Maximum entries to store (default: 100,000)
   */
  constructor(maxSize: number = 100000) {
    if (maxSize <= 0) {
      throw new Error('maxSize must be positive');
    }
    this.maxSize = maxSize;
  }

  /**
   * Record that an attestation was used for a transaction
   * @param attestationUID - EAS attestation UID (bytes32)
   * @param txId - Transaction ID (bytes32)
   * @returns true if recorded, false if already used for different transaction
   *
   * SECURITY FIX (NEW-H-2): LRU eviction when max size reached
   * SECURITY FIX (HIGH-1): Now async for interface consistency
   */
  async recordUsage(attestationUID: string, txId: string): Promise<boolean> {
    return this.recordUsageSync(attestationUID, txId);
  }

  /**
   * Synchronous version of recordUsage (for backward compatibility)
   * @param attestationUID - EAS attestation UID (bytes32)
   * @param txId - Transaction ID (bytes32)
   * @returns true if recorded, false if already used for different transaction
   */
  recordUsageSync(attestationUID: string, txId: string): boolean {
    const normalizedUID = attestationUID.toLowerCase();
    const normalizedTxId = txId.toLowerCase();

    const existingTxId = this.usedAttestations.get(normalizedUID);

    // If attestation was already used for a different transaction, reject
    if (existingTxId && existingTxId !== normalizedTxId) {
      return false;
    }

    // SECURITY FIX (NEW-H-2): Enforce max size limit with true LRU behavior
    if (this.usedAttestations.size >= this.maxSize && !existingTxId) {
      // Remove oldest entry (first entry in Map)
      const firstKey = this.usedAttestations.keys().next().value;
      if (firstKey) {
        this.usedAttestations.delete(firstKey);
      }
    } else if (existingTxId) {
      // SECURITY FIX (M-3): True LRU - delete and re-add to move to end
      this.usedAttestations.delete(normalizedUID);
    }

    // Record the usage (at end for LRU)
    this.usedAttestations.set(normalizedUID, normalizedTxId);
    return true;
  }

  /**
   * Check if attestation has been used
   * @param attestationUID - EAS attestation UID (bytes32)
   * @returns Transaction ID if used, null if not used
   *
   * SECURITY FIX (MEDIUM-4): Updates access order for true LRU behavior
   * Accessed items are moved to end of Map (most recently used)
   */
  getUsageForAttestation(attestationUID: string): string | null {
    const normalizedUID = attestationUID.toLowerCase();
    const txId = this.usedAttestations.get(normalizedUID);

    // SECURITY FIX (MEDIUM-4): True LRU - move accessed item to end
    // Without this, eviction uses insertion order, not access order
    if (txId !== undefined) {
      this.usedAttestations.delete(normalizedUID);
      this.usedAttestations.set(normalizedUID, txId);
    }

    return txId || null;
  }

  /**
   * Check if attestation is valid for transaction
   * @param attestationUID - EAS attestation UID
   * @param txId - Transaction ID
   * @returns true if attestation is unused or already used for this txId
   *
   * SECURITY FIX (MEDIUM-4): Updates access order for true LRU behavior
   */
  isValidForTransaction(attestationUID: string, txId: string): boolean {
    const normalizedUID = attestationUID.toLowerCase();
    const normalizedTxId = txId.toLowerCase();

    const existingTxId = this.usedAttestations.get(normalizedUID);

    // SECURITY FIX (MEDIUM-4): True LRU - move accessed item to end
    if (existingTxId !== undefined) {
      this.usedAttestations.delete(normalizedUID);
      this.usedAttestations.set(normalizedUID, existingTxId);
    }

    // Valid if: not used OR used for same transaction
    return !existingTxId || existingTxId === normalizedTxId;
  }

  /**
   * Clear all tracked attestations
   */
  clear(): void {
    this.usedAttestations.clear();
  }

  /**
   * Get all tracked attestations (for debugging/persistence)
   */
  getAllUsages(): Record<string, string> {
    return Object.fromEntries(this.usedAttestations.entries());
  }

  /**
   * Get count of tracked attestations
   */
  getCount(): number {
    return this.usedAttestations.size;
  }

  /**
   * Cleanup old entries based on timestamp (optional)
   *
   * SECURITY FIX (NEW-H-2): Manual cleanup for old entries
   * Note: This requires external timestamp tracking. For automatic cleanup,
   * use FileBasedUsedAttestationTracker with periodic cleanup.
   *
   * @param maxAgeHours - Remove entries older than this many hours
   */
  cleanupOldEntries(maxAgeHours: number): number {
    // In-memory tracker doesn't track timestamps
    // This is a placeholder for future enhancement
    console.warn(
      'cleanupOldEntries not implemented for InMemoryUsedAttestationTracker. ' +
      'Consider using FileBasedUsedAttestationTracker for time-based cleanup.'
    );
    return 0;
  }
}

/**
 * File-based Used Attestation Tracker for persistence
 *
 * SECURITY FIX (C-1): Persistent storage for attestation tracking
 * SECURITY FIX (NEW-H-4): File locking to prevent concurrent write corruption
 *
 * Survives process restarts.
 */
export class FileBasedUsedAttestationTracker implements IUsedAttestationTracker {
  private inMemory: InMemoryUsedAttestationTracker;
  private filePath: string;
  private fs: typeof import('fs');
  private path: typeof import('path');
  private lockfile: typeof import('proper-lockfile');

  constructor(stateDirectory: string) {
    this.inMemory = new InMemoryUsedAttestationTracker();
    this.fs = require('fs');
    this.path = require('path');
    // SECURITY FIX (NEW-H-4): File locking to prevent race conditions
    this.lockfile = require('proper-lockfile');

    // Ensure directory exists
    const actpDir = this.path.join(stateDirectory, '.actp');
    ensureSafeDir(actpDir, 0o755);

    this.filePath = this.path.join(actpDir, 'used-attestations.json');

    // Load existing data
    this.loadFromFile();
  }

  private loadFromFile(): void {
    if (!this.fs.existsSync(this.filePath)) return;

    // SECURITY: Refuse to read from symlinked tracker files
    assertSafeFileForRead(this.filePath);

    // Basic size limit to avoid memory DoS on parse
    const MAX_TRACKER_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const st = this.fs.statSync(this.filePath);
    if (st.size > MAX_TRACKER_FILE_SIZE) {
      throw new Error(
        `used-attestations.json exceeds ${MAX_TRACKER_FILE_SIZE / 1024 / 1024}MB limit: ${this.filePath}`
      );
    }

    try {
      const data = JSON.parse(this.fs.readFileSync(this.filePath, 'utf-8'));
      for (const [uid, txId] of Object.entries(data)) {
        this.inMemory.recordUsageSync(uid, txId as string);
      }
    } catch (e: any) {
      // Fail closed: losing replay-protection state is a security issue.
      throw new Error(
        `Failed to parse used-attestations.json (replay protection would be disabled). ` +
          `Fix/delete the file: ${this.filePath}. Error: ${e?.message || String(e)}`
      );
    }
  }

  /**
   * Save data to file with file locking
   *
   * SECURITY FIX (NEW-H-4): File locking prevents concurrent write corruption
   * SECURITY FIX (NEW-HIGH-1): Create file before locking if it doesn't exist
   */
  private async saveToFile(): Promise<void> {
    const data = this.inMemory.getAllUsages();
    const tempPath = `${this.filePath}.tmp`;

    // SECURITY FIX (NEW-HIGH-1): Ensure file exists before locking
    // proper-lockfile.lock() fails on non-existent files
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
      // Always release lock if acquired
      if (release) {
        await release();
      }
    }
  }

  /**
   * Record attestation usage with guaranteed persistence
   *
   * SECURITY FIX (HIGH-1): Now properly awaits persistence to prevent data loss
   */
  async recordUsage(attestationUID: string, txId: string): Promise<boolean> {
    const result = this.inMemory.recordUsageSync(attestationUID, txId);
    if (result) {
      // SECURITY FIX (HIGH-1): Await persistence to ensure data is saved
      await this.saveToFile();
    }
    return result;
  }

  /**
   * Fire-and-forget version for backward compatibility
   * WARNING: May lose data if process crashes before save completes
   */
  recordUsageSync(attestationUID: string, txId: string): boolean {
    const result = this.inMemory.recordUsageSync(attestationUID, txId);
    if (result) {
      this.saveToFile().catch((err) => {
        console.error('Failed to save attestation tracker state:', err);
      });
    }
    return result;
  }

  getUsageForAttestation(attestationUID: string): string | null {
    return this.inMemory.getUsageForAttestation(attestationUID);
  }

  isValidForTransaction(attestationUID: string, txId: string): boolean {
    return this.inMemory.isValidForTransaction(attestationUID, txId);
  }

  clear(): void {
    this.inMemory.clear();
    if (this.fs.existsSync(this.filePath)) {
      this.fs.unlinkSync(this.filePath);
    }
  }
}

/**
 * Factory to create attestation tracker
 * @param stateDirectory - Optional directory for persistent storage
 * @returns IUsedAttestationTracker instance
 */
export function createUsedAttestationTracker(
  stateDirectory?: string
): IUsedAttestationTracker {
  if (stateDirectory) {
    return new FileBasedUsedAttestationTracker(stateDirectory);
  }
  return new InMemoryUsedAttestationTracker();
}
