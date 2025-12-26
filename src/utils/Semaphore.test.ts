/**
 * Semaphore and RateLimiter (from Semaphore.ts) Test Suite
 *
 * Tests cover:
 * - Semaphore concurrency limiting
 * - Acquire/release semantics
 * - Timeout handling
 * - FIFO queue ordering
 * - Edge cases (invalid permits, over-release)
 *
 * @module utils/Semaphore.test
 */

import { Semaphore, RateLimiter } from './Semaphore';

describe('Semaphore', () => {
  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create with default 10 permits', () => {
      const sem = new Semaphore();
      expect(sem.limit).toBe(10);
      expect(sem.availablePermits).toBe(10);
    });

    it('should create with custom permits', () => {
      const sem = new Semaphore(5);
      expect(sem.limit).toBe(5);
      expect(sem.availablePermits).toBe(5);
    });

    it('should throw on zero permits', () => {
      expect(() => new Semaphore(0)).toThrow('maxPermits must be a positive integer');
    });

    it('should throw on negative permits', () => {
      expect(() => new Semaphore(-1)).toThrow('maxPermits must be a positive integer');
    });

    it('should throw on non-integer permits', () => {
      expect(() => new Semaphore(1.5)).toThrow('maxPermits must be a positive integer');
    });
  });

  // ============================================================================
  // Acquire Tests
  // ============================================================================

  describe('acquire()', () => {
    it('should acquire immediately when permits available', async () => {
      const sem = new Semaphore(2);

      await sem.acquire();

      expect(sem.availablePermits).toBe(1);
    });

    it('should acquire multiple permits', async () => {
      const sem = new Semaphore(3);

      await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      expect(sem.availablePermits).toBe(0);
      expect(sem.isFull).toBe(true);
    });

    it('should wait when no permits available', async () => {
      const sem = new Semaphore(1);
      await sem.acquire(); // Take the only permit

      let acquired = false;
      const acquirePromise = sem.acquire().then(() => {
        acquired = true;
      });

      // Hasn't acquired yet (blocked)
      await new Promise((r) => setTimeout(r, 10));
      expect(acquired).toBe(false);

      // Release permit
      sem.release();

      await acquirePromise;
      expect(acquired).toBe(true);
    });

    it('should respect timeout', async () => {
      const sem = new Semaphore(1);
      await sem.acquire(); // Take the only permit

      await expect(sem.acquire(50)).rejects.toThrow('Semaphore acquire timeout after 50ms');
    });

    it('should not leave dangling waiters on timeout', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      await expect(sem.acquire(10)).rejects.toThrow();

      // Queue should be empty after timeout
      expect(sem.queueLength).toBe(0);
    });
  });

  // ============================================================================
  // tryAcquire Tests
  // ============================================================================

  describe('tryAcquire()', () => {
    it('should return true when permit available', () => {
      const sem = new Semaphore(1);

      expect(sem.tryAcquire()).toBe(true);
      expect(sem.availablePermits).toBe(0);
    });

    it('should return false when no permit available', () => {
      const sem = new Semaphore(1);
      sem.tryAcquire();

      expect(sem.tryAcquire()).toBe(false);
    });

    it('should not block', () => {
      const sem = new Semaphore(1);
      sem.tryAcquire();

      const start = Date.now();
      sem.tryAcquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10); // Should be instant
    });
  });

  // ============================================================================
  // Release Tests
  // ============================================================================

  describe('release()', () => {
    it('should increase available permits', async () => {
      const sem = new Semaphore(2);
      await sem.acquire();
      expect(sem.availablePermits).toBe(1);

      sem.release();

      expect(sem.availablePermits).toBe(2);
    });

    it('should throw when releasing without holding permit', () => {
      const sem = new Semaphore(1);

      expect(() => sem.release()).toThrow('Cannot release: no permits held');
    });

    it('should wake up waiting tasks in FIFO order', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const order: number[] = [];

      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));
      const p3 = sem.acquire().then(() => order.push(3));

      // Release permits one by one
      sem.release();
      await p1;
      sem.release();
      await p2;
      sem.release();
      await p3;

      expect(order).toEqual([1, 2, 3]); // FIFO order
    });
  });

  // ============================================================================
  // run() Tests
  // ============================================================================

  describe('run()', () => {
    it('should execute function with semaphore protection', async () => {
      const sem = new Semaphore(1);

      const result = await sem.run(() => 42);

      expect(result).toBe(42);
      expect(sem.availablePermits).toBe(1); // Released after
    });

    it('should release permit even on error', async () => {
      const sem = new Semaphore(1);

      await expect(
        sem.run(() => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      expect(sem.availablePermits).toBe(1); // Still released
    });

    it('should handle async functions', async () => {
      const sem = new Semaphore(1);

      const result = await sem.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async result';
      });

      expect(result).toBe('async result');
    });

    it('should respect timeout parameter', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      await expect(sem.run(() => 42, 50)).rejects.toThrow('Semaphore acquire timeout');
    });
  });

  // ============================================================================
  // Property Tests
  // ============================================================================

  describe('Properties', () => {
    it('should report correct availablePermits', async () => {
      const sem = new Semaphore(3);

      expect(sem.availablePermits).toBe(3);
      await sem.acquire();
      expect(sem.availablePermits).toBe(2);
      await sem.acquire();
      expect(sem.availablePermits).toBe(1);
    });

    it('should report correct queueLength', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      expect(sem.queueLength).toBe(0);

      const p1 = sem.acquire();
      const p2 = sem.acquire();

      expect(sem.queueLength).toBe(2);

      sem.release();
      await p1;
      expect(sem.queueLength).toBe(1);

      sem.release();
      await p2;
      expect(sem.queueLength).toBe(0);
    });

    it('should report correct limit', () => {
      const sem = new Semaphore(5);
      expect(sem.limit).toBe(5);
    });

    it('should report isFull correctly', async () => {
      const sem = new Semaphore(2);

      expect(sem.isFull).toBe(false);
      await sem.acquire();
      expect(sem.isFull).toBe(false);
      await sem.acquire();
      expect(sem.isFull).toBe(true);
    });
  });

  // ============================================================================
  // cancelAll Tests
  // ============================================================================

  describe('cancelAll()', () => {
    it('should reject all waiting tasks', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const p1 = sem.acquire();
      const p2 = sem.acquire();

      sem.cancelAll('Test cancellation');

      await expect(p1).rejects.toThrow('Test cancellation');
      await expect(p2).rejects.toThrow('Test cancellation');
    });

    it('should use default reason if not provided', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const p = sem.acquire();
      sem.cancelAll();

      await expect(p).rejects.toThrow('Semaphore cancelled');
    });

    it('should empty the wait queue', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      sem.acquire().catch(() => {});
      sem.acquire().catch(() => {});
      expect(sem.queueLength).toBe(2);

      sem.cancelAll();

      expect(sem.queueLength).toBe(0);
    });
  });

  // ============================================================================
  // Concurrency Tests
  // ============================================================================

  describe('Concurrency', () => {
    it('should limit concurrent execution', async () => {
      const sem = new Semaphore(2);
      let concurrent = 0;
      let maxConcurrent = 0;

      const task = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      };

      const promises = Array(10)
        .fill(null)
        .map(() => sem.run(task));

      await Promise.all(promises);

      expect(maxConcurrent).toBe(2); // Never exceeded limit
    });
  });
});

describe('RateLimiter (from Semaphore.ts)', () => {
  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create with valid config', () => {
      const limiter = new RateLimiter(10, 1000);
      expect(limiter.stats.max).toBe(10);
    });

    it('should throw on invalid maxRequests', () => {
      expect(() => new RateLimiter(0, 1000)).toThrow('maxRequests must be positive');
      expect(() => new RateLimiter(-1, 1000)).toThrow('maxRequests must be positive');
    });

    it('should throw on invalid windowMs', () => {
      expect(() => new RateLimiter(10, 0)).toThrow('windowMs must be positive');
      expect(() => new RateLimiter(10, -1)).toThrow('windowMs must be positive');
    });
  });

  // ============================================================================
  // tryAcquire Tests
  // ============================================================================

  describe('tryAcquire()', () => {
    it('should allow requests within limit', () => {
      const limiter = new RateLimiter(3, 1000);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('should reject requests over limit', () => {
      const limiter = new RateLimiter(2, 1000);

      limiter.tryAcquire();
      limiter.tryAcquire();

      expect(limiter.tryAcquire()).toBe(false);
    });

    it('should reset after window expires', async () => {
      const limiter = new RateLimiter(1, 50);

      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);

      await new Promise((r) => setTimeout(r, 60));

      expect(limiter.tryAcquire()).toBe(true);
    });
  });

  // ============================================================================
  // acquire Tests
  // ============================================================================

  describe('acquire()', () => {
    it('should resolve immediately when under limit', async () => {
      const limiter = new RateLimiter(10, 1000);
      await limiter.acquire();
      expect(limiter.stats.current).toBe(1);
    });

    it('should wait when at limit', async () => {
      const limiter = new RateLimiter(1, 50);
      await limiter.acquire(); // First request

      const start = Date.now();
      await limiter.acquire(); // Should wait
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(40); // Waited for window
    });

    it('should respect timeout', async () => {
      const limiter = new RateLimiter(1, 1000);
      await limiter.acquire();

      await expect(limiter.acquire(50)).rejects.toThrow('Rate limiter timeout');
    });
  });

  // ============================================================================
  // timeUntilNextSlot Tests
  // ============================================================================

  describe('timeUntilNextSlot()', () => {
    it('should return 0 when under limit', () => {
      const limiter = new RateLimiter(10, 1000);
      expect(limiter.timeUntilNextSlot()).toBe(0);
    });

    it('should return positive value when at limit', () => {
      const limiter = new RateLimiter(1, 1000);
      limiter.tryAcquire();

      const waitTime = limiter.timeUntilNextSlot();
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(1000);
    });
  });

  // ============================================================================
  // stats Tests
  // ============================================================================

  describe('stats', () => {
    it('should return current usage', () => {
      const limiter = new RateLimiter(5, 1000);

      limiter.tryAcquire();
      limiter.tryAcquire();

      const stats = limiter.stats;
      expect(stats.current).toBe(2);
      expect(stats.max).toBe(5);
      expect(stats.windowMs).toBe(1000);
    });
  });
});
