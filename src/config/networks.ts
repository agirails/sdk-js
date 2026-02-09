import { ethers } from 'ethers';

// ============================================================================
// SECURITY FIX (C-7): RPC URL Configuration
// ============================================================================
// Environment variables take priority over hardcoded defaults.
// This prevents accidental API key leakage if developers modify this file.
// Public RPC endpoints are used as fallbacks for ease of use.
//
// Set these environment variables to use your own RPC provider:
//   BASE_SEPOLIA_RPC - Custom RPC for Base Sepolia testnet
//   BASE_MAINNET_RPC - Custom RPC for Base Mainnet
// ============================================================================

const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const BASE_MAINNET_RPC_URL = process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org';

// AGIRAILS CDP Client API Key — safe to embed, cannot access funds/portfolios.
// Developers can override with their own key via CDP_API_KEY env var.
// Paymaster policy restricts sponsorship to AGIRAILS contracts only.
const CDP_CLIENT_KEY = process.env.CDP_API_KEY || '2txciN85t41erCjveqgNnXYyHRcoo5xP';

/**
 * Network configuration
 */
export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  blockExplorer: string;
  contracts: {
    actpKernel: string;
    escrowVault: string;
    usdc: string;
    eas: string; // EAS contract address
    easSchemaRegistry: string; // EAS SchemaRegistry contract
    agentRegistry?: string; // AIP-7 Agent Registry (optional until deployed)
    identityRegistry?: string; // AIP-7 ERC-1056 DID Registry (optional until deployed)
    archiveTreasury?: string; // AIP-7 Archive Treasury for Arweave funding (optional until deployed)
    x402Relay?: string; // X402Relay for atomic payment fee splitting (optional until deployed)
  };
  eas: {
    deliverySchemaUID: string; // AIP-4 delivery proof schema
    configSnapshotSchemaUID?: string; // AGIRAILS.md config snapshot schema
  };
  gasSettings: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  };
  /**
   * Maximum transaction amount in USDC (human-readable, e.g., 100 = $100)
   *
   * SECURITY: Limits exposure on unaudited mainnet contracts.
   * Set to undefined for no limit (testnet only).
   */
  maxTransactionAmount?: number;

  /**
   * AIP-12: Account Abstraction (AA) configuration.
   * EntryPoint v0.6 + CoinbaseSmartWallet.
   */
  aa?: {
    /** ERC-4337 EntryPoint v0.6 address */
    entryPoint: string;
    /** CoinbaseSmartWallet factory address */
    smartWalletFactory: string;
    /** Bundler RPC URLs */
    bundlerUrls: {
      coinbase: string;
      pimlico?: string;
    };
    /** Paymaster RPC URLs (ERC-7677) */
    paymasterUrls: {
      coinbase: string;
      pimlico?: string;
    };
  };
}

/**
 * Base Sepolia Testnet Configuration
 */
export const BASE_SEPOLIA: NetworkConfig = {
  name: 'Base Sepolia',
  chainId: 84532,
  rpcUrl: BASE_SEPOLIA_RPC_URL,
  blockExplorer: 'https://sepolia.basescan.org',
  contracts: {
    // Redeployed 2026-02-06 with agentId support
    actpKernel: '0x469CBADbACFFE096270594F0a31f0EEC53753411',
    escrowVault: '0x57f888261b629bB380dfb983f5DA6c70Ff2D49E5',
    usdc: '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb', // MockUSDC
    // EAS contracts (Base native deployment)
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    // AIP-7 Agent Registry v2 (redeployed 2026-02-09 with configHash/configCID/listed)
    agentRegistry: '0xDd6D66924B43419F484aE981F174b803487AF25A',
    // AIP-7 Identity Registry - ERC-1056 DID Registry (deployed 2026-01-09)
    identityRegistry: '0xF64F748C7802a68Cb936a9213881fE74e83FDA97',
    // AIP-7 Archive Treasury - Arweave funding (deployed 2026-01-09)
    archiveTreasury: '0xeB75DE7cF5ce77ab15BB0fFa3a2A79e6aaa554B0',
    // X402Relay - atomic payment fee splitting (TODO: deploy and set address)
    // x402Relay: '0x...',
  },
  eas: {
    // Deployed 2025-11-23 - AIP-4 delivery proof schema
    deliverySchemaUID: '0x1b0ebdf0bd20c28ec9d5362571ce8715a55f46e81c3de2f9b0d8e1b95fb5ffce'
  },
  gasSettings: {
    maxFeePerGas: ethers.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei')
  },
  // AIP-12: Account Abstraction
  aa: {
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    smartWalletFactory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
    bundlerUrls: {
      // Coinbase CDP bundler — set CDP_API_KEY env var
      coinbase: process.env.CDP_BUNDLER_URL || `https://api.developer.coinbase.com/rpc/v1/base-sepolia/${CDP_CLIENT_KEY}`,
      // Pimlico backup bundler — set PIMLICO_API_KEY env var
      pimlico: process.env.PIMLICO_BUNDLER_URL || (process.env.PIMLICO_API_KEY ? `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${process.env.PIMLICO_API_KEY}` : undefined),
    },
    paymasterUrls: {
      // Coinbase CDP paymaster — same endpoint as bundler
      coinbase: process.env.CDP_PAYMASTER_URL || `https://api.developer.coinbase.com/rpc/v1/base-sepolia/${CDP_CLIENT_KEY}`,
      // Pimlico backup paymaster — set PIMLICO_API_KEY env var
      pimlico: process.env.PIMLICO_PAYMASTER_URL || (process.env.PIMLICO_API_KEY ? `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${process.env.PIMLICO_API_KEY}` : undefined),
    },
  },
};

/**
 * Base Mainnet Configuration
 *
 * Base Mainnet Configuration
 * Redeployed 2026-02-09 with agentId + AgentRegistry v2 (configHash, configCID, listed)
 */
export const BASE_MAINNET: NetworkConfig = {
  name: 'Base Mainnet',
  chainId: 8453,
  rpcUrl: BASE_MAINNET_RPC_URL,
  blockExplorer: 'https://basescan.org',
  contracts: {
    // Redeployed 2026-02-09 with agentId support
    actpKernel: '0x132B9eB321dBB57c828B083844287171BDC92d29',
    escrowVault: '0x6aAF45882c4b0dD34130ecC790bb5Ec6be7fFb99',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Official USDC on Base
    // EAS contracts (Base native deployment)
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    // AIP-7 contracts (redeployed 2026-02-09)
    agentRegistry: '0x6fB222CF3DDdf37Bcb248EE7BBBA42Fb41901de8',
    archiveTreasury: '0x0516C411C0E8d75D17A768022819a0a4FB3cA2f2',
    // X402Relay - atomic payment fee splitting (TODO: deploy and set address)
    // x402Relay: '0x...',
  },
  eas: {
    // Registered 2026-02-03
    deliverySchemaUID: '0x166501e7476e2fcf9214c4c5144533c2957d56fe59d639effc1719a0658d9c9a'
  },
  gasSettings: {
    maxFeePerGas: ethers.parseUnits('0.5', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('0.1', 'gwei')
  },
  /**
   * SECURITY: $1,000 max transaction limit until contracts are audited.
   * This limits exposure in case of undiscovered vulnerabilities.
   * Will be removed/increased after formal security audit.
   */
  maxTransactionAmount: 1000,
  // AIP-12: Account Abstraction
  aa: {
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    smartWalletFactory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
    bundlerUrls: {
      coinbase: process.env.CDP_BUNDLER_URL || `https://api.developer.coinbase.com/rpc/v1/base/${CDP_CLIENT_KEY}`,
      // Pimlico backup bundler — set PIMLICO_API_KEY env var
      pimlico: process.env.PIMLICO_BUNDLER_URL || (process.env.PIMLICO_API_KEY ? `https://api.pimlico.io/v2/base/rpc?apikey=${process.env.PIMLICO_API_KEY}` : undefined),
    },
    paymasterUrls: {
      coinbase: process.env.CDP_PAYMASTER_URL || `https://api.developer.coinbase.com/rpc/v1/base/${CDP_CLIENT_KEY}`,
      // Pimlico backup paymaster — set PIMLICO_API_KEY env var
      pimlico: process.env.PIMLICO_PAYMASTER_URL || (process.env.PIMLICO_API_KEY ? `https://api.pimlico.io/v2/base/rpc?apikey=${process.env.PIMLICO_API_KEY}` : undefined),
    },
  },
};

/**
 * All supported networks
 */
export const NETWORKS: Record<string, NetworkConfig> = {
  'base-sepolia': BASE_SEPOLIA,
  'base-mainnet': BASE_MAINNET
};

/**
 * Get network configuration by name (returns deep clone to prevent mutation)
 */
export function getNetwork(network: string): NetworkConfig {
  const config = NETWORKS[network];
  if (!config) {
    throw new Error(
      `Unknown network: ${network}. Supported networks: ${Object.keys(NETWORKS).join(', ')}`
    );
  }

  // Validate that contracts are deployed (not zero addresses)
  validateNetworkConfig(config);

  // Deep clone to prevent global mutation
  return {
    name: config.name,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    blockExplorer: config.blockExplorer,
    contracts: {
      actpKernel: config.contracts.actpKernel,
      escrowVault: config.contracts.escrowVault,
      usdc: config.contracts.usdc,
      eas: config.contracts.eas,
      easSchemaRegistry: config.contracts.easSchemaRegistry,
      agentRegistry: config.contracts.agentRegistry,
      identityRegistry: config.contracts.identityRegistry,
      archiveTreasury: config.contracts.archiveTreasury,
      x402Relay: config.contracts.x402Relay
    },
    eas: {
      deliverySchemaUID: config.eas.deliverySchemaUID,
      configSnapshotSchemaUID: config.eas.configSnapshotSchemaUID
    },
    gasSettings: {
      maxFeePerGas: config.gasSettings.maxFeePerGas,
      maxPriorityFeePerGas: config.gasSettings.maxPriorityFeePerGas
    },
    ...(config.aa ? {
      aa: {
        entryPoint: config.aa.entryPoint,
        smartWalletFactory: config.aa.smartWalletFactory,
        bundlerUrls: { ...config.aa.bundlerUrls },
        paymasterUrls: { ...config.aa.paymasterUrls },
      }
    } : {}),
  };
}

/**
 * Validate network name
 */
export function isValidNetwork(network: string): boolean {
  return network in NETWORKS;
}

/**
 * Validate that contract addresses are deployed (not zero addresses)
 *
 * @throws Error if any contract address is zero (0x000...000)
 */
export function validateNetworkConfig(config: NetworkConfig): void {
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  const errors: string[] = [];

  if (config.contracts.actpKernel === zeroAddress) {
    errors.push('ACTPKernel address is zero - contracts not yet deployed to this network');
  }

  if (config.contracts.escrowVault === zeroAddress) {
    errors.push('EscrowVault address is zero - contracts not yet deployed to this network');
  }

  if (config.contracts.usdc === zeroAddress) {
    errors.push('USDC address is zero - token contract not configured for this network');
  }

  if (errors.length > 0) {
    throw new Error(
      `Network configuration error for ${config.name} (chainId: ${config.chainId}):\n\n` +
      errors.map(e => `  ✗ ${e}`).join('\n') +
      `\n\nContracts must be deployed before using the SDK. Please:\n` +
      `  1. Deploy contracts to ${config.name}\n` +
      `  2. Update src/config/networks.ts with deployed addresses\n` +
      `  3. Rebuild the SDK: npm run build`
    );
  }
}

