/**
 * Circuit Breaker - Gateway Health Tracking (Retry Amplification Protection)
 *
 * Implements the Circuit Breaker pattern for storage gateways:
 * - Tracks consecutive failures per gateway
 * - "Opens" circuit after threshold failures (blocks requests)
 * - Auto-resets after cooldown period
 *
 * This prevents retry amplification attacks where a malicious/failing
 * gateway causes excessive retries.
 *
 * @module utils/circuitBreaker
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Circuit state
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Gateway health record
 */
interface GatewayHealth {
  /** Consecutive failure count */
  failures: number;
  /** Timestamp of last failure */
  lastFailure: number;
  /** Current circuit state */
  state: CircuitState;
  /** Timestamp when circuit opened */
  openedAt?: number;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold?: number;

  /** Cooldown period in ms before attempting reset (default: 60000 = 1 min) */
  resetTimeoutMs?: number;

  /** Time window in ms for counting failures (default: 300000 = 5 min) */
  failureWindowMs?: number;

  /** Number of successes in half-open to close circuit (default: 2) */
  successThreshold?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 60000; // 1 minute
const DEFAULT_FAILURE_WINDOW_MS = 300000; // 5 minutes
const DEFAULT_SUCCESS_THRESHOLD = 2;

// ============================================================================
// GatewayCircuitBreaker Class
// ============================================================================

/**
 * Circuit Breaker for gateway health management
 *
 * Usage:
 * ```typescript
 * const circuitBreaker = new GatewayCircuitBreaker();
 *
 * // Before making request
 * if (!circuitBreaker.isHealthy(gatewayUrl)) {
 *   throw new Error('Gateway circuit open');
 * }
 *
 * try {
 *   const result = await fetchFromGateway(gatewayUrl);
 *   circuitBreaker.recordSuccess(gatewayUrl);
 *   return result;
 * } catch (error) {
 *   circuitBreaker.recordFailure(gatewayUrl);
 *   throw error;
 * }
 * ```
 */
export class GatewayCircuitBreaker {
  private readonly health = new Map<string, GatewayHealth>();
  private readonly config: Required<CircuitBreakerConfig>;
  private halfOpenSuccesses = new Map<string, number>();

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      resetTimeoutMs: config.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS,
      failureWindowMs: config.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS,
      successThreshold: config.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD
    };
  }

  /**
   * Check if gateway is healthy (circuit closed or half-open)
   *
   * @param url - Gateway URL
   * @returns true if requests should be allowed
   */
  isHealthy(url: string): boolean {
    const state = this.getState(url);
    return state !== 'OPEN';
  }

  /**
   * Get current circuit state for gateway
   *
   * @param url - Gateway URL
   * @returns Circuit state
   */
  getState(url: string): CircuitState {
    const health = this.health.get(url);

    if (!health) {
      return 'CLOSED';
    }

    // Check if circuit should transition from OPEN to HALF_OPEN
    if (health.state === 'OPEN') {
      const timeSinceOpen = Date.now() - (health.openedAt || 0);
      if (timeSinceOpen >= this.config.resetTimeoutMs) {
        // Transition to half-open
        health.state = 'HALF_OPEN';
        this.halfOpenSuccesses.set(url, 0);
      }
    }

    // Check if failures have expired (outside window)
    if (health.state === 'CLOSED') {
      const timeSinceLastFailure = Date.now() - health.lastFailure;
      if (timeSinceLastFailure >= this.config.failureWindowMs) {
        // Reset failure count
        health.failures = 0;
      }
    }

    return health.state;
  }

  /**
   * Record a successful request
   *
   * @param url - Gateway URL
   */
  recordSuccess(url: string): void {
    const health = this.health.get(url);

    if (!health) {
      return; // No failures recorded, nothing to do
    }

    if (health.state === 'HALF_OPEN') {
      // Count successes in half-open state
      const successes = (this.halfOpenSuccesses.get(url) || 0) + 1;
      this.halfOpenSuccesses.set(url, successes);

      if (successes >= this.config.successThreshold) {
        // Enough successes - close circuit
        this.reset(url);
      }
    } else if (health.state === 'CLOSED') {
      // Reset failure count on success
      health.failures = 0;
    }
  }

  /**
   * Record a failed request
   *
   * @param url - Gateway URL
   */
  recordFailure(url: string): void {
    const now = Date.now();
    let health = this.health.get(url);

    if (!health) {
      health = {
        failures: 0,
        lastFailure: now,
        state: 'CLOSED'
      };
      this.health.set(url, health);
    }

    // If in half-open state, any failure opens circuit again
    if (health.state === 'HALF_OPEN') {
      health.state = 'OPEN';
      health.openedAt = now;
      health.failures = this.config.failureThreshold; // Keep at threshold
      this.halfOpenSuccesses.delete(url);
      return;
    }

    // Check if previous failures have expired
    const timeSinceLastFailure = now - health.lastFailure;
    if (timeSinceLastFailure >= this.config.failureWindowMs) {
      health.failures = 0;
    }

    // Increment failure count
    health.failures++;
    health.lastFailure = now;

    // Check if threshold reached
    if (health.failures >= this.config.failureThreshold) {
      health.state = 'OPEN';
      health.openedAt = now;
    }
  }

  /**
   * Reset circuit for gateway (force close)
   *
   * @param url - Gateway URL
   */
  reset(url: string): void {
    this.health.delete(url);
    this.halfOpenSuccesses.delete(url);
  }

  /**
   * Reset all circuits
   */
  resetAll(): void {
    this.health.clear();
    this.halfOpenSuccesses.clear();
  }

  /**
   * Get health status for all tracked gateways
   *
   * @returns Map of gateway URL to health info
   */
  getHealthStatus(): Map<string, { state: CircuitState; failures: number }> {
    const status = new Map<string, { state: CircuitState; failures: number }>();

    for (const [url, health] of this.health) {
      status.set(url, {
        state: this.getState(url), // This updates state if needed
        failures: health.failures
      });
    }

    return status;
  }

  /**
   * Get failure count for gateway
   *
   * @param url - Gateway URL
   * @returns Number of consecutive failures
   */
  getFailureCount(url: string): number {
    return this.health.get(url)?.failures || 0;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Default global circuit breaker instance
 *
 * Use this for simple cases where a single circuit breaker is sufficient.
 * For more control, create your own GatewayCircuitBreaker instance.
 */
export const globalCircuitBreaker = new GatewayCircuitBreaker();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Wrap an async operation with circuit breaker protection
 *
 * @param url - Gateway URL to track
 * @param operation - Async operation to execute
 * @param circuitBreaker - Circuit breaker instance (default: global)
 * @returns Operation result
 * @throws Error if circuit is open, or operation error
 *
 * @example
 * ```typescript
 * const result = await withCircuitBreaker(
 *   'https://ipfs.filebase.io',
 *   () => fetch(url).then(r => r.json())
 * );
 * ```
 */
export async function withCircuitBreaker<T>(
  url: string,
  operation: () => Promise<T>,
  circuitBreaker: GatewayCircuitBreaker = globalCircuitBreaker
): Promise<T> {
  // Check if circuit allows request
  if (!circuitBreaker.isHealthy(url)) {
    const state = circuitBreaker.getState(url);
    throw new Error(
      `Circuit breaker OPEN for gateway: ${url}. ` +
      `State: ${state}, Failures: ${circuitBreaker.getFailureCount(url)}. ` +
      `Please wait for cooldown period before retrying.`
    );
  }

  try {
    const result = await operation();
    circuitBreaker.recordSuccess(url);
    return result;
  } catch (error) {
    circuitBreaker.recordFailure(url);
    throw error;
  }
}
