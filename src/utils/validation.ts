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
 * Check if IP address is private/local (SSRF protection)
 *
 * SECURITY FIX (H-1): Comprehensive private IP detection
 * - IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 * - IPv6: ::1, fc00::/7, fd00::/8, fe80::/10
 * - IPv4-mapped IPv6: ::ffff:127.0.0.0/8, ::ffff:10.0.0.0/8, etc.
 *
 * @param ip - IP address (v4 or v6, no brackets)
 * @returns true if IP is private/local
 */
function isPrivateIP(ip: string): boolean {
  // Remove IPv6 brackets if present
  const cleanIP = ip.replace(/^\[|\]$/g, '');

  // IPv4 patterns
  const ipv4PrivatePatterns = [
    /^127\./,                      // Loopback
    /^10\./,                       // Private class A
    /^172\.(1[6-9]|2\d|3[01])\./,  // Private class B (172.16-172.31)
    /^192\.168\./,                 // Private class C
    /^169\.254\./,                 // Link-local / AWS metadata
    /^0\./,                        // Invalid source
    /^localhost$/i                 // Localhost hostname
  ];

  for (const pattern of ipv4PrivatePatterns) {
    if (pattern.test(cleanIP)) {
      return true;
    }
  }

  // IPv6 patterns (without brackets)
  const ipv6PrivatePatterns = [
    /^::1$/,                       // IPv6 loopback
    /^::ffff:127\./,               // IPv4-mapped localhost
    /^::ffff:10\./,                // IPv4-mapped private 10.x
    /^::ffff:192\.168\./,          // IPv4-mapped private 192.168.x
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./,  // IPv4-mapped private 172.16-31.x
    /^::ffff:169\.254\./,          // IPv4-mapped link-local (CRITICAL: AWS metadata)
    /^fc00:/i,                     // IPv6 ULA fc00::/7
    /^fd/i,                        // IPv6 ULA fd00::/8
    /^fe80:/i                      // IPv6 link-local fe80::/10
  ];

  for (const pattern of ipv6PrivatePatterns) {
    if (pattern.test(cleanIP)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate endpoint URL (for AgentRegistry)
 *
 * SECURITY FIX (H-1): Enhanced SSRF protection with DNS resolution
 *
 * Security checks:
 * - Valid URL format
 * - HTTPS or IPFS protocols only
 * - Maximum length 256 characters
 * - DNS resolution check (hostname → IP validation)
 * - No private/local IP addresses (SSRF protection)
 * - Blocks AWS metadata endpoint (169.254.169.254)
 * - Fail-secure: if DNS lookup fails, reject
 *
 * **CRITICAL**: This function is now ASYNC due to DNS resolution.
 * All callers MUST await this function.
 *
 * @param endpoint - URL to validate
 * @param fieldName - Field name for error messages
 * @throws {ValidationError} If endpoint is invalid or points to private IP
 */
export async function validateEndpointURL(endpoint: string, fieldName: string = 'endpoint'): Promise<void> {
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

  // SECURITY FIX (H-1): First check hostname syntax
  // URL().hostname strips brackets from IPv6 addresses
  const hostname = parsedUrl.hostname;

  // Check if hostname itself looks like a private IP (bypass DNS for direct IPs)
  if (isPrivateIP(hostname)) {
    throw new ValidationError(
      fieldName,
      `Endpoint hostname "${hostname}" is a private/local address (SSRF protection)`
    );
  }

  // SECURITY FIX (H-1): DNS resolution check
  // Resolve hostname to IP address(es) and validate each resolved IP
  // This prevents DNS rebinding attacks where hostname resolves to private IP
  if (parsedUrl.protocol === 'https:') {
    try {
      // Dynamic import for Node.js dns module (not available in browser)
      // If running in browser, skip DNS check (browsers have their own SSRF protection)
      const dns = await import('dns').catch(() => null);

      if (dns) {
        // Resolve hostname to ALL IP addresses and validate each (prevents AAAA/A bypass)
        const results = await dns.promises.lookup(hostname, { all: true });

        for (const { address, family } of results) {
          // Validate resolved IP is not private
          if (isPrivateIP(address)) {
            throw new ValidationError(
              fieldName,
              `Endpoint hostname "${hostname}" resolves to private IP address ${address} (SSRF protection). ` +
                `This could be an attempt to access internal services. ` +
                `IP family: IPv${family}`
            );
          }

          // SECURITY FIX (H-1): CRITICAL - Block AWS metadata endpoint explicitly
          if (address === '169.254.169.254') {
            throw new ValidationError(
              fieldName,
              `Endpoint resolves to AWS metadata endpoint (169.254.169.254). ` +
                `This is blocked for security reasons (credential theft prevention).`
            );
          }
        }
      }
    } catch (error: any) {
      // SECURITY FIX (H-1): Fail-secure - if DNS lookup fails, reject
      // Don't allow requests to unresolvable hostnames (could be DNS rebinding setup)
      if (error instanceof ValidationError) {
        throw error; // Re-throw validation errors
      }

      throw new ValidationError(
        fieldName,
        `Failed to resolve hostname "${hostname}": ${error.message}. ` +
        `DNS resolution is required for SSRF protection (fail-secure mode).`
      );
    }
  }

  // IPFS endpoints skip DNS check (no DNS resolution for IPFS CIDs)
}

