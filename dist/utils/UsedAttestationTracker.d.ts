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
export declare class InMemoryUsedAttestationTracker implements IUsedAttestationTracker {
    private usedAttestations;
    private readonly maxSize;
    /**
     * Create in-memory tracker with optional max size
     * @param maxSize - Maximum entries to store (default: 100,000)
     */
    constructor(maxSize?: number);
    /**
     * Record that an attestation was used for a transaction
     * @param attestationUID - EAS attestation UID (bytes32)
     * @param txId - Transaction ID (bytes32)
     * @returns true if recorded, false if already used for different transaction
     *
     * SECURITY FIX (NEW-H-2): LRU eviction when max size reached
     * SECURITY FIX (HIGH-1): Now async for interface consistency
     */
    recordUsage(attestationUID: string, txId: string): Promise<boolean>;
    /**
     * Synchronous version of recordUsage (for backward compatibility)
     * @param attestationUID - EAS attestation UID (bytes32)
     * @param txId - Transaction ID (bytes32)
     * @returns true if recorded, false if already used for different transaction
     */
    recordUsageSync(attestationUID: string, txId: string): boolean;
    /**
     * Check if attestation has been used
     * @param attestationUID - EAS attestation UID (bytes32)
     * @returns Transaction ID if used, null if not used
     *
     * SECURITY FIX (MEDIUM-4): Updates access order for true LRU behavior
     * Accessed items are moved to end of Map (most recently used)
     */
    getUsageForAttestation(attestationUID: string): string | null;
    /**
     * Check if attestation is valid for transaction
     * @param attestationUID - EAS attestation UID
     * @param txId - Transaction ID
     * @returns true if attestation is unused or already used for this txId
     *
     * SECURITY FIX (MEDIUM-4): Updates access order for true LRU behavior
     */
    isValidForTransaction(attestationUID: string, txId: string): boolean;
    /**
     * Clear all tracked attestations
     */
    clear(): void;
    /**
     * Get all tracked attestations (for debugging/persistence)
     */
    getAllUsages(): Record<string, string>;
    /**
     * Get count of tracked attestations
     */
    getCount(): number;
    /**
     * Cleanup old entries based on timestamp (optional)
     *
     * SECURITY FIX (NEW-H-2): Manual cleanup for old entries
     * Note: This requires external timestamp tracking. For automatic cleanup,
     * use FileBasedUsedAttestationTracker with periodic cleanup.
     *
     * @param maxAgeHours - Remove entries older than this many hours
     */
    cleanupOldEntries(maxAgeHours: number): number;
}
/**
 * File-based Used Attestation Tracker for persistence
 *
 * SECURITY FIX (C-1): Persistent storage for attestation tracking
 * SECURITY FIX (NEW-H-4): File locking to prevent concurrent write corruption
 *
 * Survives process restarts.
 */
export declare class FileBasedUsedAttestationTracker implements IUsedAttestationTracker {
    private inMemory;
    private filePath;
    private fs;
    private path;
    private lockfile;
    constructor(stateDirectory: string);
    private loadFromFile;
    /**
     * Save data to file with file locking
     *
     * SECURITY FIX (NEW-H-4): File locking prevents concurrent write corruption
     * SECURITY FIX (NEW-HIGH-1): Create file before locking if it doesn't exist
     */
    private saveToFile;
    /**
     * Record attestation usage with guaranteed persistence
     *
     * SECURITY FIX (HIGH-1): Now properly awaits persistence to prevent data loss
     */
    recordUsage(attestationUID: string, txId: string): Promise<boolean>;
    /**
     * Fire-and-forget version for backward compatibility
     * WARNING: May lose data if process crashes before save completes
     */
    recordUsageSync(attestationUID: string, txId: string): boolean;
    getUsageForAttestation(attestationUID: string): string | null;
    isValidForTransaction(attestationUID: string, txId: string): boolean;
    clear(): void;
}
/**
 * Factory to create attestation tracker
 * @param stateDirectory - Optional directory for persistent storage
 * @returns IUsedAttestationTracker instance
 */
export declare function createUsedAttestationTracker(stateDirectory?: string): IUsedAttestationTracker;
//# sourceMappingURL=UsedAttestationTracker.d.ts.map