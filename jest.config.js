/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Preserve cwd across test suites to prevent uv_cwd errors
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
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
