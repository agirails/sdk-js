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
  };
  eas: {
    deliverySchemaUID: string; // AIP-4 delivery proof schema
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
    // Redeployed 2025-12-10
    actpKernel: '0xD199070F8e9FB9a127F6Fe730Bc13300B4b3d962',
    escrowVault: '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585',
    usdc: '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb', // MockUSDC
    // EAS contracts (Base native deployment)
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    // AIP-7 Agent Registry (deployed 2025-12-11)
    agentRegistry: '0xFed6914Aa70c0a53E9c7Cc4d2Ae159e4748fb09D',
    // AIP-7 Identity Registry - ERC-1056 DID Registry (deployed 2026-01-09)
    identityRegistry: '0xF64F748C7802a68Cb936a9213881fE74e83FDA97',
    // AIP-7 Archive Treasury - Arweave funding (deployed 2026-01-09)
    archiveTreasury: '0xeB75DE7cF5ce77ab15BB0fFa3a2A79e6aaa554B0'
  },
  eas: {
    // Deployed 2025-11-23 - AIP-4 delivery proof schema
    deliverySchemaUID: '0x1b0ebdf0bd20c28ec9d5362571ce8715a55f46e81c3de2f9b0d8e1b95fb5ffce'
  },
  gasSettings: {
    maxFeePerGas: ethers.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei')
  }
};

/**
 * Base Mainnet Configuration
 *
 * WARNING: Mainnet contracts are NOT YET DEPLOYED.
 * Using 'base-mainnet' will throw an error until contracts are deployed.
 * Use 'base-sepolia' for testnet development.
 */
export const BASE_MAINNET: NetworkConfig = {
  name: 'Base Mainnet',
  chainId: 8453,
  rpcUrl: BASE_MAINNET_RPC_URL,
  blockExplorer: 'https://basescan.org',
  contracts: {
    // Deployed 2026-02-03
    actpKernel: '0xeaE4D6925510284dbC45C8C64bb8104a079D4c60',
    escrowVault: '0xb7bCadF7F26f0761995d95105DFb2346F81AF02D',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Official USDC on Base
    // EAS contracts (Base native deployment)
    eas: '0x4200000000000000000000000000000000000021',
    easSchemaRegistry: '0x4200000000000000000000000000000000000020',
    // AIP-7 contracts
    agentRegistry: '0xbf9Aa0FC291A06A4dFA943c3E0Ad41E7aE20DF02',
    archiveTreasury: '0x64B8f93fef2D2E749F5E88586753343F73246012'
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
  maxTransactionAmount: 1000
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
      archiveTreasury: config.contracts.archiveTreasury
    },
    eas: {
      deliverySchemaUID: config.eas.deliverySchemaUID
    },
    gasSettings: {
      maxFeePerGas: config.gasSettings.maxFeePerGas,
      maxPriorityFeePerGas: config.gasSettings.maxPriorityFeePerGas
    }
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

