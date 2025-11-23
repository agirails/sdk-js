/**
 * Canonical JSON Serialization for AIP-4
 * Reference: AIP-4 §3.6
 *
 * CRITICAL: Uses fast-json-stable-stringify@^2.1.0 for deterministic hashing
 * This ensures resultHash is identical across all implementations (JS, Python, Go, Rust)
 */

import stringify from 'fast-json-stable-stringify';
import { keccak256, toUtf8Bytes } from 'ethers';

/**
 * Canonical JSON stringify (sorted keys, no whitespace)
 * @param obj - Any JSON-serializable object
 * @returns Canonical JSON string
 */
export function canonicalJsonStringify(obj: any): string {
  return stringify(obj);
}

/**
 * Compute keccak256 hash of canonical JSON
 * @param obj - Any JSON-serializable object
 * @returns Keccak256 hash (0x-prefixed hex string)
 */
export function computeCanonicalHash(obj: any): string {
  const canonical = canonicalJsonStringify(obj);
  return keccak256(toUtf8Bytes(canonical));
}

/**
 * Compute result hash for delivery proof (AIP-4)
 * @param resultData - Service result data
 * @returns Keccak256 hash of canonical result JSON
 */
export function computeResultHash(resultData: any): string {
  return computeCanonicalHash(resultData);
}
