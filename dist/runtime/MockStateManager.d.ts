/**
 * MockStateManager - Persistent state management for Mock Mode
 *
 * Responsible for persisting mock blockchain state to disk, enabling
 * state sharing across CLI commands, SDK library usage, and Dashboard.
 *
 * Features:
 * - File-based JSON persistence in `.actp/mock-state.json`
 * - Atomic file operations (write to temp file, then rename)
 * - File locking to prevent concurrent access corruption
 * - Error recovery for corrupted state files
 *
 * @module runtime/MockStateManager
 * @see ADR-001 (Mock State Persistence Strategy)
 * @see MOCK_STATE_MANAGER_SPEC.md
 */
import { MockState } from './types/MockState';
/**
 * Error thrown when mock state file is corrupted.
 */
export declare class MockStateCorruptedError extends Error {
    readonly statePath: string;
    constructor(statePath: string, cause?: Error);
}
/**
 * Error thrown when state version is unsupported.
 */
export declare class MockStateVersionError extends Error {
    readonly version: string;
    readonly supportedVersion: string;
    constructor(version: string, supportedVersion?: string);
}
/**
 * Error thrown when lock cannot be acquired.
 */
export declare class MockStateLockError extends Error {
    readonly statePath: string;
    readonly cause?: Error;
    constructor(statePath: string, cause?: Error);
}
/**
 * MockStateManager handles persistence of mock blockchain state.
 *
 * State is stored in `.actp/mock-state.json` within the project root.
 * Uses file locking to prevent corruption from concurrent access.
 *
 * @example
 * ```typescript
 * const manager = new MockStateManager();
 *
 * // Read-only access (no lock)
 * const state = manager.loadState();
 * console.log('Transactions:', Object.keys(state.transactions).length);
 *
 * // Read-modify-write with lock
 * const txId = await manager.withLock(async (state) => {
 *   const txId = generateId();
 *   state.transactions[txId] = { ... };
 *   return txId;
 * });
 * ```
 */
export declare class MockStateManager {
    /** Path to the state JSON file */
    private readonly statePath;
    /** Path to the .actp directory */
    private readonly actpDir;
    /**
     * Creates a new MockStateManager instance.
     *
     * @param projectRoot - Root directory for `.actp/` folder.
     *                      Defaults to current working directory.
     *
     * @example
     * ```typescript
     * // Use current directory
     * const manager = new MockStateManager();
     *
     * // Use specific project root
     * const manager = new MockStateManager('/path/to/project');
     * ```
     */
    constructor(projectRoot?: string);
    /**
     * Ensures the .actp directory exists.
     * Creates it with secure permissions if missing.
     */
    private ensureDirectory;
    /**
     * Loads state from disk.
     *
     * Returns default state if file doesn't exist (first run).
     * Validates version compatibility and file size limits.
     *
     * SECURITY: Validates nesting depth to prevent DoS attacks.
     *
     * @returns The current mock state
     *
     * @throws {MockStateCorruptedError} If state file contains invalid JSON
     * @throws {MockStateVersionError} If state version is not supported
     * @throws {Error} If file exceeds size limit or other I/O errors
     *
     * @example
     * ```typescript
     * const state = manager.loadState();
     * console.log('Current time:', state.blockchain.currentTime);
     * ```
     */
    loadState(): MockState;
    /**
     * Saves state to disk atomically.
     *
     * Uses write-to-temp-then-rename pattern to ensure atomicity:
     * 1. Write state to `.tmp` file
     * 2. Rename `.tmp` to final path (atomic on POSIX)
     *
     * This prevents corruption if process crashes during write.
     *
     * @param state - The state to save
     *
     * @throws {Error} If write fails (disk full, permissions, etc.)
     *
     * @example
     * ```typescript
     * const state = manager.loadState();
     * state.blockchain.currentTime += 3600; // Advance 1 hour
     * manager.saveState(state);
     * ```
     */
    saveState(state: MockState): void;
    /**
     * Executes an operation with exclusive file lock.
     *
     * Provides read-modify-write semantics with concurrency protection:
     * 1. Acquires exclusive lock on state file
     * 2. Loads current state
     * 3. Executes operation (may modify state)
     * 4. Saves updated state
     * 5. Releases lock
     *
     * Lock is always released, even if operation throws.
     *
     * @typeParam T - Return type of the operation
     * @param operation - Function that receives state and returns result.
     *                    Can be sync or async. May modify state object.
     *
     * @returns Promise resolving to operation's return value
     *
     * @throws {MockStateLockError} If lock cannot be acquired after retries
     * @throws {Error} If operation throws or save fails
     *
     * @example
     * ```typescript
     * // Create transaction with lock
     * const txId = await manager.withLock(async (state) => {
     *   const txId = '0x' + crypto.randomBytes(32).toString('hex');
     *   state.transactions[txId] = {
     *     id: txId,
     *     state: 'INITIATED',
     *     // ...
     *   };
     *   return txId;
     * });
     * ```
     */
    withLock<T>(operation: (state: MockState) => T | Promise<T>): Promise<T>;
    /**
     * Resets state to default (fresh blockchain).
     *
     * Useful for starting fresh during testing or after corruption.
     * Does not require lock (overwrites entire file).
     *
     * @example
     * ```typescript
     * // Reset to clean state
     * manager.reset();
     *
     * // Verify reset
     * const state = manager.loadState();
     * console.log('Transactions:', Object.keys(state.transactions).length); // 0
     * ```
     */
    reset(): void;
    /**
     * Checks if mock mode is initialized (state file exists).
     *
     * @returns true if state file exists, false otherwise
     *
     * @example
     * ```typescript
     * if (!manager.exists()) {
     *   console.log('Run: actp init to initialize mock mode');
     * }
     * ```
     */
    exists(): boolean;
    /**
     * Gets the path to the state file.
     *
     * @returns Absolute path to mock-state.json
     */
    getStatePath(): string;
    /**
     * Gets the path to the .actp directory.
     *
     * @returns Absolute path to .actp directory
     */
    getActpDir(): string;
    /**
     * Creates default/initial mock state.
     *
     * Used when state file doesn't exist or after reset.
     * Initializes blockchain with current timestamp.
     *
     * @returns Fresh mock state with empty transactions/escrows/accounts
     */
    getDefaultState(): MockState;
    /**
     * Deletes the state file and .actp directory if empty.
     *
     * Used for cleanup during tests or uninitialization.
     *
     * @param force - If true, delete .actp directory even if not empty
     *
     * @example
     * ```typescript
     * // Clean up after tests
     * manager.destroy();
     * ```
     */
    destroy(force?: boolean): void;
}
//# sourceMappingURL=MockStateManager.d.ts.map