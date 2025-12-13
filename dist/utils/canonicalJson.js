"use strict";
/**
 * Canonical JSON Serialization for AIP-4
 * Reference: AIP-4 §3.6
 *
 * CRITICAL: Uses fast-json-stable-stringify@^2.1.0 for deterministic hashing
 * This ensures resultHash is identical across all implementations (JS, Python, Go, Rust)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalJsonStringify = canonicalJsonStringify;
exports.computeCanonicalHash = computeCanonicalHash;
exports.computeResultHash = computeResultHash;
const fast_json_stable_stringify_1 = __importDefault(require("fast-json-stable-stringify"));
const ethers_1 = require("ethers");
/**
 * Canonical JSON stringify (sorted keys, no whitespace)
 * @param obj - Any JSON-serializable object
 * @returns Canonical JSON string
 */
function canonicalJsonStringify(obj) {
    return (0, fast_json_stable_stringify_1.default)(obj);
}
/**
 * Compute keccak256 hash of canonical JSON
 * @param obj - Any JSON-serializable object
 * @returns Keccak256 hash (0x-prefixed hex string)
 */
function computeCanonicalHash(obj) {
    const canonical = canonicalJsonStringify(obj);
    return (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(canonical));
}
/**
 * Compute result hash for delivery proof (AIP-4)
 * @param resultData - Service result data
 * @returns Keccak256 hash of canonical result JSON
 */
function computeResultHash(resultData) {
    return computeCanonicalHash(resultData);
}
//# sourceMappingURL=canonicalJson.js.map