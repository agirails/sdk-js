/**
 * MockRuntime Comprehensive Test Suite
 *
 * Tests cover:
 * - Time management (advance, set, blocks)
 * - Transaction lifecycle (create, transition, query)
 * - State machine validation (valid/invalid transitions)
 * - Escrow operations (link, release, balance)
 * - Balance management (mint, transfer, insufficient funds)
 * - Event recording (emit, query, filter)
 * - Error handling (not found, invalid transition, etc.)
 *
 * @module runtime/MockRuntime.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MockRuntime,
  TransactionNotFoundError,
  InvalidStateTransitionError,
  InsufficientBalanceError,
  EscrowNotFoundError,
  DeadlinePassedError,
  InvalidAmountError,
  DisputeWindowActiveError,
} from './MockRuntime';
import { CreateTransactionParams } from './IACTPRuntime';
import { MockStateManager } from './MockStateManager';
import { TransactionState } from './types/MockState';

describe('MockRuntime', () => {
  let testDir: string;
  let stateManager: MockStateManager;
  let runtime: MockRuntime;

  /**
   * Create a unique test directory and runtime for each test.
   */
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-runtime-test-'));
    stateManager = new MockStateManager(testDir);
    runtime = new MockRuntime(stateManager);
  });

  /**
   * Clean up test directory after each test.
   */
  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to create a valid transaction params object.
   */
  function createTxParams(overrides?: Partial<CreateTransactionParams>): CreateTransactionParams {
    return {
      provider: '0xProvider',
      requester: '0xRequester',
      amount: '1000000', // 1 USDC
      deadline: runtime.time.now() + 86400, // 24 hours from now
      disputeWindow: 172800, // 2 days
      serviceDescription: 'Test service',
      ...overrides,
    };
  }

  // ============================================================================
  // Time Management Tests
  // ============================================================================

  describe('Time Management', () => {
    describe('time.now()', () => {
      it('should return current mock timestamp', () => {
        const now = runtime.time.now();
        expect(typeof now).toBe('number');
        expect(now).toBeGreaterThan(0);
      });

      it('should return timestamp close to real time on fresh runtime', () => {
        const now = runtime.time.now();
        const realNow = Math.floor(Date.now() / 1000);
        // Allow 5 second difference
        expect(Math.abs(now - realNow)).toBeLessThan(5);
      });
    });

    describe('time.advanceTime()', () => {
      it('should advance time by specified seconds', async () => {
        const before = runtime.time.now();
        await runtime.time.advanceTime(3600); // 1 hour
        const after = runtime.time.now();

        expect(after - before).toBe(3600);
      });

      it('should advance block number based on block time', async () => {
        const stateBefore = runtime.getState();
        const blockBefore = stateBefore.blockchain.blockNumber;

        await runtime.time.advanceTime(100); // 100 seconds = 50 blocks (at 2s/block)

        const stateAfter = runtime.getState();
        expect(stateAfter.blockchain.blockNumber - blockBefore).toBe(50);
      });

      it('should record TimeAdvanced event', async () => {
        await runtime.time.advanceTime(3600);

        const events = runtime.events.getByType('TimeAdvanced');
        expect(events).toHaveLength(1);
        expect(events[0].data.seconds).toBe(3600);
      });

      it('should handle advancing by 0 seconds', async () => {
        const before = runtime.time.now();
        await runtime.time.advanceTime(0);
        const after = runtime.time.now();

        expect(after).toBe(before);
      });

      it('should throw error for negative seconds', async () => {
        await expect(runtime.time.advanceTime(-100)).rejects.toThrow('Cannot advance time by negative amount');
      });

      it('should accumulate multiple time advances', async () => {
        const start = runtime.time.now();

        await runtime.time.advanceTime(1000);
        await runtime.time.advanceTime(2000);
        await runtime.time.advanceTime(3000);

        const end = runtime.time.now();
        expect(end - start).toBe(6000);
      });
    });

    describe('time.advanceBlocks()', () => {
      it('should advance block number by specified blocks', async () => {
        const stateBefore = runtime.getState();
        const blockBefore = stateBefore.blockchain.blockNumber;

        await runtime.time.advanceBlocks(100);

        const stateAfter = runtime.getState();
        expect(stateAfter.blockchain.blockNumber - blockBefore).toBe(100);
      });

      it('should advance time based on block time', async () => {
        const before = runtime.time.now();

        await runtime.time.advanceBlocks(100); // 100 blocks * 2s = 200s

        const after = runtime.time.now();
        expect(after - before).toBe(200);
      });

      it('should record BlocksAdvanced event', async () => {
        await runtime.time.advanceBlocks(50);

        const events = runtime.events.getByType('BlocksAdvanced');
        expect(events).toHaveLength(1);
        expect(events[0].data.blocks).toBe(50);
      });

      it('should handle advancing by 0 blocks', async () => {
        const stateBefore = runtime.getState();
        await runtime.time.advanceBlocks(0);
        const stateAfter = runtime.getState();

        expect(stateAfter.blockchain.blockNumber).toBe(stateBefore.blockchain.blockNumber);
      });

      it('should throw error for negative blocks', async () => {
        await expect(runtime.time.advanceBlocks(-10)).rejects.toThrow('Cannot advance blocks by negative amount');
      });
    });

    describe('time.setTime()', () => {
      it('should set exact timestamp', async () => {
        const targetTime = runtime.time.now() + 100000;
        await runtime.time.setTime(targetTime);

        expect(runtime.time.now()).toBe(targetTime);
      });

      it('should advance block number proportionally', async () => {
        const stateBefore = runtime.getState();
        const timeBefore = stateBefore.blockchain.currentTime;
        const blockBefore = stateBefore.blockchain.blockNumber;

        const targetTime = timeBefore + 1000; // 1000 seconds = 500 blocks
        await runtime.time.setTime(targetTime);

        const stateAfter = runtime.getState();
        expect(stateAfter.blockchain.blockNumber - blockBefore).toBe(500);
      });

      it('should record TimeSet event', async () => {
        const targetTime = runtime.time.now() + 5000;
        await runtime.time.setTime(targetTime);

        const events = runtime.events.getByType('TimeSet');
        expect(events).toHaveLength(1);
        expect(events[0].data.newTime).toBe(targetTime);
      });

      it('should throw error when setting time backwards', async () => {
        const current = runtime.time.now();
        const pastTime = current - 1000;

        await expect(runtime.time.setTime(pastTime)).rejects.toThrow('Cannot move time backwards');
      });

      it('should allow setting same time (no-op)', async () => {
        const current = runtime.time.now();
        await runtime.time.setTime(current);

        expect(runtime.time.now()).toBe(current);
      });
    });
  });

  // ============================================================================
  // Transaction Lifecycle Tests
  // ============================================================================

  describe('Transaction Lifecycle', () => {
    describe('createTransaction()', () => {
      it('should create transaction with valid params', async () => {
        const params = createTxParams();
        const txId = await runtime.createTransaction(params);

        expect(txId).toMatch(/^0x[a-f0-9]{64}$/);

        const tx = await runtime.getTransaction(txId);
        expect(tx).not.toBeNull();
        expect(tx!.state).toBe('INITIATED');
        expect(tx!.requester).toBe(params.requester);
        expect(tx!.provider).toBe(params.provider);
        expect(tx!.amount).toBe(params.amount);
      });

      it('should set default dispute window to 2 days', async () => {
        const params = createTxParams({ disputeWindow: undefined });
        const txId = await runtime.createTransaction(params);

        const tx = await runtime.getTransaction(txId);
        expect(tx!.disputeWindow).toBe(172800); // 2 days in seconds
      });

      it('should set custom dispute window', async () => {
        const params = createTxParams({ disputeWindow: 86400 }); // 1 day
        const txId = await runtime.createTransaction(params);

        const tx = await runtime.getTransaction(txId);
        expect(tx!.disputeWindow).toBe(86400);
      });

      it('should record TransactionCreated event', async () => {
        const params = createTxParams();
        const txId = await runtime.createTransaction(params);

        const events = runtime.events.getByType('TransactionCreated');
        expect(events).toHaveLength(1);
        expect(events[0].data.txId).toBe(txId);
        expect(events[0].data.amount).toBe(params.amount);
      });

      it('should throw DeadlinePassedError for past deadline', async () => {
        const params = createTxParams({ deadline: runtime.time.now() - 100 });

        await expect(runtime.createTransaction(params)).rejects.toThrow(DeadlinePassedError);
      });

      it('should throw DeadlinePassedError for current timestamp deadline', async () => {
        const params = createTxParams({ deadline: runtime.time.now() });

        await expect(runtime.createTransaction(params)).rejects.toThrow(DeadlinePassedError);
      });

      it('should generate unique transaction IDs', async () => {
        const ids = new Set<string>();
        for (let i = 0; i < 10; i++) {
          const txId = await runtime.createTransaction(createTxParams());
          ids.add(txId);
        }

        expect(ids.size).toBe(10);
      });

      it('should set createdAt and updatedAt to current time', async () => {
        const currentTime = runtime.time.now();
        const txId = await runtime.createTransaction(createTxParams());

        const tx = await runtime.getTransaction(txId);
        expect(tx!.createdAt).toBe(currentTime);
        expect(tx!.updatedAt).toBe(currentTime);
      });
    });

    describe('getTransaction()', () => {
      it('should return transaction by ID', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        const tx = await runtime.getTransaction(txId);
        expect(tx).not.toBeNull();
        expect(tx!.id).toBe(txId);
      });

      it('should return null for non-existent transaction', async () => {
        const tx = await runtime.getTransaction('0x' + '0'.repeat(64));
        expect(tx).toBeNull();
      });
    });

    describe('getAllTransactions()', () => {
      it('should return empty array when no transactions exist', async () => {
        const transactions = await runtime.getAllTransactions();
        expect(transactions).toHaveLength(0);
      });

      it('should return all transactions', async () => {
        await runtime.createTransaction(createTxParams());
        await runtime.createTransaction(createTxParams());
        await runtime.createTransaction(createTxParams());

        const transactions = await runtime.getAllTransactions();
        expect(transactions).toHaveLength(3);
      });
    });
  });

  // ============================================================================
  // State Machine Tests
  // ============================================================================

  describe('State Machine', () => {
    describe('Valid State Transitions', () => {
      it('should transition INITIATED -> QUOTED', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        await runtime.transitionState(txId, 'QUOTED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('QUOTED');
      });

      it('should transition INITIATED -> CANCELLED', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        await runtime.transitionState(txId, 'CANCELLED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('CANCELLED');
      });

      it('should transition QUOTED -> CANCELLED', async () => {
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.transitionState(txId, 'QUOTED');

        await runtime.transitionState(txId, 'CANCELLED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('CANCELLED');
      });

      it('should transition COMMITTED -> IN_PROGRESS', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');

        await runtime.transitionState(txId, 'IN_PROGRESS');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('IN_PROGRESS');
      });

      it('should transition COMMITTED -> DELIVERED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');

        await runtime.transitionState(txId, 'DELIVERED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('DELIVERED');
      });

      it('should transition COMMITTED -> CANCELLED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');

        await runtime.transitionState(txId, 'CANCELLED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('CANCELLED');
      });

      it('should transition IN_PROGRESS -> DELIVERED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'IN_PROGRESS');

        await runtime.transitionState(txId, 'DELIVERED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('DELIVERED');
      });

      it('should transition IN_PROGRESS -> CANCELLED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'IN_PROGRESS');

        await runtime.transitionState(txId, 'CANCELLED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('CANCELLED');
      });

      it('should transition DELIVERED -> SETTLED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'DELIVERED');

        await runtime.transitionState(txId, 'SETTLED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('SETTLED');
      });

      it('should transition DELIVERED -> DISPUTED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'DELIVERED');

        await runtime.transitionState(txId, 'DISPUTED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('DISPUTED');
      });

      it('should transition DISPUTED -> SETTLED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'DELIVERED');
        await runtime.transitionState(txId, 'DISPUTED');

        await runtime.transitionState(txId, 'SETTLED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('SETTLED');
      });

      it('should set completedAt when transitioning to DELIVERED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');

        const deliveryTime = runtime.time.now();
        await runtime.transitionState(txId, 'DELIVERED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.completedAt).toBe(deliveryTime);
      });
    });

    describe('Invalid State Transitions', () => {
      it('should throw InvalidStateTransitionError for INITIATED -> SETTLED', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        await expect(runtime.transitionState(txId, 'SETTLED')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw InvalidStateTransitionError for INITIATED -> IN_PROGRESS', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        await expect(runtime.transitionState(txId, 'IN_PROGRESS')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw InvalidStateTransitionError for INITIATED -> DELIVERED', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        await expect(runtime.transitionState(txId, 'DELIVERED')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw InvalidStateTransitionError for INITIATED -> DISPUTED', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        await expect(runtime.transitionState(txId, 'DISPUTED')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw InvalidStateTransitionError for backwards transition COMMITTED -> INITIATED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');

        await expect(runtime.transitionState(txId, 'INITIATED')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw InvalidStateTransitionError for backwards transition DELIVERED -> COMMITTED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'DELIVERED');

        await expect(runtime.transitionState(txId, 'COMMITTED')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw InvalidStateTransitionError from terminal state SETTLED', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'DELIVERED');
        await runtime.transitionState(txId, 'SETTLED');

        await expect(runtime.transitionState(txId, 'INITIATED')).rejects.toThrow(
          InvalidStateTransitionError
        );
        await expect(runtime.transitionState(txId, 'DISPUTED')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw InvalidStateTransitionError from terminal state CANCELLED', async () => {
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.transitionState(txId, 'CANCELLED');

        await expect(runtime.transitionState(txId, 'INITIATED')).rejects.toThrow(
          InvalidStateTransitionError
        );
        await expect(runtime.transitionState(txId, 'COMMITTED')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should include correct error details', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        try {
          await runtime.transitionState(txId, 'SETTLED');
          fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidStateTransitionError);
          const err = error as InvalidStateTransitionError;
          expect(err.txId).toBe(txId);
          expect(err.currentState).toBe('INITIATED');
          expect(err.targetState).toBe('SETTLED');
        }
      });
    });

    describe('State Transition Events', () => {
      it('should record StateTransitioned event', async () => {
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.transitionState(txId, 'QUOTED');

        const events = runtime.events.getByType('StateTransitioned');
        expect(events).toHaveLength(1);
        expect(events[0].data.txId).toBe(txId);
        expect(events[0].data.oldState).toBe('INITIATED');
        expect(events[0].data.newState).toBe('QUOTED');
      });

      it('should update transaction updatedAt timestamp', async () => {
        const txId = await runtime.createTransaction(createTxParams());
        const createdAt = (await runtime.getTransaction(txId))!.updatedAt;

        await runtime.time.advanceTime(1000);
        await runtime.transitionState(txId, 'QUOTED');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.updatedAt).toBe(createdAt + 1000);
      });
    });

    describe('TransactionNotFoundError', () => {
      it('should throw TransactionNotFoundError for non-existent transaction', async () => {
        const fakeTxId = '0x' + 'f'.repeat(64);

        await expect(runtime.transitionState(fakeTxId, 'QUOTED')).rejects.toThrow(
          TransactionNotFoundError
        );
      });

      it('should include txId in error', async () => {
        const fakeTxId = '0x' + 'a'.repeat(64);

        try {
          await runtime.transitionState(fakeTxId, 'QUOTED');
          fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(TransactionNotFoundError);
          expect((error as TransactionNotFoundError).txId).toBe(fakeTxId);
        }
      });
    });
  });

  // ============================================================================
  // Escrow Operations Tests
  // ============================================================================

  describe('Escrow Operations', () => {
    describe('linkEscrow()', () => {
      beforeEach(async () => {
        // Give requester some funds
        await runtime.mintTokens('0xRequester', '10000000'); // 10 USDC
      });

      it('should link escrow and auto-transition to COMMITTED', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        const escrowId = await runtime.linkEscrow(txId, '1000000');

        expect(escrowId).toMatch(/^escrow-/);
        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('COMMITTED');
        expect(tx!.escrowId).toBe(escrowId);
      });

      it('should link escrow from QUOTED state', async () => {
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.transitionState(txId, 'QUOTED');

        const escrowId = await runtime.linkEscrow(txId, '1000000');

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('COMMITTED');
        expect(tx!.escrowId).toBe(escrowId);
      });

      it('should deduct funds from requester', async () => {
        const txId = await runtime.createTransaction(createTxParams());
        const balanceBefore = await runtime.getBalance('0xRequester');

        await runtime.linkEscrow(txId, '1000000');

        const balanceAfter = await runtime.getBalance('0xRequester');
        expect(BigInt(balanceBefore) - BigInt(balanceAfter)).toBe(BigInt('1000000'));
      });

      it('should set escrow balance', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        const escrowId = await runtime.linkEscrow(txId, '1000000');

        const balance = await runtime.getEscrowBalance(escrowId);
        expect(balance).toBe('1000000');
      });

      it('should throw InsufficientBalanceError for insufficient funds', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        // Try to lock more than available
        await expect(runtime.linkEscrow(txId, '100000000')).rejects.toThrow(
          InsufficientBalanceError
        );
      });

      it('should throw InvalidStateTransitionError if already COMMITTED', async () => {
        const txId = await runtime.createTransaction(createTxParams());
        await runtime.linkEscrow(txId, '1000000');

        // Try to link again
        await expect(runtime.linkEscrow(txId, '1000000')).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should throw TransactionNotFoundError for non-existent transaction', async () => {
        const fakeTxId = '0x' + 'f'.repeat(64);

        await expect(runtime.linkEscrow(fakeTxId, '1000000')).rejects.toThrow(
          TransactionNotFoundError
        );
      });

      it('should throw DeadlinePassedError if deadline has passed', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        // Advance time past deadline
        await runtime.time.advanceTime(100000); // Way past 24 hours

        await expect(runtime.linkEscrow(txId, '1000000')).rejects.toThrow(
          DeadlinePassedError
        );
      });

      it('should record EscrowLinked event', async () => {
        const txId = await runtime.createTransaction(createTxParams());

        const escrowId = await runtime.linkEscrow(txId, '1000000');

        const events = runtime.events.getByType('EscrowLinked');
        expect(events).toHaveLength(1);
        expect(events[0].data.txId).toBe(txId);
        expect(events[0].data.escrowId).toBe(escrowId);
        expect(events[0].data.amount).toBe('1000000');
      });

      it('should generate unique escrow IDs', async () => {
        const ids = new Set<string>();
        for (let i = 0; i < 5; i++) {
          const txId = await runtime.createTransaction(createTxParams());
          const escrowId = await runtime.linkEscrow(txId, '100000');
          ids.add(escrowId);
        }

        expect(ids.size).toBe(5);
      });
    });

    describe('releaseEscrow()', () => {
      let txId: string;
      let escrowId: string;

      beforeEach(async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        txId = await runtime.createTransaction(createTxParams());
        escrowId = await runtime.linkEscrow(txId, '1000000');
        await runtime.transitionState(txId, 'DELIVERED');
        // Advance time past dispute window (default 2 days = 172800 seconds)
        await runtime.time.advanceTime(172801);
      });

      it('should release funds to provider', async () => {
        const providerBalanceBefore = await runtime.getBalance('0xProvider');

        await runtime.releaseEscrow(escrowId);

        const providerBalanceAfter = await runtime.getBalance('0xProvider');
        expect(BigInt(providerBalanceAfter) - BigInt(providerBalanceBefore)).toBe(
          BigInt('1000000')
        );
      });

      it('should transition transaction to SETTLED', async () => {
        await runtime.releaseEscrow(escrowId);

        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('SETTLED');
      });

      it('should clear escrow balance', async () => {
        await runtime.releaseEscrow(escrowId);

        const balance = await runtime.getEscrowBalance(escrowId);
        expect(balance).toBe('0');
      });

      it('should throw EscrowNotFoundError for non-existent escrow', async () => {
        await expect(runtime.releaseEscrow('escrow-fake')).rejects.toThrow(
          EscrowNotFoundError
        );
      });

      it('should throw InvalidStateTransitionError if not in DELIVERED state', async () => {
        // Create new transaction in COMMITTED state
        const txId2 = await runtime.createTransaction(createTxParams());
        const escrowId2 = await runtime.linkEscrow(txId2, '100000');

        await expect(runtime.releaseEscrow(escrowId2)).rejects.toThrow(
          InvalidStateTransitionError
        );
      });

      it('should record EscrowReleased event', async () => {
        await runtime.releaseEscrow(escrowId);

        const events = runtime.events.getByType('EscrowReleased');
        expect(events).toHaveLength(1);
        expect(events[0].data.escrowId).toBe(escrowId);
        expect(events[0].data.amount).toBe('1000000');
      });
    });

    describe('getEscrowBalance()', () => {
      it('should return escrow balance', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());
        const escrowId = await runtime.linkEscrow(txId, '5000000');

        const balance = await runtime.getEscrowBalance(escrowId);
        expect(balance).toBe('5000000');
      });

      it('should throw EscrowNotFoundError for non-existent escrow', async () => {
        await expect(runtime.getEscrowBalance('escrow-fake')).rejects.toThrow(
          EscrowNotFoundError
        );
      });
    });
  });

  // ============================================================================
  // Balance Management Tests
  // ============================================================================

  describe('Balance Management', () => {
    describe('getBalance()', () => {
      it('should return 0 for non-existent account', async () => {
        const balance = await runtime.getBalance('0xNewAddress');
        expect(balance).toBe('0');
      });

      it('should return minted balance', async () => {
        await runtime.mintTokens('0xTest', '5000000');

        const balance = await runtime.getBalance('0xTest');
        expect(balance).toBe('5000000');
      });
    });

    describe('mintTokens()', () => {
      it('should mint tokens to new account', async () => {
        await runtime.mintTokens('0xNew', '1000000');

        const balance = await runtime.getBalance('0xNew');
        expect(balance).toBe('1000000');
      });

      it('should add to existing balance', async () => {
        await runtime.mintTokens('0xExisting', '1000000');
        await runtime.mintTokens('0xExisting', '2000000');

        const balance = await runtime.getBalance('0xExisting');
        expect(balance).toBe('3000000');
      });

      it('should handle large amounts (max uint256)', async () => {
        const largeAmount = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
        await runtime.mintTokens('0xWhale', largeAmount);

        const balance = await runtime.getBalance('0xWhale');
        expect(balance).toBe(largeAmount);
      });

      it('should record TokensMinted event', async () => {
        await runtime.mintTokens('0xMinter', '5000000');

        const events = runtime.events.getByType('TokensMinted');
        expect(events).toHaveLength(1);
        expect(events[0].data.address).toBe('0xMinter');
        expect(events[0].data.amount).toBe('5000000');
      });
    });

    describe('transfer()', () => {
      beforeEach(async () => {
        await runtime.mintTokens('0xFrom', '10000000');
      });

      it('should transfer tokens between accounts', async () => {
        await runtime.transfer('0xFrom', '0xTo', '3000000');

        const fromBalance = await runtime.getBalance('0xFrom');
        const toBalance = await runtime.getBalance('0xTo');

        expect(fromBalance).toBe('7000000');
        expect(toBalance).toBe('3000000');
      });

      it('should throw InsufficientBalanceError for insufficient funds', async () => {
        await expect(runtime.transfer('0xFrom', '0xTo', '50000000')).rejects.toThrow(
          InsufficientBalanceError
        );
      });

      it('should throw InsufficientBalanceError with correct details', async () => {
        try {
          await runtime.transfer('0xFrom', '0xTo', '50000000');
          fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(InsufficientBalanceError);
          const err = error as InsufficientBalanceError;
          expect(err.address).toBe('0xFrom');
          expect(err.required).toBe('50000000');
          expect(err.available).toBe('10000000');
        }
      });

      it('should create receiver account if it does not exist', async () => {
        const balanceBefore = await runtime.getBalance('0xNewRecipient');
        expect(balanceBefore).toBe('0');

        await runtime.transfer('0xFrom', '0xNewRecipient', '1000000');

        const balanceAfter = await runtime.getBalance('0xNewRecipient');
        expect(balanceAfter).toBe('1000000');
      });

      it('should record Transfer event', async () => {
        await runtime.transfer('0xFrom', '0xTo', '2000000');

        const events = runtime.events.getByType('Transfer');
        expect(events).toHaveLength(1);
        expect(events[0].data.from).toBe('0xFrom');
        expect(events[0].data.to).toBe('0xTo');
        expect(events[0].data.amount).toBe('2000000');
      });

      it('should handle zero amount transfer', async () => {
        const fromBalanceBefore = await runtime.getBalance('0xFrom');

        await runtime.transfer('0xFrom', '0xTo', '0');

        const fromBalanceAfter = await runtime.getBalance('0xFrom');
        expect(fromBalanceAfter).toBe(fromBalanceBefore);
      });
    });
  });

  // ============================================================================
  // Event Recording Tests
  // ============================================================================

  describe('Event Recording', () => {
    describe('events.getAll()', () => {
      it('should return all events', async () => {
        await runtime.mintTokens('0xTest', '1000000');
        await runtime.createTransaction(createTxParams());
        await runtime.time.advanceTime(1000);

        const events = runtime.events.getAll();
        expect(events.length).toBeGreaterThanOrEqual(3);
      });

      it('should return empty array when no events', () => {
        const events = runtime.events.getAll();
        expect(events).toHaveLength(0);
      });

      it('should return copy of events (not mutable reference)', async () => {
        await runtime.time.advanceTime(100);

        const events1 = runtime.events.getAll();
        const events2 = runtime.events.getAll();

        expect(events1).not.toBe(events2);
      });
    });

    describe('events.getByType()', () => {
      it('should filter events by type', async () => {
        await runtime.mintTokens('0xTest', '1000000');
        await runtime.createTransaction(createTxParams());
        await runtime.createTransaction(createTxParams());

        const mintEvents = runtime.events.getByType('TokensMinted');
        const createEvents = runtime.events.getByType('TransactionCreated');

        expect(mintEvents).toHaveLength(1);
        expect(createEvents).toHaveLength(2);
      });

      it('should return empty array for non-existent type', () => {
        const events = runtime.events.getByType('NonExistent');
        expect(events).toHaveLength(0);
      });
    });

    describe('events.getByTransaction()', () => {
      it('should return events for specific transaction', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId1 = await runtime.createTransaction(createTxParams());
        const txId2 = await runtime.createTransaction(createTxParams());

        await runtime.linkEscrow(txId1, '1000000');
        await runtime.transitionState(txId1, 'DELIVERED');

        const tx1Events = runtime.events.getByTransaction(txId1);
        const tx2Events = runtime.events.getByTransaction(txId2);

        // txId1 should have: TransactionCreated, EscrowLinked, StateTransitioned (to COMMITTED), StateTransitioned (to DELIVERED)
        expect(tx1Events.length).toBeGreaterThanOrEqual(4);
        // txId2 should only have TransactionCreated
        expect(tx2Events).toHaveLength(1);
      });

      it('should return empty array for non-existent transaction', () => {
        const events = runtime.events.getByTransaction('0x' + 'f'.repeat(64));
        expect(events).toHaveLength(0);
      });
    });

    describe('events.clear()', () => {
      it('should clear all events', async () => {
        await runtime.mintTokens('0xTest', '1000000');
        await runtime.time.advanceTime(100);

        expect(runtime.events.getAll().length).toBeGreaterThan(0);

        runtime.events.clear();

        expect(runtime.events.getAll()).toHaveLength(0);
      });
    });
  });

  // ============================================================================
  // State Management Tests
  // ============================================================================

  describe('State Management', () => {
    describe('reset()', () => {
      it('should clear all transactions', async () => {
        await runtime.createTransaction(createTxParams());
        await runtime.createTransaction(createTxParams());

        await runtime.reset();

        const transactions = await runtime.getAllTransactions();
        expect(transactions).toHaveLength(0);
      });

      it('should clear all events', async () => {
        await runtime.time.advanceTime(100);
        await runtime.mintTokens('0xTest', '1000000');

        await runtime.reset();

        expect(runtime.events.getAll()).toHaveLength(0);
      });

      it('should reset blockchain state', async () => {
        await runtime.time.advanceTime(100000);

        await runtime.reset();

        const state = runtime.getState();
        expect(state.blockchain.blockNumber).toBe(1000); // Default
      });

      it('should clear all accounts', async () => {
        await runtime.mintTokens('0xTest', '1000000');

        await runtime.reset();

        const balance = await runtime.getBalance('0xTest');
        expect(balance).toBe('0');
      });
    });

    describe('getState()', () => {
      it('should return current mock state', () => {
        const state = runtime.getState();

        expect(state.version).toBe('1.0');
        expect(state.mode).toBe('mock');
        expect(state.blockchain).toBeDefined();
        expect(state.transactions).toBeDefined();
        expect(state.escrows).toBeDefined();
        expect(state.accounts).toBeDefined();
      });

      it('should reflect current state after operations', async () => {
        await runtime.mintTokens('0xTest', '5000000');
        await runtime.createTransaction(createTxParams());

        const state = runtime.getState();

        expect(Object.keys(state.accounts)).toHaveLength(1);
        expect(Object.keys(state.transactions)).toHaveLength(1);
      });
    });
  });

  // ============================================================================
  // Complete Flow Tests (Happy Path)
  // ============================================================================

  describe('Complete Transaction Flow', () => {
    it('should complete happy path: INITIATED -> COMMITTED -> DELIVERED -> SETTLED', async () => {
      // Setup
      const requester = '0xRequester';
      const provider = '0xProvider';
      const amount = '1000000'; // 1 USDC

      await runtime.mintTokens(requester, '10000000');

      // Create transaction
      const txId = await runtime.createTransaction({
        provider,
        requester,
        amount,
        deadline: runtime.time.now() + 86400,
      });

      let tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('INITIATED');

      // Link escrow (auto-transitions to COMMITTED)
      const escrowId = await runtime.linkEscrow(txId, amount);
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('COMMITTED');

      // Provider delivers
      await runtime.transitionState(txId, 'DELIVERED');
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('DELIVERED');

      // Wait for dispute window to pass (default 2 days)
      await runtime.time.advanceTime(172801);

      // Release escrow (auto-transitions to SETTLED)
      await runtime.releaseEscrow(escrowId);
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');

      // Verify final balances
      const requesterBalance = await runtime.getBalance(requester);
      const providerBalance = await runtime.getBalance(provider);

      expect(requesterBalance).toBe('9000000'); // 10 - 1 USDC
      expect(providerBalance).toBe('1000000'); // Received 1 USDC
    });

    it('should complete optional path with QUOTED and IN_PROGRESS', async () => {
      const requester = '0xRequester';
      const provider = '0xProvider';
      const amount = '2000000';

      await runtime.mintTokens(requester, '10000000');

      // Create transaction
      const txId = await runtime.createTransaction({
        provider,
        requester,
        amount,
        deadline: runtime.time.now() + 86400,
      });

      // Optional: Provider quotes
      await runtime.transitionState(txId, 'QUOTED');
      let tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('QUOTED');

      // Link escrow
      const escrowId = await runtime.linkEscrow(txId, amount);
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('COMMITTED');

      // Optional: Provider signals in progress
      await runtime.transitionState(txId, 'IN_PROGRESS');
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('IN_PROGRESS');

      // Provider delivers
      await runtime.transitionState(txId, 'DELIVERED');
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('DELIVERED');

      // Wait for dispute window to pass (default 2 days)
      await runtime.time.advanceTime(172801);

      // Release escrow
      await runtime.releaseEscrow(escrowId);
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });

    it('should handle dispute path', async () => {
      const requester = '0xRequester';
      const provider = '0xProvider';
      const amount = '3000000';

      await runtime.mintTokens(requester, '10000000');

      // Create and commit transaction
      const txId = await runtime.createTransaction({
        provider,
        requester,
        amount,
        deadline: runtime.time.now() + 86400,
      });
      await runtime.linkEscrow(txId, amount);

      // Deliver
      await runtime.transitionState(txId, 'DELIVERED');

      // Requester disputes
      await runtime.transitionState(txId, 'DISPUTED');
      let tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('DISPUTED');

      // Resolve dispute (goes to SETTLED)
      await runtime.transitionState(txId, 'SETTLED');
      tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });

    it('should handle cancellation path', async () => {
      // Create transaction
      const txId = await runtime.createTransaction(createTxParams());

      // Cancel before any commitment
      await runtime.transitionState(txId, 'CANCELLED');
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('CANCELLED');
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle transaction created exactly 1 second before deadline', async () => {
      const deadline = runtime.time.now() + 1;
      const txId = await runtime.createTransaction(createTxParams({ deadline }));

      const tx = await runtime.getTransaction(txId);
      expect(tx).not.toBeNull();
    });

    it('should handle minimum amount transaction (1 wei)', async () => {
      await runtime.mintTokens('0xRequester', '1');
      const txId = await runtime.createTransaction(createTxParams({ amount: '1' }));
      await runtime.linkEscrow(txId, '1');

      const tx = await runtime.getTransaction(txId);
      expect(tx!.amount).toBe('1');
    });

    it('should handle multiple concurrent transactions for same requester/provider', async () => {
      await runtime.mintTokens('0xRequester', '100000000');

      const txIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const txId = await runtime.createTransaction(createTxParams());
        txIds.push(txId);
      }

      // All should be unique
      expect(new Set(txIds).size).toBe(5);

      // All should be in INITIATED state
      for (const txId of txIds) {
        const tx = await runtime.getTransaction(txId);
        expect(tx!.state).toBe('INITIATED');
      }
    });

    it('should handle time advancement affecting multiple transactions', async () => {
      await runtime.mintTokens('0xRequester', '100000000');

      // Create transactions with different deadlines
      const txShort = await runtime.createTransaction(
        createTxParams({ deadline: runtime.time.now() + 100 })
      );
      const txLong = await runtime.createTransaction(
        createTxParams({ deadline: runtime.time.now() + 10000 })
      );

      // Advance time past short deadline
      await runtime.time.advanceTime(200);

      // Short deadline transaction can't link escrow
      await expect(runtime.linkEscrow(txShort, '1000000')).rejects.toThrow(
        DeadlinePassedError
      );

      // Long deadline transaction still works
      await runtime.linkEscrow(txLong, '1000000');
      const txLongState = await runtime.getTransaction(txLong);
      expect(txLongState!.state).toBe('COMMITTED');
    });

    it('should preserve BigNumber precision for large amounts', async () => {
      const largeAmount = '99999999999999999999'; // Large but valid USDC amount
      await runtime.mintTokens('0xRequester', largeAmount);

      const txId = await runtime.createTransaction(createTxParams({ amount: largeAmount }));
      await runtime.linkEscrow(txId, largeAmount);

      const escrowBalance = await runtime.getEscrowBalance((await runtime.getTransaction(txId))!.escrowId!);
      expect(escrowBalance).toBe(largeAmount);

      const requesterBalance = await runtime.getBalance('0xRequester');
      expect(requesterBalance).toBe('0');
    });
  });

  // ============================================================================
  // Runtime Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create runtime with default state manager', () => {
      // Use temp directory
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-default-'));
      process.chdir(tempDir);

      try {
        const defaultRuntime = new MockRuntime();
        expect(defaultRuntime).toBeDefined();
        expect(defaultRuntime.time.now()).toBeGreaterThan(0);
      } finally {
        process.chdir(testDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should create runtime with custom state manager', () => {
      const customManager = new MockStateManager(testDir);
      const customRuntime = new MockRuntime(customManager);

      expect(customRuntime).toBeDefined();
    });
  });

  // ============================================================================
  // Security Fix Tests - Issue #1: Escrow Refund on CANCELLED
  // ============================================================================

  describe('Security Fix: Escrow Refund on CANCELLED', () => {
    it('should refund escrow when transaction is cancelled after linkEscrow', async () => {
      // Setup - mint tokens to requester
      await runtime.mintTokens('0xRequester', '10000000'); // 10 USDC
      const initialBalance = await runtime.getBalance('0xRequester');
      expect(initialBalance).toBe('10000000');

      // Create transaction and link escrow
      const txId = await runtime.createTransaction(createTxParams());
      const escrowId = await runtime.linkEscrow(txId, '1000000'); // 1 USDC

      // Verify funds were deducted
      const balanceAfterEscrow = await runtime.getBalance('0xRequester');
      expect(balanceAfterEscrow).toBe('9000000');

      // Verify escrow has funds
      const escrowBalance = await runtime.getEscrowBalance(escrowId);
      expect(escrowBalance).toBe('1000000');

      // Transition to CANCELLED
      await runtime.transitionState(txId, 'CANCELLED');

      // Verify requester balance is restored
      const finalBalance = await runtime.getBalance('0xRequester');
      expect(finalBalance).toBe('10000000');

      // Verify escrow balance is 0
      const escrowBalanceAfter = await runtime.getEscrowBalance(escrowId);
      expect(escrowBalanceAfter).toBe('0');

      // Verify transaction is in CANCELLED state
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('CANCELLED');
    });

    it('should emit EscrowRefunded event when cancelled with escrow', async () => {
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(createTxParams());
      const escrowId = await runtime.linkEscrow(txId, '1000000');

      await runtime.transitionState(txId, 'CANCELLED');

      const events = runtime.events.getByType('EscrowRefunded');
      expect(events).toHaveLength(1);
      expect(events[0].data.txId).toBe(txId);
      expect(events[0].data.escrowId).toBe(escrowId);
      expect(events[0].data.requester).toBe('0xRequester');
      expect(events[0].data.amount).toBe('1000000');
    });

    it('should refund escrow when cancelled from COMMITTED state', async () => {
      await runtime.mintTokens('0xRequester', '5000000');
      const txId = await runtime.createTransaction(createTxParams());
      await runtime.linkEscrow(txId, '2000000');

      // Transaction is now COMMITTED
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('COMMITTED');

      await runtime.transitionState(txId, 'CANCELLED');

      const balance = await runtime.getBalance('0xRequester');
      expect(balance).toBe('5000000'); // Fully restored
    });

    it('should refund escrow when cancelled from IN_PROGRESS state', async () => {
      await runtime.mintTokens('0xRequester', '5000000');
      const txId = await runtime.createTransaction(createTxParams());
      await runtime.linkEscrow(txId, '2000000');
      await runtime.transitionState(txId, 'IN_PROGRESS');

      // Verify IN_PROGRESS state
      const txBefore = await runtime.getTransaction(txId);
      expect(txBefore!.state).toBe('IN_PROGRESS');

      await runtime.transitionState(txId, 'CANCELLED');

      const balance = await runtime.getBalance('0xRequester');
      expect(balance).toBe('5000000'); // Fully restored
    });

    it('should not emit EscrowRefunded event when cancelled without escrow', async () => {
      const txId = await runtime.createTransaction(createTxParams());

      // Cancel before escrow linked
      await runtime.transitionState(txId, 'CANCELLED');

      const events = runtime.events.getByType('EscrowRefunded');
      expect(events).toHaveLength(0);
    });
  });

  // ============================================================================
  // Security Fix Tests - Issue #2: Amount Validation
  // ============================================================================

  describe('Security Fix: Amount Validation', () => {
    describe('createTransaction() amount validation', () => {
      it('should reject zero amount in createTransaction', async () => {
        await expect(
          runtime.createTransaction(createTxParams({ amount: '0' }))
        ).rejects.toThrow(InvalidAmountError);
      });

      it('should include correct error details for zero amount', async () => {
        try {
          await runtime.createTransaction(createTxParams({ amount: '0' }));
          fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidAmountError);
          const err = error as InvalidAmountError;
          expect(err.amount).toBe('0');
          expect(err.reason).toBe('Amount must be positive');
        }
      });

      it('should reject negative amount in createTransaction (BigInt throws)', async () => {
        // BigInt constructor throws on invalid string like '-100'
        // when the string doesn't parse as a valid bigint
        await expect(
          runtime.createTransaction(createTxParams({ amount: '-100' }))
        ).rejects.toThrow();
      });

      it('should accept positive amounts in createTransaction', async () => {
        const txId = await runtime.createTransaction(createTxParams({ amount: '1' }));
        const tx = await runtime.getTransaction(txId);
        expect(tx!.amount).toBe('1');
      });

      it('should accept large positive amounts in createTransaction', async () => {
        const largeAmount = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
        const txId = await runtime.createTransaction(createTxParams({ amount: largeAmount }));
        const tx = await runtime.getTransaction(txId);
        expect(tx!.amount).toBe(largeAmount);
      });
    });

    describe('linkEscrow() amount validation', () => {
      it('should reject zero amount in linkEscrow', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());

        await expect(runtime.linkEscrow(txId, '0')).rejects.toThrow(InvalidAmountError);
      });

      it('should include correct error details for zero amount in linkEscrow', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());

        try {
          await runtime.linkEscrow(txId, '0');
          fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidAmountError);
          const err = error as InvalidAmountError;
          expect(err.amount).toBe('0');
          expect(err.reason).toBe('Amount must be positive');
        }
      });

      it('should accept positive amounts in linkEscrow', async () => {
        await runtime.mintTokens('0xRequester', '10000000');
        const txId = await runtime.createTransaction(createTxParams());

        const escrowId = await runtime.linkEscrow(txId, '1000000');
        const balance = await runtime.getEscrowBalance(escrowId);
        expect(balance).toBe('1000000');
      });
    });
  });

  // ============================================================================
  // Security Fix Tests - Issue #3: Dispute Window Enforcement
  // ============================================================================

  describe('Security Fix: Dispute Window Enforcement', () => {
    it('should reject releaseEscrow during active dispute window', async () => {
      // Setup - create transaction with 1 hour dispute window
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(
        createTxParams({ disputeWindow: 3600 }) // 1 hour
      );
      const escrowId = await runtime.linkEscrow(txId, '1000000');

      // Transition to DELIVERED
      await runtime.transitionState(txId, 'DELIVERED');

      // Immediately try to release - should fail
      await expect(runtime.releaseEscrow(escrowId)).rejects.toThrow(
        DisputeWindowActiveError
      );
    });

    it('should include correct error details for active dispute window', async () => {
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(
        createTxParams({ disputeWindow: 3600 })
      );
      const escrowId = await runtime.linkEscrow(txId, '1000000');
      await runtime.transitionState(txId, 'DELIVERED');

      const tx = await runtime.getTransaction(txId);
      const expectedWindowEnd = tx!.completedAt! + tx!.disputeWindow;
      const currentTime = runtime.time.now();

      try {
        await runtime.releaseEscrow(escrowId);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DisputeWindowActiveError);
        const err = error as DisputeWindowActiveError;
        expect(err.txId).toBe(txId);
        expect(err.windowEnd).toBe(expectedWindowEnd);
        expect(err.currentTime).toBe(currentTime);
      }
    });

    it('should allow releaseEscrow after dispute window expires', async () => {
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(
        createTxParams({ disputeWindow: 3600 }) // 1 hour
      );
      const escrowId = await runtime.linkEscrow(txId, '1000000');
      await runtime.transitionState(txId, 'DELIVERED');

      // Advance time past dispute window
      await runtime.time.advanceTime(3601); // 1 hour + 1 second

      // Now release should succeed
      await runtime.releaseEscrow(escrowId);

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');

      const providerBalance = await runtime.getBalance('0xProvider');
      expect(providerBalance).toBe('1000000');
    });

    it('should allow releaseEscrow exactly at dispute window end', async () => {
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(
        createTxParams({ disputeWindow: 3600 })
      );
      const escrowId = await runtime.linkEscrow(txId, '1000000');
      await runtime.transitionState(txId, 'DELIVERED');

      // Advance time to exactly the dispute window end
      await runtime.time.advanceTime(3600);

      // At exactly the window end, release should succeed (currentTime >= windowEnd)
      await runtime.releaseEscrow(escrowId);

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });

    it('should allow release 1 second after dispute window', async () => {
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(
        createTxParams({ disputeWindow: 100 }) // Short window for test
      );
      const escrowId = await runtime.linkEscrow(txId, '1000000');
      await runtime.transitionState(txId, 'DELIVERED');

      // Advance time 1 second past window
      await runtime.time.advanceTime(101);

      await runtime.releaseEscrow(escrowId);

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });

    it('should enforce default 2-day dispute window', async () => {
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(createTxParams()); // Default 2 days
      const escrowId = await runtime.linkEscrow(txId, '1000000');
      await runtime.transitionState(txId, 'DELIVERED');

      // Try to release immediately
      await expect(runtime.releaseEscrow(escrowId)).rejects.toThrow(
        DisputeWindowActiveError
      );

      // Advance time by 1 day - still within window
      await runtime.time.advanceTime(86400);
      await expect(runtime.releaseEscrow(escrowId)).rejects.toThrow(
        DisputeWindowActiveError
      );

      // Advance time by 1 more day + 1 second - past window
      await runtime.time.advanceTime(86401);
      await runtime.releaseEscrow(escrowId);

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });

    it('should work with minimum dispute window (1 second)', async () => {
      await runtime.mintTokens('0xRequester', '10000000');
      const txId = await runtime.createTransaction(
        createTxParams({ disputeWindow: 1 })
      );
      const escrowId = await runtime.linkEscrow(txId, '1000000');
      await runtime.transitionState(txId, 'DELIVERED');

      // Immediately should fail
      await expect(runtime.releaseEscrow(escrowId)).rejects.toThrow(
        DisputeWindowActiveError
      );

      // Advance 2 seconds
      await runtime.time.advanceTime(2);

      await runtime.releaseEscrow(escrowId);
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });
  });
});
