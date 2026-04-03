import { SettleOnInteract } from './SettleOnInteract';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

describe('SettleOnInteract', () => {
  let runtime: MockRuntime;
  let tmpDir: string;
  const requesterAddress = '0x1111111111111111111111111111111111111111';
  const providerAddress = '0x2222222222222222222222222222222222222222';

  beforeEach(async () => {
    // Use isolated temp directory to avoid file-based state conflicts
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-'));
    const stateManager = new MockStateManager(tmpDir);
    runtime = new MockRuntime(stateManager);
    await runtime.reset();
    await runtime.mintTokens(requesterAddress, '10000000000');
  });

  afterEach(() => {
    // Clean up temp directory
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /** Helper: create a DELIVERED transaction with given dispute window */
  async function createDeliveredTx(disputeWindowSeconds = 3600): Promise<string> {
    const txId = await runtime.createTransaction({
      provider: providerAddress,
      requester: requesterAddress,
      amount: '1000000',
      deadline: Math.floor(Date.now() / 1000) + 86400,
      disputeWindow: disputeWindowSeconds,
    });
    await runtime.linkEscrow(txId, '1000000');
    await runtime.transitionState(txId, 'IN_PROGRESS');
    await runtime.transitionState(txId, 'DELIVERED');
    return txId;
  }

  describe('MockRuntime sweep', () => {
    test('settles expired DELIVERED transactions', async () => {
      const txId = await createDeliveredTx(3600); // 1 hour window

      // Advance time past dispute window
      await runtime.time.advanceTime(3601);

      const settler = new SettleOnInteract(runtime, providerAddress, 0);
      await settler.sweepNow();

      const tx = await runtime.getTransaction(txId);
      expect(tx?.state).toBe('SETTLED');
    });

    test('does not settle transactions with active dispute window', async () => {
      const txId = await createDeliveredTx(3600);

      // Don't advance time — window still active
      const settler = new SettleOnInteract(runtime, providerAddress, 0);
      await settler.sweepNow();

      const tx = await runtime.getTransaction(txId);
      expect(tx?.state).toBe('DELIVERED');
    });

    test('handles zero DELIVERED transactions gracefully', async () => {
      const settler = new SettleOnInteract(runtime, providerAddress, 0);
      // Should not throw
      await settler.sweepNow();
    });

    test('only sweeps transactions for the specified provider', async () => {
      const otherProvider = '0x3333333333333333333333333333333333333333';
      const txId = await createDeliveredTx(3600);

      await runtime.time.advanceTime(3601);

      // Sweep for a different provider
      const settler = new SettleOnInteract(runtime, otherProvider, 0);
      await settler.sweepNow();

      // Use getAllTransactions to check state without triggering MockRuntime's
      // built-in auto-settle in getTransaction()
      const allTxs = await runtime.getAllTransactions();
      const tx = allTxs.find(t => t.id === txId);
      expect(tx?.state).toBe('DELIVERED');
    });

    test('settles multiple expired transactions in one sweep', async () => {
      const txId1 = await createDeliveredTx(3600);
      const txId2 = await createDeliveredTx(3600);

      await runtime.time.advanceTime(3601);

      const settler = new SettleOnInteract(runtime, providerAddress, 0);
      await settler.sweepNow();

      const tx1 = await runtime.getTransaction(txId1);
      const tx2 = await runtime.getTransaction(txId2);
      expect(tx1?.state).toBe('SETTLED');
      expect(tx2?.state).toBe('SETTLED');
    });
  });

  describe('cooldown', () => {
    test('trigger() respects cooldown timer', async () => {
      // Use a mock runtime-like object to precisely track sweep calls
      let sweepCount = 0;
      const mockRuntime = {
        sweepExpiredDeliveredForProvider: jest.fn().mockImplementation(async () => { sweepCount++; }),
      } as any;

      const settler = new SettleOnInteract(mockRuntime, providerAddress, 60_000); // 1 min cooldown

      // First trigger: should sweep
      settler.trigger();
      await new Promise(r => setTimeout(r, 50));
      expect(sweepCount).toBe(1);

      // Second trigger within cooldown: should NOT sweep
      settler.trigger();
      await new Promise(r => setTimeout(r, 50));
      expect(sweepCount).toBe(1); // Still 1 — cooldown blocked
    });

    test('sweepNow() bypasses cooldown', async () => {
      const txId1 = await createDeliveredTx(3600);
      await runtime.time.advanceTime(3601);

      const settler = new SettleOnInteract(runtime, providerAddress, 60_000);

      // First sweep
      await settler.sweepNow();
      const tx1 = await runtime.getTransaction(txId1);
      expect(tx1?.state).toBe('SETTLED');

      // Create another expired tx and sweep again immediately
      const txId2 = await createDeliveredTx(3600);
      await runtime.time.advanceTime(3601);

      await settler.sweepNow(); // Bypasses cooldown
      const tx2 = await runtime.getTransaction(txId2);
      expect(tx2?.state).toBe('SETTLED');
    });
  });

  describe('error handling', () => {
    test('trigger() never throws', async () => {
      // Create settler with a provider address that doesn't match anything
      const settler = new SettleOnInteract(runtime, providerAddress, 0);
      // Should not throw even if runtime is in unexpected state
      expect(() => settler.trigger()).not.toThrow();
      // Wait for fire-and-forget sweep to complete before afterEach cleanup
      await new Promise(r => setTimeout(r, 50));
    });

    test('sweepNow() swallows per-transaction errors (blockchain path)', async () => {
      // Use mock blockchain-like runtime to test the per-tx error handling path
      const mockRuntime = {
        getExpiredDeliveredTransactions: jest.fn().mockResolvedValue([
          { txId: '0xabc' },
          { txId: '0xdef' },
        ]),
        releaseEscrow: jest.fn()
          .mockRejectedValueOnce(new Error('release failed'))
          .mockResolvedValueOnce(undefined),
      } as any;

      const settler = new SettleOnInteract(mockRuntime, providerAddress, 0);
      // Should not throw even though first releaseEscrow fails
      await settler.sweepNow();
      // Second tx should still be attempted despite first failure
      expect(mockRuntime.releaseEscrow).toHaveBeenCalledTimes(2);
    });
  });

  describe('duck-typing runtime detection', () => {
    test('falls back gracefully for unknown runtime', async () => {
      // Create a minimal runtime-like object without sweep methods
      const bareRuntime = {
        releaseEscrow: jest.fn(),
        getTransaction: jest.fn(),
        getAllTransactions: jest.fn().mockResolvedValue([]),
        createTransaction: jest.fn(),
        transitionState: jest.fn(),
        linkEscrow: jest.fn(),
        mintTokens: jest.fn(),
      } as any;

      const settler = new SettleOnInteract(bareRuntime, providerAddress, 0);
      // Should not throw — just silently skip
      await settler.sweepNow();
      expect(bareRuntime.releaseEscrow).not.toHaveBeenCalled();
    });

    test('uses getExpiredDeliveredTransactions when available', async () => {
      const mockBlockchainRuntime = {
        getExpiredDeliveredTransactions: jest.fn().mockResolvedValue([
          { txId: '0xabc123' },
          { txId: '0xdef456' },
        ]),
        releaseEscrow: jest.fn().mockResolvedValue(undefined),
      } as any;

      const settler = new SettleOnInteract(mockBlockchainRuntime, providerAddress, 0);
      await settler.sweepNow();

      expect(mockBlockchainRuntime.getExpiredDeliveredTransactions).toHaveBeenCalledWith(providerAddress);
      expect(mockBlockchainRuntime.releaseEscrow).toHaveBeenCalledTimes(2);
      expect(mockBlockchainRuntime.releaseEscrow).toHaveBeenCalledWith('0xabc123');
      expect(mockBlockchainRuntime.releaseEscrow).toHaveBeenCalledWith('0xdef456');
    });
  });
});
