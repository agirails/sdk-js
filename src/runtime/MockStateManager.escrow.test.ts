import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MockStateManager, MockStateCorruptedError } from './MockStateManager';
import { MOCK_STATE_DEFAULTS } from './types/MockState';

describe('MockStateManager: an escrow links exactly one transaction', () => {
  let testDir: string;
  let manager: MockStateManager;

  const stateWithEscrow = (transactions: string[]) => ({
    version: MOCK_STATE_DEFAULTS.VERSION,
    mode: 'mock',
    blockchain: { currentTime: 1733990000, blockNumber: 1, blockTime: 2 },
    transactions: {},
    escrows: {
      'escrow-1': { id: 'escrow-1', balance: '1000000', transactions, createdAt: 1733990000 },
    },
    accounts: {},
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actp-test-'));
    manager = new MockStateManager(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('loads an escrow with one transaction', () => {
    fs.writeFileSync(manager.getStatePath(), JSON.stringify(stateWithEscrow(['0xtx'])), 'utf-8');

    expect(manager.loadState().escrows['escrow-1'].transactions).toEqual(['0xtx']);
  });

  it('throws MockStateCorruptedError for an escrow with two transactions', () => {
    fs.writeFileSync(manager.getStatePath(), JSON.stringify(stateWithEscrow(['0xa', '0xb'])), 'utf-8');

    expect(() => manager.loadState()).toThrow(MockStateCorruptedError);
  });

  it('throws MockStateCorruptedError for an escrow without a transaction', () => {
    fs.writeFileSync(manager.getStatePath(), JSON.stringify(stateWithEscrow([])), 'utf-8');

    expect(() => manager.loadState()).toThrow(MockStateCorruptedError);
  });
});
