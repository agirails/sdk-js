"use strict";
/**
 * DID (Decentralized Identity) Types - AIP-7 §2
 *
 * Implements W3C DID specification for Ethereum-based identities
 * using the did:ethr method with ERC-1056 registry
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttributeName = exports.DelegateType = void 0;
/**
 * Delegate types for ERC-1056
 */
var DelegateType;
(function (DelegateType) {
    /** Can sign on behalf of identity */
    DelegateType["SIGNING"] = "veriKey";
    /** Can encrypt messages for identity */
    DelegateType["ENCRYPTION"] = "encryptionKey";
    /** Can perform general actions */
    DelegateType["GENERAL"] = "delegate";
    /** Custom delegate type */
    DelegateType["CUSTOM"] = "custom";
})(DelegateType || (exports.DelegateType = DelegateType = {}));
/**
 * Attribute names for ERC-1056
 */
var AttributeName;
(function (AttributeName) {
    /** Service endpoint (e.g., AGIRAILS API endpoint) */
    AttributeName["SERVICE_ENDPOINT"] = "did/svc/AGIRAILSProvider";
    /** Public key for verification */
    AttributeName["PUBLIC_KEY"] = "did/pub/Secp256k1/veriKey";
    /** Encryption public key */
    AttributeName["ENCRYPTION_KEY"] = "did/pub/X25519/enc";
    /** Custom attribute */
    AttributeName["CUSTOM"] = "custom";
})(AttributeName || (exports.AttributeName = AttributeName = {}));
//# sourceMappingURL=did.js.map