"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProofGenerator = void 0;
const ethers_1 = require("ethers");
const eip712_1 = require("../types/eip712");
/**
 * ProofGenerator - Content hashing and delivery proofs
 * Reference: Yellow Paper §11.4.1
 */
class ProofGenerator {
    /**
     * Hash deliverable content
     * Uses Keccak256 per Yellow Paper §11.4.1
     */
    hashContent(content) {
        const buffer = typeof content === 'string' ? (0, ethers_1.toUtf8Bytes)(content) : content;
        return (0, ethers_1.keccak256)(buffer);
    }
    /**
     * Generate delivery proof (AIP-4)
     * Reference: Yellow Paper §8.2
     * Complete schema with type field for AIP compliance
     * Computed fields (size, mimeType) cannot be overwritten
     */
    generateDeliveryProof(params) {
        const { txId, deliverable, deliveryUrl, metadata = {} } = params;
        const contentHash = this.hashContent(deliverable);
        const size = typeof deliverable === 'string'
            ? Buffer.from(deliverable).length
            : deliverable.length;
        // Spread user metadata first, then enforce computed fields
        // This prevents users from spoofing size/mimeType
        const { size: _ignoredSize, mimeType: _ignoredMimeType, ...userMetadata } = metadata;
        return {
            type: 'delivery.proof', // Required per AIP-4
            txId,
            contentHash,
            timestamp: Date.now(),
            deliveryUrl, // Optional: IPFS/Arweave link
            metadata: {
                ...userMetadata, // User-supplied fields (excluding reserved)
                size, // Enforced: computed from deliverable
                mimeType: metadata.mimeType || 'application/octet-stream' // Enforced with fallback
            }
        };
    }
    /**
     * Convert a generated delivery proof into typed EIP-712 data
     */
    toDeliveryProofTypedData(proof) {
        return (0, eip712_1.deliveryProofDataFromProof)(proof);
    }
    /**
     * Encode proof for on-chain submission
     */
    encodeProof(proof) {
        const abiCoder = ethers_1.AbiCoder.defaultAbiCoder();
        return abiCoder.encode(['bytes32', 'bytes32', 'uint256'], [proof.txId, proof.contentHash, proof.timestamp]);
    }
    /**
     * Decode proof from on-chain data
     */
    decodeProof(proofData) {
        const abiCoder = ethers_1.AbiCoder.defaultAbiCoder();
        const [txId, contentHash, timestamp] = abiCoder.decode(['bytes32', 'bytes32', 'uint256'], proofData);
        return {
            txId,
            contentHash,
            timestamp: Number(timestamp)
        };
    }
    /**
     * Verify deliverable matches expected hash
     */
    verifyDeliverable(deliverable, expectedHash) {
        const actualHash = this.hashContent(deliverable);
        return actualHash.toLowerCase() === expectedHash.toLowerCase();
    }
    /**
     * Generate content hash from URL (for IPFS/Arweave)
     */
    async hashFromUrl(url) {
        // In browser/Node.js environment with fetch
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            return this.hashContent(buffer);
        }
        catch (error) {
            throw new Error(`Failed to fetch content from ${url}: ${error}`);
        }
    }
}
exports.ProofGenerator = ProofGenerator;
//# sourceMappingURL=ProofGenerator.js.map