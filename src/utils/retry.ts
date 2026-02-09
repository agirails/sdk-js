/**
 * Retry Utility - Exponential Backoff with Jitter (P1-2)
 *
 * Implements retry logic for storage operations with:
 * - Exponential backoff (doubles delay each attempt)
 * - Random jitter (prevents thundering herd)
 * - Maximum retry limit
 * - Configurable retry conditions
 *
 * @module utils/retry
 */

import { StorageRateLimitError } from '../errors';

// ============================================================================
// Types
// ============================================================================

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;

  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;

  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;

  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;

  /** Jitter factor 0-1 (default: 0.1 = ±10%) */
  jitterFactor?: number;

  /** Function to determine if error is retryable (default: built-in check) */
  isRetryable?: (error: unknown) => boolean;

  /** Callback for each retry attempt (for logging) */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/**
 * Result of retry operation
 */
export interface RetryResult<T> {
  /** Operation result (if successful) */
  result?: T;

  /** Final error (if all retries failed) */
  error?: unknown;

  /** Number of attempts made */
  attempts: number;

  /** Total time spent (including delays) */
  totalTimeMs: number;

  /** Whether operation succeeded */
  success: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000; // Reduced from 30s to 10s (NEW-4: prevent long stalls)
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_JITTER_FACTOR = 0.1;

/**
 * Default list of retryable HTTP status codes
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504  // Gateway Timeout
]);

/**
 * Default list of retryable error codes
 */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH'
]);

// ============================================================================
// Functions
// ============================================================================

/**
 * Default function to determine if error is retryable
 *
 * @param error - Error to check
 * @returns True if error should trigger retry
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  // Rate limit errors are always retryable
  if (error instanceof StorageRateLimitError) {
    return true;
  }

  const e = error as any;

  // Check HTTP status codes
  if (e.statusCode && RETRYABLE_STATUS_CODES.has(e.statusCode)) {
    return true;
  }

  if (e.status && RETRYABLE_STATUS_CODES.has(e.status)) {
    return true;
  }

  // Check error codes (network errors)
  if (e.code && RETRYABLE_ERROR_CODES.has(e.code)) {
    return true;
  }

  // Check for timeout errors
  if (e.name === 'AbortError' || e.name === 'TimeoutError') {
    return true;
  }

  // Check message for common retryable patterns
  const message = String(e.message || e).toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('service unavailable') ||
    message.includes('temporarily unavailable')
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 *
 * @param attempt - Current attempt number (1-based)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  options: RetryOptions = {}
): number {
  const {
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
    jitterFactor = DEFAULT_JITTER_FACTOR
  } = options;

  // Exponential backoff: initialDelay * (multiplier ^ (attempt - 1))
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: ±jitterFactor
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
  const finalDelay = Math.max(0, cappedDelay + jitter);

  return Math.round(finalDelay);
}

/**
 * Sleep for specified duration
 *
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute async operation with retry logic
 *
 * Implements exponential backoff with jitter for handling transient failures.
 * Particularly useful for storage operations that may fail due to:
 * - Rate limiting
 * - Network timeouts
 * - Temporary service unavailability
 *
 * @param operation - Async function to execute
 * @param options - Retry configuration
 * @returns Promise resolving to operation result or throwing final error
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await withRetry(
 *   () => client.uploadJSON(data),
 *   { maxAttempts: 3 }
 * );
 *
 * // With logging
 * const result = await withRetry(
 *   () => client.downloadJSON(cid),
 *   {
 *     maxAttempts: 5,
 *     onRetry: (attempt, error, delay) => {
 *       console.log(`Retry ${attempt}, waiting ${delay}ms:`, error);
 *     }
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    isRetryable = isRetryableError,
    onRetry
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if this is the last attempt
      if (attempt >= maxAttempts) {
        break;
      }

      // Check if error is retryable
      if (!isRetryable(error)) {
        break;
      }

      // Calculate delay
      let delayMs = calculateBackoffDelay(attempt, options);

      // If rate limit error with retry-after header, use that instead
      if (error instanceof StorageRateLimitError && error.details?.retryAfter) {
        delayMs = Math.max(delayMs, error.details.retryAfter * 1000);
      }

      // Notify callback
      if (onRetry) {
        onRetry(attempt, error, delayMs);
      }

      // Wait before retry
      await sleep(delayMs);
    }
  }

  // All retries failed
  throw lastError;
}

/**
 * Execute async operation with retry logic, returning detailed result
 *
 * Unlike `withRetry`, this function never throws - it returns a result object
 * with success/failure status and metadata.
 *
 * @param operation - Async function to execute
 * @param options - Retry configuration
 * @returns Promise resolving to detailed result object
 *
 * @example
 * ```typescript
 * const result = await withRetryResult(
 *   () => client.uploadJSON(data),
 *   { maxAttempts: 3 }
 * );
 *
 * if (result.success) {
 *   console.log('Uploaded:', result.result);
 * } else {
 *   console.error(`Failed after ${result.attempts} attempts:`, result.error);
 * }
 * ```
 */
export async function withRetryResult<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    isRetryable = isRetryableError,
    onRetry
  } = options;

  let lastError: unknown;
  const startTime = Date.now();
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;

    try {
      const result = await operation();
      return {
        result,
        attempts,
        totalTimeMs: Date.now() - startTime,
        success: true
      };
    } catch (error) {
      lastError = error;

      // Check if this is the last attempt
      if (attempt >= maxAttempts) {
        break;
      }

      // Check if error is retryable
      if (!isRetryable(error)) {
        break;
      }

      // Calculate delay
      let delayMs = calculateBackoffDelay(attempt, options);

      // If rate limit error with retry-after header, use that instead
      if (error instanceof StorageRateLimitError && error.details?.retryAfter) {
        delayMs = Math.max(delayMs, error.details.retryAfter * 1000);
      }

      // Notify callback
      if (onRetry) {
        onRetry(attempt, error, delayMs);
      }

      // Wait before retry
      await sleep(delayMs);
    }
  }

  return {
    error: lastError,
    attempts,
    totalTimeMs: Date.now() - startTime,
    success: false
  };
}
