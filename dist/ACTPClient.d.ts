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
import { IACTPRuntime } from './runtime/IACTPRuntime';
import { BeginnerAdapter } from './adapters/BeginnerAdapter';
import { IntermediateAdapter } from './adapters/IntermediateAdapter';
import { EASHelper, EASConfig } from './protocol/EASHelper';
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
     * ⚠️ SECURITY WARNING (HIGH-4):
     * - NEVER log this value or include in error messages
     * - NEVER store in plaintext - use environment variables
     * - NEVER expose in API responses or client-side code
     * - Consider using hardware wallets for production
     * - The ACTPClient toJSON() method excludes this field from serialization
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
export declare class ACTPClient {
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
    readonly beginner: BeginnerAdapter;
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
    readonly intermediate: IntermediateAdapter;
    /**
     * The underlying runtime implementation.
     *
     * Direct access to the protocol runtime for advanced use cases.
     * This is the same as `client.advanced`.
     */
    readonly runtime: IACTPRuntime;
    /**
     * Client information (mode, address, etc.)
     */
    readonly info: ACTPClientInfo;
    /**
     * SECURITY FIX (C-4): EAS helper for attestation verification.
     * Only available in testnet/mainnet modes when easConfig is provided.
     */
    readonly easHelper?: EASHelper;
    /**
     * Private constructor - use ACTPClient.create() factory method.
     */
    private constructor();
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
    static create(config: ACTPClientConfig): Promise<ACTPClient>;
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
    get advanced(): IACTPRuntime;
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
    getAddress(): string;
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
    getMode(): ACTPClientMode;
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
    reset(): Promise<void>;
    /**
     * Custom JSON serialization to prevent private key exposure.
     *
     * SECURITY FIX (HIGH-4): Prevents accidental private key logging
     * when ACTPClient instance is serialized (e.g., JSON.stringify, console.log).
     *
     * @returns Safe serializable object with sensitive data removed
     */
    toJSON(): object;
    /**
     * Custom string representation for debugging.
     *
     * SECURITY FIX (HIGH-4): Prevents private key exposure in logs.
     */
    toString(): string;
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
    mintTokens(address: string, amount: string): Promise<void>;
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
    getBalance(address: string): Promise<string>;
}
//# sourceMappingURL=ACTPClient.d.ts.map