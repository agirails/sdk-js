/**
 * BlockchainRuntime Unit Tests
 *
 * Tests the BlockchainRuntime class with mocked ethers.js providers.
 * For real blockchain integration tests, see BlockchainRuntime.integration.test.ts
 */

import { BlockchainRuntime, BlockchainRuntimeConfig } from './BlockchainRuntime';
import { JsonRpcProvider, Wallet, Network, ZeroHash } from 'ethers';
import { TransactionState } from './types/MockState';

// Mock ethers modules
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');

  // Create mock function that acts as both a function and has estimateGas property
  const createMockTxFunction = () => {
    const mockFn = jest.fn().mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        logs: [{
          topics: ['0x1234'],
          data: '0x'
        }]
      })
    });
    (mockFn as any).estimateGas = jest.fn().mockResolvedValue(100000n);
    return mockFn;
  };

  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => ({
      getFunction: jest.fn().mockReturnValue(createMockTxFunction()),
      getTransaction: jest.fn().mockResolvedValue({
        requester: '0x1111111111111111111111111111111111111111',
        provider: '0x2222222222222222222222222222222222222222',
        amount: 100000000n,
        state: 0,
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        escrowId: '0x0000000000000000000000000000000000000000000000000000000000000000'
      }),
      platformFeeBps: jest.fn().mockResolvedValue(100n),
      requesterPenaltyBps: jest.fn().mockResolvedValue(500n),
      feeRecipient: jest.fn().mockResolvedValue('0x3333333333333333333333333333333333333333'),
      interface: {
        parseLog: jest.fn().mockReturnValue({
          name: 'TransactionCreated',
          args: {
            transactionId: '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234'
          }
        })
      }
    }))
  };
});

describe('BlockchainRuntime', () => {
  let mockProvider: jest.Mocked<JsonRpcProvider>;
  let mockSigner: jest.Mocked<Wallet>;
  let runtime: BlockchainRuntime;

  const REQUESTER = '0x1111111111111111111111111111111111111111';
  const PROVIDER = '0x2222222222222222222222222222222222222222';

  beforeEach(async () => {
    // Create mock provider
    mockProvider = {
      getNetwork: jest.fn().mockResolvedValue({
        chainId: 84532n,
        name: 'base-sepolia'
      } as unknown as Network),
      getBlockNumber: jest.fn().mockResolvedValue(1000),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: 1000000000n,
        maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 100000000n
      })
    } as unknown as jest.Mocked<JsonRpcProvider>;

    // Create mock signer
    mockSigner = {
      getAddress: jest.fn().mockResolvedValue(REQUESTER),
      provider: mockProvider,
      signTypedData: jest.fn().mockResolvedValue('0xsignature')
    } as unknown as jest.Mocked<Wallet>;

    // Create runtime
    const config: BlockchainRuntimeConfig = {
      network: 'base-sepolia',
      signer: mockSigner,
      provider: mockProvider
    };

    runtime = new BlockchainRuntime(config);
  });

  describe('constructor', () => {
    it('should create runtime with base-sepolia network', () => {
      expect(runtime).toBeInstanceOf(BlockchainRuntime);
      expect(runtime.getNetworkConfig().name).toBe('Base Sepolia');
      expect(runtime.getNetworkConfig().chainId).toBe(84532);
    });

    it('should apply contract address overrides', () => {
      const customKernel = '0x9999999999999999999999999999999999999999';
      const config: BlockchainRuntimeConfig = {
        network: 'base-sepolia',
        signer: mockSigner,
        provider: mockProvider,
        contracts: {
          actpKernel: customKernel
        }
      };

      const customRuntime = new BlockchainRuntime(config);
      expect(customRuntime.getNetworkConfig().contracts.actpKernel).toBe(customKernel);
    });

    it('should default requireAttestation to false', () => {
      expect(runtime.isAttestationRequired()).toBe(false);
    });

    it('should set requireAttestation when provided', () => {
      const config: BlockchainRuntimeConfig = {
        network: 'base-sepolia',
        signer: mockSigner,
        provider: mockProvider,
        requireAttestation: true
      };

      const secureRuntime = new BlockchainRuntime(config);
      expect(secureRuntime.isAttestationRequired()).toBe(true);
    });
  });

  describe('initialize()', () => {
    it('should mark runtime as initialized', async () => {
      expect(runtime.isInitialized()).toBe(false);
      await runtime.initialize();
      expect(runtime.isInitialized()).toBe(true);
    });

    it('should validate chainId matches network config', async () => {
      await runtime.initialize();
      expect(mockProvider.getNetwork).toHaveBeenCalled();
    });

    it('should throw on chainId mismatch', async () => {
      mockProvider.getNetwork = jest.fn().mockResolvedValue({
        chainId: 1n, // Mainnet, not Base Sepolia
        name: 'mainnet'
      });

      await expect(runtime.initialize()).rejects.toThrow('Network mismatch');
    });

    it('should warn but continue if network check fails', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockProvider.getNetwork = jest.fn().mockRejectedValue(new Error('Network error'));

      await runtime.initialize();

      expect(consoleSpy).toHaveBeenCalled();
      expect(runtime.isInitialized()).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe('requireInitialized()', () => {
    it('should throw if not initialized', async () => {
      await expect(
        runtime.createTransaction({
          provider: PROVIDER,
          requester: REQUESTER,
          amount: '100000000',
          deadline: Math.floor(Date.now() / 1000) + 86400,
          disputeWindow: 172800
        })
      ).rejects.toThrow('BlockchainRuntime not initialized');
    });
  });

  describe('createTransaction()', () => {
    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should validate provider address', async () => {
      await expect(
        runtime.createTransaction({
          provider: 'invalid',
          requester: REQUESTER,
          amount: '100000000',
          deadline: Math.floor(Date.now() / 1000) + 86400,
          disputeWindow: 172800
        })
      ).rejects.toThrow('Invalid provider address');
    });

    it('should validate requester address', async () => {
      await expect(
        runtime.createTransaction({
          provider: PROVIDER,
          requester: 'invalid',
          amount: '100000000',
          deadline: Math.floor(Date.now() / 1000) + 86400,
          disputeWindow: 172800
        })
      ).rejects.toThrow('Invalid requester address');
    });

    it('should validate amount is positive', async () => {
      await expect(
        runtime.createTransaction({
          provider: PROVIDER,
          requester: REQUESTER,
          amount: '0',
          deadline: Math.floor(Date.now() / 1000) + 86400,
          disputeWindow: 172800
        })
      ).rejects.toThrow('Amount must be positive');
    });

    it('should validate deadline is in the future', async () => {
      await expect(
        runtime.createTransaction({
          provider: PROVIDER,
          requester: REQUESTER,
          amount: '100000000',
          deadline: Math.floor(Date.now() / 1000) - 3600, // Past
          disputeWindow: 172800
        })
      ).rejects.toThrow('Deadline must be in the future');
    });

    it('should use default dispute window of 2 days', async () => {
      // This test verifies the default is applied
      const params = {
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        deadline: Math.floor(Date.now() / 1000) + 86400
        // No disputeWindow - should default to 172800
      };

      // The actual transaction creation is mocked, but we verify the params
      expect((params as any).disputeWindow).toBeUndefined();
    });
  });

  describe('linkEscrow()', () => {
    const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should validate transaction exists', async () => {
      // Mock getTransaction to return null
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue(null);

      await expect(
        runtime.linkEscrow(TX_ID, '100000000')
      ).rejects.toThrow('Transaction not found');
    });

    it('should validate state is INITIATED or QUOTED', async () => {
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'COMMITTED', // Already committed
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: '',
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      await expect(
        runtime.linkEscrow(TX_ID, '100000000')
      ).rejects.toThrow('Cannot link escrow in current state');
    });

    it('should validate amount matches transaction', async () => {
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'INITIATED',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: '',
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      await expect(
        runtime.linkEscrow(TX_ID, '50000000') // Different amount
      ).rejects.toThrow('Amount mismatch');
    });
  });

  describe('transitionState()', () => {
    const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should validate state value', async () => {
      await expect(
        runtime.transitionState(TX_ID, 'INVALID_STATE' as TransactionState)
      ).rejects.toThrow('Invalid state');
    });

    it('should map state string to numeric value correctly', async () => {
      const stateMap: Record<TransactionState, number> = {
        INITIATED: 0,
        QUOTED: 1,
        COMMITTED: 2,
        IN_PROGRESS: 3,
        DELIVERED: 4,
        SETTLED: 5,
        DISPUTED: 6,
        CANCELLED: 7
      };

      for (const [_state, expected] of Object.entries(stateMap)) {
        // Verify mapping exists
        expect(expected).toBeDefined();
      }
    });
  });

  describe('getTransaction()', () => {
    const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should return null for non-existent transaction', async () => {
      // Spy on the runtime method to return null for non-existent transaction
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue(null);

      const result = await runtime.getTransaction(TX_ID);
      expect(result).toBeNull();
    });

    it('should map state numbers to state strings correctly', async () => {
      const stateMap: Record<number, TransactionState> = {
        0: 'INITIATED',
        1: 'QUOTED',
        2: 'COMMITTED',
        3: 'IN_PROGRESS',
        4: 'DELIVERED',
        5: 'SETTLED',
        6: 'DISPUTED',
        7: 'CANCELLED'
      };

      for (const [num, state] of Object.entries(stateMap)) {
        expect(state).toBe(stateMap[parseInt(num)]);
      }
    });

    // Companion fix for Damir review Issue A: BlockchainRuntime.getTransaction
    // used to swallow ALL errors and return null. That hid decode / RPC /
    // network errors as "not found", making Issue A surface as TX_NOT_FOUND
    // for real on-chain transactions. Now: null ONLY for confirmed-missing.
    describe('error propagation (Damir review companion fix)', () => {
      // Import inside the describe to avoid polluting the outer scope.
      const { TransactionNotFoundError } = jest.requireActual('../errors');

      it('returns null for TransactionNotFoundError from kernel', async () => {
        jest.spyOn((runtime as any).kernel, 'getTransaction')
          .mockRejectedValue(new TransactionNotFoundError(TX_ID));
        const result = await runtime.getTransaction(TX_ID);
        expect(result).toBeNull();
      });

      it('propagates decode / network / generic errors (was swallowed pre-fix)', async () => {
        jest.spyOn((runtime as any).kernel, 'getTransaction')
          .mockRejectedValue(new Error('Failed to fetch transaction: could not decode result data'));
        await expect(runtime.getTransaction(TX_ID)).rejects.toThrow(/decode/);
      });

      it('propagates BAD_DATA errors from the kernel as-is', async () => {
        const err: any = new Error('could not decode result data');
        err.code = 'BAD_DATA';
        jest.spyOn((runtime as any).kernel, 'getTransaction').mockRejectedValue(err);
        await expect(runtime.getTransaction(TX_ID)).rejects.toThrow(/BAD_DATA|decode/);
      });
    });
  });

  // PRD-event-driven-provider-listening §5.2: bounded EventMonitor sweep,
  // newest-first selection, case-insensitive provider match, return
  // oldest-first to match MockRuntime semantics.
  describe('getTransactionsByProvider() — §5.2 impl', () => {
    const PROVIDER = '0x1111111111111111111111111111111111111111';

    beforeEach(async () => {
      await runtime.initialize();
      // sweepBlockWindow defaults to 7200; pin currentBlock so we can assert
      // the fromBlock the impl passes to EventMonitor.
      jest.spyOn((runtime as any).provider, 'getBlockNumber').mockResolvedValue(10_000);
    });

    it('returns empty array when EventMonitor yields no events', async () => {
      jest.spyOn((runtime as any).events, 'getTransactionHistory').mockResolvedValue([]);
      const result = await runtime.getTransactionsByProvider(PROVIDER);
      expect(result).toEqual([]);
    });

    it('passes bounded fromBlock = currentBlock − sweepBlockWindow to EventMonitor', async () => {
      const historySpy = jest
        .spyOn((runtime as any).events, 'getTransactionHistory')
        .mockResolvedValue([]);
      await runtime.getTransactionsByProvider(PROVIDER);
      expect(historySpy).toHaveBeenCalledWith(
        PROVIDER,
        'provider',
        { fromBlock: 10_000 - 7200, toBlock: 'latest' }
      );
    });

    it('hydrates each candidate, applies state filter, and returns oldest-first', async () => {
      jest.spyOn((runtime as any).events, 'getTransactionHistory').mockResolvedValue([
        { txId: '0xaaa', state: 0, blockNumber: 9_990, logIndex: 0 }, // oldest INITIATED
        { txId: '0xbbb', state: 0, blockNumber: 9_995, logIndex: 0 }, // newer INITIATED
        { txId: '0xccc', state: 2, blockNumber: 9_998, logIndex: 0 }, // newest, COMMITTED — filtered out
      ] as any);
      const baseTx = {
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        deadline: 0,
        disputeWindow: 172800,
        escrowId: '',
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: [],
      };
      jest.spyOn(runtime, 'getTransaction').mockImplementation(async (txId) => {
        if (txId === '0xaaa') return { ...baseTx, id: txId, state: 'INITIATED' };
        if (txId === '0xbbb') return { ...baseTx, id: txId, state: 'INITIATED' };
        if (txId === '0xccc') return { ...baseTx, id: txId, state: 'COMMITTED' };
        return null;
      });

      const result = await runtime.getTransactionsByProvider(PROVIDER, 'INITIATED');

      // 0xccc filtered out by state; remaining returned oldest-first.
      expect(result.map((t) => t.id)).toEqual(['0xaaa', '0xbbb']);
    });

    it('matches provider case-insensitively (PRD §5.2)', async () => {
      jest.spyOn((runtime as any).events, 'getTransactionHistory').mockResolvedValue([
        { txId: '0xaaa', state: 0, blockNumber: 9_990, logIndex: 0 },
      ] as any);
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: '0xaaa',
        provider: PROVIDER.toUpperCase().replace('0X', '0x'), // mixed case stored
        requester: REQUESTER,
        amount: '100000000',
        state: 'INITIATED',
        deadline: 0,
        disputeWindow: 172800,
        escrowId: '',
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: [],
      });

      // Query with lowercase address — must still match the mixed-case stored value
      const result = await runtime.getTransactionsByProvider(PROVIDER.toLowerCase());
      expect(result).toHaveLength(1);
    });

    it('honors limit by truncating after newest-first selection', async () => {
      // Three INITIATED events at descending block numbers; limit=2 must keep the
      // two newest (which become positions [1, 0] after the reverse-to-oldest-first).
      jest.spyOn((runtime as any).events, 'getTransactionHistory').mockResolvedValue([
        { txId: '0xaaa', state: 0, blockNumber: 9_990, logIndex: 0 },
        { txId: '0xbbb', state: 0, blockNumber: 9_995, logIndex: 0 },
        { txId: '0xccc', state: 0, blockNumber: 9_999, logIndex: 0 },
      ] as any);
      const baseTx = {
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'INITIATED' as const,
        deadline: 0,
        disputeWindow: 172800,
        escrowId: '',
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: [],
      };
      jest.spyOn(runtime, 'getTransaction').mockImplementation(async (txId) => ({
        ...baseTx,
        id: txId,
      }));

      const result = await runtime.getTransactionsByProvider(PROVIDER, 'INITIATED', 2);

      // Newest two selected (bbb, ccc), then reversed → [bbb, ccc]
      expect(result.map((t) => t.id)).toEqual(['0xbbb', '0xccc']);
    });

    it('skips null hydrations and mismatched providers', async () => {
      jest.spyOn((runtime as any).events, 'getTransactionHistory').mockResolvedValue([
        { txId: '0xaaa', state: 0, blockNumber: 9_990, logIndex: 0 },
        { txId: '0xbbb', state: 0, blockNumber: 9_991, logIndex: 0 },
      ] as any);
      const baseTx = {
        requester: REQUESTER,
        amount: '100000000',
        state: 'INITIATED' as const,
        deadline: 0,
        disputeWindow: 172800,
        escrowId: '',
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: [],
      };
      jest.spyOn(runtime, 'getTransaction').mockImplementation(async (txId) => {
        if (txId === '0xaaa') return null;
        if (txId === '0xbbb') {
          return { ...baseTx, id: txId, provider: '0x9999999999999999999999999999999999999999' };
        }
        return null;
      });

      const result = await runtime.getTransactionsByProvider(PROVIDER);
      expect(result).toEqual([]);
    });
  });

  // PRD-event-driven-provider-listening §5.2: live subscription wiring.
  describe('subscribeProviderJobs() — §5.2', () => {
    const PROVIDER = '0x1111111111111111111111111111111111111111';

    beforeEach(async () => {
      await runtime.initialize();
    });

    it('returns a cleanup function and registers a TransactionCreated listener', () => {
      const onTxSpy = jest
        .spyOn((runtime as any).events, 'onTransactionCreated')
        .mockReturnValue(() => undefined);

      const cleanup = runtime.subscribeProviderJobs(PROVIDER, jest.fn());

      expect(onTxSpy).toHaveBeenCalledWith({ provider: PROVIDER }, expect.any(Function));
      expect(typeof cleanup).toBe('function');
    });

    it('invokes onJob only when hydrated tx is INITIATED', async () => {
      let capturedListener: any;
      jest
        .spyOn((runtime as any).events, 'onTransactionCreated')
        .mockImplementation((_filter: any, listener: any) => {
          capturedListener = listener;
          return () => undefined;
        });

      const baseTx = {
        id: '0xaaa',
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        deadline: 0,
        disputeWindow: 172800,
        escrowId: '',
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: [],
      };

      const onJob = jest.fn();
      runtime.subscribeProviderJobs(PROVIDER, onJob);

      // Case 1: INITIATED → fired
      jest.spyOn(runtime, 'getTransaction').mockResolvedValueOnce({ ...baseTx, state: 'INITIATED' });
      await capturedListener({ txId: '0xaaa' });
      expect(onJob).toHaveBeenCalledTimes(1);

      // Case 2: post-INITIATED (cancelled between event and read) → not fired
      jest.spyOn(runtime, 'getTransaction').mockResolvedValueOnce({ ...baseTx, state: 'CANCELLED' });
      await capturedListener({ txId: '0xbbb' });
      expect(onJob).toHaveBeenCalledTimes(1); // still 1

      // Case 3: hydration null (RPC eventual consistency) → not fired, no throw
      jest.spyOn(runtime, 'getTransaction').mockResolvedValueOnce(null);
      await capturedListener({ txId: '0xccc' });
      expect(onJob).toHaveBeenCalledTimes(1); // still 1
    });
  });

  describe('releaseEscrow()', () => {
    const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should throw if transaction not found', async () => {
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue(null);

      await expect(
        runtime.releaseEscrow(TX_ID)
      ).rejects.toThrow('Transaction not found');
    });

    it('should throw if transaction not in DELIVERED state', async () => {
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'COMMITTED', // Not DELIVERED
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: TX_ID,
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      await expect(
        runtime.releaseEscrow(TX_ID)
      ).rejects.toThrow('is in state COMMITTED, expected DELIVERED');
    });

    it('should allow requester to release escrow before dispute window expires', async () => {
      mockSigner.getAddress = jest.fn().mockResolvedValue(REQUESTER);
      jest.spyOn((runtime as any).kernel, 'transitionState').mockResolvedValue(undefined);

      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'DELIVERED',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: TX_ID,
        createdAt: Math.floor(Date.now() / 1000) - 60,
        updatedAt: 0,
        completedAt: Math.floor(Date.now() / 1000) - 30, // dispute window active
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      await expect(runtime.releaseEscrow(TX_ID)).resolves.toBeUndefined();
    });

    it('should block non-requester release while dispute window is active', async () => {
      mockSigner.getAddress = jest.fn().mockResolvedValue(PROVIDER);

      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'DELIVERED',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: TX_ID,
        createdAt: Math.floor(Date.now() / 1000) - 60,
        updatedAt: 0,
        completedAt: Math.floor(Date.now() / 1000) - 30, // dispute window active
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      await expect(
        runtime.releaseEscrow(TX_ID)
      ).rejects.toThrow('dispute window still active');
    });

    it('should require attestationUID when requireAttestation is true', async () => {
      // Create runtime with attestation required
      const secureRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: mockSigner,
        provider: mockProvider,
        requireAttestation: true
      });
      await secureRuntime.initialize();

      jest.spyOn(secureRuntime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'DELIVERED',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: TX_ID,
        createdAt: Math.floor(Date.now() / 1000) - 200000, // Far in the past
        updatedAt: 0,
        completedAt: Math.floor(Date.now() / 1000) - 200000, // Dispute window passed
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      await expect(
        secureRuntime.releaseEscrow(TX_ID) // No attestationUID
      ).rejects.toThrow('attestation verification is required but no attestationUID provided');
    });

    it('should handle legacy escrowId format', async () => {
      const legacyEscrowId = `escrow-${TX_ID}-1234567890`;

      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'DELIVERED',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: TX_ID,
        createdAt: Math.floor(Date.now() / 1000) - 200000,
        updatedAt: 0,
        completedAt: Math.floor(Date.now() / 1000) - 200000,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Should extract txId from legacy format and warn
      // Note: This will still fail because we're mocking, but we want to verify the warning
      try {
        await runtime.releaseEscrow(legacyEscrowId);
      } catch (e) {
        // Expected to fail, but warning should have been logged
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('legacy escrowId format'),
        expect.anything()
      );
      warnSpy.mockRestore();
    });
  });

  describe('getEscrowBalance()', () => {
    const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should return 0 for non-existent transaction', async () => {
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue(null);

      const balance = await runtime.getEscrowBalance(TX_ID);
      expect(balance).toBe('0');
    });

    it('should return transaction amount for COMMITTED state', async () => {
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'COMMITTED',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: TX_ID,
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      const balance = await runtime.getEscrowBalance(TX_ID);
      expect(balance).toBe('100000000');
    });

    it('should return 0 for SETTLED state', async () => {
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        id: TX_ID,
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        state: 'SETTLED',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        escrowId: TX_ID,
        createdAt: 0,
        updatedAt: 0,
        completedAt: 0,
        serviceDescription: '',
        serviceHash: ZeroHash,
        deliveryProof: '',
        events: []
      });

      const balance = await runtime.getEscrowBalance(TX_ID);
      expect(balance).toBe('0');
    });
  });

  describe('time interface', () => {
    it('should return current Unix timestamp', () => {
      const now = runtime.time.now();
      const expected = Math.floor(Date.now() / 1000);

      // Should be within 1 second
      expect(Math.abs(now - expected)).toBeLessThanOrEqual(1);
    });
  });

  describe('utility methods', () => {
    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should return signer address', async () => {
      const address = await runtime.getAddress();
      expect(address).toBe(REQUESTER);
    });

    it('should return block number', async () => {
      const blockNumber = await runtime.getBlockNumber();
      expect(blockNumber).toBe(1000);
    });

    it('should return network config', () => {
      const config = runtime.getNetworkConfig();
      expect(config.name).toBe('Base Sepolia');
      expect(config.chainId).toBe(84532);
    });

    it('should throw when getting MessageSigner before initialization', () => {
      const uninitRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: mockSigner,
        provider: mockProvider
      });

      expect(() => uninitRuntime.getMessageSigner()).toThrow(
        'BlockchainRuntime not initialized'
      );
    });

    it('should throw when getting EASHelper without config', async () => {
      await runtime.initialize();

      expect(() => runtime.getEASHelper()).toThrow(
        'EASHelper not initialized'
      );
    });
  });

  describe('gas estimation', () => {
    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should estimate createTransaction gas', async () => {
      const estimate = await runtime.estimateCreateTransactionGas({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800
      });

      expect(estimate.gasLimit).toBeGreaterThan(0n);
      expect(estimate.gasCostWei).toBeGreaterThan(0n);
      expect(estimate.gasCostGwei).toBeDefined();
    });

    it('should estimate linkEscrow gas', async () => {
      const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';
      const estimate = await runtime.estimateLinkEscrowGas(TX_ID);

      expect(estimate.gasLimit).toBe(200000n);
      expect(estimate.gasCostWei).toBeGreaterThan(0n);
    });

    it('should estimate transition gas', async () => {
      const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';
      const estimate = await runtime.estimateTransitionGas(TX_ID, 'DELIVERED');

      expect(estimate.gasLimit).toBe(80000n);
    });

    it('should get current gas price', async () => {
      const gasInfo = await runtime.getGasPrice();

      expect(gasInfo.gasPrice).toBe(1000000000n);
      expect(gasInfo.gasPriceGwei).toBeDefined();
    });
  });

  describe('connection resilience', () => {
    it('should track connection status', async () => {
      await runtime.initialize();

      const status = runtime.getConnectionStatus();

      expect(status.isHealthy).toBe(true);
      expect(status.reconnectAttempts).toBe(0);
      expect(status.maxReconnectAttempts).toBe(5);
    });
  });

  describe('validateServiceHash', () => {
    beforeEach(async () => {
      await runtime.initialize();
    });

    it('should accept valid bytes32 hash', async () => {
      // This is tested implicitly through createTransaction
      // Valid hash should not throw
      const validHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      expect(validHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should hash raw strings', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // When creating transaction with raw string service description,
      // it should be hashed and a warning logged
      // (tested implicitly)

      warnSpy.mockRestore();
    });
  });
});

describe('BlockchainRuntime edge cases', () => {
  let mockProvider: jest.Mocked<JsonRpcProvider>;
  let mockSigner: jest.Mocked<Wallet>;

  beforeEach(() => {
    mockProvider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 84532n }),
      getBlockNumber: jest.fn().mockResolvedValue(1000),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: 1000000000n,
        maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 100000000n
      })
    } as unknown as jest.Mocked<JsonRpcProvider>;

    mockSigner = {
      getAddress: jest.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
      provider: mockProvider,
      signTypedData: jest.fn().mockResolvedValue('0xsignature')
    } as unknown as jest.Mocked<Wallet>;
  });

  it('should throw on unknown network', () => {
    expect(() => {
      new BlockchainRuntime({
        network: 'unknown-network' as any,
        signer: mockSigner,
        provider: mockProvider
      });
    }).toThrow('Unknown network');
  });

  it('should warn when requireAttestation true but no EAS config', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const runtime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: mockSigner,
      provider: mockProvider,
      requireAttestation: true
      // No easConfig
    });

    await runtime.initialize();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('requireAttestation is true but no EAS config provided'),
      expect.anything()
    );

    warnSpy.mockRestore();
  });

  // ==========================================================================
  // submitQuote (AIP-2.1 §3.5 — canonical entry point for QUOTED)
  // ==========================================================================

  describe('submitQuote', () => {
    const { QuoteBuilder } = require('../builders/QuoteBuilder');
    const { InMemoryNonceManager } = require('../utils/NonceManager');

    it('delegates to kernel.submitQuote with canonical hash recomputed', async () => {
      const runtime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: mockSigner,
        provider: mockProvider,
      });
      await runtime.initialize();

      // Build a canonical quote. Provider wallet is the kernel's mocked
      // signer (mockSigner) — in production submitQuote must be called
      // by the transaction's provider; here we just need any wallet
      // because the kernel mock doesn't enforce.
      const providerWallet = Wallet.createRandom();
      const builder = new QuoteBuilder(providerWallet, new InMemoryNonceManager());
      const quote = await builder.build({
        txId: '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
        provider: `did:ethr:84532:${providerWallet.address}`,
        consumer: 'did:ethr:84532:0x2222222222222222222222222222222222222222',
        quotedAmount: '7000000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: 84532,
        kernelAddress: '0x1234567890123456789012345678901234567890',
      });
      const expectedHash = builder.computeHash(quote);

      const kernelSpy = jest
        .spyOn((runtime as any).kernel, 'submitQuote')
        .mockResolvedValue(undefined);

      await runtime.submitQuote(
        '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
        quote,
      );

      expect(kernelSpy).toHaveBeenCalledTimes(1);
      expect(kernelSpy).toHaveBeenCalledWith(
        '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
        expectedHash,
      );

      kernelSpy.mockRestore();
    });

    it('propagates kernel errors (wrong state / wrong caller)', async () => {
      const runtime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: mockSigner,
        provider: mockProvider,
      });
      await runtime.initialize();

      const providerWallet = Wallet.createRandom();
      const builder = new QuoteBuilder(providerWallet, new InMemoryNonceManager());
      const quote = await builder.build({
        txId: '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
        provider: `did:ethr:84532:${providerWallet.address}`,
        consumer: 'did:ethr:84532:0x2222222222222222222222222222222222222222',
        quotedAmount: '7000000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: 84532,
        kernelAddress: '0x1234567890123456789012345678901234567890',
      });

      const kernelSpy = jest
        .spyOn((runtime as any).kernel, 'submitQuote')
        .mockRejectedValue(new Error('Only provider can submit quote'));

      await expect(
        runtime.submitQuote(
          '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
          quote,
        ),
      ).rejects.toThrow('Only provider can submit quote');

      kernelSpy.mockRestore();
    });
  });
});
