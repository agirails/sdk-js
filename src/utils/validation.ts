import { isAddress, getAddress } from 'ethers';
import {
  InvalidAddressError,
  InvalidAmountError,
  ValidationError,
  InvalidCIDError,
  InvalidArweaveTxIdError
} from '../errors';

/**
 * Input validation utilities
 */

// ============================================================================
// Shared Validation Patterns (AIP-7 Storage)
// ============================================================================

/** Ethereum address validation pattern */
export const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/** Transaction ID (bytes32) validation pattern */
export const TX_ID_PATTERN = /^0x[a-fA-F0-9]{64}$/;

/** Hash (bytes32) validation pattern */
export const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

/** Signature (65 bytes = 130 hex chars) validation pattern */
export const SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;

/** CID validation pattern (CIDv0 or CIDv1) */
export const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

/** Arweave TX ID pattern (43 characters, base64url) */
export const ARWEAVE_TX_ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

/** Semver pattern for version validation */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

// ============================================================================
// Gateway URL Whitelist (SSRF Protection - P0-1)
// ============================================================================

/**
 * Allowed IPFS gateway domains
 * Only whitelisted gateways are allowed for downloads
 */
export const ALLOWED_IPFS_GATEWAYS = [
  'ipfs.filebase.io',
  'gateway.pinata.cloud',
  'cloudflare-ipfs.com',
  'ipfs.io',
  'dweb.link',
  'w3s.link',
  'nftstorage.link'
] as const;

/**
 * Allowed Arweave gateway domains
 * Only whitelisted gateways are allowed for downloads
 */
export const ALLOWED_ARWEAVE_GATEWAYS = [
  'arweave.net',
  'gateway.irys.xyz',
  'arweave.dev'
] as const;

// ============================================================================
// Validation Functions
// ============================================================================

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
  // Includes both standard ::ffff: and alternative ::ffff:0: notation (NEW-2 fix)
  const ipv6PrivatePatterns = [
    /^::1$/,                       // IPv6 loopback
    /^::ffff:127\./,               // IPv4-mapped localhost
    /^::ffff:0:127\./,             // Alternative IPv4-mapped localhost
    /^::ffff:10\./,                // IPv4-mapped private 10.x
    /^::ffff:0:10\./,              // Alternative IPv4-mapped private 10.x
    /^::ffff:192\.168\./,          // IPv4-mapped private 192.168.x
    /^::ffff:0:192\.168\./,        // Alternative IPv4-mapped private 192.168.x
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./,  // IPv4-mapped private 172.16-31.x
    /^::ffff:0:172\.(1[6-9]|2\d|3[01])\./,// Alternative IPv4-mapped private 172.16-31.x
    /^::ffff:169\.254\./,          // IPv4-mapped link-local (CRITICAL: AWS metadata)
    /^::ffff:0:169\.254\./,        // Alternative IPv4-mapped link-local
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

// ============================================================================
// Storage Validation Functions (AIP-7)
// ============================================================================

/**
 * Validate IPFS CID format
 *
 * @param cid - IPFS CID to validate
 * @param fieldName - Field name for error messages
 * @throws {InvalidCIDError} If CID is invalid
 */
export function validateCID(cid: string, fieldName: string = 'cid'): void {
  if (!cid || typeof cid !== 'string') {
    throw new InvalidCIDError(String(cid), 'CID is required');
  }

  if (!CID_PATTERN.test(cid)) {
    throw new InvalidCIDError(cid, 'Invalid CID format (expected CIDv0 Qm... or CIDv1 bafy...)');
  }
}

/**
 * Validate Arweave transaction ID format
 *
 * @param txId - Arweave TX ID to validate
 * @param fieldName - Field name for error messages
 * @throws {InvalidArweaveTxIdError} If TX ID is invalid
 */
export function validateArweaveTxId(txId: string, fieldName: string = 'txId'): void {
  if (!txId || typeof txId !== 'string') {
    throw new InvalidArweaveTxIdError(String(txId), 'TX ID is required');
  }

  if (!ARWEAVE_TX_ID_PATTERN.test(txId)) {
    throw new InvalidArweaveTxIdError(
      txId,
      'Invalid format (expected 43 character base64url string)'
    );
  }
}

/**
 * Validate gateway URL against whitelist (SSRF Protection - P0-1)
 *
 * SECURITY FIX: Only allow downloads from whitelisted gateway domains.
 * This prevents SSRF attacks where attacker controls the gateway URL.
 *
 * @param url - Full gateway URL to validate
 * @param allowedGateways - List of allowed gateway domains
 * @param fieldName - Field name for error messages
 * @throws {ValidationError} If gateway is not whitelisted
 */
export function validateGatewayURL(
  url: string,
  allowedGateways: readonly string[],
  fieldName: string = 'gatewayUrl'
): void {
  if (!url || typeof url !== 'string') {
    throw new ValidationError(fieldName, 'Gateway URL is required');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ValidationError(fieldName, 'Invalid URL format');
  }

  // Must be HTTPS
  if (parsedUrl.protocol !== 'https:') {
    throw new ValidationError(fieldName, 'Gateway URL must use HTTPS');
  }

  // NEW-3: Validate port (must be 443 or default, prevents port bypass attacks)
  const port = parsedUrl.port;
  if (port && !['443', ''].includes(port)) {
    throw new ValidationError(
      fieldName,
      `Gateway URL must use standard HTTPS port (443). Found port: ${port}. ` +
      `Non-standard ports may bypass whitelist intent.`
    );
  }

  // Check hostname against whitelist
  const hostname = parsedUrl.hostname.toLowerCase();
  const isAllowed = allowedGateways.some(gateway =>
    hostname === gateway.toLowerCase() ||
    hostname.endsWith('.' + gateway.toLowerCase())
  );

  if (!isAllowed) {
    throw new ValidationError(
      fieldName,
      `Gateway "${hostname}" is not in the allowed list. ` +
      `Allowed gateways: ${allowedGateways.join(', ')}. ` +
      `This restriction prevents SSRF attacks.`
    );
  }
}

/**
 * Validate semver version string
 *
 * @param version - Version string to validate
 * @param fieldName - Field name for error messages
 * @throws {ValidationError} If version is invalid
 */
export function validateSemver(version: string, fieldName: string = 'version'): void {
  if (!version || typeof version !== 'string') {
    throw new ValidationError(fieldName, 'Version is required');
  }

  if (!SEMVER_PATTERN.test(version)) {
    throw new ValidationError(fieldName, 'Must be semver format (e.g., 1.0.0)');
  }
}

/**
 * Validate hash (bytes32) format
 *
 * @param hash - Hash to validate
 * @param fieldName - Field name for error messages
 * @throws {ValidationError} If hash is invalid
 */
export function validateHash(hash: string, fieldName: string = 'hash'): void {
  if (!hash || typeof hash !== 'string') {
    throw new ValidationError(fieldName, 'Hash is required');
  }

  if (!HASH_PATTERN.test(hash)) {
    throw new ValidationError(fieldName, 'Invalid hash format (expected bytes32 hex string)');
  }
}

/**
 * Validate signature format (65 bytes)
 *
 * @param signature - Signature to validate
 * @param fieldName - Field name for error messages
 * @throws {ValidationError} If signature is invalid
 */
export function validateSignature(signature: string, fieldName: string = 'signature'): void {
  if (!signature || typeof signature !== 'string') {
    throw new ValidationError(fieldName, 'Signature is required');
  }

  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new ValidationError(
      fieldName,
      'Invalid signature format (expected 65 bytes = 0x + 130 hex chars)'
    );
  }
}

// ============================================================================
// Error Sanitization (P0-2)
// ============================================================================

/**
 * Sanitize error messages to remove sensitive data
 *
 * SECURITY FIX (P0-2): Removes credentials, private keys, and other
 * sensitive data from error messages before logging/returning.
 *
 * @param error - Error to sanitize
 * @returns Sanitized error message
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error';

  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = String(error);
  }

  // Patterns to redact
  const sensitivePatterns = [
    // Private keys (hex)
    /0x[a-fA-F0-9]{64}/g,
    // AWS access key IDs
    /AKIA[0-9A-Z]{16}/g,
    // AWS secret keys (40 chars)
    /[a-zA-Z0-9/+=]{40}/g,
    // Bearer tokens
    /Bearer\s+[a-zA-Z0-9._-]+/gi,
    // API keys (generic pattern)
    /api[_-]?key[=:]\s*["']?[a-zA-Z0-9_-]+["']?/gi,
    // Secret in URL query params
    /secret[=][^&\s]+/gi,
    // Password in URL
    /password[=][^&\s]+/gi,
    // Authorization headers
    /authorization[=:]\s*["']?[^"'\s]+["']?/gi
  ];

  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  return sanitized;
}

/**
 * Create a safe error object for external consumption
 *
 * SECURITY FIX (P0-2): Returns error without stack trace or sensitive details
 *
 * @param error - Original error
 * @param operation - What operation failed
 * @returns Safe error object
 */
export function createSafeError(
  error: unknown,
  operation: string
): { message: string; code: string; operation: string } {
  const sanitizedMessage = sanitizeErrorMessage(error);

  // Don't expose internal details - generic message with operation context
  return {
    message: `Operation failed: ${operation}. ${sanitizedMessage}`,
    code: (error as any)?.code || 'UNKNOWN_ERROR',
    operation
  };
}

