module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  // Transform ESM modules (kubo-rpc-client) to CommonJS for Jest
  transformIgnorePatterns: [
    'node_modules/(?!(kubo-rpc-client|ipfs-core-utils|multiformats|@multiformats)/)'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**'
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    },
    './src/protocol/EscrowVault.ts': {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90
    },
    './src/protocol/ACTPKernel.ts': {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90
    },
    './src/utils/validation.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  }
};


