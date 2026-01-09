/**
 * Storage Validation Tests (AIP-7 Security)
 *
 * Comprehensive tests for storage-related validation functions:
 * - Gateway URL validation (SSRF protection)
 * - CID validation
 * - Arweave TX ID validation
 * - Error sanitization (credential redaction)
 *
 * @module utils/validation.storage.test
 */

import {
  validateGatewayURL,
  validateCID,
  validateArweaveTxId,
  sanitizeErrorMessage,
  createSafeError,
  validateSemver,
  validateHash,
  validateSignature,
  ALLOWED_IPFS_GATEWAYS,
  ALLOWED_ARWEAVE_GATEWAYS,
  CID_PATTERN,
  ARWEAVE_TX_ID_PATTERN
} from './validation';
import { ValidationError, InvalidCIDError, InvalidArweaveTxIdError } from '../errors';

// ============================================================================
// Gateway URL Validation (SSRF Protection - P0-1)
// ============================================================================

describe('validateGatewayURL', () => {
  describe('IPFS Gateways', () => {
    test('accepts valid IPFS gateway URLs', () => {
      expect(() => validateGatewayURL(
        'https://ipfs.filebase.io/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();

      expect(() => validateGatewayURL(
        'https://gateway.pinata.cloud/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();

      expect(() => validateGatewayURL(
        'https://cloudflare-ipfs.com/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();

      expect(() => validateGatewayURL(
        'https://ipfs.io/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();
    });

    test('accepts subdomains of whitelisted gateways', () => {
      // Note: This depends on implementation - some gateways use subdomains
      expect(() => validateGatewayURL(
        'https://QmTestCID.ipfs.dweb.link',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();
    });

    test('rejects non-whitelisted IPFS gateways', () => {
      expect(() => validateGatewayURL(
        'https://evil-ipfs-gateway.com/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).toThrow(ValidationError);

      expect(() => validateGatewayURL(
        'https://my-malicious-server.com/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).toThrow(/not in the allowed list/);
    });
  });

  describe('Arweave Gateways', () => {
    test('accepts valid Arweave gateway URLs', () => {
      expect(() => validateGatewayURL(
        'https://arweave.net/txid123',
        ALLOWED_ARWEAVE_GATEWAYS
      )).not.toThrow();

      expect(() => validateGatewayURL(
        'https://gateway.irys.xyz/txid123',
        ALLOWED_ARWEAVE_GATEWAYS
      )).not.toThrow();
    });

    test('rejects non-whitelisted Arweave gateways', () => {
      expect(() => validateGatewayURL(
        'https://malicious-arweave.net/txid123',
        ALLOWED_ARWEAVE_GATEWAYS
      )).toThrow(ValidationError);
    });
  });

  describe('Protocol Validation', () => {
    test('rejects HTTP (non-HTTPS) URLs', () => {
      expect(() => validateGatewayURL(
        'http://ipfs.filebase.io/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).toThrow(/must use HTTPS/);
    });

    test('rejects other protocols', () => {
      expect(() => validateGatewayURL(
        'ftp://ipfs.filebase.io/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).toThrow(/must use HTTPS/);

      expect(() => validateGatewayURL(
        'file:///etc/passwd',
        ALLOWED_IPFS_GATEWAYS
      )).toThrow(/must use HTTPS/);
    });
  });

  describe('Port Validation (NEW-3 fix)', () => {
    test('accepts standard HTTPS port 443', () => {
      expect(() => validateGatewayURL(
        'https://ipfs.filebase.io:443/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();
    });

    test('accepts default port (no port specified)', () => {
      expect(() => validateGatewayURL(
        'https://ipfs.filebase.io/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();
    });

    test('rejects non-standard ports (bypass attempt)', () => {
      // Attacker might try to use port 8080 on a whitelisted domain
      // that redirects to their malicious server
      expect(() => validateGatewayURL(
        'https://ipfs.filebase.io:8080/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).toThrow(/must use standard HTTPS port/);

      expect(() => validateGatewayURL(
        'https://arweave.net:9000/txid123',
        ALLOWED_ARWEAVE_GATEWAYS
      )).toThrow(/must use standard HTTPS port/);

      expect(() => validateGatewayURL(
        'https://ipfs.io:1337/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).toThrow(/Found port: 1337/);
    });
  });

  describe('Invalid Input Handling', () => {
    test('rejects null/undefined', () => {
      expect(() => validateGatewayURL(null as any, ALLOWED_IPFS_GATEWAYS))
        .toThrow(/is required/);
      expect(() => validateGatewayURL(undefined as any, ALLOWED_IPFS_GATEWAYS))
        .toThrow(/is required/);
    });

    test('rejects empty string', () => {
      expect(() => validateGatewayURL('', ALLOWED_IPFS_GATEWAYS))
        .toThrow(/is required/);
    });

    test('rejects invalid URL format', () => {
      expect(() => validateGatewayURL('not-a-url', ALLOWED_IPFS_GATEWAYS))
        .toThrow(/Invalid URL format/);

      expect(() => validateGatewayURL('just text', ALLOWED_IPFS_GATEWAYS))
        .toThrow(/Invalid URL format/);
    });
  });

  describe('Case Sensitivity', () => {
    test('handles case-insensitive domain matching', () => {
      expect(() => validateGatewayURL(
        'https://IPFS.FILEBASE.IO/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();

      expect(() => validateGatewayURL(
        'https://Gateway.Pinata.Cloud/ipfs/QmTest',
        ALLOWED_IPFS_GATEWAYS
      )).not.toThrow();
    });
  });
});

// ============================================================================
// CID Validation
// ============================================================================

describe('validateCID', () => {
  describe('Valid CIDs', () => {
    test('accepts valid CIDv0 (Qm...)', () => {
      const validCIDv0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      expect(() => validateCID(validCIDv0)).not.toThrow();
    });

    test('accepts valid CIDv1 (bafy...)', () => {
      const validCIDv1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      expect(() => validateCID(validCIDv1)).not.toThrow();
    });

    test('pattern matches expected formats', () => {
      expect(CID_PATTERN.test('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
      expect(CID_PATTERN.test('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true);
    });
  });

  describe('Invalid CIDs', () => {
    test('rejects null/undefined', () => {
      expect(() => validateCID(null as any)).toThrow(InvalidCIDError);
      expect(() => validateCID(undefined as any)).toThrow(InvalidCIDError);
    });

    test('rejects empty string', () => {
      expect(() => validateCID('')).toThrow(InvalidCIDError);
    });

    test('rejects wrong prefix', () => {
      expect(() => validateCID('Qn1234567890123456789012345678901234567890123'))
        .toThrow(/Invalid CID format/);
    });

    test('rejects wrong length', () => {
      expect(() => validateCID('QmShort')).toThrow(InvalidCIDError);
      expect(() => validateCID('bafy123')).toThrow(InvalidCIDError);
    });

    test('rejects invalid characters', () => {
      // CIDv0 excludes 0, O, I, l
      expect(() => validateCID('Qm000000000000000000000000000000000000000000'))
        .toThrow(InvalidCIDError);
    });

    test('rejects random strings', () => {
      expect(() => validateCID('not-a-cid')).toThrow(InvalidCIDError);
      expect(() => validateCID('hello world')).toThrow(InvalidCIDError);
    });
  });
});

// ============================================================================
// Arweave TX ID Validation
// ============================================================================

describe('validateArweaveTxId', () => {
  describe('Valid TX IDs', () => {
    test('accepts valid 43-character base64url TX ID', () => {
      // 43 chars of base64url
      const validTxId = 'usjm4PCxUd5mtaon_WOIw_cfrXZ5ZB0pYT9Aer-qTXY';
      expect(() => validateArweaveTxId(validTxId)).not.toThrow();
    });

    test('pattern matches expected format', () => {
      // Exactly 43 characters of base64url (a-z=26, A-Q=17 = 43 total)
      expect(ARWEAVE_TX_ID_PATTERN.test('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ')).toBe(true);
      expect(ARWEAVE_TX_ID_PATTERN.test('0123456789_-abcdefghijklmnopqrstuvwxyzABCDE')).toBe(true);
    });
  });

  describe('Invalid TX IDs', () => {
    test('rejects null/undefined', () => {
      expect(() => validateArweaveTxId(null as any)).toThrow(InvalidArweaveTxIdError);
      expect(() => validateArweaveTxId(undefined as any)).toThrow(InvalidArweaveTxIdError);
    });

    test('rejects empty string', () => {
      expect(() => validateArweaveTxId('')).toThrow(InvalidArweaveTxIdError);
    });

    test('rejects wrong length', () => {
      expect(() => validateArweaveTxId('short')).toThrow(/Invalid format/);
      expect(() => validateArweaveTxId('a'.repeat(44))).toThrow(InvalidArweaveTxIdError); // Too long
      expect(() => validateArweaveTxId('a'.repeat(42))).toThrow(InvalidArweaveTxIdError); // Too short
    });

    test('rejects invalid characters', () => {
      // base64url doesn't include + or /
      expect(() => validateArweaveTxId('abc+defghijklmnopqrstuvwxyzABCDEFGHIJKLM'))
        .toThrow(InvalidArweaveTxIdError);
      expect(() => validateArweaveTxId('abc/defghijklmnopqrstuvwxyzABCDEFGHIJKLM'))
        .toThrow(InvalidArweaveTxIdError);
    });
  });
});

// ============================================================================
// Error Sanitization (P0-2)
// ============================================================================

describe('sanitizeErrorMessage', () => {
  describe('Private Key Redaction', () => {
    test('redacts Ethereum private keys (64 hex chars)', () => {
      const error = new Error(
        'Failed with key: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      );
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('1234567890abcdef');
    });

    test('redacts multiple private keys', () => {
      const msg = 'Keys: 0x' + 'a'.repeat(64) + ' and 0x' + 'b'.repeat(64);
      const sanitized = sanitizeErrorMessage(msg);
      expect(sanitized.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('AWS Credential Redaction', () => {
    test('redacts AWS access key IDs', () => {
      const error = 'AWS key: AKIAIOSFODNN7EXAMPLE';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    test('redacts AWS secret keys (40 chars)', () => {
      const error = 'Secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('wJalrXUtnFEMI');
    });
  });

  describe('Bearer Token Redaction', () => {
    test('redacts Bearer tokens', () => {
      const error = 'Auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    });

    test('handles case-insensitive bearer', () => {
      const error = 'BEARER abc123token';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain('abc123token');
    });
  });

  describe('API Key Redaction', () => {
    test('redacts api_key parameters', () => {
      const error = 'Request failed: api_key=sk_live_secret123';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain('sk_live_secret123');
    });

    test('redacts api-key parameters', () => {
      const error = 'api-key: my_secret_key_123';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain('my_secret_key_123');
    });
  });

  describe('URL Credential Redaction', () => {
    test('redacts secret in query params', () => {
      const error = 'URL: https://api.com?secret=mysecret123&other=value';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain('mysecret123');
    });

    test('redacts password in query params', () => {
      const error = 'Failed: https://api.com?password=hunter2&user=bob';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain('hunter2');
    });
  });

  describe('Authorization Header Redaction', () => {
    test('redacts authorization header keyword and token', () => {
      // Pattern matches "authorization: <value>" where value stops at whitespace
      const error = 'Headers: authorization:Bearer-eyJtoken123';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain('Bearer-eyJtoken123');
      expect(sanitized).toContain('[REDACTED]');
    });

    test('Bearer tokens are separately redacted', () => {
      // Bearer tokens have their own pattern
      const error = 'Headers: authorization: Basic dXNlcjpwYXNz';
      const sanitized = sanitizeErrorMessage(error);
      // authorization: Basic is redacted, and any Bearer tokens are separately handled
      expect(sanitized).toContain('[REDACTED]');
    });
  });

  describe('Edge Cases', () => {
    test('handles null/undefined', () => {
      expect(sanitizeErrorMessage(null)).toBe('Unknown error');
      expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
    });

    test('handles Error objects', () => {
      const error = new Error('Simple error message');
      expect(sanitizeErrorMessage(error)).toBe('Simple error message');
    });

    test('handles string errors', () => {
      expect(sanitizeErrorMessage('String error')).toBe('String error');
    });

    test('handles non-string/non-Error objects', () => {
      expect(sanitizeErrorMessage({ code: 123 })).toBe('[object Object]');
      expect(sanitizeErrorMessage(123)).toBe('123');
    });

    test('preserves non-sensitive parts of message', () => {
      const error = 'Connection to https://api.example.com failed at 2024-01-01';
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).toContain('Connection to');
      expect(sanitized).toContain('api.example.com');
      expect(sanitized).toContain('2024-01-01');
    });
  });
});

describe('createSafeError', () => {
  test('creates safe error with sanitized message', () => {
    const error = new Error('Failed with key: 0x' + 'a'.repeat(64));
    const safe = createSafeError(error, 'upload');

    expect(safe.operation).toBe('upload');
    expect(safe.message).toContain('Operation failed: upload');
    expect(safe.message).toContain('[REDACTED]');
    expect(safe.message).not.toContain('aaaa');
  });

  test('includes error code if present', () => {
    const error = { message: 'Network error', code: 'ECONNRESET' };
    const safe = createSafeError(error, 'download');

    expect(safe.code).toBe('ECONNRESET');
  });

  test('uses UNKNOWN_ERROR for errors without code', () => {
    const error = new Error('Simple error');
    const safe = createSafeError(error, 'process');

    expect(safe.code).toBe('UNKNOWN_ERROR');
  });
});

// ============================================================================
// Other Validation Functions
// ============================================================================

describe('validateSemver', () => {
  test('accepts valid semver', () => {
    expect(() => validateSemver('1.0.0')).not.toThrow();
    expect(() => validateSemver('0.0.1')).not.toThrow();
    expect(() => validateSemver('10.20.30')).not.toThrow();
  });

  test('rejects invalid semver', () => {
    expect(() => validateSemver('1.0')).toThrow(ValidationError);
    expect(() => validateSemver('v1.0.0')).toThrow(ValidationError);
    expect(() => validateSemver('1.0.0-beta')).toThrow(ValidationError);
    expect(() => validateSemver('')).toThrow(ValidationError);
  });
});

describe('validateHash', () => {
  test('accepts valid bytes32 hash', () => {
    const validHash = '0x' + 'a'.repeat(64);
    expect(() => validateHash(validHash)).not.toThrow();
  });

  test('rejects invalid hash', () => {
    expect(() => validateHash('0x123')).toThrow(ValidationError);
    expect(() => validateHash('not-a-hash')).toThrow(ValidationError);
    expect(() => validateHash('')).toThrow(ValidationError);
  });
});

describe('validateSignature', () => {
  test('accepts valid 65-byte signature', () => {
    const validSig = '0x' + 'a'.repeat(130);
    expect(() => validateSignature(validSig)).not.toThrow();
  });

  test('rejects invalid signature', () => {
    expect(() => validateSignature('0x' + 'a'.repeat(64))).toThrow(ValidationError);
    expect(() => validateSignature('not-a-sig')).toThrow(ValidationError);
    expect(() => validateSignature('')).toThrow(ValidationError);
  });
});
