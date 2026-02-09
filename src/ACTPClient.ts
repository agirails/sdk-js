/**
 * ACTPClient - Main entry point for AGIRAILS SDK
 *
 * Provides the unified API for interacting with the ACTP protocol
 * through three different abstraction levels:
 * - `basic`: High-level, opinionated API for simple use cases
 * - `standard`: Balanced API with more control
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
 * // Basic API - simplest approach
 * const result = await client.basic.pay({
 *   to: '0xProvider...',
 *   amount: '100',
 * });
 *
 * // Standard API - more control
 * const txId = await client.standard.createTransaction({
 *   provider: '0xProvider...',
 *   amount: '100',
 * });
 * await client.standard.linkEscrow(txId);
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
import { BasicAdapter } from './adapters/BasicAdapter';
import { StandardAdapter } from './adapters/StandardAdapter';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { AdapterRouter } from './adapters/AdapterRouter';
import { IAdapter, TransactionStatus } from './adapters/IAdapter';
import { UnifiedPayParams, UnifiedPayResult } from './types/adapter';
import { EASHelper, EASConfig } from './protocol/EASHelper';
import { ERC8004Bridge } from './erc8004/ERC8004Bridge';
import { ReputationReporter } from './erc8004/ReputationReporter';
import { ERC8004Network } from './types/erc8004';
import { getNetwork } from './config/networks';
import { IWalletProvider } from './wallet/IWalletProvider';
import { EOAWalletProvider } from './wallet/EOAWalletProvider';
import { AutoWalletProvider } from './wallet/AutoWalletProvider';
import { sdkLogger } from './utils/Logger';

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
/**
 * Check if an agent is registered on AgentRegistry.
 * Lightweight read-only check — no signer needed.
 *
 * Uses minimal ABI fragment to avoid importing the full AgentRegistry class.
 * Checks registeredAt field of AgentProfile struct (> 0 means registered).
 */
async function checkRegistration(
  provider: ethers.JsonRpcProvider,
  registryAddress: string,
  agentAddress: string
): Promise<boolean> {
  const contract = new ethers.Contract(
    registryAddress,
    [
      'function getAgent(address agentAddress) view returns ' +
      '(tuple(address agentAddress, string did, string endpoint, bytes32[] serviceTypes, ' +
      'uint256 stakedAmount, uint256 reputationScore, uint256 totalTransactions, ' +
      'uint256 disputedTransactions, uint256 totalVolumeUSDC, uint256 registeredAt, ' +
      'uint256 updatedAt, bool isActive, bytes32 configHash, string configCID, bool listed))',
    ],
    provider
  );
  const profile = await contract.getAgent(agentAddress);
  return profile.registeredAt > 0n;
}

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
   * When wallet is 'auto', this is auto-derived from the Smart Wallet
   * and does NOT need to be provided.
   *
   * @example '0x1111111111111111111111111111111111111111'
   */
  requesterAddress?: string;

  /**
   * AIP-12: Wallet mode.
   *
   * - 'auto': CoinbaseSmartWallet + gas sponsorship (Tier 1, recommended).
   *           Requires CDP_API_KEY env var. Agent address = Smart Wallet address.
   * - undefined: EOA wallet from privateKey (Tier 2, backward compatible).
   *
   * When 'auto', requesterAddress is derived from the Smart Wallet
   * and does not need to be provided.
   */
  wallet?: 'auto';

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
    agentRegistry?: string;
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
  /** Wallet tier ('auto' = Smart Wallet, 'eoa' = EOA, undefined = mock) */
  walletTier?: 'auto' | 'eoa';
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
 * **Basic API** (`client.basic`):
 * - Simplest possible interface
 * - Smart defaults (24h deadline, 2-day dispute window)
 * - User-friendly inputs (strings, no BigInt)
 * - Perfect for: Quick prototypes, simple integrations
 *
 * **Standard API** (`client.standard`):
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
 * // 1. Basic: One call does everything
 * await client.basic.pay({ to: '0xProvider', amount: '100' });
 *
 * // 2. Standard: Explicit steps
 * const txId = await client.standard.createTransaction({
 *   provider: '0xProvider',
 *   amount: '100',
 * });
 * await client.standard.linkEscrow(txId);
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
   * Basic-level API.
   *
   * Provides the simplest interface for creating and checking transactions.
   * Ideal for developers who want to "just make it work" without deep
   * protocol knowledge.
   *
   * @example
   * ```typescript
   * const result = await client.basic.pay({
   *   to: '0xProvider...',
   *   amount: '100',
   * });
   * console.log('Transaction ID:', result.txId);
   * console.log('State:', result.state); // 'COMMITTED'
   * ```
   */
  public readonly basic: BasicAdapter;

  /**
   * Standard-level API.
   *
   * Provides explicit lifecycle methods for more control over
   * the transaction flow while still offering user-friendly inputs.
   *
   * @example
   * ```typescript
   * // Create transaction (INITIATED state)
   * const txId = await client.standard.createTransaction({
   *   provider: '0xProvider...',
   *   amount: '100',
   *   deadline: '+7d',
   * });
   *
   * // Link escrow (auto-transitions to COMMITTED)
   * await client.standard.linkEscrow(txId);
   *
   * // Transition to DELIVERED
   * await client.standard.transitionState(txId, 'DELIVERED');
   * ```
   */
  public readonly standard: StandardAdapter;

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
   * Adapter registry for managing available adapters.
   *
   * Used internally by the router but exposed for custom adapter registration.
   */
  private readonly registry: AdapterRegistry;

  /**
   * Adapter router for intelligent adapter selection.
   *
   * Selects the best adapter based on payment parameters and metadata.
   */
  private readonly router: AdapterRouter;

  /**
   * ERC-8004 Reputation Reporter (testnet/mainnet only).
   * Used to report settlement outcomes to ERC-8004 Reputation Registry.
   * @internal
   */
  private readonly reputationReporter?: ReputationReporter;

  /**
   * AIP-12: Wallet provider (Tier 1 Auto or Tier 2 EOA).
   * Only set in testnet/mainnet modes.
   * @internal
   */
  private readonly walletProvider?: IWalletProvider;

  /**
   * Private constructor - use ACTPClient.create() factory method.
   */
  private constructor(
    runtime: IACTPRuntime,
    requesterAddress: string,
    info: ACTPClientInfo,
    easHelper?: EASHelper,
    erc8004Bridge?: ERC8004Bridge,
    reputationReporter?: ReputationReporter,
    walletProvider?: IWalletProvider,
    contractAddresses?: { usdc: string; actpKernel: string; escrowVault: string }
  ) {
    this.runtime = runtime;
    this.info = info;
    this.easHelper = easHelper;
    this.reputationReporter = reputationReporter;
    this.walletProvider = walletProvider;
    this.basic = new BasicAdapter(runtime, requesterAddress, easHelper, walletProvider, contractAddresses);
    this.standard = new StandardAdapter(runtime, requesterAddress, easHelper);

    // Initialize registry and router
    this.registry = new AdapterRegistry();
    this.registry.register(this.basic);
    this.registry.register(this.standard);
    this.router = new AdapterRouter(this.registry, erc8004Bridge);
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
    let runtime: IACTPRuntime;
    let stateDirectory: string | undefined;
    let easHelper: EASHelper | undefined;
    let erc8004Bridge: ERC8004Bridge | undefined;
    let reputationReporter: ReputationReporter | undefined;
    let walletProvider: IWalletProvider | undefined;
    let requesterAddress: string;
    let contractAddresses: { usdc: string; actpKernel: string; escrowVault: string } | undefined;

    // If custom runtime provided, use it directly
    if (config.runtime) {
      // Custom runtime: requesterAddress is mandatory
      if (!config.requesterAddress) {
        throw new Error('requesterAddress is required when providing a custom runtime');
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(config.requesterAddress)) {
        throw new Error(
          `Invalid requesterAddress: "${config.requesterAddress}". ` +
            'Must be a valid Ethereum address (0x-prefixed, 40 hex chars)'
        );
      }
      requesterAddress = config.requesterAddress;
      runtime = config.runtime;
    } else {
      // Initialize runtime based on mode
      switch (config.mode) {
        case 'mock': {
          // Mock mode: requesterAddress is mandatory
          if (!config.requesterAddress) {
            throw new Error('requesterAddress is required for mock mode');
          }
          if (!/^0x[a-fA-F0-9]{40}$/.test(config.requesterAddress)) {
            throw new Error(
              `Invalid requesterAddress: "${config.requesterAddress}". ` +
                'Must be a valid Ethereum address (0x-prefixed, 40 hex chars)'
            );
          }
          requesterAddress = config.requesterAddress;

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
          const networkConfig = getNetwork(network);

          // Default RPC URL from network config if not provided
          const rpcUrl = config.rpcUrl ?? networkConfig.rpcUrl;

          // Optional persistent state directory
          if (config.stateDirectory) {
            validateStateDirectory(config.stateDirectory);
          }

          // Create ethers provider and signer
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const signer = new ethers.Wallet(config.privateKey, provider);

          // ====================================================================
          // AIP-12: Wallet Provider Selection
          // ====================================================================
          if (config.wallet === 'auto') {
            // Tier 1: CoinbaseSmartWallet + gasless transactions
            if (!networkConfig.aa) {
              throw new Error(
                `AA configuration not available for ${config.mode} mode. ` +
                  'Check that networks.ts has aa config for this network.'
              );
            }

            const autoWallet = await AutoWalletProvider.create({
              signer,
              provider,
              chainId: networkConfig.chainId,
              actpKernelAddress: config.contracts?.actpKernel ?? networkConfig.contracts.actpKernel,
              bundler: {
                primaryUrl: networkConfig.aa.bundlerUrls.coinbase,
                backupUrl: networkConfig.aa.bundlerUrls.pimlico,
              },
              paymaster: {
                primaryUrl: networkConfig.aa.paymasterUrls.coinbase,
                backupUrl: networkConfig.aa.paymasterUrls.pimlico,
              },
            });

            // Check AgentRegistry — gasless only for registered agents
            const smartWalletAddress = autoWallet.getAddress();
            const agentRegistryAddress = config.contracts?.agentRegistry
              ?? networkConfig.contracts.agentRegistry;

            let isRegistered = false;
            if (agentRegistryAddress) {
              try {
                isRegistered = await checkRegistration(
                  provider, agentRegistryAddress, smartWalletAddress
                );
              } catch {
                // Registry check failed (network issues) — allow AA anyway
                // Paymaster policy is the final gate
                isRegistered = true;
                sdkLogger.warn('AgentRegistry check failed, proceeding with AA wallet');
              }
            } else {
              // No registry deployed — skip check (early testnet)
              isRegistered = true;
            }

            if (isRegistered) {
              walletProvider = autoWallet;
              requesterAddress = smartWalletAddress;
            } else {
              // Not registered — fall back to EOA with warning
              sdkLogger.warn(
                'Agent not registered on AgentRegistry. ' +
                'Falling back to EOA wallet (gas not sponsored). ' +
                'Run "actp register" for gas-free transactions.'
              );
              walletProvider = new EOAWalletProvider(signer, networkConfig.chainId);
              requesterAddress = config.requesterAddress ?? signer.address;
            }
          } else {
            // Tier 2: EOA Wallet (backward compatible)
            walletProvider = new EOAWalletProvider(signer, networkConfig.chainId);
            requesterAddress = config.requesterAddress ?? signer.address;
          }

          // Validate derived/provided address
          if (!/^0x[a-fA-F0-9]{40}$/.test(requesterAddress)) {
            throw new Error(
              `Invalid requesterAddress: "${requesterAddress}". ` +
                'Must be a valid Ethereum address (0x-prefixed, 40 hex chars)'
            );
          }

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

          // ERC-8004 INTEGRATION: Create bridge for agent ID resolution
          const erc8004Network: ERC8004Network =
            config.mode === 'testnet' ? 'base-sepolia' : 'base';
          erc8004Bridge = new ERC8004Bridge({
            network: erc8004Network,
            rpcUrl,
          });

          // ERC-8004 REPUTATION: Create reporter for settlement outcome reporting
          reputationReporter = new ReputationReporter({
            network: erc8004Network,
            signer,
          });

          // AIP-12: Contract addresses for AA batched payments
          contractAddresses = {
            usdc: config.contracts?.usdc ?? networkConfig.contracts.usdc,
            actpKernel: config.contracts?.actpKernel ?? networkConfig.contracts.actpKernel,
            escrowVault: config.contracts?.escrowVault ?? networkConfig.contracts.escrowVault,
          };

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
    const normalizedAddress = requesterAddress.toLowerCase();

    const info: ACTPClientInfo = {
      mode: config.mode,
      address: normalizedAddress,
      stateDirectory,
      walletTier: walletProvider?.getWalletInfo().tier,
    };

    // Pass wallet provider and contract addresses to constructor
    const client = new ACTPClient(
      runtime, normalizedAddress, info, easHelper,
      erc8004Bridge, reputationReporter, walletProvider, contractAddresses
    );

    // Drift detection: non-blocking check for AGIRAILS.md sync status
    if (config.mode !== 'mock') {
      client.checkConfigDrift(config).catch(() => {
        // Silently ignore drift check errors — non-critical
      });
    }

    return client;
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

  // ==========================================================================
  // Unified Payment API (Router-based)
  // ==========================================================================

  /**
   * Unified pay method - auto-selects the best adapter.
   *
   * This is the recommended way to initiate payments. The router
   * intelligently selects the appropriate adapter based on:
   * - Explicit adapter preference (metadata.preferredAdapter)
   * - Required capabilities (escrow, disputes)
   * - Recipient type (address vs HTTP endpoint)
   *
   * IMPORTANT: Returns with state=COMMITTED, NOT settled.
   * You MUST call the lifecycle methods to complete:
   *
   * ```typescript
   * const result = await client.pay({ to, amount });
   * // ... provider does work ...
   * await client.startWork(result.txId);
   * await client.deliver(result.txId);
   * // ... after dispute window ...
   * await client.release(result.escrowId!);  // EXPLICIT release
   * ```
   *
   * @param params - Unified payment parameters
   * @returns Promise resolving to unified payment result
   * @throws {ValidationError} If params are invalid
   * @throws {Error} If no suitable adapter found
   *
   * @example
   * ```typescript
   * // Simple payment (uses basic adapter by default)
   * const result = await client.pay({
   *   to: '0xProvider...',
   *   amount: '100',
   * });
   *
   * // Require escrow (prefers standard adapter)
   * const result = await client.pay({
   *   to: '0xProvider...',
   *   amount: '100',
   *   metadata: { requiresEscrow: true }
   * });
   *
   * // Explicit adapter selection
   * const result = await client.pay({
   *   to: '0xProvider...',
   *   amount: '100',
   *   metadata: { preferredAdapter: 'standard' }
   * });
   * ```
   */
  async pay(params: UnifiedPayParams): Promise<UnifiedPayResult> {
    // Use selectAndResolve to auto-resolve ERC-8004 agent IDs to wallet addresses
    const { adapter, resolvedParams } = await this.router.selectAndResolve(params);
    return adapter.pay(resolvedParams);
  }

  /**
   * Get transaction status by ID.
   *
   * Returns current state plus action hints indicating
   * what operations are available.
   *
   * @param txId - Transaction ID
   * @returns Promise resolving to transaction status
   * @throws {Error} If transaction not found
   *
   * @example
   * ```typescript
   * const status = await client.getStatus(txId);
   * if (status.canRelease) {
   *   await client.release(txId);
   * }
   * ```
   */
  async getStatus(txId: string): Promise<TransactionStatus> {
    // Use standard adapter for status - it has access to all tx details
    return this.standard.getStatus(txId);
  }

  /**
   * Transition to IN_PROGRESS state (provider starts work).
   *
   * Must be called by provider after accepting the transaction.
   * ACTP requires this explicit transition before delivery.
   *
   * @param txId - Transaction ID
   * @throws {Error} If transaction not found or wrong state
   *
   * @example
   * ```typescript
   * // Provider acknowledges and starts work
   * await client.startWork(txId);
   * ```
   */
  async startWork(txId: string): Promise<void> {
    await this.runtime.transitionState(txId, 'IN_PROGRESS');
  }

  /**
   * Transition to DELIVERED state (provider completes work).
   *
   * When no disputeWindowSeconds is provided, uses the transaction's actual
   * disputeWindow from creation time. This ensures consistency and prevents
   * mismatches between transaction creation and delivery.
   *
   * @param txId - Transaction ID
   * @param disputeWindowSeconds - Optional dispute window override in seconds.
   *                               If not provided, uses transaction's disputeWindow.
   * @throws {Error} If transaction not found or wrong state
   *
   * @example
   * ```typescript
   * // Use transaction's disputeWindow (recommended)
   * await client.deliver(txId);
   *
   * // Override with custom dispute window (use with caution)
   * await client.deliver(txId, 7200);
   * ```
   */
  async deliver(txId: string, disputeWindowSeconds?: number): Promise<void> {
    // Fetch transaction
    const tx = await this.runtime.getTransaction(txId);
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    // First ensure we're in IN_PROGRESS state
    if (tx.state === 'COMMITTED') {
      await this.runtime.transitionState(txId, 'IN_PROGRESS');
    }

    // Use provided disputeWindow or fall back to transaction's disputeWindow
    const effectiveDisputeWindow = disputeWindowSeconds ?? tx.disputeWindow;

    // Encode dispute window as proof
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256'],
      [effectiveDisputeWindow]
    );

    await this.runtime.transitionState(txId, 'DELIVERED', proof);
  }

  /**
   * Release escrow funds (EXPLICIT settlement).
   *
   * MUST be called after dispute window expires or requester approves.
   * This is the ONLY way to settle - NO auto-settle.
   *
   * If ERC-8004 agent ID was set during transaction creation, this method
   * also reports the settlement to the ERC-8004 Reputation Registry.
   * Reputation reporting is non-blocking - failures don't affect settlement.
   *
   * @param escrowId - Escrow ID (usually same as txId)
   * @param attestationUID - Optional attestation UID for verification
   * @throws {Error} If escrow not found or dispute window active
   *
   * @example
   * ```typescript
   * // After dispute window expires
   * await client.release(result.escrowId!);
   * // Transaction is now SETTLED
   * // If ERC-8004 agent, reputation is automatically reported
   * ```
   */
  async release(escrowId: string, attestationUID?: string): Promise<void> {
    // In ACTP, escrowId === txId
    const txId = escrowId;

    // Get transaction to find agentId (for reputation reporting)
    const tx = await this.runtime.getTransaction(txId);
    const agentId = tx?.agentId;

    // Release escrow (this is the critical operation)
    await this.runtime.releaseEscrow(escrowId, attestationUID);

    // ERC-8004 REPUTATION: Report settlement if agent ID exists
    // Non-blocking - fire and forget (settlement already succeeded)
    if (this.reputationReporter && agentId && agentId !== '0') {
      // Don't await - reputation reporting shouldn't block the release
      this.reputationReporter
        .reportSettlement({
          agentId,
          txId,
        })
        .then((result) => {
          if (result) {
            console.log(
              `[ERC8004] Settlement reported for agent ${agentId}: ${result.txHash}`
            );
          }
        })
        .catch(() => {
          // Errors already logged by reporter - silently ignore here
        });
    }
  }

  /**
   * Register a custom adapter.
   *
   * Allows adding custom payment adapters (e.g., x402, ERC-8004)
   * that will be considered during router selection.
   *
   * @param adapter - Adapter to register
   *
   * @example
   * ```typescript
   * // Register a custom x402 adapter
   * client.registerAdapter(new X402Adapter(client.runtime, requesterAddress));
   * ```
   */
  registerAdapter(adapter: IAdapter): void {
    this.registry.register(adapter);
  }

  /**
   * Get all registered adapter IDs.
   *
   * @returns Array of adapter IDs
   *
   * @example
   * ```typescript
   * const adapters = client.getRegisteredAdapters();
   * console.log(adapters); // ['basic', 'standard', 'x402']
   * ```
   */
  getRegisteredAdapters(): string[] {
    return this.registry.getIds();
  }

  /**
   * Get the ERC-8004 Reputation Reporter instance.
   *
   * Only available in testnet/mainnet modes. Returns undefined in mock mode.
   * Use this for manual reputation reporting or checking stats.
   *
   * @returns ReputationReporter instance or undefined
   *
   * @example
   * ```typescript
   * const reporter = client.getReputationReporter();
   * if (reporter) {
   *   // Check if already reported
   *   const reported = reporter.isReported(txId);
   *
   *   // Get agent reputation
   *   const rep = await reporter.getAgentReputation('12345');
   *   console.log(`Agent has ${rep?.count} reviews, score: ${rep?.score}`);
   * }
   * ```
   */
  getReputationReporter(): ReputationReporter | undefined {
    return this.reputationReporter;
  }

  /**
   * AIP-12: Get the wallet provider instance.
   *
   * Only available in testnet/mainnet modes.
   * Returns undefined in mock mode.
   *
   * Use this for advanced operations like checking wallet info,
   * or sending custom batched transactions.
   */
  getWalletProvider(): IWalletProvider | undefined {
    return this.walletProvider;
  }

  /**
   * Non-blocking drift detection for AGIRAILS.md config.
   * Checks if local AGIRAILS.md matches on-chain config hash.
   * Logs warnings but never blocks agent operation.
   * @internal
   */
  private async checkConfigDrift(config: ACTPClientConfig): Promise<void> {
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');

      // Look for AGIRAILS.md in cwd
      const agirailsMdPath = join(process.cwd(), 'AGIRAILS.md');
      if (!existsSync(agirailsMdPath)) {
        return; // No local file — nothing to check
      }

      const network = config.mode === 'testnet' ? 'base-sepolia' : 'base-mainnet';
      const networkConfig = getNetwork(network);
      if (!networkConfig.contracts.agentRegistry) {
        return; // No registry on this network
      }

      const content = readFileSync(agirailsMdPath, 'utf-8');
      const { computeConfigHash } = await import('./config/agirailsmd');
      const { configHash: localHash } = computeConfigHash(content);

      const { AgentRegistryClient } = await import('./registry/AgentRegistryClient');
      const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
      const registryClient = AgentRegistryClient.readOnly(networkConfig.contracts.agentRegistry, provider);

      // Detect template vs published state from frontmatter
      const { parseAgirailsMd: parseMd } = await import('./config/agirailsmd');
      const { frontmatter } = parseMd(content);
      const isTemplate = !frontmatter.config_hash;

      const onChainState = await registryClient.getConfig(config.requesterAddress ?? this.info.address);
      const ZERO_HASH = '0x' + '0'.repeat(64);

      if (onChainState.configHash === ZERO_HASH) {
        if (isTemplate) {
          console.info('[AGIRAILS] AGIRAILS.md loaded (template mode). Run "actp publish" to register and sync on-chain.');
        } else {
          console.warn('[AGIRAILS] Config not published on-chain. Run: actp publish');
        }
      } else if (onChainState.configHash !== localHash) {
        console.warn('[AGIRAILS] Local AGIRAILS.md differs from on-chain. Run: actp diff');
      }
    } catch {
      // Silently ignore — drift detection is best-effort
    }
  }
}
