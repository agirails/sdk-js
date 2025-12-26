/**
 * Index exports test - verify all public exports are accessible.
 */

import {
  MockStateManager,
  MockStateCorruptedError,
  MockStateVersionError,
  MockStateLockError,
  MockState,
  MockTransaction,
  MockEscrow,
  MockAccount,
  MockBlockchain,
  MockEvent,
  TransactionState,
  TransactionStateValue,
  MOCK_STATE_DEFAULTS,
} from './index';

describe('SDK exports', () => {
  it('should export MockStateManager class', () => {
    expect(MockStateManager).toBeDefined();
    expect(typeof MockStateManager).toBe('function');
  });

  it('should export error classes', () => {
    expect(MockStateCorruptedError).toBeDefined();
    expect(MockStateVersionError).toBeDefined();
    expect(MockStateLockError).toBeDefined();
  });

  it('should export TransactionStateValue enum', () => {
    expect(TransactionStateValue).toBeDefined();
    expect(TransactionStateValue.INITIATED).toBe(0);
    expect(TransactionStateValue.QUOTED).toBe(1);
    expect(TransactionStateValue.COMMITTED).toBe(2);
    expect(TransactionStateValue.IN_PROGRESS).toBe(3);
    expect(TransactionStateValue.DELIVERED).toBe(4);
    expect(TransactionStateValue.SETTLED).toBe(5);
    expect(TransactionStateValue.DISPUTED).toBe(6);
    expect(TransactionStateValue.CANCELLED).toBe(7);
  });

  it('should export MOCK_STATE_DEFAULTS', () => {
    expect(MOCK_STATE_DEFAULTS).toBeDefined();
    expect(MOCK_STATE_DEFAULTS.VERSION).toBe('1.0');
    expect(MOCK_STATE_DEFAULTS.CHAIN_ID).toBe(84532);
    expect(MOCK_STATE_DEFAULTS.INITIAL_BLOCK_NUMBER).toBe(1000);
    expect(MOCK_STATE_DEFAULTS.BLOCK_TIME).toBe(2);
    expect(MOCK_STATE_DEFAULTS.DEFAULT_USDC_BALANCE).toBe('10000000000');
  });

  it('should be able to instantiate MockStateManager', () => {
    const manager = new MockStateManager('/tmp/test-actp');
    expect(manager).toBeInstanceOf(MockStateManager);
  });

  it('should be able to instantiate error classes', () => {
    const corrupted = new MockStateCorruptedError('/test/path');
    expect(corrupted).toBeInstanceOf(Error);
    expect(corrupted.statePath).toBe('/test/path');

    const version = new MockStateVersionError('0.5');
    expect(version).toBeInstanceOf(Error);
    expect(version.version).toBe('0.5');

    const lock = new MockStateLockError('/test/path');
    expect(lock).toBeInstanceOf(Error);
    expect(lock.statePath).toBe('/test/path');
  });

  it('should export state types', () => {
    // Verify type exports are defined (they're TypeScript interfaces/types)
    // These are used as type annotations, not runtime values
    const mockState: MockState = {} as MockState;
    const mockTx: MockTransaction = {} as MockTransaction;
    const mockEscrow: MockEscrow = {} as MockEscrow;
    const mockAccount: MockAccount = {} as MockAccount;
    const mockBlockchain: MockBlockchain = {} as MockBlockchain;
    const mockEvent: MockEvent = {} as MockEvent;

    // Just verify they're usable as types
    expect(mockState).toBeDefined();
    expect(mockTx).toBeDefined();
    expect(mockEscrow).toBeDefined();
    expect(mockAccount).toBeDefined();
    expect(mockBlockchain).toBeDefined();
    expect(mockEvent).toBeDefined();
  });

  it('should export TransactionState type', () => {
    const state: TransactionState = 'INITIATED';
    expect(state).toBe('INITIATED');
  });
});
