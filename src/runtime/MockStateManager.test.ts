/**
 * MockStateManager Unit Tests
 *
 * Tests cover:
 * - File creation and directory setup
 * - Load/save cycle integrity
 * - Atomic write operations
 * - File locking and concurrent access
 * - Corrupted file handling
 * - Version validation
 * - Edge cases and error conditions
 *
 * @module runtime/MockStateManager.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ZeroHash } from 'ethers';
import {
  MockStateManager,
  MockStateCorruptedError,
  MockStateVersionError,
  MockStateLockError,
} from './MockStateManager';
import { MockState, MOCK_STATE_DEFAULTS } from './types/MockState';

describe('MockStateManager', () => {
  let testDir: string;
  let manager: MockStateManager;

  /**
   * Create a unique test directory for each test.
   */
  beforeEach(() => {
    // Create unique temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actp-test-'));
    manager = new MockStateManager(testDir);
  });

  /**
   * Clean up test directory after each test.
   */
  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should create .actp directory if it does not exist', () => {
      const actpDir = path.join(testDir, '.actp');
      expect(fs.existsSync(actpDir)).toBe(true);
    });

    it('should use process.cwd() as default project root', () => {
      const defaultManager = new MockStateManager();
      const expectedPath = path.join(process.cwd(), '.actp', 'mock-state.json');
      expect(defaultManager.getStatePath()).toBe(expectedPath);
    });

    it('should handle nested project roots', () => {
      const nestedDir = path.join(testDir, 'nested', 'project');
      fs.mkdirSync(nestedDir, { recursive: true });

      const nestedManager = new MockStateManager(nestedDir);
      const expectedPath = path.join(nestedDir, '.actp', 'mock-state.json');
      expect(nestedManager.getStatePath()).toBe(expectedPath);
      expect(fs.existsSync(path.join(nestedDir, '.actp'))).toBe(true);
    });
  });

  describe('loadState', () => {
    it('should return default state if file does not exist', () => {
      const state = manager.loadState();

      expect(state.version).toBe(MOCK_STATE_DEFAULTS.VERSION);
      expect(state.mode).toBe('mock');
      expect(state.blockchain.chainId).toBe(MOCK_STATE_DEFAULTS.CHAIN_ID);
      expect(state.blockchain.blockNumber).toBe(MOCK_STATE_DEFAULTS.INITIAL_BLOCK_NUMBER);
      expect(Object.keys(state.transactions)).toHaveLength(0);
      expect(Object.keys(state.escrows)).toHaveLength(0);
      expect(Object.keys(state.accounts)).toHaveLength(0);
    });

    it('should return state with current timestamp for new state', () => {
      const beforeTime = Math.floor(Date.now() / 1000);
      const state = manager.loadState();
      const afterTime = Math.floor(Date.now() / 1000);

      expect(state.blockchain.currentTime).toBeGreaterThanOrEqual(beforeTime);
      expect(state.blockchain.currentTime).toBeLessThanOrEqual(afterTime);
    });

    it('should load existing state from file', () => {
      // Create state with specific data
      const customState: MockState = {
        version: MOCK_STATE_DEFAULTS.VERSION,
        mode: 'mock',
        blockchain: {
          currentTime: 1733990400,
          blockNumber: 2000,
          chainId: 84532,
          blockTime: 2,
        },
        transactions: {
          '0x1234': {
            id: '0x1234',
            requester: '0xAAA',
            provider: '0xBBB',
            amount: '1000000',
            state: 'INITIATED',
            createdAt: 1733990000,
            updatedAt: 1733990000,
            deadline: 1734076400,
            disputeWindow: 172800,
            completedAt: null,
            escrowId: null,
            serviceDescription: 'Test service',
            serviceHash: ZeroHash,
            deliveryProof: null,
            events: [],
          },
        },
        escrows: {},
        accounts: {},
      };

      manager.saveState(customState);
      const loaded = manager.loadState();

      expect(loaded.blockchain.blockNumber).toBe(2000);
      expect(loaded.transactions['0x1234']).toBeDefined();
      expect(loaded.transactions['0x1234'].amount).toBe('1000000');
    });

    it('should throw MockStateCorruptedError for invalid JSON', () => {
      const statePath = manager.getStatePath();
      fs.writeFileSync(statePath, '{ invalid json }', 'utf-8');

      expect(() => manager.loadState()).toThrow(MockStateCorruptedError);
    });

    it('should throw MockStateVersionError for unsupported version', () => {
      const statePath = manager.getStatePath();
      const badVersionState = {
        version: '99.0',
        mode: 'mock',
        blockchain: { currentTime: 0, blockNumber: 0, chainId: 0, blockTime: 2 },
        transactions: {},
        escrows: {},
        accounts: {},
      };
      fs.writeFileSync(statePath, JSON.stringify(badVersionState), 'utf-8');

      expect(() => manager.loadState()).toThrow(MockStateVersionError);
    });

    it('should throw MockStateCorruptedError for invalid schema', () => {
      const statePath = manager.getStatePath();
      const badSchemaState = {
        version: MOCK_STATE_DEFAULTS.VERSION,
        mode: 'mock',
        // Missing blockchain, transactions, etc.
      };
      fs.writeFileSync(statePath, JSON.stringify(badSchemaState), 'utf-8');

      expect(() => manager.loadState()).toThrow(MockStateCorruptedError);
    });

    it('should throw error for file exceeding size limit', () => {
      const statePath = manager.getStatePath();
      // Create a file larger than 10MB
      const largeContent = 'x'.repeat(11 * 1024 * 1024);
      fs.writeFileSync(statePath, largeContent, 'utf-8');

      expect(() => manager.loadState()).toThrow(/exceeds.*MB limit/);
    });
  });

  describe('saveState', () => {
    it('should create state file with correct content', () => {
      const state = manager.getDefaultState();
      state.blockchain.blockNumber = 5000;

      manager.saveState(state);

      const statePath = manager.getStatePath();
      expect(fs.existsSync(statePath)).toBe(true);

      const raw = fs.readFileSync(statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.blockchain.blockNumber).toBe(5000);
    });

    it('should write JSON with pretty formatting (2-space indent)', () => {
      const state = manager.getDefaultState();
      manager.saveState(state);

      const raw = fs.readFileSync(manager.getStatePath(), 'utf-8');

      // Check for 2-space indent
      expect(raw).toContain('\n  "');
    });

    it('should perform atomic write (no temp file left behind on success)', () => {
      const state = manager.getDefaultState();
      manager.saveState(state);

      const tempPath = `${manager.getStatePath()}.tmp`;
      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it('should preserve data integrity across save/load cycles', () => {
      const originalState = manager.getDefaultState();
      originalState.transactions['0xtest'] = {
        id: '0xtest',
        requester: '0xRequester',
        provider: '0xProvider',
        amount: '999999999999',
        state: 'COMMITTED',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        deadline: 1700100000,
        disputeWindow: 86400,
        completedAt: null,
        escrowId: 'escrow-001',
        serviceDescription: 'Test',
        serviceHash: ZeroHash,
        deliveryProof: null,
        events: [
          {
            type: 'TransactionCreated',
            timestamp: 1700000000,
            blockNumber: 1000,
            data: { test: true },
          },
        ],
      };

      manager.saveState(originalState);
      const loadedState = manager.loadState();

      expect(loadedState.transactions['0xtest'].amount).toBe('999999999999');
      expect(loadedState.transactions['0xtest'].events).toHaveLength(1);
      expect(loadedState.transactions['0xtest'].events[0].data).toEqual({ test: true });
    });

    it('should recreate .actp directory if deleted', () => {
      const actpDir = manager.getActpDir();

      // Save initial state
      manager.saveState(manager.getDefaultState());

      // Delete .actp directory
      fs.rmSync(actpDir, { recursive: true, force: true });
      expect(fs.existsSync(actpDir)).toBe(false);

      // Save should recreate directory
      manager.saveState(manager.getDefaultState());
      expect(fs.existsSync(actpDir)).toBe(true);
      expect(fs.existsSync(manager.getStatePath())).toBe(true);
    });
  });

  describe('withLock', () => {
    it('should execute operation and return result', async () => {
      const result = await manager.withLock((state) => {
        state.blockchain.blockNumber = 9999;
        return 'success';
      });

      expect(result).toBe('success');

      const state = manager.loadState();
      expect(state.blockchain.blockNumber).toBe(9999);
    });

    it('should support async operations', async () => {
      const result = await manager.withLock(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state.blockchain.blockNumber = 8888;
        return 'async-success';
      });

      expect(result).toBe('async-success');

      const state = manager.loadState();
      expect(state.blockchain.blockNumber).toBe(8888);
    });

    it('should create state file if it does not exist', async () => {
      expect(manager.exists()).toBe(false);

      await manager.withLock((state) => {
        state.blockchain.blockNumber = 1234;
      });

      expect(manager.exists()).toBe(true);
    });

    it('should release lock after successful operation', async () => {
      await manager.withLock((state) => {
        state.blockchain.blockNumber = 1111;
      });

      // Second operation should succeed immediately
      await manager.withLock((state) => {
        state.blockchain.blockNumber = 2222;
      });

      const state = manager.loadState();
      expect(state.blockchain.blockNumber).toBe(2222);
    });

    it('should release lock after failed operation', async () => {
      await expect(
        manager.withLock(() => {
          throw new Error('Operation failed');
        })
      ).rejects.toThrow('Operation failed');

      // Subsequent operation should succeed
      await manager.withLock((state) => {
        state.blockchain.blockNumber = 3333;
      });

      const state = manager.loadState();
      expect(state.blockchain.blockNumber).toBe(3333);
    });

    it('should serialize concurrent operations', async () => {
      const results: number[] = [];

      // Run two operations "concurrently"
      await Promise.all([
        manager.withLock(async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          state.blockchain.blockNumber += 1;
          results.push(1);
        }),
        manager.withLock(async (state) => {
          state.blockchain.blockNumber += 1;
          results.push(2);
        }),
      ]);

      // Both operations completed
      expect(results).toHaveLength(2);

      // Block number incremented twice
      const state = manager.loadState();
      expect(state.blockchain.blockNumber).toBe(MOCK_STATE_DEFAULTS.INITIAL_BLOCK_NUMBER + 2);
    });

    it('should maintain state consistency across sequential operations', async () => {
      // Initialize with starting balance
      await manager.withLock((state) => {
        state.accounts['0xTest'] = {
          address: '0xTest',
          usdcBalance: '1000000000', // 1000 USDC
        };
      });

      // Run 5 sequential operations that each deduct 200 USDC
      // Using sequential to avoid lock contention timeout in tests
      for (let i = 0; i < 5; i++) {
        await manager.withLock(async (state) => {
          const account = state.accounts['0xTest'];
          const balance = BigInt(account.usdcBalance);
          account.usdcBalance = (balance - BigInt(200000000)).toString(); // -200 USDC
        });
      }

      const state = manager.loadState();
      // Final balance should be exactly 0
      expect(state.accounts['0xTest'].usdcBalance).toBe('0');
    });

    it('should handle moderate concurrent access (3 operations)', async () => {
      // Initialize with starting balance
      await manager.withLock((state) => {
        state.accounts['0xConcurrent'] = {
          address: '0xConcurrent',
          usdcBalance: '3000000', // 3 USDC
        };
      });

      // Run 3 concurrent operations (within retry budget)
      const operations = Array(3)
        .fill(null)
        .map(() =>
          manager.withLock(async (state) => {
            const account = state.accounts['0xConcurrent'];
            const balance = BigInt(account.usdcBalance);
            account.usdcBalance = (balance - BigInt(1000000)).toString(); // -1 USDC
          })
        );

      await Promise.all(operations);

      const state = manager.loadState();
      // Final balance should be exactly 0
      expect(state.accounts['0xConcurrent'].usdcBalance).toBe('0');
    });
  });

  describe('reset', () => {
    it('should restore default state', () => {
      // Create state with data
      const state = manager.getDefaultState();
      state.transactions['0x123'] = {
        id: '0x123',
        requester: '0xA',
        provider: '0xB',
        amount: '100',
        state: 'INITIATED',
        createdAt: 0,
        updatedAt: 0,
        deadline: 0,
        disputeWindow: 0,
        completedAt: null,
        escrowId: null,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: null,
        events: [],
      };
      manager.saveState(state);

      // Reset
      manager.reset();

      // Verify reset
      const resetState = manager.loadState();
      expect(Object.keys(resetState.transactions)).toHaveLength(0);
      expect(resetState.blockchain.blockNumber).toBe(MOCK_STATE_DEFAULTS.INITIAL_BLOCK_NUMBER);
    });

    it('should create file if it does not exist', () => {
      expect(manager.exists()).toBe(false);

      manager.reset();

      expect(manager.exists()).toBe(true);
    });
  });

  describe('exists', () => {
    it('should return false if state file does not exist', () => {
      expect(manager.exists()).toBe(false);
    });

    it('should return true if state file exists', () => {
      manager.saveState(manager.getDefaultState());
      expect(manager.exists()).toBe(true);
    });
  });

  describe('getDefaultState', () => {
    it('should return state with correct version', () => {
      const state = manager.getDefaultState();
      expect(state.version).toBe(MOCK_STATE_DEFAULTS.VERSION);
    });

    it('should return state with mode "mock"', () => {
      const state = manager.getDefaultState();
      expect(state.mode).toBe('mock');
    });

    it('should return state with Base Sepolia chain ID', () => {
      const state = manager.getDefaultState();
      expect(state.blockchain.chainId).toBe(84532);
    });

    it('should return state with current timestamp', () => {
      const before = Math.floor(Date.now() / 1000);
      const state = manager.getDefaultState();
      const after = Math.floor(Date.now() / 1000);

      expect(state.blockchain.currentTime).toBeGreaterThanOrEqual(before);
      expect(state.blockchain.currentTime).toBeLessThanOrEqual(after);
    });

    it('should return empty collections', () => {
      const state = manager.getDefaultState();
      expect(Object.keys(state.transactions)).toHaveLength(0);
      expect(Object.keys(state.escrows)).toHaveLength(0);
      expect(Object.keys(state.accounts)).toHaveLength(0);
    });
  });

  describe('destroy', () => {
    it('should remove state file', () => {
      manager.saveState(manager.getDefaultState());
      expect(manager.exists()).toBe(true);

      manager.destroy();

      expect(manager.exists()).toBe(false);
    });

    it('should remove .actp directory if empty', () => {
      manager.saveState(manager.getDefaultState());

      manager.destroy();

      expect(fs.existsSync(manager.getActpDir())).toBe(false);
    });

    it('should preserve .actp directory if not empty (without force)', () => {
      manager.saveState(manager.getDefaultState());

      // Create another file in .actp
      const otherFile = path.join(manager.getActpDir(), 'config.json');
      fs.writeFileSync(otherFile, '{}', 'utf-8');

      manager.destroy();

      expect(fs.existsSync(manager.getActpDir())).toBe(true);
      expect(fs.existsSync(otherFile)).toBe(true);
    });

    it('should remove .actp directory even if not empty (with force)', () => {
      manager.saveState(manager.getDefaultState());

      // Create another file in .actp
      const otherFile = path.join(manager.getActpDir(), 'config.json');
      fs.writeFileSync(otherFile, '{}', 'utf-8');

      manager.destroy(true);

      expect(fs.existsSync(manager.getActpDir())).toBe(false);
    });

    it('should not throw if state file does not exist', () => {
      expect(() => manager.destroy()).not.toThrow();
    });
  });

  describe('error recovery', () => {
    it('should provide helpful error message for corrupted JSON', () => {
      const statePath = manager.getStatePath();
      fs.writeFileSync(statePath, '{ "version": "1.0", broken', 'utf-8');

      try {
        manager.loadState();
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MockStateCorruptedError);
        expect((error as MockStateCorruptedError).message).toContain('corrupted');
        expect((error as MockStateCorruptedError).message).toContain('actp mock reset');
        expect((error as MockStateCorruptedError).statePath).toBe(statePath);
      }
    });

    it('should include cause in MockStateCorruptedError when provided', () => {
      const cause = new Error('Original parse error');
      const error = new MockStateCorruptedError('/test/path', cause);
      expect(error.message).toContain('Original parse error');
    });

    it('should include cause in MockStateLockError when provided', () => {
      const cause = new Error('Lock acquisition failed');
      const error = new MockStateLockError('/test/path', cause);
      expect(error.message).toContain('Lock acquisition failed');
      expect(error.cause).toBe(cause);
    });

    it('should handle MockStateLockError without cause', () => {
      const error = new MockStateLockError('/test/path');
      expect(error.message).not.toContain('Cause:');
      expect(error.cause).toBeUndefined();
    });

    it('should provide helpful error message for version mismatch', () => {
      const statePath = manager.getStatePath();
      const oldState = {
        version: '0.1',
        mode: 'mock',
        blockchain: { currentTime: 0, blockNumber: 0, chainId: 0, blockTime: 2 },
        transactions: {},
        escrows: {},
        accounts: {},
      };
      fs.writeFileSync(statePath, JSON.stringify(oldState), 'utf-8');

      try {
        manager.loadState();
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MockStateVersionError);
        expect((error as MockStateVersionError).version).toBe('0.1');
        expect((error as MockStateVersionError).supportedVersion).toBe(MOCK_STATE_DEFAULTS.VERSION);
      }
    });
  });

  describe('path helpers', () => {
    it('should return correct state path', () => {
      const expectedPath = path.join(testDir, '.actp', 'mock-state.json');
      expect(manager.getStatePath()).toBe(expectedPath);
    });

    it('should return correct .actp directory path', () => {
      const expectedPath = path.join(testDir, '.actp');
      expect(manager.getActpDir()).toBe(expectedPath);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string values in state', async () => {
      await manager.withLock((state) => {
        state.transactions['0xempty'] = {
          id: '0xempty',
          requester: '',
          provider: '',
          amount: '0',
          state: 'INITIATED',
          createdAt: 0,
          updatedAt: 0,
          deadline: 0,
          disputeWindow: 0,
          completedAt: null,
          escrowId: null,
          serviceDescription: '',
          serviceHash: ZeroHash,
          deliveryProof: null,
          events: [],
        };
      });

      const state = manager.loadState();
      expect(state.transactions['0xempty'].requester).toBe('');
    });

    it('should handle large BigNumber strings', async () => {
      const maxUint256 =
        '115792089237316195423570985008687907853269984665640564039457584007913129639935';

      await manager.withLock((state) => {
        state.accounts['0xWhale'] = {
          address: '0xWhale',
          usdcBalance: maxUint256,
        };
      });

      const state = manager.loadState();
      expect(state.accounts['0xWhale'].usdcBalance).toBe(maxUint256);
    });

    it('should handle unicode in service descriptions', async () => {
      const unicodeDesc = 'AI服务 🤖🚀 - Ümläuts: äöü - Special chars: <>\'"&';

      await manager.withLock((state) => {
        state.transactions['0xunicode'] = {
          id: '0xunicode',
          requester: '0xA',
          provider: '0xB',
          amount: '100',
          state: 'INITIATED',
          createdAt: 0,
          updatedAt: 0,
          deadline: 0,
          disputeWindow: 0,
          completedAt: null,
          escrowId: null,
          serviceDescription: unicodeDesc,
          serviceHash: ZeroHash,
          deliveryProof: null,
          events: [],
        };
      });

      const state = manager.loadState();
      expect(state.transactions['0xunicode'].serviceDescription).toBe(unicodeDesc);
    });

    it('should handle deeply nested event data', async () => {
      const nestedData = {
        level1: {
          level2: {
            level3: {
              array: [1, 2, { nested: true }],
            },
          },
        },
      };

      await manager.withLock((state) => {
        state.transactions['0xnested'] = {
          id: '0xnested',
          requester: '0xA',
          provider: '0xB',
          amount: '100',
          state: 'INITIATED',
          createdAt: 0,
          updatedAt: 0,
          deadline: 0,
          disputeWindow: 0,
          completedAt: null,
          escrowId: null,
          serviceDescription: '',
          serviceHash: ZeroHash,
          deliveryProof: null,
          events: [
            {
              type: 'Custom',
              timestamp: 0,
              blockNumber: 0,
              data: nestedData,
            },
          ],
        };
      });

      const state = manager.loadState();
      const eventData = state.transactions['0xnested'].events[0].data as typeof nestedData;
      expect(eventData.level1.level2.level3.array[2]).toEqual({ nested: true });
    });
  });
});
