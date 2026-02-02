// Mock dns before importing the module under test (validateEndpointURL uses dynamic import('dns'))
jest.mock('dns', () => ({
  promises: {
    lookup: jest.fn(),
  },
}));

import { validateEndpointURL } from './validation';
import { ValidationError } from '../errors';

const dns = require('dns');

describe('validateEndpointURL (SSRF hardening)', () => {
  test('rejects if ANY resolved IP is private (checks all A/AAAA results)', async () => {
    dns.promises.lookup.mockResolvedValue([
      { address: '203.0.113.10', family: 4 }, // public
      { address: '127.0.0.1', family: 4 }, // private
    ]);

    await expect(validateEndpointURL('https://example.com')).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  test('accepts when all resolved IPs are public', async () => {
    dns.promises.lookup.mockResolvedValue([
      { address: '203.0.113.10', family: 4 },
      { address: '2001:db8::1', family: 6 },
    ]);

    await expect(validateEndpointURL('https://example.com')).resolves.toBeUndefined();
  });

  test('accepts ipfs:// URLs without DNS lookup', async () => {
    // Should not be called for ipfs:
    dns.promises.lookup.mockClear();

    await expect(
      validateEndpointURL('ipfs://bafybeigdyrzt6qf2q4v4xv7p3kz6xk7lq3y2c5v5w4x3y2c5v5w4x3y2c5v')
    ).resolves.toBeUndefined();

    expect(dns.promises.lookup).not.toHaveBeenCalled();
  });
});











