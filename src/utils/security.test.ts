/**
 * Security Utilities Tests
 *
 * SECURITY FIX (N-3): Comprehensive tests for security utilities
 * to ensure protection against timing attacks, path traversal,
 * injection attacks, and prototype pollution.
 *
 * @module utils/security.test
 */

import {
  timingSafeEqual,
  validatePath,
  validateServiceName,
  isValidAddress,
  safeJSONParse,
  LRUCache,
} from './security';

describe('Security Utilities', () => {
  describe('timingSafeEqual', () => {
    test('returns true for equal strings', () => {
      expect(timingSafeEqual('hello', 'hello')).toBe(true);
      expect(timingSafeEqual('0x1234abcd', '0x1234abcd')).toBe(true);
    });

    test('returns false for different strings', () => {
      expect(timingSafeEqual('hello', 'world')).toBe(false);
      expect(timingSafeEqual('0x1234', '0x5678')).toBe(false);
    });

    test('returns false for different lengths', () => {
      expect(timingSafeEqual('hello', 'helloworld')).toBe(false);
      expect(timingSafeEqual('short', 'longer')).toBe(false);
    });

    test('handles non-strings safely', () => {
      expect(timingSafeEqual(null as any, 'hello')).toBe(false);
      expect(timingSafeEqual('hello', undefined as any)).toBe(false);
      expect(timingSafeEqual(123 as any, 123 as any)).toBe(false);
    });

    test('is constant-time for same length strings', () => {
      // This is a basic smoke test - true constant-time testing requires timing analysis
      const str1 = 'a'.repeat(1000);
      const str2a = 'a'.repeat(999) + 'b'; // Different at end
      const str2b = 'b' + 'a'.repeat(999); // Different at start

      expect(timingSafeEqual(str1, str2a)).toBe(false);
      expect(timingSafeEqual(str1, str2b)).toBe(false);
    });
  });

  describe('validatePath', () => {
    const baseDir = '/home/user/agirails';

    test('allows valid subdirectories', () => {
      expect(validatePath('data', baseDir)).toBe('/home/user/agirails/data');
      expect(validatePath('logs/2024', baseDir)).toBe('/home/user/agirails/logs/2024');
      expect(validatePath('./config', baseDir)).toBe('/home/user/agirails/config');
    });

    test('rejects path traversal with ..', () => {
      expect(() => validatePath('../etc/passwd', baseDir)).toThrow('path traversal');
      expect(() => validatePath('data/../../etc', baseDir)).toThrow('path traversal');
      expect(() => validatePath('foo/../../../root', baseDir)).toThrow('path traversal');
    });

    test('rejects null bytes', () => {
      expect(() => validatePath('data\0/file.txt', baseDir)).toThrow('null byte');
      expect(() => validatePath('file\u0000name', baseDir)).toThrow('null byte');
    });

    test('rejects paths outside base directory', () => {
      expect(() => validatePath('/etc/passwd', baseDir)).toThrow('outside base directory');
      expect(() => validatePath('/tmp/malicious', baseDir)).toThrow('outside base directory');
    });

    test('normalizes paths correctly', () => {
      expect(validatePath('data//logs', baseDir)).toBe('/home/user/agirails/data/logs');
      expect(validatePath('./data/./logs', baseDir)).toBe('/home/user/agirails/data/logs');
    });
  });

  describe('validateServiceName', () => {
    test('allows valid names', () => {
      expect(validateServiceName('translation')).toBe('translation');
      expect(validateServiceName('text-to-speech')).toBe('text-to-speech');
      expect(validateServiceName('service_123')).toBe('service_123');
      expect(validateServiceName('api.v2.endpoint')).toBe('api.v2.endpoint');
    });

    test('rejects special characters', () => {
      expect(() => validateServiceName('service@123')).toThrow('only alphanumeric');
      expect(() => validateServiceName('service#name')).toThrow('only alphanumeric');
      expect(() => validateServiceName('service name')).toThrow('only alphanumeric'); // spaces
      expect(() => validateServiceName('service;drop table')).toThrow('only alphanumeric');
    });

    test('rejects dot-prefixed names', () => {
      expect(() => validateServiceName('.hidden')).toThrow('cannot start with a dot');
      expect(() => validateServiceName('.')).toThrow('cannot start with a dot');
      expect(() => validateServiceName('..')).toThrow('cannot start with a dot');
    });

    test('enforces length limit', () => {
      const longName = 'a'.repeat(300);
      expect(() => validateServiceName(longName)).toThrow('exceeds maximum length');
    });

    test('rejects empty strings', () => {
      expect(() => validateServiceName('')).toThrow('must be a non-empty string');
      expect(() => validateServiceName('   ')).toThrow('cannot be empty');
    });

    test('trims whitespace', () => {
      expect(validateServiceName('  translation  ')).toBe('translation');
    });
  });

  describe('isValidAddress', () => {
    test('validates correct addresses', () => {
      expect(isValidAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
      expect(isValidAddress('0xAbCdEf1234567890AbCdEf1234567890AbCdEf12')).toBe(true);
      expect(isValidAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    });

    test('rejects invalid addresses', () => {
      expect(isValidAddress('1234567890abcdef1234567890abcdef12345678')).toBe(false); // Missing 0x
      expect(isValidAddress('0x123')).toBe(false); // Too short
      expect(isValidAddress('0x1234567890abcdef1234567890abcdef123456789')).toBe(false); // Too long
      expect(isValidAddress('0x1234567890abcdef1234567890abcdef1234567g')).toBe(false); // Invalid char
      expect(isValidAddress('')).toBe(false);
      expect(isValidAddress(null as any)).toBe(false);
    });
  });

  describe('safeJSONParse', () => {
    test('parses valid JSON', () => {
      const result = safeJSONParse('{"name":"Alice","age":30}');
      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    test('removes __proto__ property', () => {
      const malicious = '{"__proto__":{"isAdmin":true},"name":"Alice"}';
      const result = safeJSONParse(malicious);
      // Check that dangerous properties were removed
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
      expect(result).toEqual({ name: 'Alice' });
    });

    test('removes constructor property', () => {
      const malicious = '{"constructor":{"prototype":{"isAdmin":true}},"name":"Alice"}';
      const result = safeJSONParse(malicious);
      // Check that dangerous properties were removed
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
      expect(result).toEqual({ name: 'Alice' });
    });

    test('validates against schema', () => {
      const schema = {
        name: 'string',
        age: 'number',
        active: 'boolean',
      };

      const json = '{"name":"Alice","age":30,"active":true,"extra":"ignored"}';
      const result = safeJSONParse(json, schema);

      expect(result).toEqual({
        name: 'Alice',
        age: 30,
        active: true,
      });
      expect(result).not.toHaveProperty('extra');
    });

    test('rejects type mismatches in schema', () => {
      const schema = {
        name: 'string',
        age: 'number',
      };

      const json = '{"name":"Alice","age":"thirty"}'; // age is string, not number
      const result = safeJSONParse(json, schema);

      expect(result).toEqual({
        name: 'Alice',
        // age is omitted due to type mismatch
      });
    });

    test('rejects oversized JSON', () => {
      const oversized = '{"data":"' + 'a'.repeat(2_000_000) + '"}';
      const result = safeJSONParse(oversized);
      expect(result).toBeNull();
    });

    test('handles invalid JSON gracefully', () => {
      expect(safeJSONParse('not json')).toBeNull();
      expect(safeJSONParse('{invalid}')).toBeNull();
      expect(safeJSONParse('')).toBeNull();
    });

    test('sanitizes nested objects', () => {
      const malicious = '{"user":{"__proto__":{"isAdmin":true},"name":"Alice"}}';
      const result = safeJSONParse(malicious);

      expect(result).toEqual({
        user: {
          name: 'Alice',
        },
      });
      // Check nested object doesn't have dangerous property
      expect(Object.prototype.hasOwnProperty.call(result.user, '__proto__')).toBe(false);
    });

    test('handles arrays in schema', () => {
      const schema = {
        items: 'array',
        count: 'number',
      };

      const json = '{"items":[1,2,3],"count":3}';
      const result = safeJSONParse(json, schema);

      expect(result).toEqual({
        items: [1, 2, 3],
        count: 3,
      });
    });
  });

  describe('LRUCache', () => {
    test('stores and retrieves values', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);

      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });

    test('evicts oldest entries when at capacity', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // Should evict 'a'

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    test('updates LRU order on get', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Access 'a' to make it most recently used
      cache.get('a');

      // Add 'd' - should evict 'b' (oldest)
      cache.set('d', 4);

      expect(cache.get('a')).toBe(1); // Still there
      expect(cache.get('b')).toBeUndefined(); // Evicted
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    test('has() does not modify order (N-1 fix)', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // has() should not affect LRU order
      expect(cache.has('a')).toBe(true);

      // Add 'd' - 'a' should still be evicted since has() didn't make it recent
      cache.set('d', 4);

      expect(cache.get('a')).toBeUndefined(); // Evicted
    });

    test('values() returns all values (N-2 fix)', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      const values = cache.values();
      expect(values).toEqual([1, 2, 3]);
    });

    test('keys() returns all keys', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      const keys = cache.keys();
      expect(keys).toEqual(['a', 'b', 'c']);
    });

    test('entries() returns all key-value pairs', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);

      const entries = cache.entries();
      expect(entries).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
    });

    test('delete() removes entry', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);

      cache.delete('a');

      expect(cache.has('a')).toBe(false);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(1);
    });

    test('clear() removes all entries', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
    });

    test('size property reflects current entries', () => {
      const cache = new LRUCache<string, number>(10);

      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
      cache.delete('a');
      expect(cache.size).toBe(1);
    });

    test('throws error for invalid maxSize', () => {
      expect(() => new LRUCache(0)).toThrow('maxSize must be positive');
      expect(() => new LRUCache(-1)).toThrow('maxSize must be positive');
    });
  });
});
