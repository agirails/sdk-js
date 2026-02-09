/**
 * DualNonceManager Tests
 *
 * Tests cover:
 * - Sequential execution via mutex
 * - ACTP nonce increment on success
 * - ACTP nonce reset on failure
 * - Concurrent safety
 *
 * Uses a TestableNonceManager that overrides chain reads with mocks.
 */

import { DualNonceManager } from './DualNonceManager';

/**
 * Creates a test-friendly DualNonceManager that overrides
 * private chain-read methods via prototype patching.
 */
function createTestManager() {
  const manager = new (DualNonceManager as any)(
    null, // provider
    '0x' + '11'.repeat(20), // sender
    '0x' + '22'.repeat(20) // kernel
  ) as DualNonceManager;

  let entryPointNonce = 0n;
  let actpNonce = 5n;

  // Override the private methods
  (manager as any).readEntryPointNonce = async () => entryPointNonce;
  (manager as any).readActpNonce = async () => {
    (manager as any).cachedActpNonce = actpNonce;
    return actpNonce;
  };

  return {
    manager,
    setEntryPointNonce(v: bigint) { entryPointNonce = v; },
    setActpNonce(v: bigint) { actpNonce = v; },
  };
}

describe('DualNonceManager', () => {
  describe('enqueue()', () => {
    it('should provide both nonces to callback', async () => {
      const { manager } = createTestManager();

      const nonces = await manager.enqueue(async ({ entryPointNonce, actpNonce }) => ({
        result: { entryPointNonce, actpNonce },
        success: true,
      }));

      expect(nonces.entryPointNonce).toBe(0n);
      expect(nonces.actpNonce).toBe(5n);
    });

    it('should increment ACTP nonce on success when flag is true', async () => {
      const { manager } = createTestManager();

      // First call — reads from chain (5)
      await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        true
      );

      // Second call — should use cached (6)
      const nonce = await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        true
      );

      expect(nonce).toBe(6n);
    });

    it('should NOT increment ACTP nonce when flag is false', async () => {
      const { manager } = createTestManager();

      await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        false
      );

      const nonce = await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        false
      );

      expect(nonce).toBe(5n);
    });

    it('should reset ACTP nonce on failure', async () => {
      const { manager } = createTestManager();

      // First call succeeds — caches nonce 6
      await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        true
      );

      // Second call fails — resets cache
      await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: false }),
        true
      );

      // Third call re-reads from chain (5)
      const nonce = await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        true
      );

      expect(nonce).toBe(5n);
    });

    it('should reset ACTP nonce on thrown error', async () => {
      const { manager } = createTestManager();

      // First call succeeds
      await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        true
      );

      // Second call throws
      await expect(
        manager.enqueue(async () => {
          throw new Error('tx failed');
        }, true)
      ).rejects.toThrow('tx failed');

      // Third call re-reads from chain
      const nonce = await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        true
      );

      expect(nonce).toBe(5n);
    });

    it('should execute sequentially (mutex)', async () => {
      const { manager } = createTestManager();
      const order: number[] = [];

      const p1 = manager.enqueue(async () => {
        await sleep(50);
        order.push(1);
        return { result: 1, success: true };
      }, false);

      const p2 = manager.enqueue(async () => {
        await sleep(10);
        order.push(2);
        return { result: 2, success: true };
      }, false);

      const p3 = manager.enqueue(async () => {
        order.push(3);
        return { result: 3, success: true };
      }, false);

      await Promise.all([p1, p2, p3]);

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('invalidateCache()', () => {
    it('should force re-read on next enqueue', async () => {
      const { manager, setActpNonce } = createTestManager();

      // Read and cache
      await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        true
      );

      // Change on-chain value
      setActpNonce(10n);

      // Invalidate cache
      manager.invalidateCache();

      // Should re-read from chain (10)
      const nonce = await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        false
      );

      expect(nonce).toBe(10n);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
