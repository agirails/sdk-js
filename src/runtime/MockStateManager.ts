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

import * as fs from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { MockState, MOCK_STATE_DEFAULTS } from './types/MockState';
import { assertSafeFileForRead, ensureSafeDir } from '../utils/fsSafe';

/**
 * Error thrown when mock state file is corrupted.
 */
export class MockStateCorruptedError extends Error {
  public readonly statePath: string;

  constructor(statePath: string, cause?: Error) {
    super(
      `Mock state file corrupted: ${statePath}\n` +
        `Delete it manually or run: actp mock reset\n` +
        (cause ? `Cause: ${cause.message}` : '')
    );
    this.name = 'MockStateCorruptedError';
    this.statePath = statePath;
  }
}

/**
 * Error thrown when state version is unsupported.
 */
export class MockStateVersionError extends Error {
  public readonly version: string;
  public readonly supportedVersion: string;

  constructor(version: string, supportedVersion: string = MOCK_STATE_DEFAULTS.VERSION) {
    super(
      `Unsupported state version: ${version}\n` +
        `Supported version: ${supportedVersion}\n` +
        `Run: actp mock reset to create new state file`
    );
    this.name = 'MockStateVersionError';
    this.version = version;
    this.supportedVersion = supportedVersion;
  }
}

/**
 * Error thrown when lock cannot be acquired.
 */
export class MockStateLockError extends Error {
  public readonly statePath: string;
  public readonly cause?: Error;

  constructor(statePath: string, cause?: Error) {
    super(
      `Could not acquire lock on mock state: ${statePath}\n` +
        `Another ACTP process may be running.\n` +
        `Please wait a moment and try again.` +
        (cause ? `\nCause: ${cause.message}` : '')
    );
    this.name = 'MockStateLockError';
    this.statePath = statePath;
    this.cause = cause;
  }
}

/**
 * Lock options for proper-lockfile.
 * - 5 retries with exponential backoff (100ms -> 1000ms)
 * - 10 second stale lock detection (handles process crashes)
 */
const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
  },
  stale: 10000, // 10 seconds
};

/**
 * Maximum allowed state file size (10 MB).
 * Prevents disk exhaustion from runaway state growth.
 *
 * Note: For states approaching this limit, JSON.stringify/parse may
 * temporarily use ~3x the file size in memory (~30 MB for 10 MB state).
 * This is acceptable for a local development tool with <1000 transactions.
 */
const MAX_STATE_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Maximum nesting depth for JSON parsing.
 * Prevents DoS attacks via deeply nested JSON structures.
 *
 * SECURITY: Deeply nested JSON can cause:
 * - Stack overflow during parsing
 * - Excessive CPU usage during traversal
 * - Memory exhaustion from recursion
 */
const MAX_NESTING_DEPTH = 100;

// ============================================================================
// Security: Path Sanitization and JSON Depth Check
// ============================================================================

/**
 * Sanitize a file path for safe display in error messages.
 *
 * SECURITY: Replaces home directory with ~ to prevent information disclosure.
 *
 * @param fullPath - The full file path to sanitize
 * @returns Sanitized path safe for display
 */
function sanitizePath(fullPath: string): string {
  // Import os dynamically to get home directory
  const home = process.env.HOME || process.env.USERPROFILE || '/';
  return fullPath.replace(home, '~');
}

/**
 * Check the nesting depth of a parsed JSON object.
 *
 * SECURITY: Prevents DoS via deeply nested JSON structures that can cause:
 * - Stack overflow
 * - Excessive CPU usage
 * - Memory exhaustion
 *
 * @param obj - The object to check
 * @param maxDepth - Maximum allowed nesting depth
 * @param currentDepth - Current depth (used for recursion)
 * @throws Error if object exceeds maximum nesting depth
 */
function checkNestingDepth(
  obj: unknown,
  maxDepth: number = MAX_NESTING_DEPTH,
  currentDepth: number = 0
): void {
  if (currentDepth > maxDepth) {
    throw new Error(
      `State file exceeds maximum nesting depth of ${maxDepth}. ` +
      'This may indicate a corrupted or malicious state file.'
    );
  }

  if (obj !== null && typeof obj === 'object') {
    // Check arrays and objects
    const values = Array.isArray(obj) ? obj : Object.values(obj);
    for (const value of values) {
      checkNestingDepth(value, maxDepth, currentDepth + 1);
    }
  }
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
export class MockStateManager {
  /** Path to the state JSON file */
  private readonly statePath: string;

  /** Path to the .actp directory */
  private readonly actpDir: string;

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
  constructor(projectRoot: string = process.cwd()) {
    this.actpDir = path.join(projectRoot, '.actp');
    this.statePath = path.join(this.actpDir, 'mock-state.json');

    // Ensure .actp directory exists
    this.ensureDirectory();
  }

  /**
   * Ensures the .actp directory exists.
   * Creates it with secure permissions if missing.
   */
  private ensureDirectory(): void {
    ensureSafeDir(this.actpDir, 0o755);
  }

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
  loadState(): MockState {
    // If file doesn't exist, return default state
    if (!fs.existsSync(this.statePath)) {
      return this.getDefaultState();
    }

    // SECURITY: Refuse to read from symlinked state files
    assertSafeFileForRead(this.statePath);

    // Check file size limit
    const stats = fs.statSync(this.statePath);
    if (stats.size > MAX_STATE_FILE_SIZE) {
      throw new Error(
        `Mock state file exceeds ${MAX_STATE_FILE_SIZE / 1024 / 1024} MB limit.\n` +
          `Run: actp mock compact or actp mock reset`
      );
    }

    // Read and parse file
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, 'utf-8');
    } catch (error) {
      // SECURITY: Sanitize path in error message
      throw new Error(
        `Failed to read mock state file: ${sanitizePath(this.statePath)}\n` +
          `Error: ${(error as Error).message}`
      );
    }

    // Parse JSON
    let state: MockState;
    try {
      state = JSON.parse(raw);
    } catch (error) {
      // SECURITY: Sanitize path in error message
      throw new MockStateCorruptedError(sanitizePath(this.statePath), error as Error);
    }

    // Security: Check nesting depth to prevent DoS via deeply nested JSON
    try {
      checkNestingDepth(state);
    } catch (error) {
      throw new MockStateCorruptedError(
        sanitizePath(this.statePath),
        error as Error
      );
    }

    // Validate version
    if (state.version !== MOCK_STATE_DEFAULTS.VERSION) {
      throw new MockStateVersionError(state.version);
    }

    // Basic schema validation
    if (
      typeof state.mode !== 'string' ||
      typeof state.blockchain !== 'object' ||
      typeof state.transactions !== 'object' ||
      typeof state.escrows !== 'object' ||
      typeof state.accounts !== 'object'
    ) {
      throw new MockStateCorruptedError(sanitizePath(this.statePath));
    }

    return state;
  }

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
  saveState(state: MockState): void {
    // Ensure directory exists (may have been deleted)
    this.ensureDirectory();

    const tempPath = `${this.statePath}.tmp`;

    try {
      // Prevent clobbering via pre-created temp symlink/file
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      // Write to temp file first (pretty-printed for human readability)
      // BigInt replacer: ethers v6 returns BigInt from contracts; JSON.stringify can't handle them natively
      const json = JSON.stringify(state, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
      fs.writeFileSync(tempPath, json, {
        encoding: 'utf-8',
        mode: 0o644,
        flag: 'wx', // exclusive create: do not follow existing symlink
      });

      // Rename atomically (POSIX rename is atomic)
      fs.renameSync(tempPath, this.statePath);
    } catch (error) {
      // Clean up temp file if it exists
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Ignore cleanup errors
        }
      }

      throw new Error(
        `Failed to save mock state: ${(error as Error).message}\n` +
          `Path: ${sanitizePath(this.statePath)}`
      );
    }
  }

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
  async withLock<T>(operation: (state: MockState) => T | Promise<T>): Promise<T> {
    // Ensure state file exists before locking
    // (proper-lockfile requires the file to exist)
    if (!fs.existsSync(this.statePath)) {
      this.saveState(this.getDefaultState());
    }

    // SECURITY: Refuse to lock/use symlinked state files
    assertSafeFileForRead(this.statePath);

    let release: (() => Promise<void>) | null = null;

    try {
      // Acquire exclusive lock
      release = await lockfile.lock(this.statePath, LOCK_OPTIONS);

      // Load current state
      const state = this.loadState();

      // Execute operation (may be async)
      const result = await operation(state);

      // Save modified state
      this.saveState(state);

      return result;
    } catch (error) {
      // Transform lock errors into friendlier messages
      if (
        error instanceof Error &&
        (error.message.includes('ELOCKED') || error.message.includes('lock'))
      ) {
        throw new MockStateLockError(this.statePath, error);
      }
      throw error;
    } finally {
      // Always release lock
      if (release) {
        try {
          await release();
        } catch {
          // Ignore release errors (lock may have expired)
        }
      }
    }
  }

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
  reset(): void {
    const defaultState = this.getDefaultState();
    this.saveState(defaultState);
  }

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
  exists(): boolean {
    return fs.existsSync(this.statePath);
  }

  /**
   * Gets the path to the state file.
   *
   * @returns Absolute path to mock-state.json
   */
  getStatePath(): string {
    return this.statePath;
  }

  /**
   * Gets the path to the .actp directory.
   *
   * @returns Absolute path to .actp directory
   */
  getActpDir(): string {
    return this.actpDir;
  }

  /**
   * Creates default/initial mock state.
   *
   * Used when state file doesn't exist or after reset.
   * Initializes blockchain with current timestamp.
   *
   * @returns Fresh mock state with empty transactions/escrows/accounts
   */
  getDefaultState(): MockState {
    return {
      version: MOCK_STATE_DEFAULTS.VERSION,
      mode: 'mock',
      blockchain: {
        currentTime: Math.floor(Date.now() / 1000),
        blockNumber: MOCK_STATE_DEFAULTS.INITIAL_BLOCK_NUMBER,
        chainId: MOCK_STATE_DEFAULTS.CHAIN_ID,
        blockTime: MOCK_STATE_DEFAULTS.BLOCK_TIME,
      },
      transactions: {},
      escrows: {},
      accounts: {},
      // Security: Initialize events array for persistence
      events: [],
    };
  }

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
  destroy(force: boolean = false): void {
    // Remove state file
    if (fs.existsSync(this.statePath)) {
      fs.unlinkSync(this.statePath);
    }

    // Remove temp file if exists
    const tempPath = `${this.statePath}.tmp`;
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    // Remove lock file if exists (created by proper-lockfile)
    const lockPath = `${this.statePath}.lock`;
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }

    // Remove .actp directory if empty or forced
    if (fs.existsSync(this.actpDir)) {
      const files = fs.readdirSync(this.actpDir);
      if (files.length === 0 || force) {
        fs.rmSync(this.actpDir, { recursive: true, force: true });
      }
    }
  }
}
