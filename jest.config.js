/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // PRD §8.2 anvil-fork e2e tests live under src/__e2e__/blockchain-runtime/.
  // They spin up real anvil processes against a forked Base Sepolia state
  // and only run when the dedicated `test:fork-e2e` script is invoked
  // (with BASE_SEPOLIA_RPC + CI_TEST_KEYSTORE_BASE64 env vars set).
  // Default `npm test` skips them so contributors without foundry installed
  // see green.
  testPathIgnorePatterns: ['/node_modules/', 'src/__e2e__/blockchain-runtime/'],
  // Preserve cwd across test suites to prevent uv_cwd errors
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    // BETA THRESHOLDS (2025-12-26)
    // Global threshold set to current baseline for beta release
    // Security-critical modules have higher thresholds below
    // CLI commands excluded (integration tested separately)
    global: {
      branches: 25,
      functions: 30,
      lines: 35,
      statements: 35,
    },
    // Security-critical: Must maintain high coverage
    './src/utils/security.ts': {
      branches: 80,
      functions: 90,
      lines: 90,
      statements: 90,
    },
    './src/utils/NonceManager.ts': {
      branches: 70,
      functions: 70,
      lines: 80,
      statements: 80,
    },
    './src/utils/validation.ts': {
      branches: 55,
      functions: 85,
      lines: 80,
      statements: 80,
    },
    // Core runtime: Critical for correctness
    './src/runtime/MockRuntime.ts': {
      branches: 75,
      functions: 85,
      lines: 90,
      statements: 90,
    },
    './src/runtime/MockStateManager.ts': {
      branches: 80,
      functions: 95,
      lines: 90,
      statements: 90,
    },
    // Protocol: Core business logic
    './src/protocol/ACTPKernel.ts': {
      branches: 60,
      functions: 90,
      lines: 85,
      statements: 85,
    },
    './src/protocol/EscrowVault.ts': {
      branches: 45,
      functions: 95,
      lines: 90,
      statements: 90,
    },
  },
  verbose: true,
  // Run tests sequentially to avoid file locking conflicts
  // MockStateManager uses file-based persistence which can cause
  // race conditions when tests run in parallel
  maxWorkers: 1,
  // Increase timeout for CLI tests that spawn processes
  testTimeout: 30000,
};
