import { BytesLike } from 'ethers';
import { DeliveryProof } from '../types';
import { DeliveryProofData } from '../types/eip712';
/**
 * ProofGenerator - Content hashing and delivery proofs
 * Reference: Yellow Paper §11.4.1
 */
export declare class ProofGenerator {
    /**
     * Hash deliverable content
     * Uses Keccak256 per Yellow Paper §11.4.1
     */
    hashContent(content: string | Buffer): string;
    /**
     * Generate delivery proof (AIP-4)
     * Reference: Yellow Paper §8.2
     * Complete schema with type field for AIP compliance
     * Computed fields (size, mimeType) cannot be overwritten
     */
    generateDeliveryProof(params: {
        txId: string;
        deliverable: string | Buffer;
        deliveryUrl?: string;
        metadata?: Record<string, any>;
    }): DeliveryProof;
    /**
     * Convert a generated delivery proof into typed EIP-712 data
     */
    toDeliveryProofTypedData(proof: DeliveryProof): DeliveryProofData;
    /**
     * Encode proof for on-chain submission
     */
    encodeProof(proof: DeliveryProof): BytesLike;
    /**
     * Decode proof from on-chain data
     */
    decodeProof(proofData: BytesLike): {
        txId: string;
        contentHash: string;
        timestamp: number;
    };
    /**
     * Verify deliverable matches expected hash
     */
    verifyDeliverable(deliverable: string | Buffer, expectedHash: string): boolean;
    /**
     * Generate content hash from URL (for IPFS/Arweave)
     */
    hashFromUrl(url: string): Promise<string>;
}
//# sourceMappingURL=ProofGenerator.d.ts.map