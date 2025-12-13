"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTPClient = void 0;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const ethers_1 = require("ethers");
const MockRuntime_1 = require("./runtime/MockRuntime");
const MockStateManager_1 = require("./runtime/MockStateManager");
const BlockchainRuntime_1 = require("./runtime/BlockchainRuntime");
const BeginnerAdapter_1 = require("./adapters/BeginnerAdapter");
const IntermediateAdapter_1 = require("./adapters/IntermediateAdapter");
const EASHelper_1 = require("./protocol/EASHelper");
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
function validateStateDirectory(stateDirectory) {
    // Check for path traversal characters
    if (stateDirectory.includes('..')) {
        throw new Error('stateDirectory cannot contain path traversal characters (..). ' +
            'Use absolute paths only for security.');
    }
    // Resolve the path to get the absolute path
    const resolvedPath = path.resolve(stateDirectory);
    // Get safe base directories
    const homeDir = os.homedir();
    const cwd = process.cwd();
    // Normalize paths for comparison (handle trailing slashes)
    const normalizedResolved = resolvedPath.replace(/\/$/, '');
    const normalizedHome = homeDir.replace(/\/$/, '');
    const normalizedCwd = cwd.replace(/\/$/, '');
    // Check if resolved path is within safe boundaries
    const isUnderHome = normalizedResolved === normalizedHome ||
        normalizedResolved.startsWith(normalizedHome + path.sep);
    const isUnderCwd = normalizedResolved === normalizedCwd ||
        normalizedResolved.startsWith(normalizedCwd + path.sep);
    if (!isUnderHome && !isUnderCwd) {
        throw new Error('stateDirectory must be within home directory or current working directory. ' +
            `Resolved path "${resolvedPath}" is outside allowed boundaries.`);
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
function isMockRuntime(runtime) {
    return 'reset' in runtime && typeof runtime.reset === 'function';
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
class ACTPClient {
    /**
     * Private constructor - use ACTPClient.create() factory method.
     */
    constructor(runtime, requesterAddress, info, easHelper) {
        this.runtime = runtime;
        this.info = info;
        this.easHelper = easHelper;
        this.beginner = new BeginnerAdapter_1.BeginnerAdapter(runtime, requesterAddress, easHelper);
        this.intermediate = new IntermediateAdapter_1.IntermediateAdapter(runtime, requesterAddress, easHelper);
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
    static async create(config) {
        // Validate requester address
        if (!config.requesterAddress) {
            throw new Error('requesterAddress is required');
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(config.requesterAddress)) {
            throw new Error(`Invalid requesterAddress: "${config.requesterAddress}". ` +
                'Must be a valid Ethereum address (0x-prefixed, 40 hex chars)');
        }
        let runtime;
        let stateDirectory;
        let easHelper;
        // If custom runtime provided, use it directly
        if (config.runtime) {
            runtime = config.runtime;
        }
        else {
            // Initialize runtime based on mode
            switch (config.mode) {
                case 'mock': {
                    // SECURITY FIX: Enhanced path validation to prevent path traversal attacks
                    if (config.stateDirectory) {
                        validateStateDirectory(config.stateDirectory);
                    }
                    // MockStateManager takes projectRoot as string parameter
                    const stateManager = new MockStateManager_1.MockStateManager(config.stateDirectory);
                    runtime = new MockRuntime_1.MockRuntime(stateManager);
                    stateDirectory = config.stateDirectory;
                    // EASHelper not needed in mock mode
                    break;
                }
                case 'testnet':
                case 'mainnet': {
                    // Validate required parameters for blockchain modes
                    if (!config.privateKey) {
                        throw new Error(`privateKey is required for ${config.mode} mode`);
                    }
                    if (!config.rpcUrl) {
                        throw new Error(`rpcUrl is required for ${config.mode} mode`);
                    }
                    // Create ethers provider and signer
                    const provider = new ethers_1.ethers.JsonRpcProvider(config.rpcUrl);
                    const signer = new ethers_1.ethers.Wallet(config.privateKey, provider);
                    // Map mode to network config
                    const network = config.mode === 'testnet' ? 'base-sepolia' : 'base-mainnet';
                    // Create BlockchainRuntime
                    const blockchainRuntime = new BlockchainRuntime_1.BlockchainRuntime({
                        network,
                        signer,
                        provider,
                        contracts: config.contracts,
                        gasSettings: config.gasSettings,
                    });
                    // Initialize async components
                    await blockchainRuntime.initialize();
                    runtime = blockchainRuntime;
                    // SECURITY FIX (C-4): Create EASHelper if configuration provided
                    if (config.easConfig) {
                        easHelper = new EASHelper_1.EASHelper(signer, config.easConfig);
                    }
                    break;
                }
                default:
                    throw new Error(`Unknown mode: "${config.mode}". ` +
                        'Supported modes: "mock", "testnet", "mainnet"');
            }
        }
        // Normalize address to lowercase for consistency
        const normalizedAddress = config.requesterAddress.toLowerCase();
        const info = {
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
    get advanced() {
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
    getAddress() {
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
    getMode() {
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
    async reset() {
        if (this.info.mode !== 'mock') {
            throw new Error(`reset() is only available in mock mode. Current mode: "${this.info.mode}"`);
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
    toJSON() {
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
    toString() {
        return `ACTPClient(mode=${this.info.mode}, address=${this.info.address})`;
    }
    /**
     * Custom inspect for Node.js util.inspect (console.log).
     *
     * SECURITY FIX (HIGH-4): Prevents private key exposure in console output.
     */
    [Symbol.for('nodejs.util.inspect.custom')]() {
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
    async mintTokens(address, amount) {
        if (this.info.mode !== 'mock') {
            throw new Error(`mintTokens() is only available in mock mode. Current mode: "${this.info.mode}"`);
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
    async getBalance(address) {
        if (!isMockRuntime(this.runtime)) {
            throw new Error('Runtime does not support getBalance operation');
        }
        return this.runtime.getBalance(address);
    }
}
exports.ACTPClient = ACTPClient;
//# sourceMappingURL=ACTPClient.js.map