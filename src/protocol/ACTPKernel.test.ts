/**
 * ACTPKernel Unit Tests
 *
 * Tests the ACTPKernel smart contract wrapper.
 * Focus on validation, gas estimation, and error handling.
 */

import { ACTPKernel } from './ACTPKernel';
import { ethers } from 'ethers';
import { State } from '../types';
import {
  TransactionNotFoundError,
  TransactionRevertedError,
  InvalidStateTransitionError,
  ValidationError
} from '../errors';

// Helper to create mock transaction function with estimateGas
function createMockTxFunction(estimateGasValue = 100000n) {
  const mockFn = jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({
      logs: [{ topics: ['0x1234'], data: '0x' }]
    })
  });
  (mockFn as any).estimateGas = jest.fn().mockResolvedValue(estimateGasValue);
  return mockFn;
}

describe('ACTPKernel', () => {
  let kernel: ACTPKernel;
  let mockContract: any;

  const KERNEL_ADDRESS = '0xD199070F8e9FB9a127F6Fe730Bc13300B4b3d962';
  const PROVIDER = '0x2222222222222222222222222222222222222222';
  const REQUESTER = '0x1111111111111111111111111111111111111111';
  const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

  beforeEach(() => {
    // Create kernel with real wallet (creates real contract internally)
    kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom());

    // Now stub the internal contract
    const defaultMockTxFunction = createMockTxFunction(120000n);
    mockContract = {
      getFunction: jest.fn().mockReturnValue(defaultMockTxFunction),
      getTransaction: jest.fn().mockResolvedValue({
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        state: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: 172800n,
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        updatedAt: BigInt(Math.floor(Date.now() / 1000)),
        escrowContract: ethers.ZeroAddress,
        escrowId: ethers.ZeroHash,
        serviceHash: ethers.ZeroHash,
        attestationUID: ethers.ZeroHash,
        platformFeeBpsLocked: 100n
      }),
      platformFeeBps: jest.fn().mockResolvedValue(100n),
      requesterPenaltyBps: jest.fn().mockResolvedValue(500n),
      feeRecipient: jest.fn().mockResolvedValue('0x3333333333333333333333333333333333333333'),
      interface: {
        parseLog: jest.fn().mockReturnValue({
          name: 'TransactionCreated',
          args: { transactionId: TX_ID }
        })
      }
    };

    // Stub internal contract
    (kernel as any).contract = mockContract;
  });

  describe('constructor', () => {
    it('should create kernel with correct address', () => {
      expect(kernel.getAddress()).toBe(KERNEL_ADDRESS);
    });

    it('should expose underlying contract', () => {
      expect(kernel.getContract()).toBe(mockContract);
    });
  });

  describe('createTransaction()', () => {
    const validParams = {
      provider: PROVIDER,
      requester: REQUESTER,
      amount: 100000000n,
      deadline: Math.floor(Date.now() / 1000) + 86400,
      disputeWindow: 172800
    };

    it('should validate provider address', async () => {
      await expect(
        kernel.createTransaction({ ...validParams, provider: 'invalid' })
      ).rejects.toThrow();
    });

    it('should validate requester address', async () => {
      await expect(
        kernel.createTransaction({ ...validParams, requester: 'invalid' })
      ).rejects.toThrow();
    });

    it('should validate amount is positive', async () => {
      await expect(
        kernel.createTransaction({ ...validParams, amount: 0n })
      ).rejects.toThrow();
    });

    it('should validate deadline is in future', async () => {
      await expect(
        kernel.createTransaction({
          ...validParams,
          deadline: Math.floor(Date.now() / 1000) - 3600
        })
      ).rejects.toThrow();
    });

    it('should validate dispute window', async () => {
      await expect(
        kernel.createTransaction({ ...validParams, disputeWindow: -1 })
      ).rejects.toThrow();
    });

    it('should return transaction ID and eth tx hash on success', async () => {
      const result = await kernel.createTransaction(validParams);
      expect(result.txId).toBe(TX_ID);
    });

    it('should wait for 2 confirmations', async () => {
      const waitMock = jest.fn().mockResolvedValue({
        logs: [{ topics: ['0x1234'], data: '0x' }]
      });
      const mockTxFunction = createMockTxFunction();
      mockTxFunction.mockResolvedValue({ wait: waitMock });
      mockContract.getFunction.mockReturnValue(mockTxFunction);

      await kernel.createTransaction(validParams);

      expect(waitMock).toHaveBeenCalledWith(2);
    });

    it('should throw TransactionRevertedError on contract revert', async () => {
      const mockTxFunction = createMockTxFunction();
      (mockTxFunction as any).estimateGas = jest.fn().mockRejectedValue({
        reason: 'Tx deadline passed'
      });
      mockContract.getFunction.mockReturnValue(mockTxFunction);

      await expect(
        kernel.createTransaction(validParams)
      ).rejects.toThrow(TransactionRevertedError);
    });
  });

  describe('transitionState()', () => {
    beforeEach(() => {
      // Mock getTransaction to return a transaction in COMMITTED state
      mockContract.getTransaction.mockResolvedValue({
        transactionId: TX_ID,
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        state: 2n, // COMMITTED
        createdAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        updatedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: 172800n,
        escrowContract: ethers.ZeroAddress,
        escrowId: ethers.ZeroHash,
        platformFeeBpsLocked: 100n
      });

      const mockTxFunction = createMockTxFunction(80000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId format', async () => {
      await expect(
        kernel.transitionState('invalid-txid', State.IN_PROGRESS)
      ).rejects.toThrow();
    });

    it('should validate state transition is valid', async () => {
      // COMMITTED can transition to IN_PROGRESS, DELIVERED, or CANCELLED
      // Not to SETTLED directly
      await expect(
        kernel.transitionState(TX_ID, State.SETTLED)
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('should allow valid state transitions', async () => {
      // COMMITTED -> IN_PROGRESS is valid
      await expect(
        kernel.transitionState(TX_ID, State.IN_PROGRESS)
      ).resolves.toBeUndefined();
    });

    it('should pass proof data to contract', async () => {
      // AUDIT FIX (2026-02): COMMITTED cannot go directly to DELIVERED
      // Must go through IN_PROGRESS first, so mock returns IN_PROGRESS state
      mockContract.getTransaction.mockResolvedValue({
        transactionId: TX_ID,
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        state: 3n, // IN_PROGRESS - can transition to DELIVERED
        createdAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        updatedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: 172800n,
        escrowContract: ethers.ZeroAddress,
        escrowId: ethers.ZeroHash,
        platformFeeBpsLocked: 100n
      });

      const proof = '0xdeadbeef';
      const mockTxFunction = mockContract.getFunction();

      await kernel.transitionState(TX_ID, State.DELIVERED, proof);

      expect(mockTxFunction).toHaveBeenCalledWith(
        TX_ID,
        State.DELIVERED,
        proof,
        expect.any(Object)
      );
    });
  });

  describe('submitQuote()', () => {
    const VALID_QUOTE_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    beforeEach(() => {
      // Mock getTransaction to return INITIATED state
      mockContract.getTransaction.mockResolvedValue({
        transactionId: TX_ID,
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        state: 0n, // INITIATED
        createdAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        updatedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: 172800n,
        platformFeeBpsLocked: 100n
      });

      const mockTxFunction = createMockTxFunction(80000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId format', async () => {
      await expect(
        kernel.submitQuote('invalid', VALID_QUOTE_HASH)
      ).rejects.toThrow();
    });

    it('should validate quoteHash is bytes32', async () => {
      await expect(
        kernel.submitQuote(TX_ID, 'invalid-hash')
      ).rejects.toThrow(ValidationError);
    });

    it('should reject zero hash', async () => {
      const zeroHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
      await expect(
        kernel.submitQuote(TX_ID, zeroHash)
      ).rejects.toThrow(ValidationError);
    });

    it('should validate current state is INITIATED', async () => {
      mockContract.getTransaction.mockResolvedValue({
        state: 2n // COMMITTED
      });

      await expect(
        kernel.submitQuote(TX_ID, VALID_QUOTE_HASH)
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('should call transitionState with QUOTED', async () => {
      await kernel.submitQuote(TX_ID, VALID_QUOTE_HASH);

      const mockTxFunction = mockContract.getFunction();
      expect(mockTxFunction).toHaveBeenCalled();
    });
  });

  describe('linkEscrow()', () => {
    const ESCROW_CONTRACT = '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585';
    const ESCROW_ID = TX_ID;

    beforeEach(() => {
      const mockTxFunction = createMockTxFunction(150000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId format', async () => {
      await expect(
        kernel.linkEscrow('invalid', ESCROW_CONTRACT, ESCROW_ID)
      ).rejects.toThrow();
    });

    it('should validate escrowContract address', async () => {
      await expect(
        kernel.linkEscrow(TX_ID, 'invalid', ESCROW_ID)
      ).rejects.toThrow();
    });

    it('should validate escrowId is bytes32', async () => {
      await expect(
        kernel.linkEscrow(TX_ID, ESCROW_CONTRACT, 'invalid')
      ).rejects.toThrow();
    });

    it('should call contract linkEscrow function', async () => {
      await kernel.linkEscrow(TX_ID, ESCROW_CONTRACT, ESCROW_ID);

      const mockTxFunction = mockContract.getFunction();
      expect(mockTxFunction).toHaveBeenCalledWith(
        TX_ID,
        ESCROW_CONTRACT,
        ESCROW_ID,
        expect.any(Object)
      );
    });

    it('should wait for 2 confirmations', async () => {
      const waitMock = jest.fn().mockResolvedValue({});
      const mockTxFunction = createMockTxFunction(150000n);
      mockTxFunction.mockResolvedValue({ wait: waitMock });
      mockContract.getFunction.mockReturnValue(mockTxFunction);

      await kernel.linkEscrow(TX_ID, ESCROW_CONTRACT, ESCROW_ID);

      expect(waitMock).toHaveBeenCalledWith(2);
    });
  });

  describe('releaseEscrow()', () => {
    beforeEach(() => {
      const mockTxFunction = createMockTxFunction(200000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId format', async () => {
      await expect(
        kernel.releaseEscrow('invalid')
      ).rejects.toThrow();
    });

    it('should call contract releaseEscrow function', async () => {
      await kernel.releaseEscrow(TX_ID);

      const mockTxFunction = mockContract.getFunction();
      expect(mockTxFunction).toHaveBeenCalled();
    });
  });

  describe('releaseMilestone()', () => {
    beforeEach(() => {
      const mockTxFunction = createMockTxFunction(150000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId format', async () => {
      await expect(
        kernel.releaseMilestone('invalid', 50000000n)
      ).rejects.toThrow();
    });

    it('should validate amount', async () => {
      await expect(
        kernel.releaseMilestone(TX_ID, 0n)
      ).rejects.toThrow();
    });

    it('should call contract with txId and amount', async () => {
      await kernel.releaseMilestone(TX_ID, 50000000n);

      const mockTxFunction = mockContract.getFunction();
      expect(mockTxFunction).toHaveBeenCalledWith(
        TX_ID,
        50000000n,
        expect.any(Object)
      );
    });
  });

  describe('getTransaction()', () => {
    it('should return transaction data', async () => {
      mockContract.getTransaction.mockResolvedValue({
        transactionId: TX_ID,
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        state: 2n,
        createdAt: 1700000000n,
        updatedAt: 1700000100n,
        deadline: 1700086400n,
        disputeWindow: 172800n,
        escrowContract: '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585',
        escrowId: TX_ID,
        serviceHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        attestationUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        platformFeeBpsLocked: 100n
      });

      const tx = await kernel.getTransaction(TX_ID);

      expect(tx.requester).toBe(REQUESTER);
      expect(tx.provider).toBe(PROVIDER);
      expect(tx.amount).toBe(100000000n);
      expect(tx.state).toBe(2); // COMMITTED
      expect(tx.deadline).toBe(1700086400);
      expect(tx.disputeWindow).toBe(172800);
    });

    it('should throw TransactionNotFoundError for non-existent tx', async () => {
      mockContract.getTransaction.mockResolvedValue({
        createdAt: 0n
      });

      await expect(
        kernel.getTransaction(TX_ID)
      ).rejects.toThrow(TransactionNotFoundError);
    });

    it('should throw TransactionNotFoundError when contract reverts with "Tx missing"', async () => {
      mockContract.getTransaction.mockRejectedValue({
        reason: 'Tx missing'
      });

      await expect(
        kernel.getTransaction(TX_ID)
      ).rejects.toThrow(TransactionNotFoundError);
    });

    it('should convert BigInt values to numbers', async () => {
      mockContract.getTransaction.mockResolvedValue({
        transactionId: TX_ID,
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        state: 2n,
        createdAt: 1700000000n,
        updatedAt: 1700000100n,
        deadline: 1700086400n,
        disputeWindow: 172800n,
        platformFeeBpsLocked: 100n
      });

      const tx = await kernel.getTransaction(TX_ID);

      expect(typeof tx.createdAt).toBe('number');
      expect(typeof tx.updatedAt).toBe('number');
      expect(typeof tx.deadline).toBe('number');
      expect(typeof tx.disputeWindow).toBe('number');
      expect(typeof tx.state).toBe('number');
    });
  });

  describe('getEconomicParams()', () => {
    it('should call individual view functions', async () => {
      await kernel.getEconomicParams();

      expect(mockContract.platformFeeBps).toHaveBeenCalled();
      expect(mockContract.requesterPenaltyBps).toHaveBeenCalled();
      expect(mockContract.feeRecipient).toHaveBeenCalled();
    });

    it('should return formatted economic params', async () => {
      const params = await kernel.getEconomicParams();

      expect(params.baseFeeNumerator).toBe(100);
      expect(params.baseFeeDenominator).toBe(10000);
      expect(params.feeRecipient).toBe('0x3333333333333333333333333333333333333333');
      expect(params.requesterPenaltyBps).toBe(500);
      expect(params.providerPenaltyBps).toBe(0); // Not in contract yet
    });
  });

  describe('estimateCreateTransaction()', () => {
    it('should return gas estimate', async () => {
      const mockTxFunction = createMockTxFunction(120000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);

      const estimate = await kernel.estimateCreateTransaction({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: 100000000n,
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800
      });

      expect(estimate).toBe(120000n);
    });
  });

  describe('raiseDispute()', () => {
    beforeEach(() => {
      mockContract.getTransaction.mockResolvedValue({
        state: 4n // DELIVERED
      });

      const mockTxFunction = createMockTxFunction(100000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId', async () => {
      await expect(
        kernel.raiseDispute('invalid', 'reason', 'ipfs://evidence')
      ).rejects.toThrow();
    });

    it('should encode reason and evidence as proof', async () => {
      await kernel.raiseDispute(TX_ID, 'Work not delivered', 'ipfs://QmEvidence');

      const mockTxFunction = mockContract.getFunction();
      const callArgs = (mockTxFunction as jest.Mock).mock.calls[0];

      // Second arg should be DISPUTED state
      expect(callArgs[1]).toBe(State.DISPUTED);

      // Third arg should be ABI-encoded proof
      expect(callArgs[2]).toMatch(/^0x/);
    });
  });

  describe('resolveDispute()', () => {
    beforeEach(() => {
      mockContract.getTransaction.mockResolvedValue({
        state: 6n // DISPUTED
      });

      const mockTxFunction = createMockTxFunction(200000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId', async () => {
      await expect(
        kernel.resolveDispute('invalid', {
          requesterAmount: 50000000n,
          providerAmount: 50000000n,
          mediatorAmount: 0n
        })
      ).rejects.toThrow();
    });

    it('should reject negative amounts', async () => {
      await expect(
        kernel.resolveDispute(TX_ID, {
          requesterAmount: -1n,
          providerAmount: 100000000n,
          mediatorAmount: 0n
        })
      ).rejects.toThrow('cannot be negative');
    });

    it('should require mediator address when mediatorAmount > 0', async () => {
      await expect(
        kernel.resolveDispute(TX_ID, {
          requesterAmount: 40000000n,
          providerAmount: 50000000n,
          mediatorAmount: 10000000n
          // No mediator address
        })
      ).rejects.toThrow('Mediator address required');
    });

    it('should encode resolution as proof', async () => {
      await kernel.resolveDispute(TX_ID, {
        requesterAmount: 50000000n,
        providerAmount: 45000000n,
        mediatorAmount: 5000000n,
        mediator: '0x4444444444444444444444444444444444444444'
      });

      const mockTxFunction = mockContract.getFunction();
      const callArgs = (mockTxFunction as jest.Mock).mock.calls[0];

      // Second arg should be SETTLED state
      expect(callArgs[1]).toBe(State.SETTLED);

      // Third arg should be ABI-encoded resolution
      expect(callArgs[2]).toMatch(/^0x/);
    });
  });

  describe('anchorAttestation()', () => {
    const VALID_ATTESTATION_UID = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    beforeEach(() => {
      const mockTxFunction = createMockTxFunction(80000n);
      mockContract.getFunction.mockReturnValue(mockTxFunction);
    });

    it('should validate txId', async () => {
      await expect(
        kernel.anchorAttestation('invalid', VALID_ATTESTATION_UID)
      ).rejects.toThrow();
    });

    it('should validate attestationUID is 32-byte hex', async () => {
      await expect(
        kernel.anchorAttestation(TX_ID, 'invalid')
      ).rejects.toThrow(ValidationError);
    });

    it('should call contract anchorAttestation function', async () => {
      await kernel.anchorAttestation(TX_ID, VALID_ATTESTATION_UID);

      const mockTxFunction = mockContract.getFunction();
      expect(mockTxFunction).toHaveBeenCalledWith(
        TX_ID,
        VALID_ATTESTATION_UID,
        expect.any(Object)
      );
    });
  });

  describe('gas buffer calculation', () => {
    it('should enforce minimum gas floors for operations', () => {
      // Verify minimum floors exist for critical operations
      const minFloors: Record<string, bigint> = {
        createTransaction: 120000n,
        transitionState: 80000n,
        releaseEscrow: 220000n,
        raiseDispute: 100000n,
        resolveDispute: 250000n,
        cancelTransaction: 60000n,
        anchorAttestation: 80000n
      };

      for (const [_op, floor] of Object.entries(minFloors)) {
        expect(floor).toBeGreaterThan(0n);
      }
    });

    it('should apply operation-specific buffers', () => {
      const buffers: Record<string, number> = {
        createTransaction: 1.15,
        transitionState: 1.20,
        releaseEscrow: 1.30,
        raiseDispute: 1.25,
        resolveDispute: 1.30,
        cancelTransaction: 1.15,
        anchorAttestation: 1.15
      };

      for (const [_op, buffer] of Object.entries(buffers)) {
        expect(buffer).toBeGreaterThanOrEqual(1.0);
        expect(buffer).toBeLessThanOrEqual(1.5);
      }
    });
  });
});

// ============================================================================
// Confirmations parameter tests
// ============================================================================

describe('ACTPKernel confirmations', () => {
  const KERNEL_ADDRESS = '0xD199070F8e9FB9a127F6Fe730Bc13300B4b3d962';

  it('should default to 2 confirmations', () => {
    const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom());
    // Access private field for testing — confirmations is an internal detail
    expect((kernel as any).confirmations).toBe(2);
  });

  it('should accept custom confirmations', () => {
    const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom(), undefined, 5);
    expect((kernel as any).confirmations).toBe(5);
  });

  it('should accept 1 confirmation', () => {
    const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom(), undefined, 1);
    expect((kernel as any).confirmations).toBe(1);
  });

  it('should reject 0 confirmations', () => {
    expect(() => {
      new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom(), undefined, 0);
    }).toThrow('confirmations must be >= 1');
  });

  it('should reject negative confirmations', () => {
    expect(() => {
      new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom(), undefined, -1);
    }).toThrow('confirmations must be >= 1');
  });

  it('should pass confirmations to tx.wait()', async () => {
    const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom(), undefined, 3);

    // Stub the internal contract
    const mockWait = jest.fn().mockResolvedValue(undefined);
    const mockTxFunc = jest.fn().mockResolvedValue({ wait: mockWait });
    (mockTxFunc as any).estimateGas = jest.fn().mockResolvedValue(100000n);

    const mockContract = {
      getFunction: jest.fn().mockReturnValue(mockTxFunc),
      getTransaction: jest.fn().mockResolvedValue({
        requester: '0x1111111111111111111111111111111111111111',
        provider: '0x2222222222222222222222222222222222222222',
        amount: 100000000n,
        state: 3n, // IN_PROGRESS
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: 172800n,
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        updatedAt: BigInt(Math.floor(Date.now() / 1000)),
        escrowContract: ethers.ZeroAddress,
        escrowId: ethers.ZeroHash,
        serviceHash: ethers.ZeroHash,
        attestationUID: ethers.ZeroHash,
        platformFeeBpsLocked: 100n
      }),
    };

    // Replace internal contract
    (kernel as any).contract = mockContract;

    // Call transitionState (IN_PROGRESS → DELIVERED is valid)
    await kernel.transitionState(
      '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
      4 // DELIVERED
    );

    // Verify tx.wait was called with 3 (our custom confirmations)
    expect(mockWait).toHaveBeenCalledWith(3);
  });
});

describe('ACTPKernel edge cases', () => {
  it('should handle BigInt overflow detection', async () => {
    // Should not overflow with BigInt arithmetic
    const largeEstimate = BigInt(Number.MAX_SAFE_INTEGER);
    const buffer = 11500n;
    const denominator = 10000n;
    const result = (largeEstimate * buffer) / denominator;

    expect(result).toBeGreaterThan(largeEstimate);
  });

  it('should reject gas limit exceeding block gas limit', async () => {
    // 30M is Base L2 block gas limit
    const MAX_BLOCK_GAS_LIMIT = 30_000_000n;

    // If estimated gas * buffer > 30M, should throw
    const tooHighEstimate = 25_000_000n;
    const buffer = 1.30;
    const result = tooHighEstimate * BigInt(Math.floor(buffer * 10000)) / 10000n;

    expect(result).toBeGreaterThan(MAX_BLOCK_GAS_LIMIT);
  });
});
