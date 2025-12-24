/**
 * ACTPClient - Main entry point for AGIRAILS SDK
 *
 * Provides the unified API for interacting with the ACTP protocol
 * through three different abstraction levels:
 * - `beginner`: High-level, opinionated API for simple use cases
 * - `intermediate`: Balanced API with more control
 * - `advanced`: Direct protocol access for full control
 *
 * @module ACTPClient
 *
 * @example
 * ```typescript
 * // Create client in mock mode
 * const client = await ACTPClient.create({
 *   mode: 'mock',
 *   requesterAddress: '0x1234...',
 * });
 *
 * // Beginner API - simplest approach
 * const result = await client.beginner.pay({
 *   to: '0xProvider...',
 *   amount: '100',
 * });
 *
 * // Intermediate API - more control
 * const txId = await client.intermediate.createTransaction({
 *   provider: '0xProvider...',
 *   amount: '100',
 * });
 * await client.intermediate.linkEscrow(txId);
 *
 * // Advanced API - direct protocol access
 * const tx = await client.advanced.getTransaction(txId);
 * ```
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ethers } from 'ethers';
import { MockRuntime } from './runtime/MockRuntime';
import { MockStateManager } from './runtime/MockStateManager';
import { BlockchainRuntime } from './runtime/BlockchainRuntime';
import { IACTPRuntime, IMockRuntime } from './runtime/IACTPRuntime';
import { BeginnerAdapter } from './adapters/BeginnerAdapter';
import { IntermediateAdapter } from './adapters/IntermediateAdapter';
import { EASHelper, EASConfig } from './protocol/EASHelper';
import { getNetwork } from './config/networks';

// ============================================================================
// Security: Path Validation
// ============================================================================

/**
 * Validates that a state directory path is safe to use.
 *
 * SECURITY: Prevents path traversal attacks by ensuring:
 * 1. No '..' components in the path
 * 2. No symbolic links that could escape the intended directory
 * 3. Path resolves to a location within home directory or current working directory
 *
 * @param stateDirectory - The directory path to validate
 * @throws Error if path is unsafe
 */
function validateStateDirectory(stateDirectory: string): void {
  // Check for path traversal characters
  if (stateDirectory.includes('..')) {
    throw new Error(
      'stateDirectory cannot contain path traversal characters (..). ' +
      'Use absolute paths only for security.'
    );
  }

  // Resolve the path to get the absolute path
  const resolvedPath = path.resolve(stateDirectory);

  // If path exists, reject symlinks and use realpath for boundary checks.
  // This blocks symlink escapes like "~/project" -> "/etc".
  let effectivePath = resolvedPath;
  if (fs.existsSync(resolvedPath)) {
    const st = fs.lstatSync(resolvedPath);
    if (st.isSymbolicLink()) {
      throw new Error(
        'stateDirectory cannot be a symbolic link. ' +
          `Path "${stateDirectory}" resolves to a symlink at "${resolvedPath}".`
      );
    }
    if (!st.isDirectory()) {
      throw new Error(
        `stateDirectory must be a directory. Path "${resolvedPath}" is not a directory.`
      );
    }
    effectivePath = fs.realpathSync(resolvedPath);
  }

  // Get safe base directories
  const homeDir = os.homedir();
  const cwd = process.cwd();

  // SECURITY FIX (C-5): Use path.relative() instead of startsWith()
  // to handle case-insensitive filesystems (macOS, Windows) correctly.
  // path.relative() returns a path starting with '..' if target is outside base.
  const relativeToHome = path.relative(homeDir, effectivePath);
  const relativeToCwd = path.relative(cwd, effectivePath);

  // Check if path escapes the boundary (starts with '..' or is absolute)
  const isUnderHome = !relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome);
  const isUnderCwd = !relativeToCwd.startsWith('..') && !path.isAbsolute(relativeToCwd);

  if (!isUnderHome && !isUnderCwd) {
    throw new Error(
      'stateDirectory must be within home directory or current working directory. ' +
      `Resolved path "${resolvedPath}" is outside allowed boundaries.`
    );
  }

  // Additional check: Ensure path doesn't contain null bytes (can bypass validation)
  if (stateDirectory.includes('\0')) {
    throw new Error('stateDirectory contains invalid null byte character');
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if runtime is MockRuntime.
 *
 * @param runtime - Runtime to check
 * @returns True if runtime is IMockRuntime
 */
function isMockRuntime(runtime: IACTPRuntime): runtime is IMockRuntime {
  return 'reset' in runtime && typeof (runtime as IMockRuntime).reset === 'function';
}

// ============================================================================
// Types
// ============================================================================

/**
 * Supported modes for ACTPClient.
 *
 * - `mock`: Local development mode with file-based state
 * - `testnet`: Base Sepolia testnet (future)
 * - `mainnet`: Base mainnet (future)
 */
export type ACTPClientMode = 'mock' | 'testnet' | 'mainnet';

/**
 * Configuration for creating an ACTPClient instance.
 */
export interface ACTPClientConfig {
  /**
   * Operating mode.
   *
   * - 'mock': Local development with file-based state
   * - 'testnet': Base Sepolia testnet
   * - 'mainnet': Base mainnet
   */
  mode: ACTPClientMode;

  /**
   * The requester's Ethereum address.
   *
   * This address is used as the "from" address for all transactions
   * created through this client instance.
   *
   * @example '0x1111111111111111111111111111111111111111'
   */
  requesterAddress: string;

  /**
   * Optional: Project root directory for mock state file storage.
   *
   * The state file will be stored at `{stateDirectory}/.actp/mock-state.json`.
   * Defaults to current working directory.
   * Only used when mode is 'mock'.
   */
  stateDirectory?: string;

  /**
   * Optional: Private key for signing transactions.
   *
   * Required when mode is 'testnet' or 'mainnet'.
   * Not used in 'mock' mode.
   *
   * ⚠️ CRITICAL SECURITY WARNING (C-1):
   *
   * **NEVER use raw private keys in production environments**
   *
   * **Recommended Approaches:**
   * 1. **Encrypted JSON Keystore** (ethers.Wallet.fromEncryptedJson) - Best for server-side
   *    - Stores key encrypted with password
   *    - Requires decryption at runtime (password from secure vault)
   *    - Standard Web3 format (compatible with MetaMask, Geth, etc.)
   *
   * 2. **Hardware Wallets** (Ledger/Trezor) - Best for high-value operations
   *    - Private key never leaves device
   *    - User confirmation for each transaction
   *    - Future SDK integration planned
   *
   * 3. **KMS/HSM Integration** - Best for enterprise deployment
   *    - AWS KMS, Google Cloud KMS, Azure Key Vault
   *    - Private key never accessible to application
   *    - Audit trail for all signing operations
   *
   * **Security Requirements:**
   * - NEVER log this value or include in error messages
   * - NEVER store in plaintext files or git repositories
   * - NEVER expose in API responses or client-side code
   * - NEVER hardcode in source code (use environment variables minimum)
   * - ALWAYS use encrypted storage (keystore, KMS, hardware wallet)
   * - ALWAYS rotate keys if compromise suspected
   * - The ACTPClient toJSON() method excludes this field from serialization
   *
   * **Example (Encrypted Keystore):**
   * ```typescript
   * import { Wallet } from 'ethers';
   * import fs from 'fs';
   *
   * // Load encrypted keystore
   * const keystore = fs.readFileSync('path/to/keystore.json', 'utf8');
   * const password = process.env.KEYSTORE_PASSWORD; // From secure vault, not .env file
   * const wallet = await Wallet.fromEncryptedJson(keystore, password);
   *
   * // Use with ACTPClient
   * const client = await ACTPClient.create({
   *   mode: 'testnet',
   *   requesterAddress: wallet.address,
   *   privateKey: wallet.privateKey, // Decrypted at runtime only
   *   rpcUrl: process.env.RPC_URL
   * });
   * ```
   */
  privateKey?: string;

  /**
   * Optional: RPC URL for blockchain connection.
   *
   * Required when mode is 'testnet' or 'mainnet'.
   * Not used in 'mock' mode.
   *
   * @example 'https://base-sepolia.g.alchemy.com/v2/YOUR_KEY'
   */
  rpcUrl?: string;

  /**
   * Optional: Contract address overrides.
   *
   * Override default deployed contract addresses.
   * Used in 'testnet' and 'mainnet' modes.
   */
  contracts?: {
    actpKernel?: string;
    escrowVault?: string;
    usdc?: string;
  };

  /**
   * Optional: Gas settings for blockchain transactions.
   *
   * Used in 'testnet' and 'mainnet' modes.
   */
  gasSettings?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };

  /**
   * Optional: EAS (Ethereum Attestation Service) configuration.
   *
   * SECURITY FIX (C-4): Required for attestation verification in testnet/mainnet modes.
   * If not provided, attestation verification in releaseEscrow() will be skipped.
   *
   * Used in 'testnet' and 'mainnet' modes.
   */
  easConfig?: EASConfig;

  /**
   * Optional: Require valid EAS attestation before escrow release (blockchain modes).
   *
   * If true, `releaseEscrow()` will require an `attestationUID` and verify it on-chain via EAS.
   *
   * Default:
   * - true when `easConfig` is provided
   * - false otherwise
   */
  requireAttestation?: boolean;

  /**
   * Optional: Custom runtime instance.
   *
   * For advanced use cases where you want to provide your own
   * runtime implementation (e.g., for testing with custom mocks).
   *
   * If provided, mode and stateDirectory are ignored.
   */
  runtime?: IACTPRuntime;
}

/**
 * Result of creating an ACTPClient.
 *
 * Contains metadata about the client initialization.
 */
export interface ACTPClientInfo {
  /** Operating mode */
  mode: ACTPClientMode;
  /** Requester address */
  address: string;
  /** State directory (mock mode only) */
  stateDirectory?: string;
}

// ============================================================================
// ACTPClient Class
// ============================================================================

/**
 * ACTPClient - Main entry point for AGIRAILS SDK.
 *
 * This class provides a unified interface to the ACTP protocol through
 * three abstraction levels, catering to developers with different needs:
 *
 * **Beginner API** (`client.beginner`):
 * - Simplest possible interface
 * - Smart defaults (24h deadline, 2-day dispute window)
 * - User-friendly inputs (strings, no BigInt)
 * - Perfect for: Quick prototypes, simple integrations
 *
 * **Intermediate API** (`client.intermediate`):
 * - Explicit lifecycle methods
 * - More control over transaction flow
 * - Still with user-friendly input parsing
 * - Perfect for: Production apps needing control
 *
 * **Advanced API** (`client.advanced`):
 * - Direct access to protocol runtime
 * - Full control over all parameters
 * - Protocol-level types (BigInt, timestamps)
 * - Perfect for: Power users, custom integrations
 *
 * @example
 * ```typescript
 * // Create client
 * const client = await ACTPClient.create({
 *   mode: 'mock',
 *   requesterAddress: '0xRequester...',
 * });
 *
 * // Three ways to create a transaction:
 *
 * // 1. Beginner: One call does everything
 * await client.beginner.pay({ to: '0xProvider', amount: '100' });
 *
 * // 2. Intermediate: Explicit steps
 * const txId = await client.intermediate.createTransaction({
 *   provider: '0xProvider',
 *   amount: '100',
 * });
 * await client.intermediate.linkEscrow(txId);
 *
 * // 3. Advanced: Full control
 * const txId = await client.advanced.createTransaction({
 *   provider: '0xProvider',
 *   requester: '0xRequester',
 *   amount: '100000000', // wei
 *   deadline: Math.floor(Date.now() / 1000) + 86400,
 *   disputeWindow: 172800,
 * });
 * ```
 */
export class ACTPClient {
  /**
   * Beginner-level API.
   *
   * Provides the simplest interface for creating and checking transactions.
   * Ideal for developers who want to "just make it work" without deep
   * protocol knowledge.
   *
   * @example
   * ```typescript
   * const result = await client.beginner.pay({
   *   to: '0xProvider...',
   *   amount: '100',
   * });
   * console.log('Transaction ID:', result.txId);
   * console.log('State:', result.state); // 'COMMITTED'
   * ```
   */
  public readonly beginner: BeginnerAdapter;

  /**
   * Intermediate-level API.
   *
   * Provides explicit lifecycle methods for more control over
   * the transaction flow while still offering user-friendly inputs.
   *
   * @example
   * ```typescript
   * // Create transaction (INITIATED state)
   * const txId = await client.intermediate.createTransaction({
   *   provider: '0xProvider...',
   *   amount: '100',
   *   deadline: '+7d',
   * });
   *
   * // Link escrow (auto-transitions to COMMITTED)
   * await client.intermediate.linkEscrow(txId);
   *
   * // Transition to DELIVERED
   * await client.intermediate.transitionState(txId, 'DELIVERED');
   * ```
   */
  public readonly intermediate: IntermediateAdapter;

  /**
   * The underlying runtime implementation.
   *
   * Direct access to the protocol runtime for advanced use cases.
   * This is the same as `client.advanced`.
   */
  public readonly runtime: IACTPRuntime;

  /**
   * Client information (mode, address, etc.)
   */
  public readonly info: ACTPClientInfo;

  /**
   * SECURITY FIX (C-4): EAS helper for attestation verification.
   * Only available in testnet/mainnet modes when easConfig is provided.
   */
  public readonly easHelper?: EASHelper;

  /**
   * Private constructor - use ACTPClient.create() factory method.
   */
  private constructor(
    runtime: IACTPRuntime,
    requesterAddress: string,
    info: ACTPClientInfo,
    easHelper?: EASHelper
  ) {
    this.runtime = runtime;
    this.info = info;
    this.easHelper = easHelper;
    this.beginner = new BeginnerAdapter(runtime, requesterAddress, easHelper);
    this.intermediate = new IntermediateAdapter(runtime, requesterAddress, easHelper);
  }

  // ==========================================================================
  // Factory Method
  // ==========================================================================

  /**
   * Creates a new ACTPClient instance.
   *
   * This is the primary way to instantiate an ACTPClient.
   * It handles runtime initialization based on the specified mode.
   *
   * @param config - Client configuration
   * @returns Promise resolving to initialized ACTPClient
   * @throws {Error} If mode is not supported (only 'mock' currently)
   *
   * @example
   * ```typescript
   * // Mock mode (local development)
   * const client = await ACTPClient.create({
   *   mode: 'mock',
   *   requesterAddress: '0x1234...',
   * });
   *
   * // Mock mode with custom state directory
   * const client = await ACTPClient.create({
   *   mode: 'mock',
   *   requesterAddress: '0x1234...',
   *   stateDirectory: '/custom/path/.actp',
   * });
   *
   * // Custom runtime (for testing)
   * const customRuntime = new MockRuntime();
   * const client = await ACTPClient.create({
   *   mode: 'mock',
   *   requesterAddress: '0x1234...',
   *   runtime: customRuntime,
   * });
   * ```
   */
  static async create(config: ACTPClientConfig): Promise<ACTPClient> {
    // Validate requester address
    if (!config.requesterAddress) {
      throw new Error('requesterAddress is required');
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(config.requesterAddress)) {
      throw new Error(
        `Invalid requesterAddress: "${config.requesterAddress}". ` +
          'Must be a valid Ethereum address (0x-prefixed, 40 hex chars)'
      );
    }

    let runtime: IACTPRuntime;
    let stateDirectory: string | undefined;
    let easHelper: EASHelper | undefined;

    // If custom runtime provided, use it directly
    if (config.runtime) {
      runtime = config.runtime;
    } else {
      // Initialize runtime based on mode
      switch (config.mode) {
        case 'mock': {
          // SECURITY FIX: Enhanced path validation to prevent path traversal attacks
          if (config.stateDirectory) {
            validateStateDirectory(config.stateDirectory);
          }

          // MockStateManager takes projectRoot as string parameter
          const stateManager = new MockStateManager(config.stateDirectory);
          runtime = new MockRuntime(stateManager);
          stateDirectory = config.stateDirectory;
          // EASHelper not needed in mock mode
          break;
        }

        case 'testnet':
        case 'mainnet': {
          // Validate required parameters for blockchain modes
          if (!config.privateKey) {
            throw new Error(
              `privateKey is required for ${config.mode} mode`
            );
          }

          // Map mode to network config
          const network = config.mode === 'testnet' ? 'base-sepolia' : 'base-mainnet';

          // Default RPC URL from network config if not provided
          // This makes Level0/Agent usable on testnet without forcing users to pass rpcUrl explicitly.
          const rpcUrl = config.rpcUrl ?? getNetwork(network).rpcUrl;

          // Optional persistent state directory can be used for:
          // - mock mode state (mock-state.json)
          // - blockchain mode safety state (e.g., used-attestation replay protection)
          if (config.stateDirectory) {
            validateStateDirectory(config.stateDirectory);
          }

          // Create ethers provider and signer
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const signer = new ethers.Wallet(config.privateKey, provider);

          const requireAttestation = config.requireAttestation ?? Boolean(config.easConfig);

          // Create BlockchainRuntime
          const blockchainRuntime = new BlockchainRuntime({
            network,
            signer,
            provider,
            contracts: config.contracts,
            gasSettings: config.gasSettings,
            easConfig: config.easConfig,
            requireAttestation,
            stateDirectory: config.stateDirectory,
          });

          // Initialize async components
          await blockchainRuntime.initialize();

          runtime = blockchainRuntime;

          // SECURITY FIX (C-4): Use the runtime's initialized EASHelper so
          // adapters and runtime share the same tracker + verification logic.
          if (config.easConfig) {
            easHelper = blockchainRuntime.getEASHelper();
          }
          break;
        }

        default:
          throw new Error(
            `Unknown mode: "${config.mode}". ` +
              'Supported modes: "mock", "testnet", "mainnet"'
          );
      }
    }

    // Normalize address to lowercase for consistency
    const normalizedAddress = config.requesterAddress.toLowerCase();

    const info: ACTPClientInfo = {
      mode: config.mode,
      address: normalizedAddress,
      stateDirectory,
    };

    // SECURITY FIX (C-4): Pass EASHelper to adapters for attestation verification
    return new ACTPClient(runtime, normalizedAddress, info, easHelper);
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Advanced-level API.
   *
   * Provides direct access to the underlying protocol runtime.
   * Use this when you need full control over all parameters.
   *
   * This is the same as accessing `client.runtime` directly.
   *
   * @example
   * ```typescript
   * // Direct runtime access
   * const txId = await client.advanced.createTransaction({
   *   provider: '0xProvider',
   *   requester: '0xRequester',
   *   amount: '100000000', // wei
   *   deadline: Math.floor(Date.now() / 1000) + 86400,
   * });
   *
   * // Get transaction details
   * const tx = await client.advanced.getTransaction(txId);
   *
   * // Time manipulation (mock mode only - requires IMockRuntime cast)
   * import { IMockRuntime } from './runtime/IACTPRuntime';
   * if (client.getMode() === 'mock') {
   *   (client.advanced as IMockRuntime).time.advanceTime(3600); // Advance 1 hour
   * }
   * ```
   */
  get advanced(): IACTPRuntime {
    return this.runtime;
  }

  /**
   * Gets the requester's Ethereum address.
   *
   * This is the address used as the "from" address for all transactions
   * created through this client.
   *
   * @returns The requester's Ethereum address (normalized to lowercase)
   *
   * @example
   * ```typescript
   * const address = client.getAddress();
   * console.log('My address:', address);
   * // '0x1111111111111111111111111111111111111111'
   * ```
   */
  getAddress(): string {
    return this.info.address;
  }

  /**
   * Gets the current operating mode.
   *
   * @returns The client's operating mode ('mock', 'testnet', or 'mainnet')
   *
   * @example
   * ```typescript
   * if (client.getMode() === 'mock') {
   *   console.log('Running in local development mode');
   * }
   * ```
   */
  getMode(): ACTPClientMode {
    return this.info.mode;
  }

  /**
   * Resets the mock state to default.
   *
   * Only available in mock mode. Clears all transactions, escrows,
   * and accounts, resetting to a fresh state.
   *
   * @throws {Error} If not in mock mode or runtime doesn't support reset
   *
   * @example
   * ```typescript
   * // Reset state between test runs
   * await client.reset();
   * ```
   */
  async reset(): Promise<void> {
    if (this.info.mode !== 'mock') {
      throw new Error(
        `reset() is only available in mock mode. Current mode: "${this.info.mode}"`
      );
    }

    if (!isMockRuntime(this.runtime)) {
      throw new Error('Runtime does not support reset operation');
    }

    await this.runtime.reset();
  }

  /**
   * Custom JSON serialization to prevent private key exposure.
   *
   * SECURITY FIX (HIGH-4): Prevents accidental private key logging
   * when ACTPClient instance is serialized (e.g., JSON.stringify, console.log).
   *
   * @returns Safe serializable object with sensitive data removed
   */
  toJSON(): object {
    return {
      mode: this.info.mode,
      address: this.info.address,
      stateDirectory: this.info.stateDirectory,
      isInitialized: true,
      // Explicitly exclude: privateKey, signer, provider internals
      _warning: 'Sensitive data (privateKey, signer) excluded for security',
    };
  }

  /**
   * Custom string representation for debugging.
   *
   * SECURITY FIX (HIGH-4): Prevents private key exposure in logs.
   */
  toString(): string {
    return `ACTPClient(mode=${this.info.mode}, address=${this.info.address})`;
  }

  /**
   * Custom inspect for Node.js util.inspect (console.log).
   *
   * SECURITY FIX (HIGH-4): Prevents private key exposure in console output.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }

  /**
   * Mints USDC tokens to an address.
   *
   * Only available in mock mode. Useful for testing scenarios
   * where you need to fund accounts.
   *
   * @param address - Address to mint tokens to
   * @param amount - Amount to mint (in USDC wei, e.g., '1000000' for 1 USDC)
   * @throws {Error} If not in mock mode or runtime doesn't support mintTokens
   *
   * @example
   * ```typescript
   * // Mint 1000 USDC to the requester
   * await client.mintTokens(client.getAddress(), '1000000000'); // 1000 * 10^6
   * ```
   */
  async mintTokens(address: string, amount: string): Promise<void> {
    if (this.info.mode !== 'mock') {
      throw new Error(
        `mintTokens() is only available in mock mode. Current mode: "${this.info.mode}"`
      );
    }

    if (!isMockRuntime(this.runtime)) {
      throw new Error('Runtime does not support mintTokens operation');
    }

    await this.runtime.mintTokens(address, amount);
  }

  /**
   * Gets the USDC balance of an address.
   *
   * @param address - Address to check balance for
   * @returns Promise resolving to balance in USDC wei
   * @throws {Error} If runtime doesn't support getBalance
   *
   * @example
   * ```typescript
   * const balance = await client.getBalance(client.getAddress());
   * console.log('Balance:', balance); // '1000000000' (1000 USDC)
   * ```
   */
  async getBalance(address: string): Promise<string> {
    if (!isMockRuntime(this.runtime)) {
      throw new Error('Runtime does not support getBalance operation');
    }

    return this.runtime.getBalance(address);
  }
}
