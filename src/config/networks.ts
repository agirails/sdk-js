import { BigNumber, utils } from 'ethers';

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
  };
  gasSettings: {
    maxFeePerGas: BigNumber;
    maxPriorityFeePerGas: BigNumber;
  };
}

/**
 * Base Sepolia Testnet Configuration
 */
export const BASE_SEPOLIA: NetworkConfig = {
  name: 'Base Sepolia',
  chainId: 84532,
  rpcUrl: 'https://sepolia.base.org',
  blockExplorer: 'https://sepolia.basescan.org',
  contracts: {
    // Deployed 2025-01-22 by Justin (Final - Verified on Basescan)
    actpKernel: '0xb5B002A73743765450d427e2F8a472C24FDABF9b',
    escrowVault: '0x67770791c83eA8e46D8a08E09682488ba584744f',
    usdc: '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb' // MockUSDC
  },
  gasSettings: {
    maxFeePerGas: utils.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('1', 'gwei')
  }
};

/**
 * Base Mainnet Configuration
 */
export const BASE_MAINNET: NetworkConfig = {
  name: 'Base Mainnet',
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',
  blockExplorer: 'https://basescan.org',
  contracts: {
    // TODO: Update after mainnet deployment
    actpKernel: '0x0000000000000000000000000000000000000000',
    escrowVault: '0x0000000000000000000000000000000000000000',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Official USDC on Base
  },
  gasSettings: {
    maxFeePerGas: utils.parseUnits('0.5', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('0.1', 'gwei')
  }
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
      usdc: config.contracts.usdc
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

