import { HardhatUserConfig } from 'hardhat/config';
import '@nomiclabs/hardhat-ethers';
import * as dotenv from 'dotenv';

// Load .env file
dotenv.config();

/**
 * Hardhat config for ACTP SDK integration tests
 *
 * NOTE: We test against deployed contracts on Base Sepolia testnet,
 * not local mock contracts. See src/config/networks.ts for addresses.
 */
const config: HardhatUserConfig = {
  solidity: '0.8.20', // Match production contract compiler version
  paths: {
    tests: './hardhat/test',
    cache: './hardhat/cache',
    artifacts: './hardhat/artifacts'
  },
  networks: {
    'base-sepolia': {
      url: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
      accounts: [
        process.env.PRIVATE_KEY,
        process.env.PROVIDER_PRIVATE_KEY
      ].filter((key): key is string => !!key), // Filter out undefined values
      chainId: 84532
    }
  },
  mocha: {
    timeout: 120000 // Increased for network tests
  }
};

export default config;
