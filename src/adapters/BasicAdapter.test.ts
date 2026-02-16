/**
 * BasicAdapter Integration Tests
 *
 * Tests the high-level BasicAdapter API with MockRuntime:
 * - pay() - Create and fund transactions
 * - checkStatus() - Query transaction state and action hints
 *
 * Tests cover:
 * - Happy path flows
 * - Error cases (validation, self-payment, etc.)
 * - Smart defaults (deadline, dispute window)
 * - Integration with MockRuntime
 */

import { BasicAdapter } from './BasicAdapter';
import { MockRuntime } from '../runtime/MockRuntime';
import { ValidationError } from './BaseAdapter';
import { ethers } from 'ethers';

describe('BasicAdapter', () => {
  let runtime: MockRuntime;
  let adapter: BasicAdapter;
  const requesterAddress = '0x1111111111111111111111111111111111111111';
  const providerAddress = '0x2222222222222222222222222222222222222222';

  beforeEach(async () => {
    runtime = new MockRuntime();
    await runtime.reset(); // Clear any persisted state
    adapter = new BasicAdapter(runtime, requesterAddress);

    // Mint initial funds to requester
    await runtime.mintTokens(requesterAddress, '10000000000'); // 10,000 USDC
  });

  describe('pay', () => {
    describe('happy path', () => {
      test('creates and funds transaction with minimal params', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: '100',
        });

        expect(result.txId).toBeDefined();
        expect(result.txId).toMatch(/^0x[0-9a-f]{64}$/);
        expect(result.provider).toBe(providerAddress);
        expect(result.requester).toBe(requesterAddress);
        expect(result.amount).toBe('100.00 USDC');
        expect(result.state).toBe('COMMITTED'); // Auto-transitioned by linkEscrow
        expect(result.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601 format

        // Verify transaction exists and is funded
        const tx = await runtime.getTransaction(result.txId);
        expect(tx).not.toBeNull();
        expect(tx!.state).toBe('COMMITTED');
        expect(tx!.amount).toBe('100000000'); // 100.00 USDC in wei
        expect(tx!.escrowId).not.toBeNull();

        // Verify escrow is funded
        const escrowBalance = await runtime.getEscrowBalance(tx!.escrowId!);
        expect(escrowBalance).toBe('100000000');
      });

      test('creates transaction with decimal amount', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: '100.50',
        });

        expect(result.amount).toBe('100.50 USDC');

        const tx = await runtime.getTransaction(result.txId);
        expect(tx!.amount).toBe('100500000'); // 100.50 USDC
      });

      test('creates transaction with custom deadline', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: '100',
          deadline: '+7d',
        });

        const currentTime = runtime.time.now();
        const tx = await runtime.getTransaction(result.txId);
        expect(tx!.deadline).toBeGreaterThanOrEqual(currentTime + 7 * 86400);
        expect(tx!.deadline).toBeLessThan(currentTime + 7 * 86400 + 2); // Allow 1s tolerance
      });

      test('creates transaction with custom dispute window', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: '100',
          disputeWindow: 3600, // 1 hour
        });

        const tx = await runtime.getTransaction(result.txId);
        expect(tx!.disputeWindow).toBe(3600);
      });

      test('creates transaction with numeric amount', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: 100,
        });

        expect(result.amount).toBe('100.00 USDC');
      });

      test('creates transaction with currency suffix', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: '100 USDC',
        });

        expect(result.amount).toBe('100.00 USDC');
      });

      test('creates transaction with $ prefix', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: '$100',
        });

        expect(result.amount).toBe('100.00 USDC');
      });

      test('deducts funds from requester', async () => {
        const balanceBefore = await runtime.getBalance(requesterAddress);

        await adapter.pay({
          to: providerAddress,
          amount: '100',
        });

        const balanceAfter = await runtime.getBalance(requesterAddress);
        expect(BigInt(balanceAfter)).toBe(BigInt(balanceBefore) - 100_000_000n);
      });
    });

    describe('validation errors', () => {
      test('throws on invalid address', async () => {
        await expect(
          adapter.pay({
            to: 'invalid',
            amount: '100',
          })
        ).rejects.toThrow(ValidationError);

        await expect(
          adapter.pay({
            to: 'invalid',
            amount: '100',
          })
        ).rejects.toThrow('Invalid to address');
      });

      test('throws on self-payment', async () => {
        await expect(
          adapter.pay({
            to: requesterAddress, // Same as requester
            amount: '100',
          })
        ).rejects.toThrow(ValidationError);

        await expect(
          adapter.pay({
            to: requesterAddress,
            amount: '100',
          })
        ).rejects.toThrow('Cannot pay yourself');
      });

      test('throws on invalid amount format', async () => {
        await expect(
          adapter.pay({
            to: providerAddress,
            amount: 'abc',
          })
        ).rejects.toThrow(ValidationError);

        await expect(
          adapter.pay({
            to: providerAddress,
            amount: 'abc',
          })
        ).rejects.toThrow('Invalid amount format');
      });

      test('throws on negative amount', async () => {
        await expect(
          adapter.pay({
            to: providerAddress,
            amount: '-100',
          })
        ).rejects.toThrow(ValidationError);

        await expect(
          adapter.pay({
            to: providerAddress,
            amount: '-100',
          })
        ).rejects.toThrow('cannot be negative');
      });

      test('throws on deadline in the past', async () => {
        const pastTime = runtime.time.now() - 1000;

        await expect(
          adapter.pay({
            to: providerAddress,
            amount: '100',
            deadline: pastTime,
          })
        ).rejects.toThrow(ValidationError);

        await expect(
          adapter.pay({
            to: providerAddress,
            amount: '100',
            deadline: pastTime,
          })
        ).rejects.toThrow('Deadline must be in the future');
      });

      test('throws on invalid deadline format', async () => {
        await expect(
          adapter.pay({
            to: providerAddress,
            amount: '100',
            deadline: 'invalid',
          })
        ).rejects.toThrow(ValidationError);

        await expect(
          adapter.pay({
            to: providerAddress,
            amount: '100',
            deadline: 'invalid',
          })
        ).rejects.toThrow('Invalid deadline format');
      });
    });

    describe('smart defaults', () => {
      test('defaults deadline to +24h', async () => {
        const currentTime = runtime.time.now();

        const result = await adapter.pay({
          to: providerAddress,
          amount: '100',
        });

        const tx = await runtime.getTransaction(result.txId);
        expect(tx!.deadline).toBeGreaterThanOrEqual(currentTime + 86400);
        expect(tx!.deadline).toBeLessThan(currentTime + 86401); // Allow 1s tolerance
      });

      test('defaults dispute window to 2 days', async () => {
        const result = await adapter.pay({
          to: providerAddress,
          amount: '100',
        });

        const tx = await runtime.getTransaction(result.txId);
        expect(tx!.disputeWindow).toBe(172800); // 2 days
      });
    });
  });

  describe('checkStatus', () => {
    test('returns correct state for COMMITTED transaction', async () => {
      const result = await adapter.pay({
        to: providerAddress,
        amount: '100',
      });

      const status = await adapter.checkStatus(result.txId);

      expect(status.state).toBe('COMMITTED');
      expect(status.canAccept).toBe(false); // Already committed
      expect(status.canComplete).toBe(true); // Provider can deliver
      expect(status.canDispute).toBe(false); // Not delivered yet
    });

    test('returns correct state for INITIATED transaction', async () => {
      // Create transaction without linking escrow
      const txId = await runtime.createTransaction({
        provider: providerAddress,
        requester: requesterAddress,
        amount: '100000000',
        deadline: runtime.time.now() + 86400,
      });

      const status = await adapter.checkStatus(txId);

      expect(status.state).toBe('INITIATED');
      expect(status.canAccept).toBe(true);
      expect(status.canComplete).toBe(false);
      expect(status.canDispute).toBe(false);
    });

    test('returns correct state for DELIVERED transaction', async () => {
      const result = await adapter.pay({
        to: providerAddress,
        amount: '100',
      });

      // AUDIT FIX: Must go through IN_PROGRESS before DELIVERED
      await runtime.transitionState(result.txId, 'IN_PROGRESS');
      await runtime.transitionState(result.txId, 'DELIVERED');

      const status = await adapter.checkStatus(result.txId);

      expect(status.state).toBe('DELIVERED');
      expect(status.canAccept).toBe(false);
      expect(status.canComplete).toBe(false);
      expect(status.canDispute).toBe(true); // Within dispute window
    });

    test('canDispute is false after dispute window expires', async () => {
      const result = await adapter.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600, // 1 hour
      });

      // AUDIT FIX: Must go through IN_PROGRESS before DELIVERED
      await runtime.transitionState(result.txId, 'IN_PROGRESS');
      await runtime.transitionState(result.txId, 'DELIVERED');

      // Advance time past dispute window
      await runtime.time.advanceTime(3601);

      const status = await adapter.checkStatus(result.txId);

      expect(status.canDispute).toBe(false);
    });

    test('canAccept is false after deadline passes', async () => {
      const txId = await runtime.createTransaction({
        provider: providerAddress,
        requester: requesterAddress,
        amount: '100000000',
        deadline: runtime.time.now() + 100,
      });

      // Advance time past deadline
      await runtime.time.advanceTime(101);

      const status = await adapter.checkStatus(txId);

      expect(status.canAccept).toBe(false);
    });

    test('throws on non-existent transaction', async () => {
      const fakeTxId = '0x' + '1'.repeat(64);

      await expect(adapter.checkStatus(fakeTxId)).rejects.toThrow('Transaction');
      await expect(adapter.checkStatus(fakeTxId)).rejects.toThrow('not found');
    });
  });

  describe('edge cases', () => {
    test('handles zero USDC balance (insufficient funds)', async () => {
      const poorRequester = '0x3333333333333333333333333333333333333333';
      const poorAdapter = new BasicAdapter(runtime, poorRequester);

      // No minting - balance is 0

      await expect(
        poorAdapter.pay({
          to: providerAddress,
          amount: '100',
        })
      ).rejects.toThrow('Insufficient balance');
    });

    test('handles large amounts', async () => {
      // Mint large balance
      await runtime.mintTokens(requesterAddress, '1000000000000'); // 1,000,000 USDC

      const result = await adapter.pay({
        to: providerAddress,
        amount: '999999',
      });

      expect(result.amount).toBe('999999.00 USDC');
    });

    test('handles minimum amount ($0.05 USDC)', async () => {
      const result = await adapter.pay({
        to: providerAddress,
        amount: '0.05',
      });

      expect(result.amount).toBe('0.05 USDC');

      const tx = await runtime.getTransaction(result.txId);
      expect(tx!.amount).toBe('50000'); // $0.05 USDC = 50,000 wei
    });

    test('rejects amount below $0.05 minimum', async () => {
      await expect(
        adapter.pay({
          to: providerAddress,
          amount: '0.04',
        })
      ).rejects.toThrow('Amount too small');
    });

    test('handles case-insensitive self-payment check', async () => {
      // Use same address with different casing (keeping 0x lowercase)
      const upperCaseRequester = '0x' + requesterAddress.slice(2).toUpperCase();

      await expect(
        adapter.pay({
          to: upperCaseRequester, // Different case, same address
          amount: '100',
        })
      ).rejects.toThrow('Cannot pay yourself');
    });
  });

  describe('smart wallet release routing', () => {
    const contractAddresses = {
      usdc: '0x3333333333333333333333333333333333333333',
      actpKernel: '0x4444444444444444444444444444444444444444',
      escrowVault: '0x5555555555555555555555555555555555555555',
    };

    test('routes release() through transitionState(SETTLED) in wallet mode', async () => {
      const result = await adapter.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600,
      });
      await runtime.transitionState(result.txId, 'IN_PROGRESS');
      await runtime.transitionState(result.txId, 'DELIVERED');
      const deliveredTx = await runtime.getTransaction(result.txId);
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        ...deliveredTx!,
        state: 'DELIVERED',
        completedAt: runtime.time.now() - 4000,
        disputeWindow: 3600,
      } as any);

      const sendTransaction = jest.fn().mockResolvedValue({ success: true, hash: '0xabc' });
      const walletAdapter = new BasicAdapter(
        runtime,
        requesterAddress,
        undefined,
        { payACTPBatched: jest.fn(), sendTransaction } as any,
        contractAddresses
      );

      await walletAdapter.release(result.txId);

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      const sentTx = sendTransaction.mock.calls[0][0];
      const iface = new ethers.Interface([
        'function transitionState(bytes32 transactionId, uint8 newState, bytes proof)',
      ]);
      const decoded = iface.decodeFunctionData('transitionState', sentTx.data);
      expect(decoded[0]).toBe(result.txId);
      expect(decoded[1]).toBe(5n);
    });

    test('requires attestation in wallet mode when runtime mandates it', async () => {
      const result = await adapter.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600,
      });
      await runtime.transitionState(result.txId, 'IN_PROGRESS');
      await runtime.transitionState(result.txId, 'DELIVERED');
      const deliveredTx = await runtime.getTransaction(result.txId);
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        ...deliveredTx!,
        state: 'DELIVERED',
        completedAt: runtime.time.now() - 4000,
        disputeWindow: 3600,
      } as any);

      (runtime as any).isAttestationRequired = jest.fn().mockReturnValue(true);
      const sendTransaction = jest.fn().mockResolvedValue({ success: true, hash: '0xabc' });
      const walletAdapter = new BasicAdapter(
        runtime,
        requesterAddress,
        undefined,
        { payACTPBatched: jest.fn(), sendTransaction } as any,
        contractAddresses
      );

      await expect(walletAdapter.release(result.txId)).rejects.toThrow(
        'Attestation verification is REQUIRED for escrow release'
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });
});
