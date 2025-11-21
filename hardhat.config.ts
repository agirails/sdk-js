import { HardhatUserConfig } from 'hardhat/config';
import '@nomiclabs/hardhat-ethers';

const config: HardhatUserConfig = {
  solidity: '0.8.21',
  paths: {
    sources: './contracts',
    tests: './hardhat/test',
    cache: './hardhat/cache',
    artifacts: './hardhat/artifacts'
  },
  mocha: {
    timeout: 60000
  }
};

export default config;
