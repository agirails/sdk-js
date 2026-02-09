/**
 * Module Import Smoke Tests
 *
 * Verifies that the SDK exports are accessible via CommonJS require().
 * This catches packaging regressions (missing exports, broken barrel files).
 */

describe('CJS Module Imports', () => {
  it('should export ACTPClient from main entry', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../../src/index');
    expect(sdk.ACTPClient).toBeDefined();
    expect(typeof sdk.ACTPClient.create).toBe('function');
  });

  it('should export error classes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../../src/index');
    expect(sdk.ACTPError).toBeDefined();
    expect(sdk.TransactionNotFoundError).toBeDefined();
    expect(sdk.InvalidStateTransitionError).toBeDefined();
    expect(sdk.InsufficientBalanceError).toBeDefined();
    expect(sdk.ValidationError).toBeDefined();
  });

  it('should export adapter classes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../../src/index');
    expect(sdk.BasicAdapter).toBeDefined();
    expect(sdk.StandardAdapter).toBeDefined();
  });

  it('should export runtime classes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../../src/index');
    expect(sdk.MockRuntime).toBeDefined();
  });

  it('should export wallet types', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../../src/index');
    expect(sdk.EOAWalletProvider).toBeDefined();
  });

  it('should export getNetwork from config', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNetwork } = require('../../src/config/networks');
    expect(typeof getNetwork).toBe('function');
    expect(getNetwork('base-sepolia').chainId).toBe(84532);
  });

  it('should export storage sub-path if available', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const storage = require('../../src/storage/index');
    expect(storage).toBeDefined();
  });
});
