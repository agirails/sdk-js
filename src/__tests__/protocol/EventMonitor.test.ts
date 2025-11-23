/**
 * EventMonitor Test Suite
 *
 * Coverage Target: 80%+ (statements, functions, lines, branches)
 *
 * Test Categories:
 * 1. Event Watching (3 tests)
 * 2. State Monitoring (3 tests)
 * 3. Transaction History (3 tests)
 * 4. Event Subscriptions (3 tests)
 *
 * References:
 * - EventMonitor.ts implementation
 */

import { EventMonitor } from '../../protocol/EventMonitor';
import { State } from '../../types';

// Mock contract
const mockKernelContract = {
  filters: {
    StateTransitioned: jest.fn(),
    TransactionCreated: jest.fn(),
    EscrowReleased: jest.fn()
  },
  on: jest.fn(),
  off: jest.fn(),
  queryFilter: jest.fn(),
  transactions: jest.fn()
};

const mockEscrowContract = {};

describe('EventMonitor - Event Watching & Subscriptions', () => {
  let eventMonitor: EventMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    eventMonitor = new EventMonitor(
      mockKernelContract as any,
      mockEscrowContract as any
    );
  });

  describe('watchTransaction - Event Listening', () => {
    it('should set up event listener for transaction state changes', () => {
      const txId = '0x' + '1'.repeat(64);
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.watchTransaction(txId, callback);

      expect(mockKernelContract.filters.StateTransitioned).toHaveBeenCalledWith(txId);
      expect(mockKernelContract.on).toHaveBeenCalledWith(mockFilter, expect.any(Function));
      expect(typeof cleanup).toBe('function');
    });

    it('should invoke callback when state transition event occurs', () => {
      const txId = '0x' + '1'.repeat(64);
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      let eventListener: any;
      mockKernelContract.on.mockImplementation((_filter, listener) => {
        eventListener = listener;
      });

      eventMonitor.watchTransaction(txId, callback);

      // Simulate state transition event
      const mockEvent = { blockNumber: 12345 };
      eventListener(txId, State.INITIATED, State.QUOTED, mockEvent);

      expect(callback).toHaveBeenCalledWith(State.QUOTED);
    });

    it('should remove event listener when cleanup function is called', () => {
      const txId = '0x' + '1'.repeat(64);
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.watchTransaction(txId, callback);
      cleanup();

      expect(mockKernelContract.off).toHaveBeenCalledWith(mockFilter, expect.any(Function));
    });
  });

  describe('waitForState - Async State Monitoring', () => {
    it('should resolve when target state is reached', async () => {
      const txId = '0x' + '1'.repeat(64);
      const mockFilter = { address: 'mock-filter' };

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      let eventListener: any;
      mockKernelContract.on.mockImplementation((_filter, listener) => {
        eventListener = listener;
      });

      const waitPromise = eventMonitor.waitForState(txId, State.DELIVERED, 5000);

      // Simulate state transition to target state
      setTimeout(() => {
        const mockEvent = { blockNumber: 12345 };
        eventListener(txId, State.IN_PROGRESS, State.DELIVERED, mockEvent);
      }, 100);

      await expect(waitPromise).resolves.toBeUndefined();
    });

    it('should reject with timeout error if target state not reached', async () => {
      const txId = '0x' + '1'.repeat(64);
      const mockFilter = { address: 'mock-filter' };

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      const waitPromise = eventMonitor.waitForState(txId, State.DELIVERED, 100);

      await expect(waitPromise).rejects.toThrow('Timeout waiting for state DELIVERED');
    });

    it('should ignore non-matching state transitions', async () => {
      const txId = '0x' + '1'.repeat(64);
      const mockFilter = { address: 'mock-filter' };

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      let eventListener: any;
      mockKernelContract.on.mockImplementation((_filter, listener) => {
        eventListener = listener;
      });

      const waitPromise = eventMonitor.waitForState(txId, State.DELIVERED, 1000);

      // Simulate state transitions to non-target states
      setTimeout(() => {
        const mockEvent = { blockNumber: 12345 };
        eventListener(txId, State.INITIATED, State.QUOTED, mockEvent);
        eventListener(txId, State.QUOTED, State.COMMITTED, mockEvent);
      }, 100);

      // Then emit target state
      setTimeout(() => {
        const mockEvent = { blockNumber: 12346 };
        eventListener(txId, State.COMMITTED, State.DELIVERED, mockEvent);
      }, 200);

      await expect(waitPromise).resolves.toBeUndefined();
    });
  });

  describe('getTransactionHistory - Historical Data', () => {
    it('should fetch transaction history for requester', async () => {
      const requesterAddress = '0x' + 'a'.repeat(40);
      const mockFilter = { address: 'mock-filter' };

      mockKernelContract.filters.TransactionCreated.mockReturnValue(mockFilter);

      const mockEvents = [
        {
          args: {
            transactionId: '0x' + '1'.repeat(64)
          }
        },
        {
          args: {
            transactionId: '0x' + '2'.repeat(64)
          }
        }
      ];

      mockKernelContract.queryFilter.mockResolvedValue(mockEvents);

      mockKernelContract.transactions.mockImplementation((txId: string) => {
        return Promise.resolve({
          transactionId: txId,
          requester: requesterAddress,
          provider: '0x' + 'b'.repeat(40),
          amount: BigInt('100000000'),
          state: State.INITIATED,
          createdAt: BigInt(Math.floor(Date.now() / 1000)),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
          disputeWindow: BigInt(7200),
          escrowContract: '0x' + 'c'.repeat(40),
          escrowId: '0x' + '3'.repeat(64),
          serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
        });
      });

      const transactions = await eventMonitor.getTransactionHistory(requesterAddress, 'requester');

      expect(mockKernelContract.filters.TransactionCreated).toHaveBeenCalledWith(null, null, requesterAddress);
      expect(transactions).toHaveLength(2);
      expect(transactions[0].txId).toBe('0x' + '1'.repeat(64));
      expect(transactions[1].txId).toBe('0x' + '2'.repeat(64));
    });

    it('should fetch transaction history for provider', async () => {
      const providerAddress = '0x' + 'b'.repeat(40);
      const mockFilter = { address: 'mock-filter' };

      mockKernelContract.filters.TransactionCreated.mockReturnValue(mockFilter);
      mockKernelContract.queryFilter.mockResolvedValue([]);

      await eventMonitor.getTransactionHistory(providerAddress, 'provider');

      expect(mockKernelContract.filters.TransactionCreated).toHaveBeenCalledWith(null, providerAddress, null);
    });

    it('should default to requester role if not specified', async () => {
      const address = '0x' + 'a'.repeat(40);
      const mockFilter = { address: 'mock-filter' };

      mockKernelContract.filters.TransactionCreated.mockReturnValue(mockFilter);
      mockKernelContract.queryFilter.mockResolvedValue([]);

      await eventMonitor.getTransactionHistory(address);

      expect(mockKernelContract.filters.TransactionCreated).toHaveBeenCalledWith(null, null, address);
    });
  });

  describe('onTransactionCreated - Event Subscription', () => {
    it('should subscribe to transaction creation events', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.TransactionCreated.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.onTransactionCreated(callback);

      expect(mockKernelContract.filters.TransactionCreated).toHaveBeenCalledWith();
      expect(mockKernelContract.on).toHaveBeenCalledWith(mockFilter, expect.any(Function));
      expect(typeof cleanup).toBe('function');
    });

    it('should invoke callback when transaction is created', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.TransactionCreated.mockReturnValue(mockFilter);

      let eventListener: any;
      mockKernelContract.on.mockImplementation((_filter, listener) => {
        eventListener = listener;
      });

      eventMonitor.onTransactionCreated(callback);

      // Simulate TransactionCreated event
      const mockEvent = { blockNumber: 12345 };
      const txId = '0x' + '1'.repeat(64);
      const provider = '0x' + 'b'.repeat(40);
      const requester = '0x' + 'a'.repeat(40);
      const amount = BigInt('100000000');

      eventListener(txId, provider, requester, amount, mockEvent);

      expect(callback).toHaveBeenCalledWith({
        txId,
        provider,
        requester,
        amount
      });
    });

    it('should remove listener when cleanup function is called', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.TransactionCreated.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.onTransactionCreated(callback);
      cleanup();

      expect(mockKernelContract.off).toHaveBeenCalledWith(mockFilter, expect.any(Function));
    });
  });

  describe('onStateChanged - State Change Subscription', () => {
    it('should subscribe to state change events', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.onStateChanged(callback);

      expect(mockKernelContract.filters.StateTransitioned).toHaveBeenCalledWith();
      expect(mockKernelContract.on).toHaveBeenCalledWith(mockFilter, expect.any(Function));
      expect(typeof cleanup).toBe('function');
    });

    it('should invoke callback with state transition details', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      let eventListener: any;
      mockKernelContract.on.mockImplementation((_filter, listener) => {
        eventListener = listener;
      });

      eventMonitor.onStateChanged(callback);

      // Simulate StateTransitioned event
      const txId = '0x' + '1'.repeat(64);
      eventListener(txId, State.INITIATED, State.QUOTED);

      expect(callback).toHaveBeenCalledWith(txId, State.INITIATED, State.QUOTED);
    });

    it('should remove listener when cleanup function is called', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.StateTransitioned.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.onStateChanged(callback);
      cleanup();

      expect(mockKernelContract.off).toHaveBeenCalledWith(mockFilter, expect.any(Function));
    });
  });

  describe('onEscrowReleased - Escrow Release Subscription', () => {
    it('should subscribe to escrow release events', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.EscrowReleased.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.onEscrowReleased(callback);

      expect(mockKernelContract.filters.EscrowReleased).toHaveBeenCalledWith();
      expect(mockKernelContract.on).toHaveBeenCalledWith(mockFilter, expect.any(Function));
      expect(typeof cleanup).toBe('function');
    });

    it('should invoke callback when escrow is released', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.EscrowReleased.mockReturnValue(mockFilter);

      let eventListener: any;
      mockKernelContract.on.mockImplementation((_filter, listener) => {
        eventListener = listener;
      });

      eventMonitor.onEscrowReleased(callback);

      // Simulate EscrowReleased event
      const txId = '0x' + '1'.repeat(64);
      const amount = BigInt('100000000');

      eventListener(txId, amount);

      expect(callback).toHaveBeenCalledWith(txId, amount);
    });

    it('should remove listener when cleanup function is called', () => {
      const mockFilter = { address: 'mock-filter' };
      const callback = jest.fn();

      mockKernelContract.filters.EscrowReleased.mockReturnValue(mockFilter);

      const cleanup = eventMonitor.onEscrowReleased(callback);
      cleanup();

      expect(mockKernelContract.off).toHaveBeenCalledWith(mockFilter, expect.any(Function));
    });
  });
});
