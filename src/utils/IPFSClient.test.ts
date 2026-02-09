/**
 * IPFSClient Security Tests
 *
 * Tests cover:
 * - allowLocalhost default behavior (should be false)
 * - Localhost rejection when allowLocalhost=false
 * - Localhost acceptance when allowLocalhost=true
 * - SSRF protection (blocked hosts)
 * - IPFS_CONFIGS preset values
 */

// Mock kubo-rpc-client since it's a peer dependency
jest.mock('kubo-rpc-client', () => ({
  create: jest.fn(() => ({})),
}));

import { IPFSHTTPClientImpl, IPFS_CONFIGS } from './IPFSClient';

describe('IPFSClient Security', () => {
  describe('allowLocalhost default', () => {
    it('should reject localhost by default (allowLocalhost=false)', () => {
      expect(() => new IPFSHTTPClientImpl({
        url: 'http://localhost:5001',
      })).toThrow('Localhost IPFS endpoints are disabled');
    });

    it('should reject 127.0.0.1 by default', () => {
      expect(() => new IPFSHTTPClientImpl({
        url: 'http://127.0.0.1:5001',
      })).toThrow('Localhost IPFS endpoints are disabled');
    });

    it('should accept localhost when explicitly enabled', () => {
      expect(() => new IPFSHTTPClientImpl({
        url: 'http://localhost:5001',
        allowLocalhost: true,
      })).not.toThrow();
    });

    it('should accept remote HTTPS URLs by default', () => {
      expect(() => new IPFSHTTPClientImpl({
        url: 'https://ipfs.infura.io:5001/api/v0',
      })).not.toThrow();
    });
  });

  describe('SSRF protection', () => {
    it('should block GCP metadata endpoint', () => {
      expect(() => new IPFSHTTPClientImpl({
        url: 'http://metadata.google.internal',
      })).toThrow('blocked for security reasons');
    });

    it('should block AWS metadata endpoint', () => {
      expect(() => new IPFSHTTPClientImpl({
        url: 'http://169.254.169.254',
      })).toThrow('blocked for security reasons');
    });

    it('should block non-allowed protocols', () => {
      expect(() => new IPFSHTTPClientImpl({
        url: 'ftp://ipfs.example.com',
      })).toThrow('protocol "ftp:" not allowed');
    });
  });

  describe('IPFS_CONFIGS presets', () => {
    it('local config should have allowLocalhost=true', () => {
      expect(IPFS_CONFIGS.local.allowLocalhost).toBe(true);
    });

    it('local config should use localhost URL', () => {
      expect(IPFS_CONFIGS.local.url).toBe('http://localhost:5001');
    });
  });
});
