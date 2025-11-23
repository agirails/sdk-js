/**
 * ACTPKernel Security Test Suite
 *
 * CRITICAL: This module manages transaction state machine and escrow lifecycle
 * Coverage Target: 90%+ (statements, functions, lines), 85%+ (branches)
 *
 * Security Test Categories:
 * 1. State Transition Security (15 tests)
 * 2. Access Control Enforcement (10 tests)
 *
 * References:
 * - Security Analysis: /Testnet/tests/SDK_SECURITY_ANALYSIS-Ultra-Think.md
 * - V2: ACTPKernel State Transition TOCTOU vulnerability
 */

import { ACTPKernel } from '../../protocol/ACTPKernel';
import { State } from '../../types';
import { AbiCoder } from 'ethers';

// Mock ethers Contract
const mockContract = {
  estimateGas: {
    createTransaction: jest.fn().mockResolvedValue(BigInt(85000)),
    transitionState: jest.fn().mockResolvedValue(BigInt(50000)),
    linkEscrow: jest.fn().mockResolvedValue(BigInt(45000)),
    releaseEscrow: jest.fn().mockResolvedValue(BigInt(50000)),
    releaseMilestone: jest.fn().mockResolvedValue(BigInt(45000))
  },
  createTransaction: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({
      events: [{
        event: 'TransactionCreated',
        args: { transactionId: '0x' + '1'.repeat(64) }
      }]
    })
  }),
  transitionState: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  }),
  linkEscrow: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  }),
  releaseEscrow: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  }),
  releaseMilestone: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  }),
  transactions: jest.fn().mockResolvedValue({
    transactionId: '0x' + '1'.repeat(64),
    requester: '0x' + 'c'.repeat(40), // REQUESTER_ADDRESS
    provider: '0x' + 'b'.repeat(40), // PROVIDER_ADDRESS
    amount: BigInt('100000000'),
    state: State.INITIATED,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
    disputeWindow: BigInt(7200),
    escrowContract: '0x' + 'd'.repeat(40), // ESCROW_ADDRESS
    escrowId: '0x' + '2'.repeat(64), // ESCROW_ID
    serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
  }),
  getTransaction: jest.fn().mockResolvedValue({
    transactionId: '0x' + '1'.repeat(64),
    requester: '0x' + 'c'.repeat(40), // REQUESTER_ADDRESS
    provider: '0x' + 'b'.repeat(40), // PROVIDER_ADDRESS
    amount: BigInt('100000000'),
    state: State.INITIATED,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    updatedAt: BigInt(Math.floor(Date.now() / 1000)),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
    disputeWindow: BigInt(7200),
    escrowContract: '0x' + 'd'.repeat(40), // ESCROW_ADDRESS
    escrowId: '0x' + '2'.repeat(64), // ESCROW_ID
    serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    contentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    attestationUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
    platformFeeBpsLocked: BigInt(100)
  }),
  getEconomicParams: jest.fn().mockResolvedValue([
    BigInt(100), // platformFeeBps (1%)
    BigInt(500), // requesterPenaltyBps (5%)
    '0x' + 'f'.repeat(40) // feeRecipient
  ]),
  // ethers v6 requires getFunction
  getFunction: jest.fn((name: string) => {
    const functions: any = {
      createTransaction: mockContract.createTransaction,
      transitionState: mockContract.transitionState,
      linkEscrow: mockContract.linkEscrow,
      releaseEscrow: mockContract.releaseEscrow,
      releaseMilestone: mockContract.releaseMilestone,
      getTransaction: mockContract.getTransaction,
      raiseDispute: jest.fn().mockResolvedValue({ wait: jest.fn().mockResolvedValue({}) }),
      resolveDispute: jest.fn().mockResolvedValue({ wait: jest.fn().mockResolvedValue({}) })
    };
    const func = functions[name] || jest.fn().mockResolvedValue({ wait: jest.fn().mockResolvedValue({}) });
    const estimateGasMap: any = mockContract.estimateGas;
    func.estimateGas = estimateGasMap[name] || jest.fn().mockResolvedValue(BigInt(100000));
    return func;
  })
};

// Mock signer
const mockSigner = {
  provider: {}
};

// Mock Contract constructor
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => mockContract)
  };
});

describe('ACTPKernel - Security Tests', () => {
  let kernel: ACTPKernel;

  const KERNEL_ADDRESS = '0x' + 'a'.repeat(40);
  const PROVIDER_ADDRESS = '0x' + 'b'.repeat(40);
  const REQUESTER_ADDRESS = '0x' + 'c'.repeat(40);
  const ESCROW_ADDRESS = '0x' + 'd'.repeat(40);
  const TX_ID = '0x' + '1'.repeat(64);
  const ESCROW_ID = '0x' + '2'.repeat(64);

  beforeEach(() => {
    jest.clearAllMocks();
    kernel = new ACTPKernel(KERNEL_ADDRESS, mockSigner as any);
  });

  describe('createTransaction - Input Validation', () => {
    it('should successfully create transaction with valid params', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400, // 24 hours
        disputeWindow: 7200 // 2 hours
      };

      const txId = await kernel.createTransaction(params);

      expect(txId).toBe(TX_ID);
      expect(mockContract.createTransaction).toHaveBeenCalled();
    });

    it('should reject zero address provider', async () => {
      const params = {
        provider: '0x0000000000000000000000000000000000000000',
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      await expect(kernel.createTransaction(params)).rejects.toThrow('zero address');
    });

    it('should reject zero address requester', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: '0x0000000000000000000000000000000000000000',
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      await expect(kernel.createTransaction(params)).rejects.toThrow('zero address');
    });

    it('should reject zero amount', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt(0),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      await expect(kernel.createTransaction(params)).rejects.toThrow('Invalid amount');
    });

    it('should reject past deadline', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        disputeWindow: 7200
      };

      await expect(kernel.createTransaction(params)).rejects.toThrow('must be in the future');
    });

    it('should reject negative dispute window', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: -1
      };

      await expect(kernel.createTransaction(params)).rejects.toThrow('cannot be negative');
    });

    it('should reject dispute window exceeding 30 days', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 31 * 24 * 60 * 60 // 31 days
      };

      await expect(kernel.createTransaction(params)).rejects.toThrow('exceeds maximum');
    });

    it('should handle TransactionCreated event extraction failure', async () => {
      mockContract.createTransaction.mockResolvedValueOnce({
        wait: jest.fn().mockResolvedValue({
          events: []
        })
      });

      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      await expect(kernel.createTransaction(params)).rejects.toThrow('TransactionCreated event not found');
    });

    it('should include custom metadata in transaction', async () => {
      const customMetadata = '0x' + '5'.repeat(64);
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200,
        metadata: customMetadata
      };

      await kernel.createTransaction(params);

      expect(mockContract.createTransaction).toHaveBeenCalledWith(
        PROVIDER_ADDRESS,
        REQUESTER_ADDRESS,
        expect.any(BigInt),
        expect.any(Number),
        expect.any(Number),
        customMetadata,
        expect.any(Object)
      );
    });

    it('should use default metadata when not provided', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      await kernel.createTransaction(params);

      expect(mockContract.createTransaction).toHaveBeenCalledWith(
        PROVIDER_ADDRESS,
        REQUESTER_ADDRESS,
        expect.any(BigInt),
        expect.any(Number),
        expect.any(Number),
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        expect.any(Object)
      );
    });
  });

  describe('transitionState - State Machine Validation', () => {
    it('should allow valid state transition INITIATED -> QUOTED', async () => {
      mockContract.transactions.mockResolvedValueOnce({
        transactionId: TX_ID,
        requester: REQUESTER_ADDRESS,
        provider: PROVIDER_ADDRESS,
        amount: BigInt('100000000'),
        state: State.INITIATED,
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: BigInt(7200),
        escrowContract: ESCROW_ADDRESS,
        escrowId: ESCROW_ID,
        serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
      });

      await kernel.transitionState(TX_ID, State.QUOTED);

      expect(mockContract.transitionState).toHaveBeenCalledWith(
        TX_ID,
        State.QUOTED,
        '0x',
        expect.any(Object)
      );
    });

    it('should reject invalid state transition INITIATED -> DELIVERED', async () => {
      mockContract.transactions.mockResolvedValueOnce({
        transactionId: TX_ID,
        requester: REQUESTER_ADDRESS,
        provider: PROVIDER_ADDRESS,
        amount: BigInt('100000000'),
        state: State.INITIATED,
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: BigInt(7200),
        escrowContract: ESCROW_ADDRESS,
        escrowId: ESCROW_ID,
        serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
      });

      await expect(kernel.transitionState(TX_ID, State.DELIVERED))
        .rejects.toThrow('Invalid state transition');
    });

    it('should reject backwards state transition DELIVERED -> COMMITTED', async () => {
      mockContract.transactions.mockResolvedValueOnce({
        transactionId: TX_ID,
        requester: REQUESTER_ADDRESS,
        provider: PROVIDER_ADDRESS,
        amount: BigInt('100000000'),
        state: State.DELIVERED,
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: BigInt(7200),
        escrowContract: ESCROW_ADDRESS,
        escrowId: ESCROW_ID,
        serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
      });

      await expect(kernel.transitionState(TX_ID, State.COMMITTED))
        .rejects.toThrow('Invalid state transition');
    });

    it('should reject transition to same state', async () => {
      mockContract.transactions.mockResolvedValueOnce({
        transactionId: TX_ID,
        requester: REQUESTER_ADDRESS,
        provider: PROVIDER_ADDRESS,
        amount: BigInt('100000000'),
        state: State.INITIATED,
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: BigInt(7200),
        escrowContract: ESCROW_ADDRESS,
        escrowId: ESCROW_ID,
        serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
      });

      await expect(kernel.transitionState(TX_ID, State.INITIATED))
        .rejects.toThrow('Invalid state transition');
    });

    it('should accept proof data for DELIVERED state', async () => {
      mockContract.getTransaction.mockResolvedValueOnce({
        transactionId: TX_ID,
        requester: REQUESTER_ADDRESS,
        provider: PROVIDER_ADDRESS,
        amount: BigInt('100000000'),
        state: State.IN_PROGRESS,
        createdAt: BigInt(Math.floor(Date.now() / 1000)),
        updatedAt: BigInt(Math.floor(Date.now() / 1000)),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: BigInt(7200),
        escrowContract: ESCROW_ADDRESS,
        escrowId: ESCROW_ID,
        serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        contentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        attestationUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        platformFeeBpsLocked: BigInt(100)
      });

      const abiCoder = AbiCoder.defaultAbiCoder();
      const proofData = abiCoder.encode(
        ['string', 'string'],
        ['https://ipfs.io/ipfs/Qm...', '0x' + '5'.repeat(64)]
      );

      await kernel.transitionState(TX_ID, State.DELIVERED, proofData);

      expect(mockContract.transitionState).toHaveBeenCalledWith(
        TX_ID,
        State.DELIVERED,
        proofData,
        expect.any(Object)
      );
    });

    it('should validate transaction ID format', async () => {
      await expect(kernel.transitionState('invalid-tx-id', State.QUOTED))
        .rejects.toThrow('Invalid transaction ID format');
    });

    it('should throw error when transaction not found', async () => {
      mockContract.getTransaction.mockResolvedValueOnce({
        transactionId: TX_ID,
        requester: REQUESTER_ADDRESS,
        provider: PROVIDER_ADDRESS,
        amount: BigInt('100000000'),
        state: State.INITIATED,
        createdAt: BigInt(0), // Indicates transaction doesn't exist
        updatedAt: BigInt(0),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
        disputeWindow: BigInt(7200),
        escrowContract: ESCROW_ADDRESS,
        escrowId: ESCROW_ID,
        serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        contentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        attestationUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        platformFeeBpsLocked: BigInt(0)
      });

      await expect(kernel.transitionState(TX_ID, State.QUOTED))
        .rejects.toThrow('Transaction');
    });

    it('should handle contract revert errors gracefully', async () => {
      mockContract.transitionState.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Unauthorized caller',
        message: 'execution reverted: Unauthorized caller'
      });

      await expect(kernel.transitionState(TX_ID, State.QUOTED))
        .rejects.toThrow('Transaction reverted');
    });
  });

  describe('linkEscrow - Escrow Integration', () => {
    it('should successfully link escrow', async () => {
      await kernel.linkEscrow(TX_ID, ESCROW_ADDRESS, ESCROW_ID);

      expect(mockContract.linkEscrow).toHaveBeenCalledWith(
        TX_ID,
        ESCROW_ADDRESS,
        ESCROW_ID,
        expect.any(Object)
      );
    });

    it('should reject invalid transaction ID', async () => {
      await expect(kernel.linkEscrow('invalid', ESCROW_ADDRESS, ESCROW_ID))
        .rejects.toThrow('Invalid transaction ID format');
    });

    it('should reject zero address escrow contract', async () => {
      await expect(kernel.linkEscrow(TX_ID, '0x0000000000000000000000000000000000000000', ESCROW_ID))
        .rejects.toThrow('zero address');
    });

    it('should reject invalid escrow ID format', async () => {
      await expect(kernel.linkEscrow(TX_ID, ESCROW_ADDRESS, 'invalid-escrow-id'))
        .rejects.toThrow('Invalid transaction ID format');
    });

    it('should handle link escrow revert', async () => {
      mockContract.linkEscrow.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Escrow already linked',
        message: 'execution reverted: Escrow already linked'
      });

      await expect(kernel.linkEscrow(TX_ID, ESCROW_ADDRESS, ESCROW_ID))
        .rejects.toThrow('Transaction reverted');
    });
  });

  describe('releaseEscrow - Fund Distribution', () => {
    it('should successfully release escrow', async () => {
      await kernel.releaseEscrow(TX_ID);

      expect(mockContract.releaseEscrow).toHaveBeenCalledWith(
        TX_ID,
        expect.any(Object)
      );
    });

    it('should reject invalid transaction ID', async () => {
      await expect(kernel.releaseEscrow('invalid-id'))
        .rejects.toThrow('Invalid transaction ID format');
    });

    it('should handle release revert', async () => {
      mockContract.releaseEscrow.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Not in DELIVERED state',
        message: 'execution reverted: Not in DELIVERED state'
      });

      await expect(kernel.releaseEscrow(TX_ID))
        .rejects.toThrow('Transaction reverted');
    });
  });

  describe('releaseMilestone - Partial Payments', () => {
    it('should successfully release milestone', async () => {
      const milestoneId = 1;
      const amount = BigInt('50000000');

      await kernel.releaseMilestone(TX_ID, milestoneId, amount);

      expect(mockContract.releaseMilestone).toHaveBeenCalledWith(
        TX_ID,
        milestoneId,
        amount,
        expect.any(Object)
      );
    });

    it('should reject negative milestone ID', async () => {
      const amount = BigInt('50000000');

      await expect(kernel.releaseMilestone(TX_ID, -1, amount))
        .rejects.toThrow('cannot be negative');
    });

    it('should reject zero amount', async () => {
      await expect(kernel.releaseMilestone(TX_ID, 1, BigInt(0)))
        .rejects.toThrow('Invalid amount');
    });

    it('should reject invalid transaction ID', async () => {
      await expect(kernel.releaseMilestone('invalid', 1, BigInt('50000000')))
        .rejects.toThrow('Invalid transaction ID format');
    });
  });

  describe('raiseDispute - Dispute Mechanism', () => {
    it('should successfully raise dispute with reason and evidence', async () => {
      const reason = 'Work not delivered as specified';
      const evidence = 'ipfs://Qm...';

      await kernel.raiseDispute(TX_ID, reason, evidence);

      expect(mockContract.transitionState).toHaveBeenCalledWith(
        TX_ID,
        State.DISPUTED,
        expect.any(String), // Encoded proof
        expect.any(Object)
      );
    });

    it('should reject invalid transaction ID', async () => {
      await expect(kernel.raiseDispute('invalid', 'reason', 'evidence'))
        .rejects.toThrow('Invalid transaction ID format');
    });

    it('should encode dispute proof correctly', async () => {
      const reason = 'Test reason';
      const evidence = 'Test evidence';

      await kernel.raiseDispute(TX_ID, reason, evidence);

      const abiCoder = AbiCoder.defaultAbiCoder();
      const expectedProof = abiCoder.encode(
        ['string', 'string'],
        [reason, evidence]
      );

      expect(mockContract.transitionState).toHaveBeenCalledWith(
        TX_ID,
        State.DISPUTED,
        expectedProof,
        expect.any(Object)
      );
    });
  });

  describe('resolveDispute - Dispute Resolution', () => {
    it('should successfully resolve dispute with split', async () => {
      const resolution = {
        requesterAmount: BigInt('30000000'),
        providerAmount: BigInt('60000000'),
        mediatorAmount: BigInt('10000000'),
        mediator: '0x' + 'e'.repeat(40)
      };

      await kernel.resolveDispute(TX_ID, resolution);

      expect(mockContract.transitionState).toHaveBeenCalledWith(
        TX_ID,
        State.SETTLED,
        expect.any(String),
        expect.any(Object)
      );
    });

    it('should reject negative requester amount', async () => {
      const resolution = {
        requesterAmount: BigInt(-1),
        providerAmount: BigInt('60000000'),
        mediatorAmount: BigInt('10000000'),
        mediator: '0x' + 'e'.repeat(40)
      };

      await expect(kernel.resolveDispute(TX_ID, resolution))
        .rejects.toThrow('cannot be negative');
    });

    it('should reject negative provider amount', async () => {
      const resolution = {
        requesterAmount: BigInt('30000000'),
        providerAmount: BigInt(-1),
        mediatorAmount: BigInt('10000000'),
        mediator: '0x' + 'e'.repeat(40)
      };

      await expect(kernel.resolveDispute(TX_ID, resolution))
        .rejects.toThrow('cannot be negative');
    });

    it('should reject negative mediator amount', async () => {
      const resolution = {
        requesterAmount: BigInt('30000000'),
        providerAmount: BigInt('60000000'),
        mediatorAmount: BigInt(-1),
        mediator: '0x' + 'e'.repeat(40)
      };

      await expect(kernel.resolveDispute(TX_ID, resolution))
        .rejects.toThrow('cannot be negative');
    });

    it('should require mediator address when mediator amount > 0', async () => {
      const resolution = {
        requesterAmount: BigInt('30000000'),
        providerAmount: BigInt('60000000'),
        mediatorAmount: BigInt('10000000'),
        mediator: undefined
      };

      await expect(kernel.resolveDispute(TX_ID, resolution))
        .rejects.toThrow('Mediator address required');
    });

    it('should allow zero mediator amount without mediator address', async () => {
      const resolution = {
        requesterAmount: BigInt('50000000'),
        providerAmount: BigInt('50000000'),
        mediatorAmount: BigInt(0),
        mediator: undefined
      };

      await kernel.resolveDispute(TX_ID, resolution);

      expect(mockContract.transitionState).toHaveBeenCalled();
    });
  });

  describe('getTransaction - Data Retrieval', () => {
    it('should retrieve transaction details', async () => {
      const tx = await kernel.getTransaction(TX_ID);

      expect(tx.txId).toBe(TX_ID);
      expect(tx.requester).toBe(REQUESTER_ADDRESS);
      expect(tx.provider).toBe(PROVIDER_ADDRESS);
      expect(tx.state).toBe(State.INITIATED);
    });

    it('should throw error when transaction not found', async () => {
      mockContract.getTransaction.mockResolvedValueOnce({
        transactionId: TX_ID,
        requester: REQUESTER_ADDRESS,
        provider: PROVIDER_ADDRESS,
        amount: BigInt('100000000'),
        state: State.INITIATED,
        createdAt: BigInt(0), // Indicates transaction doesn't exist
        updatedAt: BigInt(0),
        deadline: BigInt(0),
        disputeWindow: BigInt(0),
        escrowContract: '0x0000000000000000000000000000000000000000',
        escrowId: '0x0000000000000000000000000000000000000000000000000000000000000000',
        serviceHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        contentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        attestationUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        platformFeeBpsLocked: BigInt(0)
      });

      await expect(kernel.getTransaction(TX_ID))
        .rejects.toThrow('not found');
    });
  });

  describe('getEconomicParams - Fee Structure', () => {
    it('should retrieve economic parameters', async () => {
      const params = await kernel.getEconomicParams();

      expect(params.baseFeeNumerator).toBe(100); // 1% = 100 bps
      expect(params.baseFeeDenominator).toBe(10000);
      expect(params.requesterPenaltyBps).toBe(500);
      expect(params.feeRecipient).toBe('0x' + 'f'.repeat(40));
    });

    it('should handle array-based response format', async () => {
      mockContract.getEconomicParams.mockResolvedValueOnce([
        BigInt(100),
        BigInt(500),
        '0x' + 'f'.repeat(40)
      ]);

      const params = await kernel.getEconomicParams();

      expect(params.baseFeeNumerator).toBe(100);
    });
  });

  describe('Gas Estimation - V6 Dynamic Buffers', () => {
    it('should apply 15% gas buffer to createTransaction', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      await kernel.createTransaction(params);

      expect(mockContract.createTransaction).toHaveBeenCalledWith(
        PROVIDER_ADDRESS,
        REQUESTER_ADDRESS,
        BigInt('100000000'),
        expect.any(Number),
        7200,
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        expect.objectContaining({
          gasLimit: BigInt(97750) // 85000 * 1.15 (15% buffer for simple state init)
        })
      );
    });

    it('should apply 20% gas buffer to transitionState', async () => {
      const txId = TX_ID;
      const newState = State.QUOTED; // Valid transition from INITIATED → QUOTED

      await kernel.transitionState(txId, newState);

      expect(mockContract.transitionState).toHaveBeenCalledWith(
        txId,
        newState,
        '0x',
        expect.objectContaining({
          gasLimit: BigInt(60000) // 50000 * 1.20 (20% buffer for standard state change)
        })
      );
    });

    it('should apply 30% gas buffer to releaseEscrow', async () => {
      const txId = TX_ID;

      await kernel.releaseEscrow(txId);

      expect(mockContract.releaseEscrow).toHaveBeenCalledWith(
        txId,
        expect.objectContaining({
          gasLimit: BigInt(65000) // 50000 * 1.30 (30% buffer for multi-recipient disbursement)
        })
      );
    });

    it('should apply 30% gas buffer to releaseMilestone', async () => {
      const txId = TX_ID;
      const milestoneId = 1;
      const amount = BigInt('50000000');

      await kernel.releaseMilestone(txId, milestoneId, amount);

      expect(mockContract.releaseMilestone).toHaveBeenCalledWith(
        txId,
        milestoneId,
        amount,
        expect.objectContaining({
          gasLimit: BigInt(58500) // 45000 * 1.30 (30% buffer for escrow release)
        })
      );
    });

    it('should apply gas settings when provided', async () => {
      const gasSettings = {
        maxFeePerGas: BigInt('2000000000'),
        maxPriorityFeePerGas: BigInt('1000000000')
      };

      const kernelWithGas = new ACTPKernel(KERNEL_ADDRESS, mockSigner as any, gasSettings);

      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      await kernelWithGas.createTransaction(params);

      expect(mockContract.createTransaction).toHaveBeenCalledWith(
        PROVIDER_ADDRESS,
        REQUESTER_ADDRESS,
        BigInt('100000000'),
        expect.any(Number),
        7200,
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        expect.objectContaining({
          maxFeePerGas: gasSettings.maxFeePerGas,
          maxPriorityFeePerGas: gasSettings.maxPriorityFeePerGas
        })
      );
    });
  });

  describe('getAddress', () => {
    it('should return kernel contract address', () => {
      expect(kernel.getAddress()).toBe(KERNEL_ADDRESS);
    });
  });

  describe('estimateCreateTransaction', () => {
    it('should estimate gas for transaction creation', async () => {
      const params = {
        provider: PROVIDER_ADDRESS,
        requester: REQUESTER_ADDRESS,
        amount: BigInt('100000000'),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 7200
      };

      const estimatedGas = await kernel.estimateCreateTransaction(params);

      expect(estimatedGas).toEqual(BigInt(85000));
    });
  });
});
