"use strict";
/**
 * RateLimiter - Prevents excessive API/RPC calls
 *
 * SECURITY FIX (M-4): Rate limiting to prevent:
 * - API rate limit exhaustion
 * - Self-inflicted DoS
 * - Excessive RPC costs
 *
 * @module utils/RateLimiter
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.APIProtector = exports.CircuitBreaker = exports.RateLimiter = void 0;
/**
 * Simple sliding window rate limiter
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({ maxRequests: 10, windowMs: 1000 });
 *
 * const result = limiter.tryAcquire();
 * if (!result.allowed) {
 *   console.log(`Rate limited. Retry after ${result.retryAfter}ms`);
 * }
 * ```
 */
class RateLimiter {
    constructor(config) {
        this.timestamps = [];
        this.config = {
            maxRequests: config.maxRequests,
            windowMs: config.windowMs,
            burstAllowance: config.burstAllowance ?? 0,
        };
    }
    /**
     * Try to acquire a rate limit slot
     *
     * @returns Rate limit result
     */
    tryAcquire() {
        const now = Date.now();
        const windowStart = now - this.config.windowMs;
        // Remove expired timestamps
        this.timestamps = this.timestamps.filter((ts) => ts > windowStart);
        const effectiveLimit = this.config.maxRequests + this.config.burstAllowance;
        if (this.timestamps.length < effectiveLimit) {
            this.timestamps.push(now);
            return {
                allowed: true,
                remaining: effectiveLimit - this.timestamps.length,
                resetIn: this.timestamps.length > 0
                    ? this.timestamps[0] + this.config.windowMs - now
                    : this.config.windowMs,
            };
        }
        // Rate limited
        const oldestTimestamp = this.timestamps[0];
        const retryAfter = oldestTimestamp + this.config.windowMs - now;
        return {
            allowed: false,
            remaining: 0,
            resetIn: retryAfter,
            retryAfter: Math.max(0, retryAfter),
        };
    }
    /**
     * Wait until rate limit allows request
     *
     * @returns Promise that resolves when request is allowed
     */
    async acquire() {
        const result = this.tryAcquire();
        if (result.allowed) {
            return;
        }
        // Wait and retry
        await new Promise((resolve) => setTimeout(resolve, result.retryAfter));
        return this.acquire();
    }
    /**
     * Get current rate limit status
     */
    getStatus() {
        const now = Date.now();
        const windowStart = now - this.config.windowMs;
        // Clean up expired timestamps
        this.timestamps = this.timestamps.filter((ts) => ts > windowStart);
        const effectiveLimit = this.config.maxRequests + this.config.burstAllowance;
        const used = this.timestamps.length;
        const remaining = Math.max(0, effectiveLimit - used);
        const resetIn = this.timestamps.length > 0
            ? this.timestamps[0] + this.config.windowMs - now
            : this.config.windowMs;
        return { used, remaining, resetIn };
    }
    /**
     * Reset the rate limiter
     */
    reset() {
        this.timestamps = [];
    }
}
exports.RateLimiter = RateLimiter;
/**
 * Circuit Breaker - Prevents cascading failures
 *
 * SECURITY FIX (M-5): Circuit breaker to:
 * - Prevent repeated calls to failing services
 * - Allow systems to recover
 * - Provide graceful degradation
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit tripped, requests fail fast
 * - HALF-OPEN: Testing if service recovered
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({
 *   failureThreshold: 5,
 *   recoveryTimeout: 30000
 * });
 *
 * async function callService() {
 *   const result = breaker.canExecute();
 *   if (!result.allowed) {
 *     throw new Error(`Circuit open. Try again later.`);
 *   }
 *
 *   try {
 *     const response = await riskyOperation();
 *     breaker.recordSuccess();
 *     return response;
 *   } catch (error) {
 *     breaker.recordFailure();
 *     throw error;
 *   }
 * }
 * ```
 */
class CircuitBreaker {
    constructor(config) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = 0;
        // SECURITY FIX (CIRCUIT-HALFOPEN): Track if a test request is in progress
        // Half-open state should only allow ONE request at a time to test service recovery
        this.halfOpenTestInProgress = false;
        // SECURITY FIX (MEDIUM-5): Track when half-open test started for timeout detection
        this.halfOpenTestStartTime = 0;
        this.config = {
            failureThreshold: config.failureThreshold,
            recoveryTimeout: config.recoveryTimeout,
            successThreshold: config.successThreshold ?? 1,
            // SECURITY FIX (MEDIUM-5): Default 30 second timeout for half-open tests
            halfOpenTestTimeout: config.halfOpenTestTimeout ?? 30000,
        };
    }
    /**
     * Check if operation can be executed
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): In half-open state, only allow ONE request
     * at a time to prevent overwhelming a recovering service.
     */
    canExecute() {
        const now = Date.now();
        switch (this.state) {
            case 'closed':
                return {
                    allowed: true,
                    state: this.state,
                    failures: this.failures,
                };
            case 'open':
                // Check if recovery timeout has passed
                if (now - this.lastFailureTime >= this.config.recoveryTimeout) {
                    this.state = 'half-open';
                    this.successes = 0;
                    // SECURITY FIX (HIGH-7): Removed duplicate assignment (was setting false then true)
                    // SECURITY FIX (CIRCUIT-HALFOPEN): Mark test as in progress for first allowed request
                    this.halfOpenTestInProgress = true;
                    // SECURITY FIX (MEDIUM-5): Record when test started for timeout detection
                    this.halfOpenTestStartTime = now;
                    return {
                        allowed: true,
                        state: this.state,
                        failures: this.failures,
                    };
                }
                return {
                    allowed: false,
                    state: this.state,
                    failures: this.failures,
                };
            case 'half-open':
                // SECURITY FIX (MEDIUM-5): Check if test has timed out (caller never reported result)
                // This prevents the circuit breaker from getting stuck if caller crashes/forgets to report
                if (this.halfOpenTestInProgress && this.halfOpenTestStartTime > 0) {
                    const testDuration = now - this.halfOpenTestStartTime;
                    if (testDuration >= this.config.halfOpenTestTimeout) {
                        // Timeout: reset the test flag and allow a new test
                        this.halfOpenTestInProgress = false;
                        this.halfOpenTestStartTime = 0;
                    }
                }
                // SECURITY FIX (CIRCUIT-HALFOPEN): Only allow if no test is in progress
                // This prevents multiple concurrent requests from overwhelming a recovering service
                if (this.halfOpenTestInProgress) {
                    return {
                        allowed: false,
                        state: this.state,
                        failures: this.failures,
                    };
                }
                // Mark test as in progress
                this.halfOpenTestInProgress = true;
                // SECURITY FIX (MEDIUM-5): Record when test started
                this.halfOpenTestStartTime = now;
                return {
                    allowed: true,
                    state: this.state,
                    failures: this.failures,
                };
        }
    }
    /**
     * Record a successful operation
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): Clears test-in-progress flag
     * SECURITY FIX (MEDIUM-5): Clears test start time
     */
    recordSuccess() {
        if (this.state === 'half-open') {
            // SECURITY FIX (CIRCUIT-HALFOPEN): Clear test flag
            this.halfOpenTestInProgress = false;
            // SECURITY FIX (MEDIUM-5): Clear test start time
            this.halfOpenTestStartTime = 0;
            this.successes++;
            if (this.successes >= this.config.successThreshold) {
                this.state = 'closed';
                this.failures = 0;
                this.successes = 0;
            }
        }
        else if (this.state === 'closed') {
            // Reset failure count on success
            this.failures = 0;
        }
    }
    /**
     * Record a failed operation
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): Clears test-in-progress flag
     * SECURITY FIX (MEDIUM-5): Clears test start time
     */
    recordFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        if (this.state === 'half-open') {
            // SECURITY FIX (CIRCUIT-HALFOPEN): Clear test flag before opening
            this.halfOpenTestInProgress = false;
            // SECURITY FIX (MEDIUM-5): Clear test start time
            this.halfOpenTestStartTime = 0;
            // Immediately open on failure in half-open state
            this.state = 'open';
        }
        else if (this.state === 'closed' && this.failures >= this.config.failureThreshold) {
            this.state = 'open';
        }
    }
    /**
     * Get current circuit state
     */
    getState() {
        // Check for automatic transition from open to half-open
        if (this.state === 'open') {
            const now = Date.now();
            if (now - this.lastFailureTime >= this.config.recoveryTimeout) {
                this.state = 'half-open';
                this.successes = 0;
            }
        }
        return this.state;
    }
    /**
     * Get detailed status
     */
    getStatus() {
        const now = Date.now();
        const timeSinceLastFailure = this.lastFailureTime > 0
            ? now - this.lastFailureTime
            : 0;
        const recoveryTimeRemaining = this.state === 'open'
            ? Math.max(0, this.config.recoveryTimeout - timeSinceLastFailure)
            : 0;
        return {
            state: this.getState(),
            failures: this.failures,
            timeSinceLastFailure,
            recoveryTimeRemaining,
        };
    }
    /**
     * Manually reset the circuit breaker
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): Also clears test-in-progress flag
     * SECURITY FIX (MEDIUM-5): Also clears test start time
     */
    reset() {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = 0;
        this.halfOpenTestInProgress = false;
        this.halfOpenTestStartTime = 0;
    }
    /**
     * Execute a function with circuit breaker protection
     *
     * @param fn - Async function to execute
     * @returns Function result or throws if circuit is open
     */
    async execute(fn) {
        const result = this.canExecute();
        if (!result.allowed) {
            throw new Error(`Circuit breaker is open (${this.failures} failures). ` +
                `Recovery in ${this.getStatus().recoveryTimeRemaining}ms.`);
        }
        try {
            const response = await fn();
            this.recordSuccess();
            return response;
        }
        catch (error) {
            this.recordFailure();
            throw error;
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
/**
 * Combined rate limiter and circuit breaker for API protection
 *
 * @example
 * ```typescript
 * const protector = new APIProtector({
 *   rateLimiter: { maxRequests: 100, windowMs: 60000 },
 *   circuitBreaker: { failureThreshold: 5, recoveryTimeout: 30000 }
 * });
 *
 * const result = await protector.execute(async () => {
 *   return await apiCall();
 * });
 * ```
 */
class APIProtector {
    constructor(config) {
        this.rateLimiter = new RateLimiter(config.rateLimiter);
        this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    }
    /**
     * Check if operation is allowed (both rate limit and circuit)
     */
    canExecute() {
        // Check circuit breaker first
        const circuitResult = this.circuitBreaker.canExecute();
        if (!circuitResult.allowed) {
            return {
                allowed: false,
                reason: `Circuit breaker open (${circuitResult.failures} failures)`,
            };
        }
        // Check rate limiter
        const rateResult = this.rateLimiter.tryAcquire();
        if (!rateResult.allowed) {
            return {
                allowed: false,
                reason: `Rate limited. Retry after ${rateResult.retryAfter}ms`,
            };
        }
        return { allowed: true };
    }
    /**
     * Execute with both rate limiting and circuit breaker protection
     */
    async execute(fn) {
        // Wait for rate limit
        await this.rateLimiter.acquire();
        // Execute with circuit breaker
        return this.circuitBreaker.execute(fn);
    }
    /**
     * Get combined status
     */
    getStatus() {
        return {
            rateLimiter: this.rateLimiter.getStatus(),
            circuitBreaker: this.circuitBreaker.getStatus(),
        };
    }
    /**
     * Record success (for circuit breaker)
     */
    recordSuccess() {
        this.circuitBreaker.recordSuccess();
    }
    /**
     * Record failure (for circuit breaker)
     */
    recordFailure() {
        this.circuitBreaker.recordFailure();
    }
    /**
     * Reset both protections
     */
    reset() {
        this.rateLimiter.reset();
        this.circuitBreaker.reset();
    }
}
exports.APIProtector = APIProtector;
//# sourceMappingURL=RateLimiter.js.map