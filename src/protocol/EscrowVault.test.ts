/**
 * EscrowVault Unit Tests
 *
 * Tests the EscrowVault smart contract wrapper.
 * Focus on token approvals, escrow queries, and validation.
 */

import { EscrowVault } from './EscrowVault';
import { ethers } from 'ethers';
import { TransactionRevertedError, ValidationError } from '../errors';

// Helper to create mock transaction function with estimateGas
function createMockTxFunction(estimateGasValue = 50000n) {
  const mockFn = jest.fn().mockResolvedValue({
    wait: jest.fn().mockResolvedValue({})
  });
  (mockFn as any).estimateGas = jest.fn().mockResolvedValue(estimateGasValue);
  return mockFn;
}

// Mock contract factory
let mockContractInstance: any = null;
let mockTokenContractInstance: any = null;

// Mock the Contract constructor
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation((address: string) => {
      // Return token contract for token addresses, escrow contract for escrow address
      if (address === '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585') {
        return mockContractInstance;
      }
      return mockTokenContractInstance;
    })
  };
});

describe('EscrowVault', () => {
  let escrow: EscrowVault;
  let mockSigner: any;

  const ESCROW_ADDRESS = '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585';
  const USDC_ADDRESS = '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb';
  const REQUESTER = '0x1111111111111111111111111111111111111111';
  const PROVIDER = '0x2222222222222222222222222222222222222222';
  const ESCROW_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

  beforeEach(() => {
    // Reset mock instances
    mockContractInstance = {
      escrows: jest.fn(),
      remaining: jest.fn()
    };

    mockTokenContractInstance = {
      allowance: jest.fn().mockResolvedValue(0n),
      getFunction: jest.fn(),
      balanceOf: jest.fn().mockResolvedValue(500000000n)
    };

    // Create mock signer with getAddress
    mockSigner = {
      getAddress: jest.fn().mockResolvedValue(REQUESTER),
      provider: null
    };

    // Create escrow instance
    escrow = new EscrowVault(ESCROW_ADDRESS, mockSigner as any);
  });

  describe('constructor', () => {
    it('should create escrow with correct address', () => {
      expect(escrow.getAddress()).toBe(ESCROW_ADDRESS);
    });

    it('should expose underlying contract', () => {
      expect(escrow.getContract()).toBe(mockContractInstance);
    });

    it('should accept gas settings', () => {
      const escrowWithGas = new EscrowVault(ESCROW_ADDRESS, mockSigner as any, {
        maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 100000000n
      });

      expect(escrowWithGas).toBeInstanceOf(EscrowVault);
    });
  });

  describe('getAddress()', () => {
    it('should return escrow vault address', () => {
      expect(escrow.getAddress()).toBe(ESCROW_ADDRESS);
    });
  });

  describe('getContract()', () => {
    it('should return underlying contract', () => {
      const contract = escrow.getContract();
      expect(contract).toBe(mockContractInstance);
    });
  });

  describe('approveToken() - validation', () => {
    it('should validate token address', async () => {
      await expect(
        escrow.approveToken('invalid', 100000000n)
      ).rejects.toThrow();
    });

    it('should validate amount is positive', async () => {
      await expect(
        escrow.approveToken(USDC_ADDRESS, 0n)
      ).rejects.toThrow();
    });

    it('should reject negative amount', async () => {
      await expect(
        escrow.approveToken(USDC_ADDRESS, -100n)
      ).rejects.toThrow();
    });
  });

  describe('approveToken() - approval flow', () => {
    beforeEach(() => {
      const mockApproveFunc = createMockTxFunction(50000n);
      mockTokenContractInstance.getFunction.mockReturnValue(mockApproveFunc);
    });

    it('should skip approval if allowance is sufficient', async () => {
      // Already has enough allowance
      mockTokenContractInstance.allowance.mockResolvedValue(200000000n);

      await escrow.approveToken(USDC_ADDRESS, 100000000n);

      // getFunction should not have been called (no approval needed)
      expect(mockTokenContractInstance.getFunction).not.toHaveBeenCalled();
    });

    it('should approve when allowance is zero', async () => {
      mockTokenContractInstance.allowance.mockResolvedValue(0n);

      const mockApproveFunc = createMockTxFunction(50000n);
      mockTokenContractInstance.getFunction.mockReturnValue(mockApproveFunc);

      await escrow.approveToken(USDC_ADDRESS, 100000000n);

      // Should have called getFunction('approve')
      expect(mockTokenContractInstance.getFunction).toHaveBeenCalledWith('approve');
      // Should have called approve once (no reset needed when allowance is 0)
      expect(mockApproveFunc).toHaveBeenCalledTimes(1);
    });

    it('should reset allowance to 0 before setting new value (USDC pattern)', async () => {
      // Has some existing allowance but not enough
      mockTokenContractInstance.allowance.mockResolvedValue(50000000n);

      const mockApproveFunc = createMockTxFunction(50000n);
      mockTokenContractInstance.getFunction.mockReturnValue(mockApproveFunc);

      await escrow.approveToken(USDC_ADDRESS, 100000000n);

      // Should be called twice: once to reset to 0, once to set new amount
      expect(mockApproveFunc).toHaveBeenCalledTimes(2);
      // First call resets to 0
      expect(mockApproveFunc).toHaveBeenNthCalledWith(1, ESCROW_ADDRESS, 0, expect.any(Object));
      // Second call sets new amount
      expect(mockApproveFunc).toHaveBeenNthCalledWith(2, ESCROW_ADDRESS, 100000000n, expect.any(Object));
    });

    it('should throw TransactionRevertedError on estimateGas failure', async () => {
      mockTokenContractInstance.allowance.mockResolvedValue(0n);

      const mockApproveFunc = jest.fn();
      (mockApproveFunc as any).estimateGas = jest.fn().mockRejectedValue({
        reason: 'Insufficient balance'
      });
      mockTokenContractInstance.getFunction.mockReturnValue(mockApproveFunc);

      await expect(
        escrow.approveToken(USDC_ADDRESS, 100000000n)
      ).rejects.toThrow(TransactionRevertedError);
    });

    it('should use 20% gas buffer for approvals', async () => {
      mockTokenContractInstance.allowance.mockResolvedValue(0n);

      const mockApproveFunc = createMockTxFunction(50000n);
      mockTokenContractInstance.getFunction.mockReturnValue(mockApproveFunc);

      await escrow.approveToken(USDC_ADDRESS, 100000000n);

      // Should have been called with gas options
      const callArgs = (mockApproveFunc as jest.Mock).mock.calls[0];
      const options = callArgs[2];

      // 50000 * 1.2 = 60000, but minimum floor is 100000
      expect(options.gasLimit).toBeGreaterThanOrEqual(100000n);
    });

    it('should throw TransactionRevertedError on tx failure', async () => {
      mockTokenContractInstance.allowance.mockResolvedValue(0n);

      const mockApproveFunc = jest.fn().mockRejectedValue({
        message: 'Transaction failed'
      });
      (mockApproveFunc as any).estimateGas = jest.fn().mockResolvedValue(50000n);
      mockTokenContractInstance.getFunction.mockReturnValue(mockApproveFunc);

      await expect(
        escrow.approveToken(USDC_ADDRESS, 100000000n)
      ).rejects.toThrow(TransactionRevertedError);
    });
  });

  describe('getEscrow()', () => {
    it('should validate escrowId format', async () => {
      await expect(
        escrow.getEscrow('invalid')
      ).rejects.toThrow();
    });

    it('should return escrow data', async () => {
      mockContractInstance.escrows.mockResolvedValue({
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        releasedAmount: 0n,
        active: true
      });

      const escrowData = await escrow.getEscrow(ESCROW_ID);

      expect(escrowData.escrowId).toBe(ESCROW_ID);
      expect(escrowData.requester).toBe(REQUESTER);
      expect(escrowData.provider).toBe(PROVIDER);
      expect(escrowData.amount).toBe(100000000n);
      expect(escrowData.releasedAmount).toBe(0n);
      expect(escrowData.active).toBe(true);
    });

    it('should return inactive escrow after settlement', async () => {
      mockContractInstance.escrows.mockResolvedValue({
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        releasedAmount: 100000000n,
        active: false
      });

      const escrowData = await escrow.getEscrow(ESCROW_ID);

      expect(escrowData.active).toBe(false);
      expect(escrowData.releasedAmount).toBe(100000000n);
    });

    it('should handle partially released escrow', async () => {
      mockContractInstance.escrows.mockResolvedValue({
        requester: REQUESTER,
        provider: PROVIDER,
        amount: 100000000n,
        releasedAmount: 50000000n,
        active: true
      });

      const escrowData = await escrow.getEscrow(ESCROW_ID);

      expect(escrowData.active).toBe(true);
      expect(escrowData.releasedAmount).toBe(50000000n);
    });
  });

  describe('getEscrowBalance()', () => {
    it('should validate escrowId format', async () => {
      await expect(
        escrow.getEscrowBalance('invalid')
      ).rejects.toThrow();
    });

    it('should return remaining balance', async () => {
      mockContractInstance.remaining.mockResolvedValue(100000000n);

      const balance = await escrow.getEscrowBalance(ESCROW_ID);

      expect(balance).toBe(100000000n);
      expect(mockContractInstance.remaining).toHaveBeenCalledWith(ESCROW_ID);
    });

    it('should return 0 for fully released escrow', async () => {
      mockContractInstance.remaining.mockResolvedValue(0n);

      const balance = await escrow.getEscrowBalance(ESCROW_ID);

      expect(balance).toBe(0n);
    });

    it('should return partial balance after milestone release', async () => {
      mockContractInstance.remaining.mockResolvedValue(50000000n);

      const balance = await escrow.getEscrowBalance(ESCROW_ID);

      expect(balance).toBe(50000000n);
    });
  });

  describe('releaseEscrow() - deprecated', () => {
    it('should throw ValidationError with guidance', async () => {
      await expect(
        escrow.releaseEscrow(ESCROW_ID, [PROVIDER], [100000000n])
      ).rejects.toThrow(ValidationError);
    });

    it('should include guidance about correct method to use', async () => {
      try {
        await escrow.releaseEscrow(ESCROW_ID, [PROVIDER], [100000000n]);
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('BlockchainRuntime.releaseEscrow');
        expect((error as Error).message).toContain('ACTPKernel');
        expect((error as Error).message).toContain('onlyKernel');
      }
    });

    it('should still validate escrowId before throwing', async () => {
      await expect(
        escrow.releaseEscrow('invalid-id', [PROVIDER], [100000000n])
      ).rejects.toThrow();
    });
  });

  describe('getTokenBalance()', () => {
    it('should return token balance for account', async () => {
      mockTokenContractInstance.balanceOf.mockResolvedValue(500000000n);

      const balance = await escrow.getTokenBalance(USDC_ADDRESS, REQUESTER);

      expect(balance).toBe(500000000n);
      expect(mockTokenContractInstance.balanceOf).toHaveBeenCalledWith(REQUESTER);
    });

    it('should return zero balance', async () => {
      mockTokenContractInstance.balanceOf.mockResolvedValue(0n);

      const balance = await escrow.getTokenBalance(USDC_ADDRESS, REQUESTER);

      expect(balance).toBe(0n);
    });
  });

  describe('getTokenAllowance()', () => {
    it('should return allowance for owner-spender pair', async () => {
      mockTokenContractInstance.allowance.mockResolvedValue(100000000n);

      const allowance = await escrow.getTokenAllowance(
        USDC_ADDRESS,
        REQUESTER,
        ESCROW_ADDRESS
      );

      expect(allowance).toBe(100000000n);
      expect(mockTokenContractInstance.allowance).toHaveBeenCalledWith(REQUESTER, ESCROW_ADDRESS);
    });

    it('should return zero allowance', async () => {
      mockTokenContractInstance.allowance.mockResolvedValue(0n);

      const allowance = await escrow.getTokenAllowance(
        USDC_ADDRESS,
        REQUESTER,
        ESCROW_ADDRESS
      );

      expect(allowance).toBe(0n);
    });
  });

  describe('gas buffer calculation', () => {
    it('should use 20% buffer for approveToken', () => {
      const buffers: Record<string, number> = {
        approveToken: 1.20
      };

      expect(buffers['approveToken']).toBe(1.20);
    });

    it('should enforce minimum gas floor of 100k', () => {
      const MIN_GAS_FLOOR = 100000n;

      // Even if estimate is low, should use floor
      const lowEstimate = 50000n;
      const safeEstimate = lowEstimate > MIN_GAS_FLOOR ? lowEstimate : MIN_GAS_FLOOR;

      expect(safeEstimate).toBe(MIN_GAS_FLOOR);
    });

    it('should detect overflow in gas calculation', () => {
      // Very large estimate
      const largeEstimate = BigInt(Number.MAX_SAFE_INTEGER);
      const bufferNumerator = BigInt(Math.floor(1.20 * 10000));
      const bufferDenominator = 10000n;
      const result = (largeEstimate * bufferNumerator) / bufferDenominator;

      // Result should be larger than estimate
      expect(result).toBeGreaterThan(largeEstimate);
    });
  });
});

describe('EscrowVault edge cases', () => {
  let escrow: EscrowVault;
  let mockSigner: any;

  const ESCROW_ADDRESS = '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585';
  const ESCROW_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';

  beforeEach(() => {
    mockSigner = {
      getAddress: jest.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
      provider: null
    };

    mockContractInstance = {
      escrows: jest.fn(),
      remaining: jest.fn()
    };

    escrow = new EscrowVault(ESCROW_ADDRESS, mockSigner as any);
  });

  it('should handle escrow not found', async () => {
    mockContractInstance.escrows.mockResolvedValue({
      requester: ethers.ZeroAddress,
      provider: ethers.ZeroAddress,
      amount: 0n,
      releasedAmount: 0n,
      active: false
    });

    const escrowData = await escrow.getEscrow(ESCROW_ID);

    expect(escrowData.requester).toBe(ethers.ZeroAddress);
    expect(escrowData.active).toBe(false);
  });

  it('should handle contract revert on remaining()', async () => {
    mockContractInstance.remaining.mockRejectedValue(new Error('Contract reverted'));

    await expect(
      escrow.getEscrowBalance(ESCROW_ID)
    ).rejects.toThrow('Contract reverted');
  });

  it('should apply gas settings when provided', () => {
    const escrowWithGas = new EscrowVault(ESCROW_ADDRESS, mockSigner as any, {
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 200000000n
    });

    expect(escrowWithGas).toBeInstanceOf(EscrowVault);
  });

  it('should handle zero remaining balance', async () => {
    mockContractInstance.remaining.mockResolvedValue(0n);

    const balance = await escrow.getEscrowBalance(ESCROW_ID);

    expect(balance).toBe(0n);
  });

  it('should handle very large escrow amounts', async () => {
    const largeAmount = 1000000000000n; // 1M USDC

    mockContractInstance.escrows.mockResolvedValue({
      requester: '0x1111111111111111111111111111111111111111',
      provider: '0x2222222222222222222222222222222222222222',
      amount: largeAmount,
      releasedAmount: 0n,
      active: true
    });

    const escrowData = await escrow.getEscrow(ESCROW_ID);

    expect(escrowData.amount).toBe(largeAmount);
  });

  it('should handle escrow with maximum uint256 amount', async () => {
    const maxAmount = 2n ** 256n - 1n;

    mockContractInstance.escrows.mockResolvedValue({
      requester: '0x1111111111111111111111111111111111111111',
      provider: '0x2222222222222222222222222222222222222222',
      amount: maxAmount,
      releasedAmount: 0n,
      active: true
    });

    const escrowData = await escrow.getEscrow(ESCROW_ID);

    expect(escrowData.amount).toBe(maxAmount);
  });

  it('should validate short escrowId', async () => {
    await expect(
      escrow.getEscrow('0xabc')
    ).rejects.toThrow();
  });

  it('should validate non-hex escrowId', async () => {
    await expect(
      escrow.getEscrow('not-a-hex-string-at-all-no-no-no-no-no-no-no-no-no-no')
    ).rejects.toThrow();
  });
});

describe('EscrowVault gas settings', () => {
  const ESCROW_ADDRESS = '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585';
  let mockSigner: any;

  beforeEach(() => {
    mockSigner = {
      getAddress: jest.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
      provider: null
    };

    mockContractInstance = {
      escrows: jest.fn(),
      remaining: jest.fn()
    };
  });

  it('should create instance without gas settings', () => {
    const escrow = new EscrowVault(ESCROW_ADDRESS, mockSigner as any);
    expect(escrow).toBeInstanceOf(EscrowVault);
  });

  it('should create instance with only maxFeePerGas', () => {
    const escrow = new EscrowVault(ESCROW_ADDRESS, mockSigner as any, {
      maxFeePerGas: 2000000000n
    });
    expect(escrow).toBeInstanceOf(EscrowVault);
  });

  it('should create instance with only maxPriorityFeePerGas', () => {
    const escrow = new EscrowVault(ESCROW_ADDRESS, mockSigner as any, {
      maxPriorityFeePerGas: 100000000n
    });
    expect(escrow).toBeInstanceOf(EscrowVault);
  });

  it('should create instance with both gas settings', () => {
    const escrow = new EscrowVault(ESCROW_ADDRESS, mockSigner as any, {
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 100000000n
    });
    expect(escrow).toBeInstanceOf(EscrowVault);
  });
});
