/**
 * Retry Module Tests (AIP-7 Security P1-2)
 *
 * Comprehensive tests for retry logic with exponential backoff:
 * - Retryable error detection
 * - Backoff delay calculation with jitter
 * - Retry execution with various scenarios
 *
 * @module utils/retry.test
 */

import {
  withRetry,
  withRetryResult,
  isRetryableError,
  calculateBackoffDelay,
} from './retry';
import { StorageRateLimitError } from '../errors';

// ============================================================================
// isRetryableError Tests
// ============================================================================

describe('isRetryableError', () => {
  describe('Rate Limit Errors', () => {
    test('recognizes StorageRateLimitError as retryable', () => {
      const error = new StorageRateLimitError(60);
      expect(isRetryableError(error)).toBe(true);
    });
  });

  describe('HTTP Status Codes', () => {
    test('recognizes 408 Request Timeout as retryable', () => {
      const error = { statusCode: 408 };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes 429 Too Many Requests as retryable', () => {
      const error = { statusCode: 429 };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes 5xx server errors as retryable', () => {
      expect(isRetryableError({ statusCode: 500 })).toBe(true);
      expect(isRetryableError({ statusCode: 502 })).toBe(true);
      expect(isRetryableError({ statusCode: 503 })).toBe(true);
      expect(isRetryableError({ statusCode: 504 })).toBe(true);
    });

    test('handles status property (alternative to statusCode)', () => {
      expect(isRetryableError({ status: 429 })).toBe(true);
      expect(isRetryableError({ status: 503 })).toBe(true);
    });

    test('does not retry 4xx client errors (except 408, 429)', () => {
      expect(isRetryableError({ statusCode: 400 })).toBe(false);
      expect(isRetryableError({ statusCode: 401 })).toBe(false);
      expect(isRetryableError({ statusCode: 403 })).toBe(false);
      expect(isRetryableError({ statusCode: 404 })).toBe(false);
      expect(isRetryableError({ statusCode: 422 })).toBe(false);
    });
  });

  describe('Network Error Codes', () => {
    test('recognizes ECONNRESET as retryable', () => {
      const error = { code: 'ECONNRESET' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes ECONNREFUSED as retryable', () => {
      const error = { code: 'ECONNREFUSED' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes ETIMEDOUT as retryable', () => {
      const error = { code: 'ETIMEDOUT' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes ENOTFOUND as retryable', () => {
      const error = { code: 'ENOTFOUND' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes ENETUNREACH as retryable', () => {
      const error = { code: 'ENETUNREACH' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes EAI_AGAIN as retryable', () => {
      const error = { code: 'EAI_AGAIN' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes EPIPE as retryable', () => {
      const error = { code: 'EPIPE' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes EHOSTUNREACH as retryable', () => {
      const error = { code: 'EHOSTUNREACH' };
      expect(isRetryableError(error)).toBe(true);
    });
  });

  describe('Abort/Timeout Errors', () => {
    test('recognizes AbortError as retryable', () => {
      const error = { name: 'AbortError' };
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes TimeoutError as retryable', () => {
      const error = { name: 'TimeoutError' };
      expect(isRetryableError(error)).toBe(true);
    });
  });

  describe('Message-Based Detection', () => {
    test('recognizes timeout in message', () => {
      const error = new Error('Request timeout after 30000ms');
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes rate limit in message', () => {
      const error = new Error('Rate limit exceeded');
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes too many requests in message', () => {
      const error = new Error('Too many requests, please try again later');
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes service unavailable in message', () => {
      const error = new Error('Service unavailable');
      expect(isRetryableError(error)).toBe(true);
    });

    test('recognizes temporarily unavailable in message', () => {
      const error = new Error('Server is temporarily unavailable');
      expect(isRetryableError(error)).toBe(true);
    });

    test('is case-insensitive for message matching', () => {
      expect(isRetryableError(new Error('TIMEOUT'))).toBe(true);
      expect(isRetryableError(new Error('Rate LIMIT'))).toBe(true);
    });
  });

  describe('Non-Retryable Errors', () => {
    test('does not retry null/undefined', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });

    test('does not retry generic errors', () => {
      expect(isRetryableError(new Error('File not found'))).toBe(false);
      expect(isRetryableError(new Error('Invalid argument'))).toBe(false);
    });

    test('does not retry validation errors', () => {
      expect(isRetryableError(new Error('Invalid CID format'))).toBe(false);
    });
  });
});

// ============================================================================
// calculateBackoffDelay Tests
// ============================================================================

describe('calculateBackoffDelay', () => {
  describe('Exponential Backoff', () => {
    test('first attempt uses initial delay', () => {
      const delay = calculateBackoffDelay(1, {
        initialDelayMs: 1000,
        jitterFactor: 0 // Disable jitter for predictable testing
      });
      expect(delay).toBe(1000);
    });

    test('doubles delay for each attempt', () => {
      const options = { initialDelayMs: 1000, jitterFactor: 0 };

      expect(calculateBackoffDelay(1, options)).toBe(1000);
      expect(calculateBackoffDelay(2, options)).toBe(2000);
      expect(calculateBackoffDelay(3, options)).toBe(4000);
      expect(calculateBackoffDelay(4, options)).toBe(8000);
    });

    test('respects custom backoff multiplier', () => {
      const options = { initialDelayMs: 1000, backoffMultiplier: 3, jitterFactor: 0 };

      expect(calculateBackoffDelay(1, options)).toBe(1000);
      expect(calculateBackoffDelay(2, options)).toBe(3000);
      expect(calculateBackoffDelay(3, options)).toBe(9000);
    });
  });

  describe('Maximum Delay Cap', () => {
    test('caps delay at maxDelayMs', () => {
      const options = {
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        jitterFactor: 0
      };

      expect(calculateBackoffDelay(5, options)).toBe(5000); // Would be 16000, capped at 5000
      expect(calculateBackoffDelay(10, options)).toBe(5000);
    });

    test('uses default max delay of 10000ms (NEW-4 fix)', () => {
      const options = { initialDelayMs: 1000, jitterFactor: 0 };

      // 2^10 * 1000 = 1024000, should be capped at 10000
      const delay = calculateBackoffDelay(10, options);
      expect(delay).toBeLessThanOrEqual(10000);
    });
  });

  describe('Jitter', () => {
    test('adds jitter within expected range', () => {
      const options = { initialDelayMs: 1000, jitterFactor: 0.1 };

      // Run multiple times to test jitter randomness
      const delays = Array.from({ length: 100 }, () =>
        calculateBackoffDelay(1, options)
      );

      // All delays should be within ±10% of 1000 (900-1100)
      delays.forEach(delay => {
        expect(delay).toBeGreaterThanOrEqual(900);
        expect(delay).toBeLessThanOrEqual(1100);
      });

      // Should have some variance (not all same value)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    test('jitter is zero when jitterFactor is 0', () => {
      const options = { initialDelayMs: 1000, jitterFactor: 0 };

      const delays = Array.from({ length: 10 }, () =>
        calculateBackoffDelay(1, options)
      );

      // All delays should be exactly 1000
      delays.forEach(delay => {
        expect(delay).toBe(1000);
      });
    });
  });

  describe('Default Values', () => {
    test('uses sensible defaults', () => {
      const delay = calculateBackoffDelay(1);
      // Default initialDelayMs is 1000, with ±10% jitter
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1100);
    });
  });
});

// ============================================================================
// withRetry Tests
// ============================================================================

describe('withRetry', () => {
  describe('Successful Operations', () => {
    test('returns result on first success', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const result = await withRetry(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('returns result after retries succeed', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockResolvedValue('success');

      const result = await withRetry(operation, {
        maxAttempts: 3,
        initialDelayMs: 10 // Fast for testing
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });
  });

  describe('Failed Operations', () => {
    test('throws after max attempts exhausted', async () => {
      const operation = jest.fn().mockRejectedValue({ statusCode: 503 });

      await expect(withRetry(operation, {
        maxAttempts: 3,
        initialDelayMs: 10
      })).rejects.toEqual({ statusCode: 503 });

      expect(operation).toHaveBeenCalledTimes(3);
    });

    test('stops retrying on non-retryable error', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockRejectedValue({ statusCode: 400 }); // Not retryable

      await expect(withRetry(operation, {
        maxAttempts: 5,
        initialDelayMs: 10
      })).rejects.toEqual({ statusCode: 400 });

      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Custom isRetryable', () => {
    test('uses custom isRetryable function', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ custom: true })
        .mockResolvedValue('success');

      const result = await withRetry(operation, {
        maxAttempts: 3,
        initialDelayMs: 10,
        isRetryable: (error: any) => error.custom === true
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('onRetry Callback', () => {
    test('calls onRetry for each retry attempt', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockResolvedValue('success');

      const onRetry = jest.fn();

      await withRetry(operation, {
        maxAttempts: 5,
        initialDelayMs: 10,
        onRetry
      });

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(1, expect.anything(), expect.any(Number));
      expect(onRetry).toHaveBeenCalledWith(2, expect.anything(), expect.any(Number));
    });

    test('onRetry receives correct delay value', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockResolvedValue('success');

      const onRetry = jest.fn();

      await withRetry(operation, {
        maxAttempts: 3,
        initialDelayMs: 100,
        jitterFactor: 0,
        onRetry
      });

      // First retry delay should be ~100ms
      expect(onRetry).toHaveBeenCalledWith(1, expect.anything(), 100);
    });
  });

  describe('Rate Limit with Retry-After', () => {
    test('respects Retry-After header from StorageRateLimitError', async () => {
      const startTime = Date.now();
      const operation = jest.fn()
        .mockRejectedValueOnce(new StorageRateLimitError(0.1)) // 0.1 seconds
        .mockResolvedValue('success');

      await withRetry(operation, {
        maxAttempts: 3,
        initialDelayMs: 10
      });

      const elapsed = Date.now() - startTime;
      // Should wait at least 100ms (0.1 * 1000); allow 5ms tolerance for timer resolution
      expect(elapsed).toBeGreaterThanOrEqual(95);
    });
  });
});

// ============================================================================
// withRetryResult Tests
// ============================================================================

describe('withRetryResult', () => {
  describe('Successful Operations', () => {
    test('returns success result with metadata', async () => {
      const operation = jest.fn().mockResolvedValue('data');

      const result = await withRetryResult(operation);

      expect(result.success).toBe(true);
      expect(result.result).toBe('data');
      expect(result.attempts).toBe(1);
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    test('tracks attempts correctly on success after retries', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockResolvedValue('data');

      const result = await withRetryResult(operation, {
        maxAttempts: 3,
        initialDelayMs: 10
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });

  describe('Failed Operations', () => {
    test('returns failure result without throwing', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Fatal error'));

      const result = await withRetryResult(operation, {
        maxAttempts: 1
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('Fatal error');
      expect(result.attempts).toBe(1);
    });

    test('tracks all attempts on failure', async () => {
      const operation = jest.fn().mockRejectedValue({ statusCode: 503 });

      const result = await withRetryResult(operation, {
        maxAttempts: 3,
        initialDelayMs: 10
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
    });

    test('tracks total time correctly', async () => {
      const operation = jest.fn().mockRejectedValue({ statusCode: 503 });

      const result = await withRetryResult(operation, {
        maxAttempts: 2,
        initialDelayMs: 50,
        jitterFactor: 0
      });

      // Should have waited approximately initialDelayMs between attempts.
      // CI timers occasionally finish ~1ms early due to scheduler granularity;
      // 5ms tolerance keeps the intent (waited ~50ms) without flaking.
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(45);
    });
  });

  describe('Non-Retryable Errors', () => {
    test('stops early on non-retryable error', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ statusCode: 503 })
        .mockRejectedValue({ statusCode: 400 });

      const result = await withRetryResult(operation, {
        maxAttempts: 5,
        initialDelayMs: 10
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect((result.error as any).statusCode).toBe(400);
    });
  });
});
