/**
 * Tests for Canonical JSON Utilities (AIP-4 §3.6)
 */

import { canonicalJsonStringify, computeCanonicalHash, computeResultHash } from '../../utils/canonicalJson';
import { keccak256, toUtf8Bytes } from 'ethers';

describe('Canonical JSON Utilities', () => {
  describe('canonicalJsonStringify', () => {
    it('should sort object keys alphabetically', () => {
      const obj = { z: 1, a: 2, m: 3 };
      const result = canonicalJsonStringify(obj);
      expect(result).toBe('{"a":2,"m":3,"z":1}');
    });

    it('should handle nested objects', () => {
      const obj = {
        b: { y: 1, x: 2 },
        a: { z: 3, w: 4 }
      };
      const result = canonicalJsonStringify(obj);
      expect(result).toBe('{"a":{"w":4,"z":3},"b":{"x":2,"y":1}}');
    });

    it('should handle arrays', () => {
      const obj = { items: [3, 1, 2], name: 'test' };
      const result = canonicalJsonStringify(obj);
      expect(result).toBe('{"items":[3,1,2],"name":"test"}');
    });

    it('should produce deterministic output', () => {
      const obj1 = { a: 1, b: 2, c: 3 };
      const obj2 = { c: 3, b: 2, a: 1 };

      expect(canonicalJsonStringify(obj1)).toBe(canonicalJsonStringify(obj2));
    });

    it('should handle special characters', () => {
      const obj = { text: 'hello "world"', emoji: '🎉' };
      const result = canonicalJsonStringify(obj);
      expect(result).toContain('hello \\"world\\"');
      expect(result).toContain('🎉');
    });

    it('should handle null and boolean values', () => {
      const obj = { isTrue: true, isFalse: false, nothing: null };
      const result = canonicalJsonStringify(obj);
      expect(result).toBe('{"isFalse":false,"isTrue":true,"nothing":null}');
    });
  });

  describe('computeCanonicalHash', () => {
    it('should compute keccak256 hash of canonical JSON', () => {
      const obj = { a: 1, b: 2 };
      const hash = computeCanonicalHash(obj);

      // Hash should be 0x-prefixed, 66 chars (0x + 64 hex)
      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should produce same hash for semantically equal objects', () => {
      const obj1 = { a: 1, b: 2, c: 3 };
      const obj2 = { c: 3, b: 2, a: 1 }; // Different order

      const hash1 = computeCanonicalHash(obj1);
      const hash2 = computeCanonicalHash(obj2);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different objects', () => {
      const obj1 = { a: 1, b: 2 };
      const obj2 = { a: 1, b: 3 };

      const hash1 = computeCanonicalHash(obj1);
      const hash2 = computeCanonicalHash(obj2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('computeResultHash', () => {
    it('should alias computeCanonicalHash', () => {
      const obj = { txId: '0xabc', result: 'test' };

      const hash1 = computeResultHash(obj);
      const hash2 = computeCanonicalHash(obj);

      expect(hash1).toBe(hash2);
    });
  });

  describe('AIP-4 Test Vector (§10.1)', () => {
    it('should match AIP-4 canonical JSON test vector', () => {
      const input = {
        txId: '0x7d87c3b8e23a5c9d1f4e6b2a8c5d9e3f1a7b4c6d8e2f5a3b9c1d7e4f6a8b2c5d',
        serviceType: 'ocr',
        result: { text: 'test', confidence: 1.0 },
        createdAt: 1700000000,
        provider: 'did:ethr:0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'
      };

      const canonical = canonicalJsonStringify(input);

      // Expected output from AIP-4 §10.1
      const expected = '{"createdAt":1700000000,"provider":"did:ethr:0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb","result":{"confidence":1,"text":"test"},"serviceType":"ocr","txId":"0x7d87c3b8e23a5c9d1f4e6b2a8c5d9e3f1a7b4c6d8e2f5a3b9c1d7e4f6a8b2c5d"}';

      expect(canonical).toBe(expected);
    });

    it('should compute correct hash for test vector', () => {
      const input = {
        txId: '0x7d87c3b8e23a5c9d1f4e6b2a8c5d9e3f1a7b4c6d8e2f5a3b9c1d7e4f6a8b2c5d',
        serviceType: 'ocr',
        result: { text: 'test', confidence: 1.0 },
        createdAt: 1700000000,
        provider: 'did:ethr:0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'
      };

      const hash = computeResultHash(input);

      // Compute expected hash manually
      const canonical = '{"createdAt":1700000000,"provider":"did:ethr:0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb","result":{"confidence":1,"text":"test"},"serviceType":"ocr","txId":"0x7d87c3b8e23a5c9d1f4e6b2a8c5d9e3f1a7b4c6d8e2f5a3b9c1d7e4f6a8b2c5d"}';
      const expectedHash = keccak256(toUtf8Bytes(canonical));

      expect(hash).toBe(expectedHash);
    });
  });

  describe('Cross-language compatibility', () => {
    it('should handle numbers without decimals', () => {
      const obj = { value: 1.0 };
      const result = canonicalJsonStringify(obj);

      // JavaScript serializes 1.0 as 1 (no decimal)
      expect(result).toBe('{"value":1}');
    });

    it('should handle large numbers', () => {
      const obj = { timestamp: 1700000000, amount: 1000000000000 };
      const result = canonicalJsonStringify(obj);

      expect(result).toBe('{"amount":1000000000000,"timestamp":1700000000}');
    });

    it('should handle unicode strings', () => {
      const obj = { text: 'Hello 世界 🌍' };
      const result = canonicalJsonStringify(obj);

      expect(result).toContain('Hello 世界 🌍');
    });
  });
});
