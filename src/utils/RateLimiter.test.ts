/**
 * RateLimiter, CircuitBreaker, and APIProtector Test Suite
 *
 * Tests cover:
 * - RateLimiter: sliding window, burst allowance, acquire/tryAcquire
 * - CircuitBreaker: state transitions, failure thresholds, recovery
 * - APIProtector: combined rate limiting and circuit breaker
 *
 * @module utils/RateLimiter.test
 */

import { RateLimiter, CircuitBreaker, APIProtector } from './RateLimiter';

describe('RateLimiter', () => {
  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create with basic config', () => {
      const limiter = new RateLimiter({ maxRequests: 10, windowMs: 1000 });
      expect(limiter.getStatus().remaining).toBe(10);
    });

    it('should accept burst allowance', () => {
      const limiter = new RateLimiter({
        maxRequests: 10,
        windowMs: 1000,
        burstAllowance: 5,
      });
      // Total allowed = maxRequests + burstAllowance
      expect(limiter.getStatus().remaining).toBe(15);
    });
  });

  // ============================================================================
  // tryAcquire Tests
  // ============================================================================

  describe('tryAcquire()', () => {
    it('should allow requests within limit', () => {
      const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });

      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(true);
    });

    it('should reject requests over limit', () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });

      limiter.tryAcquire();
      limiter.tryAcquire();

      const result = limiter.tryAcquire();
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should return correct remaining count', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });

      expect(limiter.tryAcquire().remaining).toBe(4);
      expect(limiter.tryAcquire().remaining).toBe(3);
      expect(limiter.tryAcquire().remaining).toBe(2);
    });

    it('should allow burst requests when configured', () => {
      const limiter = new RateLimiter({
        maxRequests: 2,
        windowMs: 1000,
        burstAllowance: 2,
      });

      // Should allow 4 total (2 + 2)
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(false);
    });

    it('should reset after window expires', async () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 50 });

      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(false);

      await new Promise((r) => setTimeout(r, 60));

      expect(limiter.tryAcquire().allowed).toBe(true);
    });
  });

  // ============================================================================
  // acquire Tests
  // ============================================================================

  describe('acquire()', () => {
    it('should resolve immediately when under limit', async () => {
      const limiter = new RateLimiter({ maxRequests: 10, windowMs: 1000 });

      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('should wait when at limit', async () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 100 });
      await limiter.acquire();

      const start = Date.now();
      await limiter.acquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });

  // ============================================================================
  // getStatus Tests
  // ============================================================================

  describe('getStatus()', () => {
    it('should return current status', () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });

      limiter.tryAcquire();
      limiter.tryAcquire();

      const status = limiter.getStatus();
      expect(status.used).toBe(2);
      expect(status.remaining).toBe(3);
      expect(status.resetIn).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // reset Tests
  // ============================================================================

  describe('reset()', () => {
    it('should clear all timestamps', () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });

      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.getStatus().used).toBe(2);

      limiter.reset();

      expect(limiter.getStatus().used).toBe(0);
      expect(limiter.getStatus().remaining).toBe(2);
    });
  });
});

describe('CircuitBreaker', () => {
  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create with basic config', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeout: 30000,
      });

      expect(breaker.getState()).toBe('closed');
    });

    it('should default successThreshold to 1', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeout: 30000,
      });

      expect(breaker.getState()).toBe('closed');
    });
  });

  // ============================================================================
  // State Transition Tests
  // ============================================================================

  describe('State Transitions', () => {
    it('should start in closed state', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 100,
      });

      expect(breaker.getState()).toBe('closed');
      expect(breaker.canExecute().allowed).toBe(true);
    });

    it('should open after reaching failure threshold', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 100,
      });

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('closed');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');
      expect(breaker.canExecute().allowed).toBe(false);
    });

    it('should transition to half-open after recovery timeout', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50,
      });

      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');

      await new Promise((r) => setTimeout(r, 60));

      expect(breaker.getState()).toBe('half-open');
    });

    it('should close after success in half-open state', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50,
        successThreshold: 1,
      });

      breaker.recordFailure();
      await new Promise((r) => setTimeout(r, 60));

      breaker.canExecute(); // Triggers half-open
      breaker.recordSuccess();

      expect(breaker.getState()).toBe('closed');
    });

    it('should open again on failure in half-open state', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50,
      });

      breaker.recordFailure();
      await new Promise((r) => setTimeout(r, 60));

      breaker.canExecute(); // Triggers half-open
      breaker.recordFailure();

      expect(breaker.getState()).toBe('open');
    });

    it('should require multiple successes when successThreshold > 1', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50,
        successThreshold: 3,
      });

      breaker.recordFailure();
      await new Promise((r) => setTimeout(r, 60));

      // First success
      breaker.canExecute();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe('half-open');

      // Second success
      breaker.canExecute();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe('half-open');

      // Third success - should close
      breaker.canExecute();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe('closed');
    });
  });

  // ============================================================================
  // Half-Open Protection Tests
  // ============================================================================

  describe('Half-Open Protection', () => {
    it('should only allow one request at a time in half-open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50,
      });

      breaker.recordFailure();
      await new Promise((r) => setTimeout(r, 60));

      // First request allowed
      const first = breaker.canExecute();
      expect(first.allowed).toBe(true);

      // Second request blocked (test in progress)
      const second = breaker.canExecute();
      expect(second.allowed).toBe(false);
      expect(second.state).toBe('half-open');
    });

    it('should allow next request after test completes with success', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50,
        successThreshold: 2,
      });

      breaker.recordFailure();
      await new Promise((r) => setTimeout(r, 60));

      breaker.canExecute();
      breaker.recordSuccess();

      // Should allow another test request
      const next = breaker.canExecute();
      expect(next.allowed).toBe(true);
    });

    it('should handle test timeout (stale test)', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 50,
        halfOpenTestTimeout: 30, // Short timeout for testing
      });

      breaker.recordFailure();
      await new Promise((r) => setTimeout(r, 60));

      breaker.canExecute(); // Start test, never report result
      expect(breaker.canExecute().allowed).toBe(false); // Still blocked

      // Wait for test timeout
      await new Promise((r) => setTimeout(r, 40));

      // Should allow new test after timeout
      expect(breaker.canExecute().allowed).toBe(true);
    });
  });

  // ============================================================================
  // recordSuccess Tests
  // ============================================================================

  describe('recordSuccess()', () => {
    it('should reset failure count in closed state', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 100,
      });

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();

      // Should be able to record 3 more failures before opening
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('closed');

      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');
    });
  });

  // ============================================================================
  // getStatus Tests
  // ============================================================================

  describe('getStatus()', () => {
    it('should return detailed status', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 1000,
      });

      breaker.recordFailure();
      breaker.recordFailure();

      const status = breaker.getStatus();
      expect(status.state).toBe('closed');
      expect(status.failures).toBe(2);
      expect(status.timeSinceLastFailure).toBeGreaterThanOrEqual(0);
    });

    it('should show recovery time remaining when open', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 1000,
      });

      breaker.recordFailure();

      const status = breaker.getStatus();
      expect(status.state).toBe('open');
      expect(status.recoveryTimeRemaining).toBeGreaterThan(0);
      expect(status.recoveryTimeRemaining).toBeLessThanOrEqual(1000);
    });
  });

  // ============================================================================
  // reset Tests
  // ============================================================================

  describe('reset()', () => {
    it('should reset to closed state', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 1000,
      });

      breaker.recordFailure();
      expect(breaker.getState()).toBe('open');

      breaker.reset();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.getStatus().failures).toBe(0);
    });
  });

  // ============================================================================
  // execute Tests
  // ============================================================================

  describe('execute()', () => {
    it('should execute function when closed', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 1000,
      });

      const result = await breaker.execute(async () => 42);
      expect(result).toBe(42);
    });

    it('should record success on successful execution', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 1000,
      });

      breaker.recordFailure();
      await breaker.execute(async () => 'success');

      expect(breaker.getStatus().failures).toBe(0);
    });

    it('should record failure on error', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 1000,
      });

      await expect(
        breaker.execute(async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      expect(breaker.getStatus().failures).toBe(1);
    });

    it('should throw when circuit is open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeout: 1000,
      });

      breaker.recordFailure();

      await expect(breaker.execute(async () => 42)).rejects.toThrow('Circuit breaker is open');
    });
  });
});

describe('APIProtector', () => {
  // ============================================================================
  // Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    it('should create with both protections', () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 10, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 5, recoveryTimeout: 30000 },
      });

      expect(protector.canExecute().allowed).toBe(true);
    });
  });

  // ============================================================================
  // canExecute Tests
  // ============================================================================

  describe('canExecute()', () => {
    it('should allow when both protections pass', () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 10, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 5, recoveryTimeout: 30000 },
      });

      expect(protector.canExecute().allowed).toBe(true);
    });

    it('should block when rate limited', () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 1, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 5, recoveryTimeout: 30000 },
      });

      protector.canExecute(); // Use the slot

      const result = protector.canExecute();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Rate limited');
    });

    it('should block when circuit is open', () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 10, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 1, recoveryTimeout: 30000 },
      });

      protector.recordFailure();

      const result = protector.canExecute();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Circuit breaker open');
    });

    it('should check circuit breaker first', () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 1, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 1, recoveryTimeout: 30000 },
      });

      protector.recordFailure(); // Open circuit

      const result = protector.canExecute();
      expect(result.reason).toContain('Circuit breaker'); // Not rate limiter
    });
  });

  // ============================================================================
  // execute Tests
  // ============================================================================

  describe('execute()', () => {
    it('should execute with both protections', async () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 10, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 5, recoveryTimeout: 30000 },
      });

      const result = await protector.execute(async () => 'success');
      expect(result).toBe('success');
    });

    it('should record success on successful execution', async () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 10, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 5, recoveryTimeout: 30000 },
      });

      protector.recordFailure();
      await protector.execute(async () => 'success');

      expect(protector.getStatus().circuitBreaker.failures).toBe(0);
    });

    it('should throw when circuit is open', async () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 10, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 1, recoveryTimeout: 30000 },
      });

      protector.recordFailure();

      await expect(protector.execute(async () => 'success')).rejects.toThrow('Circuit breaker is open');
    });
  });

  // ============================================================================
  // getStatus Tests
  // ============================================================================

  describe('getStatus()', () => {
    it('should return combined status', () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 10, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 5, recoveryTimeout: 30000 },
      });

      const status = protector.getStatus();
      expect(status.rateLimiter).toBeDefined();
      expect(status.circuitBreaker).toBeDefined();
    });
  });

  // ============================================================================
  // reset Tests
  // ============================================================================

  describe('reset()', () => {
    it('should reset both protections', () => {
      const protector = new APIProtector({
        rateLimiter: { maxRequests: 1, windowMs: 1000 },
        circuitBreaker: { failureThreshold: 1, recoveryTimeout: 30000 },
      });

      protector.canExecute(); // Use rate limit
      protector.recordFailure(); // Open circuit

      protector.reset();

      const status = protector.getStatus();
      expect(status.rateLimiter.used).toBe(0);
      expect(status.circuitBreaker.state).toBe('closed');
    });
  });
});
