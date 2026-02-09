/**
 * EOAWalletProvider Tests
 *
 * Tests cover:
 * - getAddress: returns signer address
 * - sendTransaction: delegates to ethers.Wallet
 * - sendBatchTransaction: sequential execution, fail fast
 * - getWalletInfo: correct metadata
 */

import { ethers } from 'ethers';
import { EOAWalletProvider } from './EOAWalletProvider';

// Well-known Anvil test key
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Mock wallet for testing (no real network)
function createMockWallet(): {
  wallet: ethers.Wallet;
  sendTransactionMock: jest.Mock;
} {
  const wallet = new ethers.Wallet(TEST_KEY);
  const sendTransactionMock = jest.fn();

  // Override sendTransaction
  (wallet as any).sendTransaction = sendTransactionMock;

  return { wallet, sendTransactionMock };
}

describe('EOAWalletProvider', () => {
  const CHAIN_ID = 84532;

  describe('getAddress()', () => {
    it('should return the signer address', () => {
      const { wallet } = createMockWallet();
      const provider = new EOAWalletProvider(wallet, CHAIN_ID);
      expect(provider.getAddress()).toBe(wallet.address);
    });
  });

  describe('getWalletInfo()', () => {
    it('should return EOA metadata', () => {
      const { wallet } = createMockWallet();
      const provider = new EOAWalletProvider(wallet, CHAIN_ID);
      const info = provider.getWalletInfo();

      expect(info.tier).toBe('eoa');
      expect(info.supportsBatching).toBe(false);
      expect(info.gasSponsored).toBe(false);
      expect(info.chainId).toBe(CHAIN_ID);
      expect(info.address).toBe(wallet.address);
    });
  });

  describe('sendTransaction()', () => {
    it('should delegate to ethers wallet', async () => {
      const { wallet, sendTransactionMock } = createMockWallet();
      const provider = new EOAWalletProvider(wallet, CHAIN_ID);

      sendTransactionMock.mockResolvedValue({
        wait: () => Promise.resolve({ hash: '0xabc', status: 1 }),
      });

      const receipt = await provider.sendTransaction({
        to: '0x' + '11'.repeat(20),
        data: '0x1234',
      });

      expect(receipt.hash).toBe('0xabc');
      expect(receipt.success).toBe(true);
      expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    });

    it('should pass value when provided', async () => {
      const { wallet, sendTransactionMock } = createMockWallet();
      const provider = new EOAWalletProvider(wallet, CHAIN_ID);

      sendTransactionMock.mockResolvedValue({
        wait: () => Promise.resolve({ hash: '0xdef', status: 1 }),
      });

      await provider.sendTransaction({
        to: '0x' + '22'.repeat(20),
        data: '0x',
        value: '1000000',
      });

      expect(sendTransactionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 1000000n,
        })
      );
    });
  });

  describe('sendBatchTransaction()', () => {
    it('should execute transactions sequentially', async () => {
      const { wallet, sendTransactionMock } = createMockWallet();
      const provider = new EOAWalletProvider(wallet, CHAIN_ID);

      const callOrder: number[] = [];
      sendTransactionMock.mockImplementation(async () => {
        callOrder.push(callOrder.length + 1);
        return {
          wait: () => Promise.resolve({ hash: `0x${callOrder.length}`, status: 1 }),
        };
      });

      const receipt = await provider.sendBatchTransaction([
        { to: '0x' + '11'.repeat(20), data: '0x01' },
        { to: '0x' + '22'.repeat(20), data: '0x02' },
        { to: '0x' + '33'.repeat(20), data: '0x03' },
      ]);

      expect(sendTransactionMock).toHaveBeenCalledTimes(3);
      expect(callOrder).toEqual([1, 2, 3]);
      // Returns last receipt
      expect(receipt.hash).toBe('0x3');
    });

    it('should fail fast on failed transaction', async () => {
      const { wallet, sendTransactionMock } = createMockWallet();
      const provider = new EOAWalletProvider(wallet, CHAIN_ID);

      let callCount = 0;
      sendTransactionMock.mockImplementation(async () => {
        callCount++;
        return {
          wait: () =>
            Promise.resolve({
              hash: `0x${callCount}`,
              status: callCount === 2 ? 0 : 1, // Second tx fails
            }),
        };
      });

      const receipt = await provider.sendBatchTransaction([
        { to: '0x' + '11'.repeat(20), data: '0x01' },
        { to: '0x' + '22'.repeat(20), data: '0x02' },
        { to: '0x' + '33'.repeat(20), data: '0x03' },
      ]);

      // Should stop at the failed tx
      expect(callCount).toBe(2);
      expect(receipt.success).toBe(false);
    });

    it('should reject empty batch', async () => {
      const { wallet } = createMockWallet();
      const provider = new EOAWalletProvider(wallet, CHAIN_ID);

      await expect(provider.sendBatchTransaction([])).rejects.toThrow(
        'at least one transaction'
      );
    });
  });
});
