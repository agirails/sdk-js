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

  describe('setCachedActpNonce()', () => {
    it('should use overridden cached nonce on next enqueue', async () => {
      const { manager } = createTestManager();

      manager.setCachedActpNonce(42n);

      const nonce = await manager.enqueue(
        async ({ actpNonce }) => ({ result: actpNonce, success: true }),
        false
      );

      expect(nonce).toBe(42n);
    });
  });

  describe('event-derived nonce helpers', () => {
    it('findContractDeploymentBlock() should binary-search and cache deployment block', async () => {
      const deploymentBlock = 42;

      const provider: any = {
        getCode: jest.fn(async (_address: string, blockTag: number) => {
          return blockTag >= deploymentBlock ? '0x1234' : '0x';
        }),
      };

      const manager = new (DualNonceManager as any)(
        provider,
        '0x' + '11'.repeat(20),
        '0x' + '22'.repeat(20)
      ) as any;

      const first = await manager.findContractDeploymentBlock(100);
      expect(first).toBe(deploymentBlock);

      const callCountAfterFirst = provider.getCode.mock.calls.length;
      const second = await manager.findContractDeploymentBlock(200);
      expect(second).toBe(deploymentBlock);
      expect(provider.getCode.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('constructor with knownDeploymentBlock seeds cache and skips binary search', async () => {
      const deploymentBlock = 12345;
      const provider: any = {
        getCode: jest.fn(async (_address: string, blockTag: number) => {
          return blockTag >= deploymentBlock ? '0x1234' : '0x';
        }),
      };

      const manager = new (DualNonceManager as any)(
        provider,
        '0x' + '11'.repeat(20),
        '0x' + '22'.repeat(20),
        deploymentBlock
      ) as any;

      expect(manager.cachedKernelDeploymentBlock).toBe(12345);

      const result = await manager.findContractDeploymentBlock(99999);
      expect(result).toBe(12345);
      // Two validation calls: getCode at hint + getCode at hint-1
      expect(provider.getCode).toHaveBeenCalledTimes(2);
    });

    it('invalid knownDeploymentBlock falls back to binary search', async () => {
      const realDeploymentBlock = 42;
      const provider: any = {
        getCode: jest.fn(async (_address: string, blockTag: number) => {
          return blockTag >= realDeploymentBlock ? '0x1234' : '0x';
        }),
      };

      const manager = new (DualNonceManager as any)(
        provider,
        '0x' + '11'.repeat(20),
        '0x' + '22'.repeat(20),
        10 // wrong — before real deployment (42), so getCode returns '0x'
      ) as any;

      // Should validate, find no code at block 10, and fall back to binary search
      const result = await manager.findContractDeploymentBlock(100);
      expect(result).toBe(realDeploymentBlock);
      // First call is validation (getCode at 10), then binary search kicks in
      expect(provider.getCode.mock.calls[0][1]).toBe(10);
      expect(provider.getCode.mock.calls.length).toBeGreaterThan(2);
    });

    it('too-high knownDeploymentBlock falls back to binary search', async () => {
      const realDeploymentBlock = 42;
      const provider: any = {
        getCode: jest.fn(async (_address: string, blockTag: number) => {
          return blockTag >= realDeploymentBlock ? '0x1234' : '0x';
        }),
      };

      // Hint is 80 — code exists there, but also at block 79 (too high)
      const manager = new (DualNonceManager as any)(
        provider,
        '0x' + '11'.repeat(20),
        '0x' + '22'.repeat(20),
        80
      ) as any;

      const result = await manager.findContractDeploymentBlock(100);
      expect(result).toBe(realDeploymentBlock);
      // Calls: getCode(80) = '0x1234', getCode(79) = '0x1234' → too high → binary search
      expect(provider.getCode.mock.calls[0][1]).toBe(80);
      expect(provider.getCode.mock.calls[1][1]).toBe(79);
      expect(provider.getCode.mock.calls.length).toBeGreaterThan(3);
    });

    it('countRequesterTransactionCreatedEvents() should reduce chunk size on RPC range errors', async () => {
      const provider: any = {
        getLogs: jest.fn(async (filter: { fromBlock: number; toBlock: number }) => {
          const span = Number(filter.toBlock) - Number(filter.fromBlock) + 1;
          if (span > 1500) {
            throw new Error('range too large');
          }
          return [{}];
        }),
      };

      const manager = new (DualNonceManager as any)(
        provider,
        '0x' + '11'.repeat(20),
        '0x' + '22'.repeat(20)
      ) as any;

      const logs = await manager.countRequesterTransactionCreatedEvents(0, 3999);
      expect(logs).toHaveLength(4);
      expect(provider.getLogs.mock.calls.length).toBeGreaterThan(4);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
