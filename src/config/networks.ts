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

// Shared AA keys for out-of-the-box UX (override with env vars in production).
const CDP_CLIENT_KEY = process.env.CDP_API_KEY?.trim() || '2txciN85t41erCjveqgNnXYyHRcoo5xP';
const PIMLICO_KEY = process.env.PIMLICO_API_KEY?.trim() || 'pim_YiHmeAijzTPUvo1UMmXUiN';

function resolveOverrideUrl(url?: string): string | undefined {
  const trimmed = url?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveCoinbaseRpcUrl(networkPath: string, override?: string): string | undefined {
  const overrideUrl = resolveOverrideUrl(override);
  if (overrideUrl) return overrideUrl;
  return `https://api.developer.coinbase.com/rpc/v1/${networkPath}/${CDP_CLIENT_KEY}`;
}

function resolvePimlicoRpcUrl(chainId: number, override?: string): string | undefined {
  const overrideUrl = resolveOverrideUrl(override);
  if (overrideUrl) return overrideUrl;
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${PIMLICO_KEY}`;
}

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
   * Known deployment block of the ACTPKernel contract.
   *
   * Eliminates the O(log N) binary-search over `getCode()` that
   * DualNonceManager otherwise performs on first nonce derivation.
   * If undefined, the binary search fallback is used.
   */
  actpKernelDeploymentBlock?: number;

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
      coinbase?: string;
      pimlico?: string;
    };
    /** Paymaster RPC URLs (ERC-7677) */
    paymasterUrls: {
      coinbase?: string;
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
    actpKernel: '0x0ba0b17554601b30F5406e74d2208f567C12CcFE',
    escrowVault: '0xedC62264301A119207f1f89C6bDE4Fd7a7A4CeB4',
    usdc: '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb', // MockUSDC
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    agentRegistry: '0x55e7F23AB5700fD0D9f83294be2d0F2eC84013E1',
    identityRegistry: '0xF64F748C7802a68Cb936a9213881fE74e83FDA97',
    archiveTreasury: '0xACB672de092beaAE2cd286dD61Cb2352AF7159F1',
    x402Relay: '0x4DCD02b276Dbeab57c265B72435e90507b6Ac81A',
  },
  eas: {
    deliverySchemaUID: '0x1b0ebdf0bd20c28ec9d5362571ce8715a55f46e81c3de2f9b0d8e1b95fb5ffce'
  },
  gasSettings: {
    maxFeePerGas: ethers.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei')
  },
  actpKernelDeploymentBlock: 39180727,
  // AIP-12: Account Abstraction
  aa: {
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    smartWalletFactory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
    bundlerUrls: {
      coinbase: resolveCoinbaseRpcUrl('base-sepolia', process.env.CDP_BUNDLER_URL),
      pimlico: resolvePimlicoRpcUrl(84532, process.env.PIMLICO_BUNDLER_URL),
    },
    paymasterUrls: {
      coinbase: resolveCoinbaseRpcUrl('base-sepolia', process.env.CDP_PAYMASTER_URL),
      pimlico: resolvePimlicoRpcUrl(84532, process.env.PIMLICO_PAYMASTER_URL),
    },
  },
};

/**
 * Base Mainnet Configuration
 */
export const BASE_MAINNET: NetworkConfig = {
  name: 'Base Mainnet',
  chainId: 8453,
  rpcUrl: BASE_MAINNET_RPC_URL,
  blockExplorer: 'https://basescan.org',
  contracts: {
    actpKernel: '0x132B9eB321dBB57c828B083844287171BDC92d29',
    escrowVault: '0x6aAF45882c4b0dD34130ecC790bb5Ec6be7fFb99',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    agentRegistry: '0x6fB222CF3DDdf37Bcb248EE7BBBA42Fb41901de8',
    archiveTreasury: '0x0516C411C0E8d75D17A768022819a0a4FB3cA2f2',
    x402Relay: '0x81DFb954A3D58FEc24Fc9c946aC2C71a911609F8',
  },
  eas: {
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
  actpKernelDeploymentBlock: 41935749,
  // AIP-12: Account Abstraction
  aa: {
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    smartWalletFactory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
    bundlerUrls: {
      coinbase: resolveCoinbaseRpcUrl('base', process.env.CDP_BUNDLER_URL),
      pimlico: resolvePimlicoRpcUrl(8453, process.env.PIMLICO_BUNDLER_URL),
    },
    paymasterUrls: {
      coinbase: resolveCoinbaseRpcUrl('base', process.env.CDP_PAYMASTER_URL),
      pimlico: resolvePimlicoRpcUrl(8453, process.env.PIMLICO_PAYMASTER_URL),
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
    maxTransactionAmount: config.maxTransactionAmount,
    actpKernelDeploymentBlock: config.actpKernelDeploymentBlock,
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
