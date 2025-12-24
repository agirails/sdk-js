/**
 * Semaphore - Concurrency limiter for ACTP SDK
 *
 * SECURITY FIX (MEDIUM-4): Prevents unbounded concurrent execution
 * which could lead to resource exhaustion (memory/CPU DoS).
 *
 * @module utils/Semaphore
 */

/**
 * Simple semaphore for limiting concurrent operations
 *
 * Uses a FIFO queue to ensure fair scheduling of waiting tasks.
 */
export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private readonly waitQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  /**
   * Create a semaphore with specified concurrency limit
   *
   * @param maxPermits - Maximum concurrent permits (default: 10)
   * @throws Error if maxPermits is not positive
   */
  constructor(maxPermits: number = 10) {
    if (maxPermits <= 0 || !Number.isInteger(maxPermits)) {
      throw new Error(`maxPermits must be a positive integer, got: ${maxPermits}`);
    }
    this.maxPermits = maxPermits;
    this.permits = maxPermits;
  }

  /**
   * Acquire a permit, waiting if necessary
   *
   * @param timeoutMs - Optional timeout in milliseconds (0 = no timeout)
   * @returns Promise that resolves when permit is acquired
   * @throws Error if timeout is exceeded
   */
  async acquire(timeoutMs: number = 0): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // No permits available, queue the request
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waitQueue.push(waiter);

      // Set up timeout if specified
      if (timeoutMs > 0) {
        const timeoutId = setTimeout(() => {
          const index = this.waitQueue.indexOf(waiter);
          if (index >= 0) {
            this.waitQueue.splice(index, 1);
            reject(new Error(`Semaphore acquire timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs);

        // Clear timeout when resolved
        const originalResolve = waiter.resolve;
        waiter.resolve = () => {
          clearTimeout(timeoutId);
          originalResolve();
        };
      }
    });
  }

  /**
   * Try to acquire a permit without waiting
   *
   * @returns true if permit was acquired, false if none available
   */
  tryAcquire(): boolean {
    if (this.permits > 0) {
      this.permits--;
      return true;
    }
    return false;
  }

  /**
   * Release a permit
   *
   * @throws Error if releasing more permits than acquired
   */
  release(): void {
    if (this.permits >= this.maxPermits) {
      throw new Error('Cannot release: no permits held');
    }

    // If there are waiters, give permit to first in queue (FIFO)
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      waiter.resolve();
    } else {
      this.permits++;
    }
  }

  /**
   * Execute a function with semaphore protection
   *
   * Automatically acquires before execution and releases after,
   * even if the function throws.
   *
   * @param fn - Function to execute
   * @param timeoutMs - Optional timeout for acquiring permit
   * @returns Result of the function
   */
  async run<T>(fn: () => Promise<T> | T, timeoutMs: number = 0): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Get current available permits
   */
  get availablePermits(): number {
    return this.permits;
  }

  /**
   * Get number of waiters in queue
   */
  get queueLength(): number {
    return this.waitQueue.length;
  }

  /**
   * Get maximum permits
   */
  get limit(): number {
    return this.maxPermits;
  }

  /**
   * Check if semaphore is fully utilized
   */
  get isFull(): boolean {
    return this.permits === 0;
  }

  /**
   * Cancel all waiting tasks
   *
   * @param reason - Error message for rejected promises
   */
  cancelAll(reason: string = 'Semaphore cancelled'): void {
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      waiter.reject(new Error(reason));
    }
  }
}

/**
 * Rate limiter using sliding window algorithm
 *
 * SECURITY FIX (MEDIUM-4): Complements semaphore for rate-based limiting
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly windowMs: number;
  private readonly maxRequests: number;

  /**
   * Create a rate limiter
   *
   * @param maxRequests - Maximum requests per window
   * @param windowMs - Time window in milliseconds
   */
  constructor(maxRequests: number, windowMs: number) {
    if (maxRequests <= 0) {
      throw new Error('maxRequests must be positive');
    }
    if (windowMs <= 0) {
      throw new Error('windowMs must be positive');
    }
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request is allowed and record it
   *
   * @returns true if request is allowed, false if rate limited
   */
  tryAcquire(): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Remove timestamps outside the window
    while (this.timestamps.length > 0 && this.timestamps[0] < windowStart) {
      this.timestamps.shift();
    }

    // Check if we're at the limit
    if (this.timestamps.length >= this.maxRequests) {
      return false;
    }

    // Record this request
    this.timestamps.push(now);
    return true;
  }

  /**
   * Wait until a request is allowed
   *
   * @param timeoutMs - Optional timeout
   * @returns Promise that resolves when request is allowed
   */
  async acquire(timeoutMs: number = 0): Promise<void> {
    const startTime = Date.now();

    while (!this.tryAcquire()) {
      if (timeoutMs > 0 && Date.now() - startTime >= timeoutMs) {
        throw new Error(`Rate limiter timeout after ${timeoutMs}ms`);
      }

      // Wait a short time before retrying
      const waitTime = Math.min(100, this.timeUntilNextSlot());
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Get time until next slot is available
   *
   * @returns Milliseconds until next slot, or 0 if slot available
   */
  timeUntilNextSlot(): number {
    if (this.timestamps.length < this.maxRequests) {
      return 0;
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;
    const oldestTimestamp = this.timestamps[0];

    if (oldestTimestamp <= windowStart) {
      return 0;
    }

    return oldestTimestamp - windowStart;
  }

  /**
   * Get current usage stats
   */
  get stats(): { current: number; max: number; windowMs: number } {
    // Clean up old timestamps
    const now = Date.now();
    const windowStart = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < windowStart) {
      this.timestamps.shift();
    }

    return {
      current: this.timestamps.length,
      max: this.maxRequests,
      windowMs: this.windowMs,
    };
  }
}
