/**
 * FilebaseClient Circuit Breaker Tests (AIP-7 Security)
 *
 * Tests for circuit breaker integration in FilebaseClient:
 * - Initialization (enabled/disabled)
 * - Gateway health check before downloads
 * - Success/failure recording
 * - isGatewayFailure() helper logic
 * - Public API methods
 *
 * @module storage/FilebaseClient.circuitBreaker.test
 */

import { FilebaseClient } from './FilebaseClient';
import {
  StorageError,
  ContentNotFoundError,
} from '../errors';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock AWS S3 Client
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      $metadata: { httpStatusCode: 200 }
    })
  })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn()
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Valid IPFS CID (CIDv1, base32)
const VALID_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

// Helper to create mock Response with streaming body
const createMockResponse = (data: unknown, status = 200, statusText = 'OK') => {
  const jsonString = JSON.stringify(data);
  const encoder = new TextEncoder();
  const uint8Array = encoder.encode(jsonString);

  let readIndex = 0;
  const mockReader = {
    read: jest.fn().mockImplementation(() => {
      if (readIndex === 0) {
        readIndex++;
        return Promise.resolve({ done: false, value: uint8Array });
      }
      return Promise.resolve({ done: true, value: undefined });
    }),
    cancel: jest.fn()
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers({
      'content-length': uint8Array.length.toString(),
      'content-type': 'application/json'
    }),
    body: {
      getReader: () => mockReader
    }
  };
};

// Helper to create mock binary Response
const createMockBinaryResponse = (data: Buffer, status = 200, statusText = 'OK') => {
  const uint8Array = new Uint8Array(data);

  let readIndex = 0;
  const mockReader = {
    read: jest.fn().mockImplementation(() => {
      if (readIndex === 0) {
        readIndex++;
        return Promise.resolve({ done: false, value: uint8Array });
      }
      return Promise.resolve({ done: true, value: undefined });
    }),
    cancel: jest.fn()
  };

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Headers({
      'content-length': data.length.toString(),
      'content-type': 'application/octet-stream'
    }),
    body: {
      getReader: () => mockReader
    }
  };
};

// ============================================================================
// Test Suite
// ============================================================================

describe('FilebaseClient Circuit Breaker', () => {
  let client: FilebaseClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('Circuit Breaker Initialization', () => {
    test('creates circuit breaker by default (enabled)', () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key'
      });

      const status = client.getCircuitBreakerStatus();
      expect(status).not.toBeNull();
      expect(status?.enabled).toBe(true);
      expect(status?.state).toBe('CLOSED');
      expect(status?.failures).toBe(0);
      expect(status?.isHealthy).toBe(true);
    });

    test('creates circuit breaker with custom config', () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 2,
          resetTimeoutMs: 500
        }
      });

      const status = client.getCircuitBreakerStatus();
      expect(status).not.toBeNull();
      expect(status?.state).toBe('CLOSED');
    });

    test('disables circuit breaker when enabled=false', () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: false
        }
      });

      const status = client.getCircuitBreakerStatus();
      expect(status).toBeNull();
    });
  });

  // ==========================================================================
  // downloadJSON Circuit Breaker Tests
  // ==========================================================================

  describe('downloadJSON with Circuit Breaker', () => {
    beforeEach(() => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 100,
          successThreshold: 2
        }
      });
    });

    test('successful download records success', async () => {
      const testData = { foo: 'bar', num: 42 };
      mockFetch.mockResolvedValueOnce(createMockResponse(testData));

      const result = await client.downloadJSON(VALID_CID);

      expect(result.data).toEqual(testData);
      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('CLOSED');
      expect(status?.failures).toBe(0);
    });

    test('gateway 5xx error records failure', async () => {
      // Mock all retry attempts
      mockFetch.mockResolvedValue(createMockResponse({}, 503, 'Service Unavailable'));

      await expect(client.downloadJSON(VALID_CID))
        .rejects.toThrow(StorageError);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBeGreaterThanOrEqual(1);
    });

    test('opens circuit after threshold failures', async () => {
      // 3 failures should open circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Internal Server Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      }

      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('OPEN');
      expect(status?.isHealthy).toBe(false);
    });

    test('rejects immediately when circuit is OPEN', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Internal Server Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      }

      // Next request should fail immediately without fetch
      mockFetch.mockClear();

      await expect(client.downloadJSON(VALID_CID))
        .rejects.toThrow(/circuit breaker OPEN/);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('allows request in HALF_OPEN state after cooldown', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Internal Server Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      }

      // Wait for reset timeout (100ms configured)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Check state transitioned to HALF_OPEN
      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('HALF_OPEN');

      // Should allow request in HALF_OPEN
      const testData = { message: 'success' };
      mockFetch.mockResolvedValueOnce(createMockResponse(testData));

      const result = await client.downloadJSON(VALID_CID);
      expect(result.data).toEqual(testData);
    });

    test('404 error does NOT record failure (content not found)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 404, 'Not Found'));

      await expect(client.downloadJSON(VALID_CID))
        .rejects.toThrow(ContentNotFoundError);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBe(0);
    });

    test('invalid JSON does NOT record failure', async () => {
      // Create response with invalid JSON
      const encoder = new TextEncoder();
      const uint8Array = encoder.encode('not valid json {{{');

      let readIndex = 0;
      const mockReader = {
        read: jest.fn().mockImplementation(() => {
          if (readIndex === 0) {
            readIndex++;
            return Promise.resolve({ done: false, value: uint8Array });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        cancel: jest.fn()
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'content-length': uint8Array.length.toString()
        }),
        body: {
          getReader: () => mockReader
        }
      });

      await expect(client.downloadJSON(VALID_CID))
        .rejects.toThrow(/Invalid JSON/);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBe(0);
    });
  });

  // ==========================================================================
  // downloadBinary Circuit Breaker Tests
  // ==========================================================================

  describe('downloadBinary with Circuit Breaker', () => {
    beforeEach(() => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 100
        }
      });
    });

    test('successful download records success', async () => {
      const testData = Buffer.from('binary data here');
      mockFetch.mockResolvedValueOnce(createMockBinaryResponse(testData));

      const result = await client.downloadBinary(VALID_CID);

      expect(result.data).toEqual(testData);
      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('CLOSED');
    });

    test('gateway error records failure', async () => {
      mockFetch.mockResolvedValue(createMockBinaryResponse(Buffer.from(''), 502, 'Bad Gateway'));

      await expect(client.downloadBinary(VALID_CID))
        .rejects.toThrow(StorageError);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBeGreaterThanOrEqual(1);
    });

    test('rejects immediately when circuit is OPEN', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockBinaryResponse(Buffer.from(''), 500, 'Error'));
        await expect(client.downloadBinary(VALID_CID)).rejects.toThrow();
      }

      mockFetch.mockClear();

      await expect(client.downloadBinary(VALID_CID))
        .rejects.toThrow(/circuit breaker OPEN/);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('404 error does NOT record failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockBinaryResponse(Buffer.from(''), 404, 'Not Found'));

      await expect(client.downloadBinary(VALID_CID))
        .rejects.toThrow(ContentNotFoundError);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBe(0);
    });
  });

  // ==========================================================================
  // isGatewayFailure Logic Tests
  // ==========================================================================

  describe('isGatewayFailure classification', () => {
    beforeEach(() => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 10 // High threshold to test classification
        }
      });
    });

    test('HTTP 500 IS a gateway failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Internal Server Error'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 502 IS a gateway failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 502, 'Bad Gateway'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 503 IS a gateway failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 503, 'Service Unavailable'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 429 (rate limit) IS a gateway failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 429, 'Too Many Requests'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 404 is NOT a gateway failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 404, 'Not Found'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow(ContentNotFoundError);
      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('HTTP 400 is NOT a gateway failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 400, 'Bad Request'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('HTTP 403 is NOT a gateway failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 403, 'Forbidden'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('network error IS a gateway failure', async () => {
      const networkError = new Error('Network error');
      (networkError as any).code = 'ECONNREFUSED';
      mockFetch.mockRejectedValue(networkError);

      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('DNS error IS a gateway failure', async () => {
      const dnsError = new Error('DNS lookup failed');
      (dnsError as any).code = 'ENOTFOUND';
      mockFetch.mockRejectedValue(dnsError);

      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('connection reset IS a gateway failure', async () => {
      const resetError = new Error('Connection reset');
      (resetError as any).code = 'ECONNRESET';
      mockFetch.mockRejectedValue(resetError);

      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('timeout error IS a gateway failure', async () => {
      const timeoutError = new Error('Timeout');
      (timeoutError as any).code = 'ETIMEDOUT';
      mockFetch.mockRejectedValue(timeoutError);

      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // Public API Tests
  // ==========================================================================

  describe('Public API Methods', () => {
    describe('getCircuitBreakerStatus', () => {
      test('returns full status when enabled', () => {
        client = new FilebaseClient({
          accessKey: 'test-access-key',
          secretKey: 'test-secret-key',
          circuitBreaker: { enabled: true }
        });

        const status = client.getCircuitBreakerStatus();

        expect(status).toEqual({
          enabled: true,
          state: 'CLOSED',
          failures: 0,
          isHealthy: true
        });
      });

      test('returns null when disabled', () => {
        client = new FilebaseClient({
          accessKey: 'test-access-key',
          secretKey: 'test-secret-key',
          circuitBreaker: { enabled: false }
        });

        expect(client.getCircuitBreakerStatus()).toBeNull();
      });

      test('reflects current state and failures', async () => {
        client = new FilebaseClient({
          accessKey: 'test-access-key',
          secretKey: 'test-secret-key',
          circuitBreaker: {
            enabled: true,
            failureThreshold: 5
          }
        });

        // Record some failures
        mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Error'));

        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();

        const status = client.getCircuitBreakerStatus();
        expect(status?.state).toBe('CLOSED');
        expect(status?.failures).toBeGreaterThanOrEqual(2);
      });

      test('shows unhealthy when circuit is OPEN', async () => {
        client = new FilebaseClient({
          accessKey: 'test-access-key',
          secretKey: 'test-secret-key',
          circuitBreaker: {
            enabled: true,
            failureThreshold: 2
          }
        });

        // Open the circuit
        mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();

        const status = client.getCircuitBreakerStatus();
        expect(status?.state).toBe('OPEN');
        expect(status?.isHealthy).toBe(false);
      });
    });

    describe('resetCircuitBreaker', () => {
      test('resets circuit breaker state', async () => {
        client = new FilebaseClient({
          accessKey: 'test-access-key',
          secretKey: 'test-secret-key',
          circuitBreaker: {
            enabled: true,
            failureThreshold: 2
          }
        });

        // Open the circuit
        mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();

        expect(client.getCircuitBreakerStatus()?.state).toBe('OPEN');

        // Reset
        client.resetCircuitBreaker();

        const status = client.getCircuitBreakerStatus();
        expect(status?.state).toBe('CLOSED');
        expect(status?.failures).toBe(0);
        expect(status?.isHealthy).toBe(true);
      });

      test('allows downloads after reset', async () => {
        client = new FilebaseClient({
          accessKey: 'test-access-key',
          secretKey: 'test-secret-key',
          circuitBreaker: {
            enabled: true,
            failureThreshold: 2
          }
        });

        // Open the circuit
        mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();

        // Verify circuit is open
        await expect(client.downloadJSON(VALID_CID))
          .rejects.toThrow(/circuit breaker OPEN/);

        // Reset and verify download works
        client.resetCircuitBreaker();

        mockFetch.mockReset();
        const testData = { success: true };
        mockFetch.mockResolvedValueOnce(createMockResponse(testData));

        const result = await client.downloadJSON(VALID_CID);
        expect(result.data).toEqual(testData);
      });

      test('does nothing when disabled', () => {
        client = new FilebaseClient({
          accessKey: 'test-access-key',
          secretKey: 'test-secret-key',
          circuitBreaker: { enabled: false }
        });

        // Should not throw
        expect(() => client.resetCircuitBreaker()).not.toThrow();
      });
    });
  });

  // ==========================================================================
  // Disabled Circuit Breaker Tests
  // ==========================================================================

  describe('Disabled Circuit Breaker', () => {
    beforeEach(() => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: { enabled: false }
      });
    });

    test('allows downloads even after many failures', async () => {
      // Many failures
      for (let i = 0; i < 10; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      }

      // Should still attempt download (no circuit breaker block)
      const testData = { success: true };
      mockFetch.mockResolvedValueOnce(createMockResponse(testData));

      const result = await client.downloadJSON(VALID_CID);
      expect(result.data).toEqual(testData);
    });

    test('getCircuitBreakerStatus returns null', () => {
      expect(client.getCircuitBreakerStatus()).toBeNull();
    });
  });

  // ==========================================================================
  // Circuit Breaker State Machine Tests
  // ==========================================================================

  describe('Circuit Breaker State Machine', () => {
    test('accumulates failures from multiple failed requests', async () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 10
        }
      });

      // Make multiple failing requests
      mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Error'));

      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      const failures1 = client.getCircuitBreakerStatus()?.failures || 0;

      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      const failures2 = client.getCircuitBreakerStatus()?.failures || 0;

      // Failures should accumulate
      expect(failures2).toBeGreaterThan(failures1);
    });

    test('success resets failure count', async () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 10
        }
      });

      // Record a failure
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThan(0);

      // Success resets
      const testData = { message: 'success' };
      mockFetch.mockResolvedValueOnce(createMockResponse(testData));
      await client.downloadJSON(VALID_CID);

      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('full lifecycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED', async () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 100,
          successThreshold: 1
        }
      });

      // Start CLOSED
      expect(client.getCircuitBreakerStatus()?.state).toBe('CLOSED');

      // Open circuit with 3 separate requests
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      }

      // Should be OPEN
      expect(client.getCircuitBreakerStatus()?.state).toBe('OPEN');

      // Wait for cooldown
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should be HALF_OPEN
      expect(client.getCircuitBreakerStatus()?.state).toBe('HALF_OPEN');

      // Success closes circuit
      const testData = { message: 'recovered' };
      mockFetch.mockResolvedValueOnce(createMockResponse(testData));
      await client.downloadJSON(VALID_CID);

      expect(client.getCircuitBreakerStatus()?.state).toBe('CLOSED');
    });

    test('failure in HALF_OPEN reopens circuit', async () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 100
        }
      });

      // Open circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      }

      // Wait for HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(client.getCircuitBreakerStatus()?.state).toBe('HALF_OPEN');

      // Failure in HALF_OPEN reopens
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();

      expect(client.getCircuitBreakerStatus()?.state).toBe('OPEN');
    });
  });

  // ==========================================================================
  // Cross-Method Circuit Breaker Tests
  // ==========================================================================

  describe('Cross-Method Circuit Breaker Behavior', () => {
    test('circuit breaker state shared between downloadJSON and downloadBinary', async () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3
        }
      });

      // Fail with downloadJSON twice
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();

      // Fail with downloadBinary once more to open circuit
      mockFetch.mockResolvedValueOnce(createMockBinaryResponse(Buffer.from(''), 500, 'Error'));
      await expect(client.downloadBinary(VALID_CID)).rejects.toThrow();

      // Circuit should be OPEN
      expect(client.getCircuitBreakerStatus()?.state).toBe('OPEN');

      // Both methods should be blocked
      await expect(client.downloadJSON(VALID_CID))
        .rejects.toThrow(/circuit breaker OPEN/);
      await expect(client.downloadBinary(VALID_CID))
        .rejects.toThrow(/circuit breaker OPEN/);
    });

    test('success from either method resets failures', async () => {
      client = new FilebaseClient({
        accessKey: 'test-access-key',
        secretKey: 'test-secret-key',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 5
        }
      });

      // Record failures with downloadJSON
      mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Error'));
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();
      await expect(client.downloadJSON(VALID_CID)).rejects.toThrow();

      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThan(0);

      // Success with downloadBinary resets
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(createMockBinaryResponse(Buffer.from('data')));
      await client.downloadBinary(VALID_CID);

      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });
  });
});
