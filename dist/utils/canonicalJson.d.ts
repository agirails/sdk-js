/**
 * Canonical JSON Serialization for AIP-4
 * Reference: AIP-4 §3.6
 *
 * CRITICAL: Uses fast-json-stable-stringify@^2.1.0 for deterministic hashing
 * This ensures resultHash is identical across all implementations (JS, Python, Go, Rust)
 */
/**
 * Canonical JSON stringify (sorted keys, no whitespace)
 * @param obj - Any JSON-serializable object
 * @returns Canonical JSON string
 */
export declare function canonicalJsonStringify(obj: any): string;
/**
 * Compute keccak256 hash of canonical JSON
 * @param obj - Any JSON-serializable object
 * @returns Keccak256 hash (0x-prefixed hex string)
 */
export declare function computeCanonicalHash(obj: any): string;
/**
 * Compute result hash for delivery proof (AIP-4)
 * @param resultData - Service result data
 * @returns Keccak256 hash of canonical result JSON
 */
export declare function computeResultHash(resultData: any): string;
//# sourceMappingURL=canonicalJson.d.ts.map