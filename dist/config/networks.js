"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NETWORKS = exports.BASE_MAINNET = exports.BASE_SEPOLIA = void 0;
exports.getNetwork = getNetwork;
exports.isValidNetwork = isValidNetwork;
exports.validateNetworkConfig = validateNetworkConfig;
const ethers_1 = require("ethers");
/**
 * Base Sepolia Testnet Configuration
 */
exports.BASE_SEPOLIA = {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    blockExplorer: 'https://sepolia.basescan.org',
    contracts: {
        // Redeployed 2025-12-10 by Arha (new deployer wallet 0x42a2f11555b9363fb7ebdcdc76d7cb26e01dcb00)
        actpKernel: '0xD199070F8e9FB9a127F6Fe730Bc13300B4b3d962',
        escrowVault: '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585',
        usdc: '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb', // MockUSDC
        // EAS contracts (Base native deployment)
        eas: '0x4200000000000000000000000000000000000021',
        easSchemaRegistry: '0x4200000000000000000000000000000000000020',
        // AIP-7 Agent Registry (deployed 2025-12-11)
        agentRegistry: '0xFed6914Aa70c0a53E9c7Cc4d2Ae159e4748fb09D'
    },
    eas: {
        // Deployed 2025-11-23 - AIP-4 delivery proof schema
        deliverySchemaUID: '0x1b0ebdf0bd20c28ec9d5362571ce8715a55f46e81c3de2f9b0d8e1b95fb5ffce'
    },
    gasSettings: {
        maxFeePerGas: ethers_1.ethers.parseUnits('2', 'gwei'),
        maxPriorityFeePerGas: ethers_1.ethers.parseUnits('1', 'gwei')
    }
};
/**
 * Base Mainnet Configuration
 */
exports.BASE_MAINNET = {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    blockExplorer: 'https://basescan.org',
    contracts: {
        // TODO: Update after mainnet deployment
        actpKernel: '0x0000000000000000000000000000000000000000',
        escrowVault: '0x0000000000000000000000000000000000000000',
        usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Official USDC on Base
        // EAS contracts (Base native deployment)
        eas: '0x4200000000000000000000000000000000000021',
        easSchemaRegistry: '0x4200000000000000000000000000000000000020'
    },
    eas: {
        // TODO: Deploy delivery schema to mainnet
        deliverySchemaUID: '0x0000000000000000000000000000000000000000000000000000000000000000'
    },
    gasSettings: {
        maxFeePerGas: ethers_1.ethers.parseUnits('0.5', 'gwei'),
        maxPriorityFeePerGas: ethers_1.ethers.parseUnits('0.1', 'gwei')
    }
};
/**
 * All supported networks
 */
exports.NETWORKS = {
    'base-sepolia': exports.BASE_SEPOLIA,
    'base-mainnet': exports.BASE_MAINNET
};
/**
 * Get network configuration by name (returns deep clone to prevent mutation)
 */
function getNetwork(network) {
    const config = exports.NETWORKS[network];
    if (!config) {
        throw new Error(`Unknown network: ${network}. Supported networks: ${Object.keys(exports.NETWORKS).join(', ')}`);
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
            agentRegistry: config.contracts.agentRegistry
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
function isValidNetwork(network) {
    return network in exports.NETWORKS;
}
/**
 * Validate that contract addresses are deployed (not zero addresses)
 *
 * @throws Error if any contract address is zero (0x000...000)
 */
function validateNetworkConfig(config) {
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    const errors = [];
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
        throw new Error(`Network configuration error for ${config.name} (chainId: ${config.chainId}):\n\n` +
            errors.map(e => `  ✗ ${e}`).join('\n') +
            `\n\nContracts must be deployed before using the SDK. Please:\n` +
            `  1. Deploy contracts to ${config.name}\n` +
            `  2. Update src/config/networks.ts with deployed addresses\n` +
            `  3. Rebuild the SDK: npm run build`);
    }
}
//# sourceMappingURL=networks.js.map