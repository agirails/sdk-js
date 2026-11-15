/**
 * Module Import Smoke Tests
 *
 * Verifies that the SDK exports are accessible via CommonJS require().
 * This catches packaging regressions (missing exports, broken barrel files).
 */

describe('CJS Module Imports', () => {
  it('should export ACTPClient from main entry', () => {
    const sdk = require('../../src/index');
    expect(sdk.ACTPClient).toBeDefined();
    expect(typeof sdk.ACTPClient.create).toBe('function');
  });

  it('should export error classes', () => {
    const sdk = require('../../src/index');
    expect(sdk.ACTPError).toBeDefined();
    expect(sdk.TransactionNotFoundError).toBeDefined();
    expect(sdk.InvalidStateTransitionError).toBeDefined();
    expect(sdk.InsufficientBalanceError).toBeDefined();
    expect(sdk.ValidationError).toBeDefined();
  });

  it('should export adapter classes', () => {
    const sdk = require('../../src/index');
    expect(sdk.BasicAdapter).toBeDefined();
    expect(sdk.StandardAdapter).toBeDefined();
  });

  it('should export runtime classes', () => {
    const sdk = require('../../src/index');
    expect(sdk.MockRuntime).toBeDefined();
  });

  it('should export wallet types', () => {
    const sdk = require('../../src/index');
    expect(sdk.EOAWalletProvider).toBeDefined();
  });

  it('should export ERC-8004 registration and read-only migration APIs', () => {
    const sdk = require('../../src/index');
    expect(typeof sdk.buildERC8004RegistrationV1).toBe('function');
    expect(typeof sdk.createERC8004MigrationLedger).toBe('function');
    expect(typeof sdk.collectERC8004MigrationInventory).toBe('function');
    expect(typeof sdk.fetchERC8004Artifact).toBe('function');
  });

  it('should export getNetwork from config', () => {
    const { getNetwork } = require('../../src/config/networks');
    expect(typeof getNetwork).toBe('function');
    expect(getNetwork('base-sepolia').chainId).toBe(84532);
  });

  it('should export storage sub-path if available', () => {
    const storage = require('../../src/storage/index');
    expect(storage).toBeDefined();
  });
});
