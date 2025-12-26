/**
 * ReceivedNonceTracker Test Suite
 *
 * Tests cover:
 * - Nonce validation and recording
 * - Replay attack prevention
 * - Multiple senders and message types
 * - Edge cases (invalid format, gaps)
 *
 * @module utils/ReceivedNonceTracker.test
 */

import { InMemoryReceivedNonceTracker } from './ReceivedNonceTracker';

describe('InMemoryReceivedNonceTracker', () => {
  let tracker: InMemoryReceivedNonceTracker;

  // Helper to create bytes32 nonce from number
  const toBytes32 = (n: number | bigint): string => {
    return '0x' + BigInt(n).toString(16).padStart(64, '0');
  };

  beforeEach(() => {
    tracker = new InMemoryReceivedNonceTracker();
  });

  // ============================================================================
  // validateAndRecord Tests
  // ============================================================================

  describe('validateAndRecord()', () => {
    it('should accept first nonce from sender', () => {
      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(1)
      );

      expect(result.valid).toBe(true);
    });

    it('should accept increasing nonces', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(1));

      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(2)
      );

      expect(result.valid).toBe(true);
    });

    it('should reject duplicate nonce (replay attack)', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));

      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(5)
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Nonce replay detected');
    });

    it('should reject lower nonce (old replay)', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(10));

      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(5)
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Nonce replay detected');
    });

    it('should accept nonce gaps (skipping nonces is OK)', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(1));

      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(100) // Big gap
      );

      expect(result.valid).toBe(true);
    });

    it('should track separately per sender', () => {
      tracker.validateAndRecord('did:ethr:0xAAA', 'delivery.v1', toBytes32(5));
      tracker.validateAndRecord('did:ethr:0xBBB', 'delivery.v1', toBytes32(5));

      // Same nonce but different sender - should be OK
      const result = tracker.validateAndRecord(
        'did:ethr:0xCCC',
        'delivery.v1',
        toBytes32(5)
      );

      expect(result.valid).toBe(true);
    });

    it('should track separately per message type', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));
      tracker.validateAndRecord('did:ethr:0x1234', 'quote.v1', toBytes32(5));

      // Same nonce but different message type - should be OK
      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'attestation.v1',
        toBytes32(5)
      );

      expect(result.valid).toBe(true);
    });

    it('should reject invalid nonce format (too short)', () => {
      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        '0x1234' // Not bytes32
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid nonce format');
    });

    it('should reject invalid nonce format (no 0x prefix)', () => {
      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        '0'.repeat(64)
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid nonce format');
    });

    it('should reject invalid nonce format (non-hex)', () => {
      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        '0x' + 'g'.repeat(64)
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid nonce format');
    });

    it('should provide expected minimum in rejection', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(10));

      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(5)
      );

      expect(result.valid).toBe(false);
      expect(result.expectedMinimum).toBe(toBytes32(11)); // > 10
      expect(result.receivedNonce).toBe(toBytes32(5));
    });
  });

  // ============================================================================
  // hasBeenUsed Tests
  // ============================================================================

  describe('hasBeenUsed()', () => {
    it('should return false for unused nonce', () => {
      const result = tracker.hasBeenUsed(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(1)
      );

      expect(result).toBe(false);
    });

    it('should return true for used nonce', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));

      expect(tracker.hasBeenUsed('did:ethr:0x1234', 'delivery.v1', toBytes32(5))).toBe(true);
    });

    it('should return true for nonces lower than highest seen', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(10));

      expect(tracker.hasBeenUsed('did:ethr:0x1234', 'delivery.v1', toBytes32(5))).toBe(true);
      expect(tracker.hasBeenUsed('did:ethr:0x1234', 'delivery.v1', toBytes32(1))).toBe(true);
    });

    it('should return false for nonces higher than highest seen', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));

      expect(tracker.hasBeenUsed('did:ethr:0x1234', 'delivery.v1', toBytes32(10))).toBe(false);
    });

    it('should return false for unknown sender', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));

      expect(tracker.hasBeenUsed('did:ethr:0xUNKNOWN', 'delivery.v1', toBytes32(5))).toBe(false);
    });

    it('should return false for unknown message type', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));

      expect(tracker.hasBeenUsed('did:ethr:0x1234', 'unknown.v1', toBytes32(5))).toBe(false);
    });
  });

  // ============================================================================
  // getHighestNonce Tests
  // ============================================================================

  describe('getHighestNonce()', () => {
    it('should return null for unknown sender', () => {
      expect(tracker.getHighestNonce('did:ethr:0x1234', 'delivery.v1')).toBeNull();
    });

    it('should return null for unknown message type', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));

      expect(tracker.getHighestNonce('did:ethr:0x1234', 'unknown.v1')).toBeNull();
    });

    it('should return highest nonce seen', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(10));
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(100));

      expect(tracker.getHighestNonce('did:ethr:0x1234', 'delivery.v1')).toBe(toBytes32(100));
    });
  });

  // ============================================================================
  // reset Tests
  // ============================================================================

  describe('reset()', () => {
    it('should clear tracking for specific sender + message type', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));
      tracker.validateAndRecord('did:ethr:0x1234', 'quote.v1', toBytes32(10));

      tracker.reset('did:ethr:0x1234', 'delivery.v1');

      // Delivery tracking reset
      expect(tracker.getHighestNonce('did:ethr:0x1234', 'delivery.v1')).toBeNull();

      // Quote tracking still exists
      expect(tracker.getHighestNonce('did:ethr:0x1234', 'quote.v1')).toBe(toBytes32(10));
    });

    it('should allow same nonce after reset', () => {
      tracker.validateAndRecord('did:ethr:0x1234', 'delivery.v1', toBytes32(5));
      tracker.reset('did:ethr:0x1234', 'delivery.v1');

      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(5)
      );

      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // clearAll Tests
  // ============================================================================

  describe('clearAll()', () => {
    it('should clear all tracking', () => {
      tracker.validateAndRecord('did:ethr:0xAAA', 'delivery.v1', toBytes32(5));
      tracker.validateAndRecord('did:ethr:0xBBB', 'quote.v1', toBytes32(10));
      tracker.validateAndRecord('did:ethr:0xCCC', 'attestation.v1', toBytes32(15));

      tracker.clearAll();

      expect(tracker.getHighestNonce('did:ethr:0xAAA', 'delivery.v1')).toBeNull();
      expect(tracker.getHighestNonce('did:ethr:0xBBB', 'quote.v1')).toBeNull();
      expect(tracker.getHighestNonce('did:ethr:0xCCC', 'attestation.v1')).toBeNull();
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle zero nonce', () => {
      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(0)
      );

      expect(result.valid).toBe(true);
    });

    it('should handle very large nonces', () => {
      const largeNonce = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');

      const result = tracker.validateAndRecord(
        'did:ethr:0x1234',
        'delivery.v1',
        toBytes32(largeNonce)
      );

      expect(result.valid).toBe(true);
      expect(tracker.getHighestNonce('did:ethr:0x1234', 'delivery.v1')).toBe(toBytes32(largeNonce));
    });

    it('should handle consecutive nonces efficiently', () => {
      for (let i = 1; i <= 100; i++) {
        const result = tracker.validateAndRecord(
          'did:ethr:0x1234',
          'delivery.v1',
          toBytes32(i)
        );
        expect(result.valid).toBe(true);
      }

      expect(tracker.getHighestNonce('did:ethr:0x1234', 'delivery.v1')).toBe(toBytes32(100));
    });

    it('should handle many different senders', () => {
      for (let i = 0; i < 100; i++) {
        const sender = `did:ethr:0x${i.toString(16).padStart(40, '0')}`;
        tracker.validateAndRecord(sender, 'delivery.v1', toBytes32(i));
      }

      // Verify each sender has their own tracking
      for (let i = 0; i < 100; i++) {
        const sender = `did:ethr:0x${i.toString(16).padStart(40, '0')}`;
        expect(tracker.getHighestNonce(sender, 'delivery.v1')).toBe(toBytes32(i));
      }
    });
  });
});
