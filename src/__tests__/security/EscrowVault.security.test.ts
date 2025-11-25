/**
 * EscrowVault Security Test Suite
 *
 * CRITICAL: This module prepares token approvals for escrow creation.
 * Actual escrow creation happens in ACTPKernel.linkEscrow() (tested in ACTPKernel integration tests).
 *
 * Per AIP-3 specification, escrow creation is atomic inside Kernel.linkEscrow(),
 * not a separate EscrowVault SDK call. This test suite validates:
 * 1. Token approval safety (USDC race condition mitigation)
 * 2. Escrow release security (multi-recipient disbursement)
 *
 * Coverage Target: 90%+ (statements, functions, lines), 85%+ (branches)
 *
 * Security Test Categories:
 * 1. Token Approval Safety (10+ tests) - Pre-escrow USDC approval
 * 2. Escrow Release Security (10 tests) - Post-settlement disbursement
 * 3. USDC Race Condition Mitigation (5+ tests) - Reset-to-zero pattern
 * 4. Gas Estimation Buffers (2+ tests) - Dynamic gas buffers
 *
 * References:
 * - Security Analysis: /Testnet/tests/SDK_SECURITY_ANALYSIS-Ultra-Think.md
 * - AIP-3 §3.2: Escrow Linking Workflow
 */

import { EscrowVault } from '../../protocol/EscrowVault';

// Mock ethers Contract
const mockContract = {
  estimateGas: {
    disburse: jest.fn().mockResolvedValue(BigInt(80000)),
    approve: jest.fn().mockResolvedValue(BigInt(50000))
  },
  disburse: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  }),
  escrows: jest.fn().mockResolvedValue({
    kernel: '0x' + '1'.repeat(40),
    txId: '0x' + '2'.repeat(64),
    token: '0x' + '3'.repeat(40),
    amount: BigInt('100000000'), // 100 USDC (6 decimals)
    beneficiary: '0x' + '4'.repeat(40),
    released: false
  }),
  allowance: jest.fn().mockResolvedValue(BigInt(0)),
  balanceOf: jest.fn().mockResolvedValue(BigInt('1000000000')), // 1000 USDC
  approve: jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  }),
  // ethers v6 requires getFunction
  getFunction: jest.fn((name: string) => {
    const functions: any = {
      disburse: mockContract.disburse,
      approve: mockContract.approve,
      estimateGas: jest.fn().mockResolvedValue(BigInt(100000))
    };
    const func = functions[name] || jest.fn();
    const estimateGasMap: any = mockContract.estimateGas;
    func.estimateGas = estimateGasMap[name] || jest.fn().mockResolvedValue(BigInt(100000));
    return func;
  }),
  // ethers v6: interface.parseLog for event parsing
  interface: {
    parseLog: jest.fn((_log: any) => ({
      name: 'EscrowCreated',
      args: { escrowId: '0x' + '1'.repeat(64) }
    }))
  }
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
  const TOKEN_ADDRESS = '0x' + 'c'.repeat(40);
  const BENEFICIARY_ADDRESS = '0x' + 'd'.repeat(40);

  beforeEach(() => {
    jest.clearAllMocks();
    escrowVault = new EscrowVault(ESCROW_ADDRESS, mockSigner as any);
  });

  describe('approveToken - Token Approval Safety', () => {
    // NOTE: These tests cover PRE-escrow workflow (USDC approval).
    // Escrow linking atomicity (approve → Kernel.linkEscrow → state transition)
    // is tested in ACTPKernel integration tests.

    it('should successfully approve token with valid parameters', async () => {
      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      expect(mockContract.approve).toHaveBeenCalledWith(
        ESCROW_ADDRESS,
        BigInt('100000000'),
        expect.objectContaining({
          gasLimit: expect.any(BigInt)
        })
      );
    });

    it('should reject approval with zero address as token', async () => {
      await expect(
        escrowVault.approveToken('0x0000000000000000000000000000000000000000', BigInt('100000000'))
      ).rejects.toThrow('zero address');
    });

    it('should reject approval with invalid token address format', async () => {
      await expect(
        escrowVault.approveToken('invalid-address', BigInt('100000000'))
      ).rejects.toThrow('Invalid Ethereum address');
    });

    it('should reject approval with zero amount', async () => {
      await expect(
        escrowVault.approveToken(TOKEN_ADDRESS, BigInt(0))
      ).rejects.toThrow('Invalid amount');
    });

    it('should reject approval with negative amount', async () => {
      await expect(
        escrowVault.approveToken(TOKEN_ADDRESS, BigInt(-1))
      ).rejects.toThrow('Invalid amount');
    });

    it('should handle minimum USDC amount (0.05 USDC = 50000 wei)', async () => {
      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt(50000));

      expect(mockContract.approve).toHaveBeenCalledWith(
        ESCROW_ADDRESS,
        BigInt(50000), // 0.05 USDC minimum
        expect.objectContaining({
          gasLimit: expect.any(BigInt)
        })
      );
    });

    it('should handle large amounts without overflow', async () => {
      // Should not throw overflow error
      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('1000000000000'));

      expect(mockContract.approve).toHaveBeenCalledWith(
        ESCROW_ADDRESS,
        BigInt('1000000000000'), // 1M USDC
        expect.objectContaining({
          gasLimit: expect.any(BigInt)
        })
      );
    });

    it('should check current allowance before approving', async () => {
      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should have checked allowance
      expect(mockContract.allowance).toHaveBeenCalled();
    });

    it('should skip approval if current allowance is sufficient', async () => {
      // Mock sufficient allowance
      mockContract.allowance.mockResolvedValueOnce(BigInt('200000000'));

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should NOT call approve if allowance is sufficient
      expect(mockContract.approve).not.toHaveBeenCalled();
    });

    it('should wrap transaction revert errors with proper context', async () => {
      mockContract.approve.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Approval failed',
        message: 'execution reverted: Approval failed'
      });

      await expect(
        escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'))
      ).rejects.toThrow('Token approval failed');
    });

    it('should skip approval if current allowance exceeds required amount', async () => {
      // Mock allowance greater than required
      mockContract.allowance.mockResolvedValueOnce(BigInt('200000000')); // 200 USDC

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000')); // Need 100 USDC

      // Should skip approval entirely
      expect(mockContract.approve).not.toHaveBeenCalled();
    });

    it('should use explicit 20% gas buffer for approveToken operation', async () => {
      // This test verifies explicit buffer for approveToken (not default)
      mockContract.allowance.mockResolvedValueOnce(BigInt(0));

      // estimateGas returns 50000
      mockContract.getFunction('approve').estimateGas.mockResolvedValueOnce(BigInt(50000));

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      const approveCall = mockContract.approve.mock.calls[0];
      const gasLimit = approveCall[2].gasLimit;

      // 50000 * 1.20 = 60000 (approveToken uses explicit 20% buffer)
      expect(gasLimit).toBe(BigInt(60000));
    });

    it('should wrap approval transaction errors with context', async () => {
      mockContract.allowance.mockResolvedValueOnce(BigInt(0));

      // Mock approve() rejecting with transaction error
      mockContract.approve.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        reason: 'Insufficient funds'
      });

      await expect(
        escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'))
      ).rejects.toThrow('Token approval failed: Insufficient funds');
    });

    it('should handle USDC approval returning false instead of reverting', async () => {
      mockContract.allowance.mockResolvedValueOnce(BigInt(0));

      // Mock approve() returning transaction that fails on wait()
      // This simulates USDC returning false instead of reverting
      mockContract.approve.mockResolvedValueOnce({
        wait: jest.fn().mockRejectedValue(new Error('Transaction failed: status 0'))
      });

      // SDK should detect failed transaction and throw
      await expect(
        escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'))
      ).rejects.toThrow('Token approval failed');
    });
  });

  describe('releaseEscrow - Distribution Safety', () => {
    const ESCROW_ID = '0x' + '1'.repeat(64);

    it('should successfully release escrow to single recipient', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigInt('100000000')];

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
        BigInt('50000000'), // 50 USDC
        BigInt('30000000'), // 30 USDC
        BigInt('20000000')  // 20 USDC
      ];

      await escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts);

      expect(mockContract.disburse).toHaveBeenCalled();
    });

    it('should reject release with mismatched recipients/amounts length', async () => {
      const recipients = [BENEFICIARY_ADDRESS, '0x' + '5'.repeat(40)];
      const amounts = [BigInt('100000000')]; // Only 1 amount for 2 recipients

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('length mismatch');
    });

    it('should reject release with empty recipients array', async () => {
      const recipients: string[] = [];
      const amounts: bigint[] = [];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('at least one recipient');
    });

    it('should reject release with zero address recipient', async () => {
      const recipients = ['0x0000000000000000000000000000000000000000'];
      const amounts = [BigInt('100000000')];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('zero address');
    });

    it('should reject release with zero amount', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigInt(0)];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Invalid amount');
    });

    it('should reject release with negative amount', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigInt(-1)];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Invalid amount');
    });

    it('should reject release with invalid escrow ID format', async () => {
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigInt('100000000')];

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
      const amounts = [BigInt('100000000')];

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
        BigInt('50000000'),
        BigInt('30000000'),
        BigInt('20000000')
      ];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Invalid Ethereum address');
    });
  });

  describe('approveToken - USDC Race Condition Mitigation', () => {
    it('should reset approval to zero before setting new value (USDC pattern)', async () => {
      // Mock existing allowance
      mockContract.allowance.mockResolvedValueOnce(BigInt('50000000'));

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should approve twice (reset to 0, then set amount)
      expect(mockContract.approve).toHaveBeenCalledTimes(2);
    });

    it('should only approve if current allowance is less than required amount', async () => {
      // Mock allowance exactly equal to amount
      mockContract.allowance.mockResolvedValueOnce(BigInt('100000000'));

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should NOT approve if allowance equals amount
      expect(mockContract.approve).not.toHaveBeenCalled();
    });

    it('should estimate gas for both reset and set approval', async () => {
      mockContract.allowance.mockResolvedValueOnce(BigInt('50000000'));

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should estimate gas twice (reset + set)
      expect(mockContract.estimateGas.approve).toHaveBeenCalledTimes(2);
    });

    it('should wait for reset approval before setting new approval', async () => {
      mockContract.allowance.mockResolvedValueOnce(BigInt('50000000'));

      const waitMock = jest.fn().mockResolvedValue({});
      mockContract.approve.mockResolvedValue({ wait: waitMock });

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should wait twice (reset + set)
      expect(waitMock).toHaveBeenCalledTimes(2);
    });

    it('should include gas settings in approval transactions', async () => {
      const gasSettings = {
        maxFeePerGas: BigInt('2000000000'), // 2 gwei
        maxPriorityFeePerGas: BigInt('1000000000') // 1 gwei
      };

      const vaultWithGas = new EscrowVault(ESCROW_ADDRESS, mockSigner as any, gasSettings);

      await vaultWithGas.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should pass gas settings to approval transactions
      expect(mockContract.approve).toHaveBeenCalledWith(
        ESCROW_ADDRESS,
        BigInt('100000000'),
        expect.objectContaining({
          gasLimit: expect.any(BigInt),
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
      expect(escrow.amount).toEqual(BigInt('100000000'));
      expect(escrow.beneficiary).toBe('0x' + '4'.repeat(40));
      expect(escrow.released).toBe(false);
    });

    it('should get escrow balance', async () => {
      const ESCROW_ID = '0x' + '1'.repeat(64);

      const balance = await escrowVault.getEscrowBalance(ESCROW_ID);

      expect(balance).toEqual(BigInt('100000000'));
    });
  });

  describe('Token Helper Methods', () => {
    it('should get token balance for account', async () => {
      const USER_ADDRESS = '0x' + 'e'.repeat(40);
      const balance = await escrowVault.getTokenBalance(TOKEN_ADDRESS, USER_ADDRESS);

      expect(balance).toEqual(BigInt('1000000000'));
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
    it('should apply 20% gas buffer to approveToken', async () => {
      mockContract.estimateGas.approve.mockResolvedValueOnce(BigInt(50000));

      await escrowVault.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should call with gasLimit = estimatedGas * 1.2 (20% buffer for ERC20 approval)
      expect(mockContract.approve).toHaveBeenCalledWith(
        ESCROW_ADDRESS,
        BigInt('100000000'),
        expect.objectContaining({
          gasLimit: BigInt(60000) // 50000 * 1.20
        })
      );
    });

    it('should apply 30% gas buffer to releaseEscrow', async () => {
      mockContract.estimateGas.disburse.mockResolvedValueOnce(BigInt(80000));

      const ESCROW_ID = '0x' + '1'.repeat(64);
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigInt('100000000')];

      await escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts);

      expect(mockContract.disburse).toHaveBeenCalledWith(
        ESCROW_ID,
        recipients,
        amounts,
        expect.objectContaining({
          gasLimit: BigInt(104000) // 80000 * 1.30 (30% buffer for multi-recipient disbursement)
        })
      );
    });

    it('should build transaction options without gas settings', async () => {
      // Create vault without gas settings
      const vaultNoGas = new EscrowVault(ESCROW_ADDRESS, mockSigner as any);

      mockContract.estimateGas.approve.mockResolvedValueOnce(BigInt(50000));

      await vaultNoGas.approveToken(TOKEN_ADDRESS, BigInt('100000000'));

      // Should only include gasLimit, no maxFeePerGas or maxPriorityFeePerGas
      expect(mockContract.approve).toHaveBeenCalledWith(
        ESCROW_ADDRESS,
        BigInt('100000000'),
        expect.objectContaining({
          gasLimit: BigInt(60000) // 50000 * 1.20
        })
      );

      // Verify gas settings are NOT included
      const approveCall = mockContract.approve.mock.calls[0];
      expect(approveCall[2]).not.toHaveProperty('maxFeePerGas');
      expect(approveCall[2]).not.toHaveProperty('maxPriorityFeePerGas');
    });

    it('should handle releaseEscrow error without reason field', async () => {
      mockContract.disburse.mockRejectedValueOnce({
        transactionHash: '0x' + 'f'.repeat(64),
        message: 'Transaction failed'
        // No 'reason' field
      });

      const ESCROW_ID = '0x' + '1'.repeat(64);
      const recipients = [BENEFICIARY_ADDRESS];
      const amounts = [BigInt('100000000')];

      await expect(escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts))
        .rejects.toThrow('Transaction failed');
    });

    it('should use correct buffer for releaseEscrow operation (30%)', async () => {
      const ESCROW_ID = '0x' + '1'.repeat(64);
      const recipients = [BENEFICIARY_ADDRESS, '0x' + '5'.repeat(40)];
      const amounts = [BigInt('60000000'), BigInt('40000000')];

      mockContract.estimateGas.disburse.mockResolvedValueOnce(BigInt(100000));

      await escrowVault.releaseEscrow(ESCROW_ID, recipients, amounts);

      // Should use 30% buffer for releaseEscrow (multi-recipient complexity)
      expect(mockContract.disburse).toHaveBeenCalledWith(
        ESCROW_ID,
        recipients,
        amounts,
        expect.objectContaining({
          gasLimit: BigInt(130000) // 100000 * 1.30
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
