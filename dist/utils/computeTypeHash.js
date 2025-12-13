"use strict";
/**
 * Compute EIP-712 Type Hash for AIP-4 Delivery Proof
 * Reference: AIP-4 §3.3, EIP-712 specification
 *
 * Run with: npx tsx src/utils/computeTypeHash.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDeliveryProofTypeHash = computeDeliveryProofTypeHash;
exports.getDeliveryProofTypeString = getDeliveryProofTypeString;
const ethers_1 = require("ethers");
const eip712_1 = require("../types/eip712");
/**
 * Compute EIP-712 type hash for DeliveryProof
 * @returns Type hash (bytes32)
 */
function computeDeliveryProofTypeHash() {
    const encoder = ethers_1.TypedDataEncoder.from(eip712_1.AIP4DeliveryProofTypes);
    const typeString = encoder.encodeType('DeliveryProof');
    // Type hash is keccak256 of the encoded type string
    const typeHash = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(typeString));
    return typeHash;
}
/**
 * Get encoded type string for DeliveryProof
 * @returns Type string (for documentation)
 */
function getDeliveryProofTypeString() {
    return ethers_1.TypedDataEncoder.from(eip712_1.AIP4DeliveryProofTypes).encodeType('DeliveryProof');
}
// If run directly, compute and print type hash
if (require.main === module) {
    console.log('=== AIP-4 Delivery Proof EIP-712 Type Hash ===\n');
    const typeString = getDeliveryProofTypeString();
    console.log('Type String:');
    console.log(typeString);
    console.log();
    const typeHash = computeDeliveryProofTypeHash();
    console.log('Type Hash (bytes32):');
    console.log(typeHash);
    console.log();
    console.log('✅ Update this value in:');
    console.log('- /Testnet/docs/AIP-4.md:204');
    console.log('- /Testnet/docs/schemas/aip-4-delivery.eip712.json:11');
}
//# sourceMappingURL=computeTypeHash.js.map