/**
 * SecureNonce - Cryptographically secure nonce generation
 *
 * SECURITY FIX (NEW-H-3): Provides secure random nonce generation
 * to prevent weak randomness vulnerabilities in EIP-712 message signing.
 *
 * Reference: V7 Re-Audit NEW-H-3 (Weak Random Nonce Generation)
 *
 * @module utils/SecureNonce
 */
/**
 * Generate a cryptographically secure random nonce (bytes32)
 *
 * Uses ethers.js randomBytes() which:
 * - Uses Node.js crypto.randomBytes() (CSPRNG)
 * - Uses Web Crypto API in browsers (window.crypto.getRandomValues)
 * - Guaranteed to be cryptographically secure
 *
 * @returns 32-byte hex string (0x...)
 *
 * @example
 * ```typescript
 * import { generateSecureNonce } from '@agirails/sdk';
 *
 * const nonce = generateSecureNonce();
 * console.log(nonce); // 0x1234...abcd (64 hex chars)
 * ```
 */
export declare function generateSecureNonce(): string;
/**
 * Validate nonce format (must be bytes32)
 *
 * @param nonce - Nonce to validate
 * @returns true if valid bytes32 format
 *
 * @example
 * ```typescript
 * isValidNonce('0x' + '00'.repeat(32)); // true
 * isValidNonce('0x1234'); // false (too short)
 * isValidNonce('not-hex'); // false (invalid format)
 * ```
 */
export declare function isValidNonce(nonce: string): boolean;
/**
 * Generate an array of secure nonces
 *
 * @param count - Number of nonces to generate
 * @returns Array of bytes32 hex strings
 *
 * @example
 * ```typescript
 * const nonces = generateSecureNonces(10);
 * console.log(nonces.length); // 10
 * ```
 */
export declare function generateSecureNonces(count: number): string[];
//# sourceMappingURL=SecureNonce.d.ts.map