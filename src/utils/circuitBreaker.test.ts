/**
 * Circuit Breaker Tests (AIP-7 Security)
 *
 * Comprehensive tests for gateway circuit breaker:
 * - State transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
 * - Failure counting and threshold
 * - Auto-reset after cooldown
 * - Half-open probing behavior
 *
 * @module utils/circuitBreaker.test
 */

import {
  GatewayCircuitBreaker,
  withCircuitBreaker,
  globalCircuitBreaker,
  CircuitState,
  CircuitBreakerConfig
} from './circuitBreaker';

// ============================================================================
// GatewayCircuitBreaker Class Tests
// ============================================================================

describe('GatewayCircuitBreaker', () => {
  let circuitBreaker: GatewayCircuitBreaker;

  beforeEach(() => {
    // Fresh instance for each test
    circuitBreaker = new GatewayCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      failureWindowMs: 5000,
      successThreshold: 2
    });
  });

  describe('Initial State', () => {
    test('new gateway starts with CLOSED state', () => {
      expect(circuitBreaker.getState('https://gateway.example.com')).toBe('CLOSED');
    });

    test('new gateway is healthy', () => {
      expect(circuitBreaker.isHealthy('https://gateway.example.com')).toBe(true);
    });

    test('new gateway has zero failures', () => {
      expect(circuitBreaker.getFailureCount('https://gateway.example.com')).toBe(0);
    });
  });

  describe('Failure Recording', () => {
    const gateway = 'https://ipfs.filebase.io';

    test('increments failure count on recordFailure', () => {
      circuitBreaker.recordFailure(gateway);
      expect(circuitBreaker.getFailureCount(gateway)).toBe(1);

      circuitBreaker.recordFailure(gateway);
      expect(circuitBreaker.getFailureCount(gateway)).toBe(2);
    });

    test('opens circuit after threshold failures', () => {
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      expect(circuitBreaker.getState(gateway)).toBe('CLOSED');

      circuitBreaker.recordFailure(gateway); // Threshold (3) reached
      expect(circuitBreaker.getState(gateway)).toBe('OPEN');
    });

    test('gateway becomes unhealthy when circuit opens', () => {
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);

      expect(circuitBreaker.isHealthy(gateway)).toBe(false);
    });
  });

  describe('Success Recording', () => {
    const gateway = 'https://ipfs.filebase.io';

    test('resets failure count on success in CLOSED state', () => {
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      expect(circuitBreaker.getFailureCount(gateway)).toBe(2);

      circuitBreaker.recordSuccess(gateway);
      expect(circuitBreaker.getFailureCount(gateway)).toBe(0);
    });

    test('success on unknown gateway does nothing', () => {
      // Should not throw
      expect(() => circuitBreaker.recordSuccess('https://unknown.gateway')).not.toThrow();
    });
  });

  describe('OPEN → HALF_OPEN Transition', () => {
    const gateway = 'https://ipfs.filebase.io';

    test('transitions to HALF_OPEN after reset timeout', async () => {
      // Open the circuit
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      expect(circuitBreaker.getState(gateway)).toBe('OPEN');

      // Wait for reset timeout (1000ms configured)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should transition to HALF_OPEN
      expect(circuitBreaker.getState(gateway)).toBe('HALF_OPEN');
      expect(circuitBreaker.isHealthy(gateway)).toBe(true); // HALF_OPEN is healthy
    });

    test('stays OPEN before reset timeout', async () => {
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);

      // Wait less than reset timeout
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(circuitBreaker.getState(gateway)).toBe('OPEN');
    });
  });

  describe('HALF_OPEN Behavior', () => {
    const gateway = 'https://ipfs.filebase.io';

    beforeEach(async () => {
      // Set up circuit in HALF_OPEN state
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(circuitBreaker.getState(gateway)).toBe('HALF_OPEN');
    });

    test('closes circuit after successThreshold successes', () => {
      circuitBreaker.recordSuccess(gateway);
      expect(circuitBreaker.getState(gateway)).toBe('HALF_OPEN');

      circuitBreaker.recordSuccess(gateway); // 2nd success = threshold
      expect(circuitBreaker.getState(gateway)).toBe('CLOSED');
    });

    test('reopens circuit on any failure in HALF_OPEN', () => {
      circuitBreaker.recordSuccess(gateway); // 1 success

      circuitBreaker.recordFailure(gateway); // Failure in HALF_OPEN
      expect(circuitBreaker.getState(gateway)).toBe('OPEN');
    });
  });

  describe('Failure Window', () => {
    const gateway = 'https://ipfs.filebase.io';

    test('resets failure count after failure window expires', async () => {
      // Use shorter failure window for testing
      circuitBreaker = new GatewayCircuitBreaker({
        failureThreshold: 3,
        failureWindowMs: 500, // 500ms window
        resetTimeoutMs: 1000,
        successThreshold: 2
      });

      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);
      expect(circuitBreaker.getFailureCount(gateway)).toBe(2);

      // Wait for failure window to expire
      await new Promise(resolve => setTimeout(resolve, 600));

      // getState() checks and resets expired failures
      expect(circuitBreaker.getState(gateway)).toBe('CLOSED');
      // Recording new failure should start fresh
      circuitBreaker.recordFailure(gateway);
      expect(circuitBreaker.getFailureCount(gateway)).toBe(1);
    });
  });

  describe('Reset Functions', () => {
    const gateway1 = 'https://ipfs.filebase.io';
    const gateway2 = 'https://arweave.net';

    test('reset() clears specific gateway', () => {
      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway2);

      circuitBreaker.reset(gateway1);

      expect(circuitBreaker.getFailureCount(gateway1)).toBe(0);
      expect(circuitBreaker.getFailureCount(gateway2)).toBe(1);
    });

    test('resetAll() clears all gateways', () => {
      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway2);
      circuitBreaker.recordFailure(gateway2);

      circuitBreaker.resetAll();

      expect(circuitBreaker.getFailureCount(gateway1)).toBe(0);
      expect(circuitBreaker.getFailureCount(gateway2)).toBe(0);
    });
  });

  describe('getHealthStatus', () => {
    test('returns status for all tracked gateways', () => {
      const gateway1 = 'https://ipfs.filebase.io';
      const gateway2 = 'https://arweave.net';

      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway1); // Opens circuit

      circuitBreaker.recordFailure(gateway2); // 1 failure

      const status = circuitBreaker.getHealthStatus();

      expect(status.get(gateway1)).toEqual({
        state: 'OPEN',
        failures: 3
      });

      expect(status.get(gateway2)).toEqual({
        state: 'CLOSED',
        failures: 1
      });
    });

    test('returns empty map when no gateways tracked', () => {
      const status = circuitBreaker.getHealthStatus();
      expect(status.size).toBe(0);
    });
  });

  describe('Multiple Gateways', () => {
    test('tracks gateways independently', () => {
      const gateway1 = 'https://ipfs.filebase.io';
      const gateway2 = 'https://gateway.pinata.cloud';
      const gateway3 = 'https://arweave.net';

      // Open circuit for gateway1
      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway1);
      circuitBreaker.recordFailure(gateway1);

      // Record some failures for gateway2
      circuitBreaker.recordFailure(gateway2);

      // gateway3 untouched

      expect(circuitBreaker.getState(gateway1)).toBe('OPEN');
      expect(circuitBreaker.isHealthy(gateway1)).toBe(false);

      expect(circuitBreaker.getState(gateway2)).toBe('CLOSED');
      expect(circuitBreaker.isHealthy(gateway2)).toBe(true);

      expect(circuitBreaker.getState(gateway3)).toBe('CLOSED');
      expect(circuitBreaker.isHealthy(gateway3)).toBe(true);
    });
  });
});

// ============================================================================
// withCircuitBreaker Helper Tests
// ============================================================================

describe('withCircuitBreaker', () => {
  let circuitBreaker: GatewayCircuitBreaker;
  const gateway = 'https://ipfs.filebase.io';

  beforeEach(() => {
    circuitBreaker = new GatewayCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 100,
      failureWindowMs: 5000,
      successThreshold: 1
    });
  });

  describe('Successful Operations', () => {
    test('executes operation and records success', async () => {
      const result = await withCircuitBreaker(
        gateway,
        async () => 'success',
        circuitBreaker
      );

      expect(result).toBe('success');
    });

    test('returns operation result correctly', async () => {
      const data = { id: 1, name: 'test' };
      const result = await withCircuitBreaker(
        gateway,
        async () => data,
        circuitBreaker
      );

      expect(result).toEqual(data);
    });
  });

  describe('Failed Operations', () => {
    test('records failure and rethrows error', async () => {
      await expect(withCircuitBreaker(
        gateway,
        async () => { throw new Error('Network error'); },
        circuitBreaker
      )).rejects.toThrow('Network error');

      expect(circuitBreaker.getFailureCount(gateway)).toBe(1);
    });

    test('opens circuit after threshold failures', async () => {
      const failingOp = async () => { throw new Error('Fail'); };

      await expect(withCircuitBreaker(gateway, failingOp, circuitBreaker))
        .rejects.toThrow();
      await expect(withCircuitBreaker(gateway, failingOp, circuitBreaker))
        .rejects.toThrow();

      expect(circuitBreaker.getState(gateway)).toBe('OPEN');
    });
  });

  describe('Open Circuit Behavior', () => {
    test('throws immediately when circuit is open', async () => {
      // Open the circuit
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);

      const operation = jest.fn().mockResolvedValue('success');

      await expect(withCircuitBreaker(gateway, operation, circuitBreaker))
        .rejects.toThrow(/Circuit breaker OPEN/);

      // Operation should not be called
      expect(operation).not.toHaveBeenCalled();
    });

    test('error message includes helpful information', async () => {
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);

      await expect(withCircuitBreaker(
        gateway,
        async () => 'success',
        circuitBreaker
      )).rejects.toThrow(/Failures: 2/);
    });
  });

  describe('Half-Open Behavior', () => {
    test('allows operation in HALF_OPEN state', async () => {
      // Open circuit
      circuitBreaker.recordFailure(gateway);
      circuitBreaker.recordFailure(gateway);

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      const result = await withCircuitBreaker(
        gateway,
        async () => 'probe success',
        circuitBreaker
      );

      expect(result).toBe('probe success');
    });
  });

  describe('Uses Global Circuit Breaker by Default', () => {
    beforeEach(() => {
      globalCircuitBreaker.resetAll();
    });

    test('uses globalCircuitBreaker when none provided', async () => {
      const result = await withCircuitBreaker(
        'https://test.gateway',
        async () => 'result'
        // No circuitBreaker argument
      );

      expect(result).toBe('result');
    });
  });
});

// ============================================================================
// Configuration Tests
// ============================================================================

describe('Circuit Breaker Configuration', () => {
  test('uses default values when no config provided', () => {
    const cb = new GatewayCircuitBreaker();
    const gateway = 'https://test.gateway';

    // Default failureThreshold is 5
    for (let i = 0; i < 4; i++) {
      cb.recordFailure(gateway);
    }
    expect(cb.getState(gateway)).toBe('CLOSED');

    cb.recordFailure(gateway); // 5th failure
    expect(cb.getState(gateway)).toBe('OPEN');
  });

  test('respects custom failureThreshold', () => {
    const cb = new GatewayCircuitBreaker({ failureThreshold: 1 });
    const gateway = 'https://test.gateway';

    cb.recordFailure(gateway); // 1st failure = threshold
    expect(cb.getState(gateway)).toBe('OPEN');
  });

  test('respects custom successThreshold', async () => {
    const cb = new GatewayCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      successThreshold: 3
    });
    const gateway = 'https://test.gateway';

    // Open and wait for HALF_OPEN
    cb.recordFailure(gateway);
    await new Promise(resolve => setTimeout(resolve, 60));

    // getState() triggers OPEN → HALF_OPEN transition after timeout
    expect(cb.getState(gateway)).toBe('HALF_OPEN');

    // Need 3 successes to close
    cb.recordSuccess(gateway);
    expect(cb.getState(gateway)).toBe('HALF_OPEN');

    cb.recordSuccess(gateway);
    expect(cb.getState(gateway)).toBe('HALF_OPEN');

    cb.recordSuccess(gateway);
    expect(cb.getState(gateway)).toBe('CLOSED');
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  test('handles rapid fire failures', () => {
    const cb = new GatewayCircuitBreaker({ failureThreshold: 100 });
    const gateway = 'https://test.gateway';

    // Rapid failures
    for (let i = 0; i < 100; i++) {
      cb.recordFailure(gateway);
    }

    expect(cb.getState(gateway)).toBe('OPEN');
    expect(cb.getFailureCount(gateway)).toBe(100);
  });

  test('handles interleaved success and failure', () => {
    const cb = new GatewayCircuitBreaker({ failureThreshold: 3 });
    const gateway = 'https://test.gateway';

    cb.recordFailure(gateway);
    cb.recordFailure(gateway);
    cb.recordSuccess(gateway); // Resets count
    cb.recordFailure(gateway);
    cb.recordFailure(gateway);

    // Should still be CLOSED (success reset the count)
    expect(cb.getState(gateway)).toBe('CLOSED');
    expect(cb.getFailureCount(gateway)).toBe(2);
  });

  test('handles URL variations correctly', () => {
    const cb = new GatewayCircuitBreaker({ failureThreshold: 2 });

    // Different URLs are tracked separately
    cb.recordFailure('https://ipfs.filebase.io/ipfs/Qm123');
    cb.recordFailure('https://ipfs.filebase.io/ipfs/Qm456');

    // Each URL has 1 failure
    expect(cb.getFailureCount('https://ipfs.filebase.io/ipfs/Qm123')).toBe(1);
    expect(cb.getFailureCount('https://ipfs.filebase.io/ipfs/Qm456')).toBe(1);
  });
});
