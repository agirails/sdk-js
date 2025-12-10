import { isAddress, getAddress } from 'ethers';
import {
  InvalidAddressError,
  InvalidAmountError,
  ValidationError
} from '../errors';

/**
 * Input validation utilities
 */

/**
 * Validate Ethereum address
 */
export function validateAddress(address: string, fieldName: string = 'address'): void {
  if (!address || !isAddress(address)) {
    throw new InvalidAddressError(address);
  }

  if (address === getAddress('0x0000000000000000000000000000000000000000')) {
    throw new ValidationError(fieldName, 'Address cannot be zero address');
  }
}

/**
 * Validate amount (must be > 0)
 */
export function validateAmount(amount: bigint, _fieldName: string = 'amount'): void {
  // Handle null/undefined before calling toString()
  if (!amount) {
    throw new InvalidAmountError(String(amount)); // Convert safely to string
  }

  if (amount <= 0n) {
    throw new InvalidAmountError(amount.toString());
  }
}

/**
 * Validate deadline (must be future timestamp)
 */
export function validateDeadline(deadline: number, fieldName: string = 'deadline'): void {
  const now = Math.floor(Date.now() / 1000);
  
  if (deadline <= now) {
    throw new ValidationError(
      fieldName,
      `Deadline must be in the future (now: ${now}, deadline: ${deadline})`
    );
  }
}

/**
 * Validate dispute window (max 30 days per spec)
 */
export function validateDisputeWindow(
  disputeWindow: number,
  fieldName: string = 'disputeWindow'
): void {
  const MAX_DISPUTE_WINDOW = 30 * 24 * 60 * 60; // 30 days in seconds
  
  if (disputeWindow < 0) {
    throw new ValidationError(fieldName, 'Dispute window cannot be negative');
  }
  
  if (disputeWindow > MAX_DISPUTE_WINDOW) {
    throw new ValidationError(
      fieldName,
      `Dispute window exceeds maximum (${MAX_DISPUTE_WINDOW}s = 30 days)`
    );
  }
}

/**
 * Validate transaction ID format
 */
export function validateTxId(txId: string, fieldName: string = 'txId'): void {
  if (!txId || !txId.match(/^0x[a-fA-F0-9]{64}$/)) {
    throw new ValidationError(fieldName, 'Invalid transaction ID format (expected bytes32)');
  }
}

/**
 * Validate endpoint URL (for AgentRegistry)
 *
 * Security checks:
 * - Valid URL format
 * - HTTPS or IPFS protocols only
 * - No private/local IP addresses (SSRF protection)
 * - Maximum length 256 characters
 */
export function validateEndpointURL(endpoint: string, fieldName: string = 'endpoint'): void {
  if (!endpoint || endpoint.length === 0) {
    throw new ValidationError(fieldName, 'Endpoint is required');
  }

  const MAX_LENGTH = 256;
  if (endpoint.length > MAX_LENGTH) {
    throw new ValidationError(fieldName, `Endpoint exceeds maximum length (${MAX_LENGTH})`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch (e) {
    throw new ValidationError(fieldName, 'Endpoint must be a valid URL');
  }

  const allowedProtocols = ['https:', 'ipfs:'];
  if (!allowedProtocols.includes(parsedUrl.protocol)) {
    throw new ValidationError(
      fieldName,
      `Endpoint protocol must be one of: ${allowedProtocols.join(', ')}`
    );
  }

  // Block private IPs (SSRF protection)
  // Note: For IPv6, URL().hostname includes brackets e.g., "[::1]"
  const hostname = parsedUrl.hostname;
  const privateIPPatterns = [
    // IPv4 private ranges
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^localhost$/i,
    // IPv6 localhost and private ranges (with brackets as returned by URL parser)
    /^\[::1\]$/,                    // IPv6 localhost
    /^\[::ffff:7f/,                 // IPv4-mapped IPv6 localhost (127.x.x.x -> 7f in hex)
    /^\[::ffff:a/,                  // IPv4-mapped IPv6 private (10.x.x.x -> a in hex)
    /^\[::ffff:c0a8:/,              // IPv4-mapped IPv6 private (192.168.x.x -> c0a8 in hex)
    /^\[::ffff:ac1[0-9a-f]:/,       // IPv4-mapped IPv6 private (172.16-31.x.x -> ac1x in hex)
    /^\[fc00:/,                     // IPv6 unique local (private) fc00::/7
    /^\[fd/,                        // IPv6 unique local (private) fd00::/8
    /^\[fe80:/,                     // IPv6 link-local fe80::/10
  ];

  for (const pattern of privateIPPatterns) {
    if (pattern.test(hostname)) {
      throw new ValidationError(fieldName, 'Endpoint cannot point to private/local addresses');
    }
  }
}

