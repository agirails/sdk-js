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
/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
    /** Maximum requests per window */
    maxRequests: number;
    /** Time window in milliseconds */
    windowMs: number;
    /** Optional: Burst allowance (extra requests allowed briefly) */
    burstAllowance?: number;
}
/**
 * Rate limiter result
 */
export interface RateLimitResult {
    /** Whether the request is allowed */
    allowed: boolean;
    /** Remaining requests in current window */
    remaining: number;
    /** Time until window resets (ms) */
    resetIn: number;
    /** Suggested retry delay if not allowed */
    retryAfter?: number;
}
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
export declare class RateLimiter {
    private timestamps;
    private readonly config;
    constructor(config: RateLimiterConfig);
    /**
     * Try to acquire a rate limit slot
     *
     * @returns Rate limit result
     */
    tryAcquire(): RateLimitResult;
    /**
     * Wait until rate limit allows request
     *
     * @returns Promise that resolves when request is allowed
     */
    acquire(): Promise<void>;
    /**
     * Get current rate limit status
     */
    getStatus(): {
        used: number;
        remaining: number;
        resetIn: number;
    };
    /**
     * Reset the rate limiter
     */
    reset(): void;
}
/**
 * Circuit breaker states
 */
export type CircuitState = 'closed' | 'open' | 'half-open';
/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
    /** Number of failures before opening circuit */
    failureThreshold: number;
    /** Time to wait before trying again (ms) */
    recoveryTimeout: number;
    /** Number of successes in half-open needed to close circuit */
    successThreshold?: number;
    /** SECURITY FIX (MEDIUM-5): Timeout for half-open test (ms). If no result reported, auto-reset. Default: 30000 */
    halfOpenTestTimeout?: number;
}
/**
 * Circuit breaker result
 */
export interface CircuitBreakerResult {
    /** Whether the operation is allowed */
    allowed: boolean;
    /** Current circuit state */
    state: CircuitState;
    /** Number of consecutive failures */
    failures: number;
}
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
export declare class CircuitBreaker {
    private state;
    private failures;
    private successes;
    private lastFailureTime;
    private readonly config;
    private halfOpenTestInProgress;
    private halfOpenTestStartTime;
    constructor(config: CircuitBreakerConfig);
    /**
     * Check if operation can be executed
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): In half-open state, only allow ONE request
     * at a time to prevent overwhelming a recovering service.
     */
    canExecute(): CircuitBreakerResult;
    /**
     * Record a successful operation
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): Clears test-in-progress flag
     * SECURITY FIX (MEDIUM-5): Clears test start time
     */
    recordSuccess(): void;
    /**
     * Record a failed operation
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): Clears test-in-progress flag
     * SECURITY FIX (MEDIUM-5): Clears test start time
     */
    recordFailure(): void;
    /**
     * Get current circuit state
     */
    getState(): CircuitState;
    /**
     * Get detailed status
     */
    getStatus(): {
        state: CircuitState;
        failures: number;
        timeSinceLastFailure: number;
        recoveryTimeRemaining: number;
    };
    /**
     * Manually reset the circuit breaker
     *
     * SECURITY FIX (CIRCUIT-HALFOPEN): Also clears test-in-progress flag
     * SECURITY FIX (MEDIUM-5): Also clears test start time
     */
    reset(): void;
    /**
     * Execute a function with circuit breaker protection
     *
     * @param fn - Async function to execute
     * @returns Function result or throws if circuit is open
     */
    execute<T>(fn: () => Promise<T>): Promise<T>;
}
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
export declare class APIProtector {
    private readonly rateLimiter;
    private readonly circuitBreaker;
    constructor(config: {
        rateLimiter: RateLimiterConfig;
        circuitBreaker: CircuitBreakerConfig;
    });
    /**
     * Check if operation is allowed (both rate limit and circuit)
     */
    canExecute(): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Execute with both rate limiting and circuit breaker protection
     */
    execute<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Get combined status
     */
    getStatus(): {
        rateLimiter: ReturnType<RateLimiter['getStatus']>;
        circuitBreaker: ReturnType<CircuitBreaker['getStatus']>;
    };
    /**
     * Record success (for circuit breaker)
     */
    recordSuccess(): void;
    /**
     * Record failure (for circuit breaker)
     */
    recordFailure(): void;
    /**
     * Reset both protections
     */
    reset(): void;
}
//# sourceMappingURL=RateLimiter.d.ts.map