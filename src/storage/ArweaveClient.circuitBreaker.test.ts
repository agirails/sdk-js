/**
 * ArweaveClient Circuit Breaker Tests (AIP-7 Security)
 *
 * Tests for circuit breaker integration in ArweaveClient:
 * - Initialization (enabled/disabled)
 * - Gateway health check before downloads
 * - Success/failure recording
 * - isGatewayFailure() helper logic
 * - Public API methods
 *
 * @module storage/ArweaveClient.circuitBreaker.test
 */

import { ArweaveClient } from './ArweaveClient';
import {
  ArweaveDownloadError,
  ArweaveTimeoutError,
  FileSizeLimitExceededError
} from '../errors';
import { ARCHIVE_BUNDLE_TYPE, ArchiveBundle } from './types';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock Irys SDK
jest.mock('@irys/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    ready: jest.fn().mockResolvedValue(undefined),
    address: '0x1234567890123456789012345678901234567890',
    getLoadedBalance: jest.fn().mockResolvedValue(BigInt(1000000000000000)),
    getPrice: jest.fn().mockResolvedValue(BigInt(1000000000000)),
    fund: jest.fn().mockResolvedValue(undefined),
    upload: jest.fn().mockResolvedValue({ id: 'mock-arweave-tx-id-1234567890123456789012' })
  }));
});

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Valid Arweave TX ID (43 characters, base64url)
const VALID_TX_ID = 'h7Xk2Jn8wQrL5mPz9sYv3TgNxR6cE4aI1bDfKoUiHjA';

// Create a valid archive bundle for testing
const createMockArchiveBundle = (): ArchiveBundle => ({
  protocolVersion: '1.0.0',
  archiveSchemaVersion: '1.0.0',
  type: ARCHIVE_BUNDLE_TYPE,
  txId: '0x' + '1'.repeat(64),
  chainId: 84532,
  archivedAt: Math.floor(Date.now() / 1000),
  participants: {
    requester: '0x' + '2'.repeat(40),
    provider: '0x' + '3'.repeat(40)
  },
  references: {
    requestCID: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    deliveryCID: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
  },
  hashes: {
    requestHash: '0x' + '4'.repeat(64),
    deliveryHash: '0x' + '5'.repeat(64),
    serviceHash: '0x' + '6'.repeat(64)
  },
  signatures: {
    providerDeliverySignature: '0x' + '7'.repeat(130)
  },
  settlement: {
    settledAt: Math.floor(Date.now() / 1000),
    finalState: 'SETTLED',
    escrowReleased: {
      to: '0x' + '3'.repeat(40),
      amount: '100000000'
    },
    platformFee: '1000000',
    wasDisputed: false
  }
});

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

// ============================================================================
// Test Suite
// ============================================================================

describe('ArweaveClient Circuit Breaker', () => {
  let client: ArweaveClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('Circuit Breaker Initialization', () => {
    test('creates circuit breaker by default (enabled)', async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org'
      });

      const status = client.getCircuitBreakerStatus();
      expect(status).not.toBeNull();
      expect(status?.state).toBe('CLOSED');
      expect(status?.failures).toBe(0);
    });

    test('creates circuit breaker with custom config', async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
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

    test('disables circuit breaker when enabled=false', async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: {
          enabled: false
        }
      });

      const status = client.getCircuitBreakerStatus();
      expect(status).toBeNull();
    });
  });

  // ==========================================================================
  // downloadBundle Circuit Breaker Tests
  // ==========================================================================

  describe('downloadBundle with Circuit Breaker', () => {
    beforeEach(async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 100,
          successThreshold: 2
        }
      });
    });

    test('successful download records success', async () => {
      const mockBundle = createMockArchiveBundle();
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBundle));

      const result = await client.downloadBundle(VALID_TX_ID);

      expect(result.data.type).toBe(ARCHIVE_BUNDLE_TYPE);
      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('CLOSED');
      expect(status?.failures).toBe(0);
    });

    test('gateway 5xx error records failure', async () => {
      // Mock all retry attempts (default 3 retries)
      mockFetch.mockResolvedValue(createMockResponse({}, 503, 'Service Unavailable'));

      await expect(client.downloadBundle(VALID_TX_ID))
        .rejects.toThrow(ArweaveDownloadError);

      const status = client.getCircuitBreakerStatus();
      // All 3 retry attempts record failures
      expect(status?.failures).toBeGreaterThanOrEqual(1);
    });

    test('opens circuit after threshold failures', async () => {
      // 3 failures should open circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Internal Server Error'));
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      }

      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('OPEN');
      expect(status?.failures).toBe(3);
    });

    test('rejects immediately when circuit is OPEN', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Internal Server Error'));
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      }

      // Next request should fail immediately without fetch
      mockFetch.mockClear();

      await expect(client.downloadBundle(VALID_TX_ID))
        .rejects.toThrow(/circuit breaker OPEN/);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('allows request in HALF_OPEN state after cooldown', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Internal Server Error'));
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      }

      // Wait for reset timeout (100ms configured)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Check state transitioned to HALF_OPEN
      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('HALF_OPEN');

      // Should allow request in HALF_OPEN
      const mockBundle = createMockArchiveBundle();
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBundle));

      const result = await client.downloadBundle(VALID_TX_ID);
      expect(result.data.type).toBe(ARCHIVE_BUNDLE_TYPE);
    });

    test('404 error does NOT record failure (content not found)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 404, 'Not Found'));

      await expect(client.downloadBundle(VALID_TX_ID))
        .rejects.toThrow(ArweaveDownloadError);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBe(0); // 404 is not a gateway failure
    });

    test('invalid bundle type does NOT record failure', async () => {
      const invalidBundle = { ...createMockArchiveBundle(), type: 'invalid.type' };
      mockFetch.mockResolvedValueOnce(createMockResponse(invalidBundle));

      await expect(client.downloadBundle(VALID_TX_ID))
        .rejects.toThrow(/Invalid bundle type/);

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

      await expect(client.downloadBundle(VALID_TX_ID))
        .rejects.toThrow(/Invalid JSON/);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBe(0);
    });
  });

  // ==========================================================================
  // downloadJSON Circuit Breaker Tests
  // ==========================================================================

  describe('downloadJSON with Circuit Breaker', () => {
    beforeEach(async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 100
        }
      });
    });

    test('successful download records success', async () => {
      const testData = { foo: 'bar', num: 42 };
      mockFetch.mockResolvedValueOnce(createMockResponse(testData));

      const result = await client.downloadJSON<typeof testData>(VALID_TX_ID);

      expect(result.data).toEqual(testData);
      const status = client.getCircuitBreakerStatus();
      expect(status?.state).toBe('CLOSED');
    });

    test('gateway error records failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 502, 'Bad Gateway'));

      await expect(client.downloadJSON(VALID_TX_ID))
        .rejects.toThrow(ArweaveDownloadError);

      const status = client.getCircuitBreakerStatus();
      expect(status?.failures).toBe(1);
    });

    test('rejects immediately when circuit is OPEN', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Internal Server Error'));
        await expect(client.downloadJSON(VALID_TX_ID)).rejects.toThrow();
      }

      mockFetch.mockClear();

      await expect(client.downloadJSON(VALID_TX_ID))
        .rejects.toThrow(/circuit breaker OPEN/);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // isGatewayFailure Logic Tests
  // ==========================================================================

  describe('isGatewayFailure classification', () => {
    beforeEach(async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 10 // High threshold to test classification
        }
      });
    });

    test('HTTP 500 IS a gateway failure', async () => {
      // Mock all retry attempts
      mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Internal Server Error'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      // With retries, multiple failures recorded
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 502 IS a gateway failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 502, 'Bad Gateway'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 503 IS a gateway failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 503, 'Service Unavailable'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 504 IS a gateway failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 504, 'Gateway Timeout'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('HTTP 404 is NOT a gateway failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 404, 'Not Found'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('HTTP 400 is NOT a gateway failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 400, 'Bad Request'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('HTTP 403 is NOT a gateway failure', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 403, 'Forbidden'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('network error IS a gateway failure', async () => {
      const networkError = new Error('Network error');
      (networkError as any).code = 'ECONNREFUSED';
      // Mock for all retries
      mockFetch.mockRejectedValue(networkError);

      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('DNS error IS a gateway failure', async () => {
      const dnsError = new Error('DNS lookup failed');
      (dnsError as any).code = 'ENOTFOUND';
      mockFetch.mockRejectedValue(dnsError);

      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });

    test('timeout error IS a gateway failure', async () => {
      const timeoutError = new Error('Timeout');
      (timeoutError as any).code = 'ETIMEDOUT';
      mockFetch.mockRejectedValue(timeoutError);

      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // Public API Tests
  // ==========================================================================

  describe('Public API Methods', () => {
    describe('getCircuitBreakerStatus', () => {
      test('returns status when enabled', async () => {
        client = await ArweaveClient.create({
          privateKey: '0x' + '1'.repeat(64),
          rpcUrl: 'https://mainnet.base.org',
          circuitBreaker: { enabled: true }
        });

        const status = client.getCircuitBreakerStatus();

        expect(status).toEqual({
          state: 'CLOSED',
          failures: 0
        });
      });

      test('returns null when disabled', async () => {
        client = await ArweaveClient.create({
          privateKey: '0x' + '1'.repeat(64),
          rpcUrl: 'https://mainnet.base.org',
          circuitBreaker: { enabled: false }
        });

        expect(client.getCircuitBreakerStatus()).toBeNull();
      });

      test('reflects current state and failures', async () => {
        client = await ArweaveClient.create({
          privateKey: '0x' + '1'.repeat(64),
          rpcUrl: 'https://mainnet.base.org',
          circuitBreaker: {
            enabled: true,
            failureThreshold: 5
          }
        });

        // Record some failures
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));

        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();

        const status = client.getCircuitBreakerStatus();
        expect(status?.state).toBe('CLOSED');
        expect(status?.failures).toBe(2);
      });
    });

    describe('resetCircuitBreaker', () => {
      test('resets circuit breaker state', async () => {
        client = await ArweaveClient.create({
          privateKey: '0x' + '1'.repeat(64),
          rpcUrl: 'https://mainnet.base.org',
          circuitBreaker: {
            enabled: true,
            failureThreshold: 2
          }
        });

        // Open the circuit
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));

        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();

        expect(client.getCircuitBreakerStatus()?.state).toBe('OPEN');

        // Reset
        client.resetCircuitBreaker();

        const status = client.getCircuitBreakerStatus();
        expect(status?.state).toBe('CLOSED');
        expect(status?.failures).toBe(0);
      });

      test('allows downloads after reset', async () => {
        client = await ArweaveClient.create({
          privateKey: '0x' + '1'.repeat(64),
          rpcUrl: 'https://mainnet.base.org',
          circuitBreaker: {
            enabled: true,
            failureThreshold: 2
          }
        });

        // Open the circuit
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));

        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();

        // Verify circuit is open
        await expect(client.downloadBundle(VALID_TX_ID))
          .rejects.toThrow(/circuit breaker OPEN/);

        // Reset and verify download works
        client.resetCircuitBreaker();

        const mockBundle = createMockArchiveBundle();
        mockFetch.mockResolvedValueOnce(createMockResponse(mockBundle));

        const result = await client.downloadBundle(VALID_TX_ID);
        expect(result.data.type).toBe(ARCHIVE_BUNDLE_TYPE);
      });

      test('does nothing when disabled', async () => {
        client = await ArweaveClient.create({
          privateKey: '0x' + '1'.repeat(64),
          rpcUrl: 'https://mainnet.base.org',
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
    beforeEach(async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: { enabled: false }
      });
    });

    test('allows downloads even after many failures', async () => {
      // Many failures
      for (let i = 0; i < 10; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      }

      // Should still attempt download (no circuit breaker block)
      const mockBundle = createMockArchiveBundle();
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBundle));

      const result = await client.downloadBundle(VALID_TX_ID);
      expect(result.data.type).toBe(ARCHIVE_BUNDLE_TYPE);
    });

    test('getCircuitBreakerStatus returns null', async () => {
      expect(client.getCircuitBreakerStatus()).toBeNull();
    });
  });

  // ==========================================================================
  // Circuit Breaker State Machine Tests
  // ==========================================================================

  describe('Circuit Breaker State Machine', () => {
    test('accumulates failures from multiple failed requests', async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 5
        }
      });

      // Make multiple failing requests
      mockFetch.mockResolvedValue(createMockResponse({}, 500, 'Error'));

      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      const failures1 = client.getCircuitBreakerStatus()?.failures || 0;

      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      const failures2 = client.getCircuitBreakerStatus()?.failures || 0;

      // Failures should accumulate
      expect(failures2).toBeGreaterThan(failures1);
    });

    test('success resets failure count', async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 10
        }
      });

      // Record a failure
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      expect(client.getCircuitBreakerStatus()?.failures).toBeGreaterThan(0);

      // Success resets
      const mockBundle = createMockArchiveBundle();
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBundle));
      await client.downloadBundle(VALID_TX_ID);

      expect(client.getCircuitBreakerStatus()?.failures).toBe(0);
    });

    test('full lifecycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED', async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
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
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      }

      // Should be OPEN
      expect(client.getCircuitBreakerStatus()?.state).toBe('OPEN');

      // Wait for cooldown
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should be HALF_OPEN
      expect(client.getCircuitBreakerStatus()?.state).toBe('HALF_OPEN');

      // Success closes circuit
      const mockBundle = createMockArchiveBundle();
      mockFetch.mockResolvedValueOnce(createMockResponse(mockBundle));
      await client.downloadBundle(VALID_TX_ID);

      expect(client.getCircuitBreakerStatus()?.state).toBe('CLOSED');
    });

    test('failure in HALF_OPEN reopens circuit', async () => {
      client = await ArweaveClient.create({
        privateKey: '0x' + '1'.repeat(64),
        rpcUrl: 'https://mainnet.base.org',
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 100
        }
      });

      // Open circuit
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
        await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();
      }

      // Wait for HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(client.getCircuitBreakerStatus()?.state).toBe('HALF_OPEN');

      // Failure in HALF_OPEN reopens
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500, 'Error'));
      await expect(client.downloadBundle(VALID_TX_ID)).rejects.toThrow();

      expect(client.getCircuitBreakerStatus()?.state).toBe('OPEN');
    });
  });
});
