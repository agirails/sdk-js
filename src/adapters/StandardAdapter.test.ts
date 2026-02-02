/**
 * StandardAdapter Integration Tests
 *
 * Tests the standard-level API with MockRuntime:
 * - createTransaction() - Create transaction without escrow
 * - linkEscrow() - Link escrow and transition to COMMITTED
 * - transitionState() - Manual state transitions
 * - releaseEscrow() - Release funds to provider
 * - getEscrowBalance() - Query escrow balance
 * - getTransaction() - Get transaction details
 */

import { StandardAdapter } from './StandardAdapter';
import { MockRuntime } from '../runtime/MockRuntime';
import { ValidationError } from './BaseAdapter';

describe('StandardAdapter', () => {
  let runtime: MockRuntime;
  let adapter: StandardAdapter;
  const requesterAddress = '0x1111111111111111111111111111111111111111';
  const providerAddress = '0x2222222222222222222222222222222222222222';

  beforeEach(async () => {
    runtime = new MockRuntime();
    await runtime.reset(); // Clear any persisted state
    adapter = new StandardAdapter(runtime, requesterAddress);

    // Mint initial funds to requester
    await runtime.mintTokens(requesterAddress, '10000000000'); // 10,000 USDC
  });

  describe('createTransaction', () => {
    test('creates transaction in INITIATED state', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      expect(txId).toMatch(/^0x[0-9a-f]{64}$/);

      const tx = await runtime.getTransaction(txId);
      expect(tx).not.toBeNull();
      expect(tx!.state).toBe('INITIATED');
      expect(tx!.amount).toBe('100000000'); // 100.00 USDC
      expect(tx!.provider).toBe(providerAddress);
      expect(tx!.requester).toBe(requesterAddress);
      expect(tx!.escrowId).toBeNull(); // Not linked yet
    });

    test('creates transaction with custom deadline', async () => {
      const currentTime = runtime.time.now();

      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        deadline: '+7d',
      });

      const tx = await runtime.getTransaction(txId);
      expect(tx!.deadline).toBeGreaterThanOrEqual(currentTime + 7 * 86400);
      expect(tx!.deadline).toBeLessThan(currentTime + 7 * 86400 + 2);
    });

    test('creates transaction with custom dispute window', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        disputeWindow: 3600,
      });

      const tx = await runtime.getTransaction(txId);
      expect(tx!.disputeWindow).toBe(3600);
    });

    test('creates transaction with service description', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        serviceDescription: 'Test service',
      });

      const tx = await runtime.getTransaction(txId);
      expect(tx!.serviceDescription).toBe('Test service');
    });

    test('throws on invalid provider address', async () => {
      await expect(
        adapter.createTransaction({
          provider: 'invalid',
          amount: '100',
        })
      ).rejects.toThrow(ValidationError);
    });

    test('throws on self-transaction', async () => {
      await expect(
        adapter.createTransaction({
          provider: requesterAddress,
          amount: '100',
        })
      ).rejects.toThrow('Cannot create transaction with yourself as provider');
    });

    test('throws on deadline in past', async () => {
      const pastTime = runtime.time.now() - 1000;

      await expect(
        adapter.createTransaction({
          provider: providerAddress,
          amount: '100',
          deadline: pastTime,
        })
      ).rejects.toThrow('Deadline must be in the future');
    });
  });

  describe('linkEscrow', () => {
    test('links escrow and transitions to COMMITTED', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      const escrowId = await adapter.linkEscrow(txId);

      expect(escrowId).toBeDefined();

      // Verify transaction transitioned to COMMITTED
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('COMMITTED');
      expect(tx!.escrowId).toBe(escrowId);

      // Verify escrow is funded
      const escrowBalance = await runtime.getEscrowBalance(escrowId);
      expect(escrowBalance).toBe('100000000');
    });

    test('deducts funds from requester', async () => {
      const balanceBefore = await runtime.getBalance(requesterAddress);

      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      await adapter.linkEscrow(txId);

      const balanceAfter = await runtime.getBalance(requesterAddress);
      expect(BigInt(balanceAfter)).toBe(BigInt(balanceBefore) - 100_000_000n);
    });

    test('throws on non-existent transaction', async () => {
      const fakeTxId = '0x' + '1'.repeat(64);

      await expect(adapter.linkEscrow(fakeTxId)).rejects.toThrow('not found');
    });
  });

  describe('transitionState', () => {
    test('transitions COMMITTED to IN_PROGRESS', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      await adapter.linkEscrow(txId);
      await adapter.transitionState(txId, 'IN_PROGRESS');

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('IN_PROGRESS');
    });

    test('transitions IN_PROGRESS to DELIVERED', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      await adapter.linkEscrow(txId);
      await adapter.transitionState(txId, 'IN_PROGRESS');
      await adapter.transitionState(txId, 'DELIVERED');

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('DELIVERED');
      expect(tx!.completedAt).not.toBeNull();
    });

    test('COMMITTED cannot go directly to DELIVERED (must go through IN_PROGRESS)', async () => {
      // AUDIT FIX (2026-02): Contract requires IN_PROGRESS step before DELIVERED
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      await adapter.linkEscrow(txId);

      // Direct COMMITTED -> DELIVERED should fail
      await expect(adapter.transitionState(txId, 'DELIVERED')).rejects.toThrow('Invalid state transition');

      // Must go through IN_PROGRESS first
      await adapter.transitionState(txId, 'IN_PROGRESS');
      await adapter.transitionState(txId, 'DELIVERED');

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('DELIVERED');
    });

    test('transitions DELIVERED to SETTLED', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        disputeWindow: 3600, // 1 hour (minimum allowed per L-1 security fix)
      });

      await adapter.linkEscrow(txId);
      await adapter.transitionState(txId, 'IN_PROGRESS'); // Required step
      await adapter.transitionState(txId, 'DELIVERED');
      // Advance time past dispute window
      await runtime.time.advanceTime(3601);
      await adapter.transitionState(txId, 'SETTLED');

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });

    test('transitions INITIATED to CANCELLED', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      await adapter.transitionState(txId, 'CANCELLED');

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('CANCELLED');
    });

    test('refunds escrow on CANCELLED transition', async () => {
      const balanceBefore = await runtime.getBalance(requesterAddress);

      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      await adapter.linkEscrow(txId);

      // Balance should be reduced
      const balanceAfterEscrow = await runtime.getBalance(requesterAddress);
      expect(BigInt(balanceAfterEscrow)).toBe(BigInt(balanceBefore) - 100_000_000n);

      // Cancel and get refund
      await adapter.transitionState(txId, 'CANCELLED');

      const balanceAfterCancel = await runtime.getBalance(requesterAddress);
      expect(balanceAfterCancel).toBe(balanceBefore); // Full refund
    });

    test('throws on invalid transition', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      // Cannot go from INITIATED to DELIVERED (must go through COMMITTED)
      await expect(adapter.transitionState(txId, 'DELIVERED')).rejects.toThrow('Invalid state transition');
    });
  });

  describe('releaseEscrow', () => {
    test('releases escrow to provider after dispute window', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        disputeWindow: 3600, // 1 hour
      });

      const escrowId = await adapter.linkEscrow(txId);

      // Must go through IN_PROGRESS before DELIVERED
      await adapter.transitionState(txId, 'IN_PROGRESS');
      await adapter.transitionState(txId, 'DELIVERED');

      // Advance time past dispute window
      await runtime.time.advanceTime(3601);

      // Release escrow
      await adapter.releaseEscrow(escrowId);

      // Verify provider received funds
      const providerBalance = await runtime.getBalance(providerAddress);
      expect(providerBalance).toBe('100000000'); // 100 USDC

      // Verify escrow is empty
      const escrowBalance = await runtime.getEscrowBalance(escrowId);
      expect(escrowBalance).toBe('0');

      // Verify transaction is SETTLED
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');
    });

    test('throws if dispute window still active', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        disputeWindow: 3600,
      });

      const escrowId = await adapter.linkEscrow(txId);

      // Must go through IN_PROGRESS before DELIVERED
      await adapter.transitionState(txId, 'IN_PROGRESS');
      await adapter.transitionState(txId, 'DELIVERED');

      // Try to release immediately (dispute window active)
      await expect(adapter.releaseEscrow(escrowId)).rejects.toThrow('Dispute window still active');
    });

    test('throws on non-existent escrow', async () => {
      await expect(adapter.releaseEscrow('fake-escrow')).rejects.toThrow('Escrow not found');
    });

    test('throws if transaction not in DELIVERED state', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      const escrowId = await adapter.linkEscrow(txId);

      // Try to release without delivering
      await expect(adapter.releaseEscrow(escrowId)).rejects.toThrow();
    });
  });

  describe('getEscrowBalance', () => {
    test('returns formatted balance', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100.50',
      });

      const escrowId = await adapter.linkEscrow(txId);

      const balance = await adapter.getEscrowBalance(escrowId);
      expect(balance).toBe('100.50 USDC');
    });

    test('returns zero balance after release', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        disputeWindow: 3600, // Minimum 1 hour per L-1 security fix
      });

      const escrowId = await adapter.linkEscrow(txId);

      // Must go through IN_PROGRESS before DELIVERED
      await adapter.transitionState(txId, 'IN_PROGRESS');
      await adapter.transitionState(txId, 'DELIVERED');
      // Advance time past dispute window
      await runtime.time.advanceTime(3601);
      await adapter.releaseEscrow(escrowId);

      const balance = await adapter.getEscrowBalance(escrowId);
      expect(balance).toBe('0.00 USDC');
    });

    test('throws on non-existent escrow', async () => {
      await expect(adapter.getEscrowBalance('fake-escrow')).rejects.toThrow('Escrow not found');
    });
  });

  describe('getTransaction', () => {
    test('returns transaction details', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100.50',
        serviceDescription: 'Test service',
      });

      const tx = await adapter.getTransaction(txId);

      expect(tx).not.toBeNull();
      expect(tx!.id).toBe(txId);
      expect(tx!.provider).toBe(providerAddress);
      expect(tx!.requester).toBe(requesterAddress);
      expect(tx!.amount).toBe('100500000');
      expect(tx!.serviceDescription).toBe('Test service');
      expect(tx!.state).toBe('INITIATED');
    });

    test('returns null for non-existent transaction', async () => {
      const fakeTxId = '0x' + '1'.repeat(64);
      const tx = await adapter.getTransaction(fakeTxId);
      expect(tx).toBeNull();
    });

    test('reflects state changes', async () => {
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
      });

      let tx = await adapter.getTransaction(txId);
      expect(tx!.state).toBe('INITIATED');

      await adapter.linkEscrow(txId);

      tx = await adapter.getTransaction(txId);
      expect(tx!.state).toBe('COMMITTED');
      expect(tx!.escrowId).not.toBeNull();
    });
  });

  describe('full lifecycle flow', () => {
    test('completes full happy path', async () => {
      // 1. Create transaction
      const txId = await adapter.createTransaction({
        provider: providerAddress,
        amount: '100',
        disputeWindow: 3600,
      });

      let tx = await adapter.getTransaction(txId);
      expect(tx!.state).toBe('INITIATED');

      // 2. Link escrow
      const escrowId = await adapter.linkEscrow(txId);
      tx = await adapter.getTransaction(txId);
      expect(tx!.state).toBe('COMMITTED');

      // 3. Start work
      await adapter.transitionState(txId, 'IN_PROGRESS');
      tx = await adapter.getTransaction(txId);
      expect(tx!.state).toBe('IN_PROGRESS');

      // 4. Deliver
      await adapter.transitionState(txId, 'DELIVERED');
      tx = await adapter.getTransaction(txId);
      expect(tx!.state).toBe('DELIVERED');

      // 5. Wait for dispute window
      await runtime.time.advanceTime(3601);

      // 6. Release escrow
      await adapter.releaseEscrow(escrowId);
      tx = await adapter.getTransaction(txId);
      expect(tx!.state).toBe('SETTLED');

      // Verify provider got paid
      const providerBalance = await runtime.getBalance(providerAddress);
      expect(providerBalance).toBe('100000000');
    });
  });
});
