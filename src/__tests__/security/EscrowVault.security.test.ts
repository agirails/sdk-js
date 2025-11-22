/**
 * EscrowVault Security Test Suite
 *
 * CRITICAL: This module handles USDC fund custody
 * Coverage Target: 90%+ (statements, functions, lines), 85%+ (branches)
 *
 * Security Test Categories:
 * 1. Fund Flow Integrity (12 tests)
 * 2. Escrow Release Security (10 tests)
 * 3. Approval Race Condition Mitigation (8 tests)
 *
 * References:
 * - Security Analysis: /Testnet/tests/SDK_SECURITY_ANALYSIS-Ultra-Think.md
 * - V1: EscrowVault Zero Test Coverage vulnerability
 */

import { BigNumber } from 'ethers';
import { EscrowVault } from '../../protocol/EscrowVault';

// Mock ethers Contract
const mockContract = {
  estimateGas: {
    createEscrow: jest.fn().mockResolvedValue(BigNumber.from(100000)),
    disburse: jest.fn().mockResolvedValue(BigNumber.from(80000)),
    approve: jest.fn().mockResolvedValue(BigNumber.from(50000))
  },
  createEscrow: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({
      events: [{
        event: 'EscrowCreated',
        args: { escrowId: '0x' + '1'.repeat(64) }
      }]
    })
  }),
  disburse: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  }),
  escrows: jest.fn().mockResolvedValue({
    kernel: '0x' + '1'.repeat(40),
    txId: '0x' + '2'.repeat(64),
    token: '0x' + '3'.repeat(40),
    amount: BigNumber.from('100000000'), // 100 USDC (6 decimals)
    beneficiary: '0x' + '4'.repeat(40),
    released: false
  }),
  allowance: jest.fn().mockResolvedValue(BigNumber.from(0)),
  balanceOf: jest.fn().mockResolvedValue(BigNumber.from('1000000000')), // 1000 USDC
  approve: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  })
};

// Mock signer
const mockSigner = {
  provider: {},
  getAddress: jest.fn().mockResolvedValue('0x' + 'e'.repeat(40))
};

// Mock Contract constructor
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => mockContract)
  };
});

describe('EscrowVault - Fund Flow Integrity', () => {
  let escrowVault: EscrowVault;

  const ESCROW_ADDRESS = '0x' + 'a'.repeat(40);
  const KERNEL_ADDRESS = '0x' + 'b'.repeat(40);
  const TOKEN_ADDRESS = '0x' + 'c'.repeat(40);
  const BENEFICIARY_ADDRESS = '0x' + 'd'.repeat(40);
  const TX_ID = '0x' + '1'.repeat(64);

  beforeEach(() => {
    jest.clearAllMocks();
    escrowVault = new EscrowVault(ESCROW_ADDRESS, mockSigner as any);
  });

  describe('createEscrow - Fund Safety', () => {
    it('should successfully create escrow with valid parameters', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'), // 100 USDC
        beneficiary: BENEFICIARY_ADDRESS
      };

      const escrowId = await escrowVault.createEscrow(params);

      expect(escrowId).toBe('0x' + '1'.repeat(64));
      expect(mockContract.createEscrow).toHaveBeenCalled();
    });

    it('should reject escrow creation with zero address as kernel', async () => {
      const params = {
        kernelAddress: '0x0000000000000000000000000000000000000000',
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('zero address');
    });

    it('should reject escrow creation with zero address as token', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: '0x0000000000000000000000000000000000000000',
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('zero address');
    });

    it('should reject escrow creation with zero address as beneficiary', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: '0x0000000000000000000000000000000000000000'
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('zero address');
    });

    it('should reject escrow creation with invalid kernel address format', async () => {
      const params = {
        kernelAddress: 'invalid-address',
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('Invalid Ethereum address');
    });

    it('should reject escrow creation with zero amount', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from(0),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('Invalid amount');
    });

    it('should reject escrow creation with negative amount', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from(-1),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('Invalid amount');
    });

    it('should handle minimum USDC amount (0.05 USDC = 50000 wei)', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from(50000), // 0.05 USDC minimum
        beneficiary: BENEFICIARY_ADDRESS
      };

      const escrowId = await escrowVault.createEscrow(params);
      expect(escrowId).toBeTruthy();
    });

    it('should handle large amounts without overflow', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('1000000000000'), // 1M USDC
        beneficiary: BENEFICIARY_ADDRESS
      };

      // Should not throw overflow error
      const escrowId = await escrowVault.createEscrow(params);
      expect(escrowId).toBeTruthy();
    });

    it('should reject invalid transaction ID format', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: 'invalid-tx-id',
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('Invalid transaction ID format');
    });

    it('should handle EscrowCreated event extraction failure gracefully', async () => {
      // Mock contract to return receipt without event
      mockContract.createEscrow.mockResolvedValueOnce({
        wait: jest.fn().mockResolvedValue({
          events: [] // No EscrowCreated event
        })
      });

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('EscrowCreated event not found');
    });

    it('should wrap transaction revert errors with proper context', async () => {
      mockContract.createEscrow.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Insufficient balance',
        message: 'execution reverted: Insufficient balance'
      });

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('Transaction reverted');
    });
  });

  describe('releaseEscrow - Distribution Safety', () => {
    const ESCROW_ID = '0x' + '1'.repeat(64);

    it('should successfully release escrow to single recipient', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigNumber.from('100000000')];

      await escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts);

      expect(mockContract.disburse).toHaveBeenCalledWith(
        ESCROW_ID,
        recipients,
        amounts,
        expect.any(Object)
      );
    });

    it('should successfully release escrow to multiple recipients', async () => {
      const recipients = [
        BENEFICIARY_ADDRESS,
        '0x' + '5'.repeat(40),
        '0x' + '6'.repeat(40)
      ];
      const amounts = [
        BigNumber.from('50000000'), // 50 USDC
        BigNumber.from('30000000'), // 30 USDC
        BigNumber.from('20000000')  // 20 USDC
      ];

      await escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts);

      expect(mockContract.disburse).toHaveBeenCalled();
    });

    it('should reject release with mismatched recipients/amounts length', async () => {
      const recipients = [BENEFICIARY_ADDRESS, '0x' + '5'.repeat(40)];
      const amounts = [BigNumber.from('100000000')]; // Only 1 amount for 2 recipients

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('length mismatch');
    });

    it('should reject release with empty recipients array', async () => {
      const recipients: string[] = [];
      const amounts: BigNumber[] = [];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('at least one recipient');
    });

    it('should reject release with zero address recipient', async () => {
      const recipients = ['0x0000000000000000000000000000000000000000'];
      const amounts = [BigNumber.from('100000000')];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('zero address');
    });

    it('should reject release with zero amount', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigNumber.from(0)];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Invalid amount');
    });

    it('should reject release with negative amount', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigNumber.from(-1)];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Invalid amount');
    });

    it('should reject release with invalid escrow ID format', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigNumber.from('100000000')];

      await expect(escrowVault.releaseEscrow('invalid-id', recipients, amounts))
        .rejects.toThrow('Invalid transaction ID format');
    });

    it('should handle disbursement transaction revert', async () => {
      mockContract.disburse.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Escrow already released',
        message: 'execution reverted: Escrow already released'
      });

      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigNumber.from('100000000')];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Transaction reverted');
    });

    it('should validate all recipients in array', async () => {
      const recipients = [
        BENEFICIARY_ADDRESS,
        'invalid-address', // Invalid address
        '0x' + '6'.repeat(40)
      ];
      const amounts = [
        BigNumber.from('50000000'),
        BigNumber.from('30000000'),
        BigNumber.from('20000000')
      ];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Invalid Ethereum address');
    });
  });

  describe('approveToken - Race Condition Mitigation', () => {
    it('should check current allowance before approving', async () => {
      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await escrowVault.createEscrow(params);

      // Should have checked allowance
      expect(mockContract.allowance).toHaveBeenCalled();
    });

    it('should reset approval to zero before setting new value (USDC pattern)', async () => {
      // Mock existing allowance
      mockContract.allowance.mockResolvedValueOnce(BigNumber.from('50000000'));

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await escrowVault.createEscrow(params);

      // Should approve twice (reset to 0, then set amount)
      expect(mockContract.approve).toHaveBeenCalledTimes(2);
    });

    it('should skip approval if current allowance is sufficient', async () => {
      // Mock sufficient allowance
      mockContract.allowance.mockResolvedValueOnce(BigNumber.from('200000000'));

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await escrowVault.createEscrow(params);

      // Should NOT call approve if allowance is sufficient
      expect(mockContract.approve).not.toHaveBeenCalled();
    });

    it('should handle approval failure gracefully', async () => {
      mockContract.approve.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Approval failed',
        message: 'execution reverted: Approval failed'
      });

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await expect(escrowVault.createEscrow(params)).rejects.toThrow('Token approval failed');
    });

    it('should only approve if current allowance is less than required amount', async () => {
      // Mock allowance exactly equal to amount
      mockContract.allowance.mockResolvedValueOnce(BigNumber.from('100000000'));

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await escrowVault.createEscrow(params);

      // Should NOT approve if allowance equals amount
      expect(mockContract.approve).not.toHaveBeenCalled();
    });

    it('should estimate gas for both reset and set approval', async () => {
      mockContract.allowance.mockResolvedValueOnce(BigNumber.from('50000000'));

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await escrowVault.createEscrow(params);

      // Should estimate gas twice (reset + set)
      expect(mockContract.estimateGas.approve).toHaveBeenCalledTimes(2);
    });

    it('should wait for reset approval before setting new approval', async () => {
      mockContract.allowance.mockResolvedValueOnce(BigNumber.from('50000000'));

      const waitMock = jest.fn().mockResolvedValue({});
      mockContract.approve.mockResolvedValue({ wait: waitMock });

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await escrowVault.createEscrow(params);

      // Should wait twice (reset + set)
      expect(waitMock).toHaveBeenCalledTimes(2);
    });

    it('should include gas settings in approval transactions', async () => {
      const gasSettings = {
        maxFeePerGas: BigNumber.from('2000000000'), // 2 gwei
        maxPriorityFeePerGas: BigNumber.from('1000000000') // 1 gwei
      };

      const vaultWithGas = new EscrowVault(ESCROW_ADDRESS, mockSigner as any, gasSettings);

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await vaultWithGas.createEscrow(params);

      // Should pass gas settings to transactions
      expect(mockContract.createEscrow).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({
          gasLimit: expect.any(Object),
          maxFeePerGas: gasSettings.maxFeePerGas,
          maxPriorityFeePerGas: gasSettings.maxPriorityFeePerGas
        })
      );
    });
  });

  describe('getEscrow - Data Retrieval', () => {
    it('should retrieve escrow details correctly', async () => {
      const ESCROW_ID = '0x' + '1'.repeat(64);

      const escrow = await escrowVault.getEscrow(ESCROW_ID);

      expect(escrow.escrowId).toBe(ESCROW_ID);
      expect(escrow.kernel).toBe('0x' + '1'.repeat(40));
      expect(escrow.txId).toBe('0x' + '2'.repeat(64));
      expect(escrow.token).toBe('0x' + '3'.repeat(40));
      expect(escrow.amount).toEqual(BigNumber.from('100000000'));
      expect(escrow.beneficiary).toBe('0x' + '4'.repeat(40));
      expect(escrow.released).toBe(false);
    });

    it('should get escrow balance', async () => {
      const ESCROW_ID = '0x' + '1'.repeat(64);

      const balance = await escrowVault.getEscrowBalance(ESCROW_ID);

      expect(balance).toEqual(BigNumber.from('100000000'));
    });
  });

  describe('Token Helper Methods', () => {
    it('should get token balance for account', async () => {
      const USER_ADDRESS = '0x' + 'e'.repeat(40);
      const balance = await escrowVault.getTokenBalance(TOKEN_ADDRESS, USER_ADDRESS);

      expect(balance).toEqual(BigNumber.from('1000000000'));
      expect(mockContract.balanceOf).toHaveBeenCalledWith(USER_ADDRESS);
    });

    it('should get token allowance', async () => {
      const USER_ADDRESS = '0x' + 'e'.repeat(40);
      await escrowVault.getTokenAllowance(
        TOKEN_ADDRESS,
        USER_ADDRESS,
        ESCROW_ADDRESS
      );

      expect(mockContract.allowance).toHaveBeenCalledWith(USER_ADDRESS, ESCROW_ADDRESS);
    });
  });

  describe('Gas Estimation - V6 Dynamic Buffers', () => {
    it('should apply 30% gas buffer to createEscrow', async () => {
      mockContract.estimateGas.createEscrow.mockResolvedValueOnce(BigNumber.from(100000));

      const params = {
        kernelAddress: KERNEL_ADDRESS,
        txId: TX_ID,
        token: TOKEN_ADDRESS,
        amount: BigNumber.from('100000000'),
        beneficiary: BENEFICIARY_ADDRESS
      };

      await escrowVault.createEscrow(params);

      // Should call with gasLimit = estimatedGas * 1.3 (30% buffer for external token transfer)
      expect(mockContract.createEscrow).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({
          gasLimit: BigNumber.from(130000) // 100000 * 1.30
        })
      );
    });

    it('should apply 30% gas buffer to releaseEscrow', async () => {
      mockContract.estimateGas.disburse.mockResolvedValueOnce(BigNumber.from(80000));

      const ESCROW_ID = '0x' + '1'.repeat(64);
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigNumber.from('100000000')];

      await escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts);

      expect(mockContract.disburse).toHaveBeenCalledWith(
        ESCROW_ID,
        recipients,
        amounts,
        expect.objectContaining({
          gasLimit: BigNumber.from(104000) // 80000 * 1.30 (30% buffer for multi-recipient disbursement)
        })
      );
    });
  });

  describe('getAddress', () => {
    it('should return escrow vault address', () => {
      expect(escrowVault.getAddress()).toBe(ESCROW_ADDRESS);
    });
  });
});
