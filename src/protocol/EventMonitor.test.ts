/**
 * EventMonitor Test Suite
 *
 * Tests cover:
 * - watchTransaction (event subscription)
 * - waitForState (with timeout)
 * - getTransactionHistory (event querying)
 * - Event listener cleanup
 *
 * Uses mocked ethers Contract.
 *
 * @module protocol/EventMonitor.test
 */

import { EventMonitor } from './EventMonitor';
import { State } from '../types';

describe('EventMonitor', () => {
  // Create mock contract factory
  const createMockContract = () => {
    const listeners: Map<string, Function[]> = new Map();

    return {
      filters: {
        StateTransitioned: jest.fn((txId?: string) => ({
          fragment: 'StateTransitioned',
          args: [txId],
        })),
        TransactionCreated: jest.fn((txId?: string | null, requester?: string | null, provider?: string | null) => ({
          fragment: 'TransactionCreated',
          args: [txId, requester, provider],
        })),
        EscrowReleased: jest.fn(() => ({
          fragment: 'EscrowReleased',
        })),
      },
      on: jest.fn((filter: any, listener: Function) => {
        const key = JSON.stringify(filter);
        if (!listeners.has(key)) {
          listeners.set(key, []);
        }
        listeners.get(key)!.push(listener);
      }),
      off: jest.fn((filter: any, listener: Function) => {
        const key = JSON.stringify(filter);
        const arr = listeners.get(key);
        if (arr) {
          const idx = arr.indexOf(listener);
          if (idx >= 0) arr.splice(idx, 1);
        }
      }),
      queryFilter: jest.fn(),
      getTransaction: jest.fn(),
      // Helper to emit events in tests
      _emit: (filter: any, ...args: any[]) => {
        const key = JSON.stringify(filter);
        const arr = listeners.get(key);
        if (arr) {
          arr.forEach((listener) => listener(...args));
        }
      },
      _getListenerCount: (filter: any) => {
        const key = JSON.stringify(filter);
        return listeners.get(key)?.length || 0;
      },
    };
  };

  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create EventMonitor with contracts', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();

      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      expect(monitor).toBeDefined();
    });
  });

  // ============================================================================
  // watchTransaction Tests
  // ============================================================================

  describe('watchTransaction()', () => {
    it('should subscribe to state transition events', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      const txId = '0x' + '1'.repeat(64);

      monitor.watchTransaction(txId, callback);

      expect(mockKernel.filters.StateTransitioned).toHaveBeenCalledWith(txId);
      expect(mockKernel.on).toHaveBeenCalled();
    });

    it('should call callback when state changes', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      const txId = '0x' + '1'.repeat(64);

      monitor.watchTransaction(txId, callback);

      // Get the filter that was created
      const filter = mockKernel.filters.StateTransitioned(txId);

      // Emit state change event
      mockKernel._emit(filter, txId, State.COMMITTED, State.DELIVERED);

      expect(callback).toHaveBeenCalledWith(State.DELIVERED);
    });

    it('should return cleanup function', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);
      const cleanup = monitor.watchTransaction(txId, jest.fn());

      expect(typeof cleanup).toBe('function');
    });

    it('should remove listener when cleanup is called', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);
      const cleanup = monitor.watchTransaction(txId, jest.fn());

      cleanup();

      expect(mockKernel.off).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // waitForState Tests
  // ============================================================================

  describe('waitForState()', () => {
    it('should resolve when target state is reached', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);

      // Start waiting for DELIVERED state
      const promise = monitor.waitForState(txId, State.DELIVERED, 1000);

      // Get the filter and emit the state change
      const filter = mockKernel.filters.StateTransitioned(txId);
      mockKernel._emit(filter, txId, State.COMMITTED, State.DELIVERED);

      // Should resolve without error
      await expect(promise).resolves.toBeUndefined();
    });

    it('should timeout if state not reached', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);

      // Wait with short timeout
      await expect(monitor.waitForState(txId, State.DELIVERED, 50)).rejects.toThrow(
        'Timeout waiting for state'
      );
    });

    it('should ignore non-matching states', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);

      // Start waiting for DELIVERED
      const promise = monitor.waitForState(txId, State.DELIVERED, 200);

      const filter = mockKernel.filters.StateTransitioned(txId);

      // Emit COMMITTED (not DELIVERED)
      mockKernel._emit(filter, txId, State.INITIATED, State.COMMITTED);

      // Still waiting... now emit DELIVERED
      setTimeout(() => {
        mockKernel._emit(filter, txId, State.COMMITTED, State.DELIVERED);
      }, 50);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should clean up listener after resolving', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);
      const filter = mockKernel.filters.StateTransitioned(txId);

      const promise = monitor.waitForState(txId, State.DELIVERED, 1000);

      // Emit state change
      mockKernel._emit(filter, txId, State.COMMITTED, State.DELIVERED);

      await promise;

      // Listener should be removed
      expect(mockKernel.off).toHaveBeenCalled();
    });

    it('should clean up listener after timeout', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);

      try {
        await monitor.waitForState(txId, State.DELIVERED, 50);
      } catch {
        // Expected timeout
      }

      // Listener should be removed
      expect(mockKernel.off).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // getTransactionHistory Tests
  // ============================================================================

  describe('getTransactionHistory()', () => {
    it('should query events for requester', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const address = '0x' + '1'.repeat(40);
      mockKernel.queryFilter.mockResolvedValue([]);

      await monitor.getTransactionHistory(address, 'requester');

      // Should use correct filter with requester position
      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalledWith(null, address, null);
    });

    it('should query events for provider', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const address = '0x' + '2'.repeat(40);
      mockKernel.queryFilter.mockResolvedValue([]);

      await monitor.getTransactionHistory(address, 'provider');

      // Should use correct filter with provider position
      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalledWith(null, null, address);
    });

    it('should default to requester role', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const address = '0x' + '1'.repeat(40);
      mockKernel.queryFilter.mockResolvedValue([]);

      await monitor.getTransactionHistory(address);

      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalledWith(null, address, null);
    });

    it('should return transaction data from events', async () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const txId = '0x' + '1'.repeat(64);
      const address = '0x' + 'a'.repeat(40);

      // Mock event
      const mockEvent = {
        args: {
          transactionId: txId,
        },
      };

      // Mock transaction data
      const mockTxData = {
        transactionId: txId,
        requester: address,
        provider: '0x' + 'b'.repeat(40),
        amount: BigInt(1000000),
        state: 2,
        createdAt: BigInt(1700000000),
        updatedAt: BigInt(1700000100),
        deadline: BigInt(1700086400),
        disputeWindow: BigInt(172800),
        escrowContract: '0x' + 'c'.repeat(40),
        escrowId: '0x' + '2'.repeat(64),
        serviceHash: '0x' + '3'.repeat(64),
        attestationUID: '0x' + '4'.repeat(64),
        metadata: null,
        platformFeeBpsLocked: BigInt(100),
      };

      mockKernel.queryFilter.mockResolvedValue([mockEvent]);
      mockKernel.getTransaction.mockResolvedValue(mockTxData);

      const result = await monitor.getTransactionHistory(address, 'requester');

      expect(result).toHaveLength(1);
      expect(result[0].txId).toBe(txId);
      expect(result[0].requester).toBe(address);
      expect(result[0].state).toBe(2);
    });

    // PRD-event-driven-provider-listening §5.5: bounded scan + ordering metadata.
    describe('range parameter (§5.5)', () => {
      it('should pass fromBlock/toBlock through to queryFilter when range provided', async () => {
        const mockKernel = createMockContract();
        const mockEscrow = createMockContract();
        const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

        const address = '0x' + '1'.repeat(40);
        mockKernel.queryFilter.mockResolvedValue([]);

        await monitor.getTransactionHistory(address, 'provider', {
          fromBlock: 1000,
          toBlock: 'latest',
        });

        // queryFilter(filter, fromBlock, toBlock)
        expect(mockKernel.queryFilter).toHaveBeenCalledWith(
          expect.anything(),
          1000,
          'latest'
        );
      });

      it('should call queryFilter without range args when range is omitted (backward compat)', async () => {
        const mockKernel = createMockContract();
        const mockEscrow = createMockContract();
        const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

        const address = '0x' + '1'.repeat(40);
        mockKernel.queryFilter.mockResolvedValue([]);

        await monitor.getTransactionHistory(address, 'provider');

        // Single-arg call — pre-§5.5 behavior preserved
        expect(mockKernel.queryFilter).toHaveBeenCalledWith(expect.anything());
        expect(mockKernel.queryFilter.mock.calls[0]).toHaveLength(1);
      });

      it('should attach blockNumber and logIndex from the source EventLog', async () => {
        const mockKernel = createMockContract();
        const mockEscrow = createMockContract();
        const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

        const txId = '0x' + '1'.repeat(64);
        const address = '0x' + 'a'.repeat(40);

        const mockEvent = {
          args: { transactionId: txId },
          blockNumber: 42_000,
          index: 3,
        };
        const mockTxData = {
          transactionId: txId,
          requester: address,
          provider: '0x' + 'b'.repeat(40),
          amount: BigInt(1000000),
          state: 0,
          createdAt: BigInt(1700000000),
          updatedAt: BigInt(1700000100),
          deadline: BigInt(1700086400),
          disputeWindow: BigInt(172800),
          escrowContract: '0x' + 'c'.repeat(40),
          escrowId: '0x' + '2'.repeat(64),
          serviceHash: '0x' + '3'.repeat(64),
          attestationUID: '0x' + '4'.repeat(64),
          metadata: null,
          platformFeeBpsLocked: BigInt(100),
        };

        mockKernel.queryFilter.mockResolvedValue([mockEvent]);
        mockKernel.getTransaction.mockResolvedValue(mockTxData);

        const result = await monitor.getTransactionHistory(address, 'provider');

        expect(result).toHaveLength(1);
        expect(result[0].blockNumber).toBe(42_000);
        expect(result[0].logIndex).toBe(3);
      });
    });
  });

  // ============================================================================
  // onTransactionCreated Tests
  // ============================================================================

  describe('onTransactionCreated()', () => {
    it('should subscribe to TransactionCreated events', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      monitor.onTransactionCreated(callback);

      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalled();
      expect(mockKernel.on).toHaveBeenCalled();
    });

    it('should call callback with transaction data', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      monitor.onTransactionCreated(callback);

      const filter = mockKernel.filters.TransactionCreated();
      const txId = '0x' + '1'.repeat(64);
      const requester = '0x' + 'a'.repeat(40);
      const provider = '0x' + 'b'.repeat(40);
      const amount = BigInt(1000000);
      const serviceHash = '0x' + 'c'.repeat(64);

      mockKernel._emit(filter, txId, requester, provider, amount, serviceHash);

      expect(callback).toHaveBeenCalledWith({
        txId,
        requester,
        provider,
        amount,
        serviceHash,
      });
    });

    it('should return cleanup function', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const cleanup = monitor.onTransactionCreated(jest.fn());

      expect(typeof cleanup).toBe('function');

      cleanup();
      expect(mockKernel.off).toHaveBeenCalled();
    });

    it('should pass null for all indexed params when no filter given', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      monitor.onTransactionCreated(jest.fn());

      // No filter = null for all three indexed params (txId, requester, provider)
      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalledWith(null, null, null);
    });

    it('should filter by provider address at RPC level', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const providerAddress = '0x' + 'b'.repeat(40);
      monitor.onTransactionCreated({ provider: providerAddress }, jest.fn());

      // Filter order: TransactionCreated(txId, requester, provider)
      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalledWith(null, null, providerAddress);
    });

    it('should filter by requester address at RPC level', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const requesterAddress = '0x' + 'a'.repeat(40);
      monitor.onTransactionCreated({ requester: requesterAddress }, jest.fn());

      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalledWith(null, requesterAddress, null);
    });

    it('should filter by both requester and provider', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const requesterAddress = '0x' + 'a'.repeat(40);
      const providerAddress = '0x' + 'b'.repeat(40);
      monitor.onTransactionCreated(
        { requester: requesterAddress, provider: providerAddress },
        jest.fn(),
      );

      expect(mockKernel.filters.TransactionCreated).toHaveBeenCalledWith(
        null,
        requesterAddress,
        providerAddress,
      );
    });

    it('should throw at subscription time if filter passed without callback', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const providerAddress = '0x' + 'b'.repeat(40);
      // JS caller forgets the callback — should fast-fail, not crash on first event
      expect(() =>
        (monitor as any).onTransactionCreated({ provider: providerAddress }),
      ).toThrow('callback is required');

      // Should NOT have subscribed
      expect(mockKernel.on).not.toHaveBeenCalled();
    });

    it('should call filtered callback with transaction data', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const providerAddress = '0x' + 'b'.repeat(40);
      const callback = jest.fn();
      monitor.onTransactionCreated({ provider: providerAddress }, callback);

      const filter = mockKernel.filters.TransactionCreated(null, null, providerAddress);
      const txId = '0x' + '1'.repeat(64);
      const requester = '0x' + 'a'.repeat(40);
      const amount = BigInt(1000000);

      mockKernel._emit(filter, txId, requester, providerAddress, amount, '0x');

      expect(callback).toHaveBeenCalledWith({
        txId,
        requester,
        provider: providerAddress,
        amount,
        serviceHash: '0x',
      });
    });
  });

  // ============================================================================
  // onStateChanged Tests
  // ============================================================================

  describe('onStateChanged()', () => {
    it('should subscribe to StateTransitioned events', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      monitor.onStateChanged(callback);

      expect(mockKernel.filters.StateTransitioned).toHaveBeenCalled();
      expect(mockKernel.on).toHaveBeenCalled();
    });

    it('should call callback with state change data', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      monitor.onStateChanged(callback);

      const filter = mockKernel.filters.StateTransitioned();
      const txId = '0x' + '1'.repeat(64);

      mockKernel._emit(filter, txId, State.COMMITTED, State.DELIVERED);

      expect(callback).toHaveBeenCalledWith(txId, State.COMMITTED, State.DELIVERED);
    });

    it('should return cleanup function', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const cleanup = monitor.onStateChanged(jest.fn());

      expect(typeof cleanup).toBe('function');

      cleanup();
      expect(mockKernel.off).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // onEscrowReleased Tests
  // ============================================================================

  describe('onEscrowReleased()', () => {
    it('should subscribe to EscrowReleased events', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      monitor.onEscrowReleased(callback);

      expect(mockKernel.filters.EscrowReleased).toHaveBeenCalled();
      expect(mockKernel.on).toHaveBeenCalled();
    });

    it('should call callback with release data', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const callback = jest.fn();
      monitor.onEscrowReleased(callback);

      const filter = mockKernel.filters.EscrowReleased();
      const txId = '0x' + '1'.repeat(64);
      const amount = BigInt(1000000);

      mockKernel._emit(filter, txId, amount);

      expect(callback).toHaveBeenCalledWith(txId, amount);
    });

    it('should return cleanup function', () => {
      const mockKernel = createMockContract();
      const mockEscrow = createMockContract();
      const monitor = new EventMonitor(mockKernel as any, mockEscrow as any);

      const cleanup = monitor.onEscrowReleased(jest.fn());

      expect(typeof cleanup).toBe('function');

      cleanup();
      expect(mockKernel.off).toHaveBeenCalled();
    });
  });
});
