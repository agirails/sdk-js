import { utils, BytesLike } from 'ethers';
import { DeliveryProof } from '../types';
import { DeliveryProofData, deliveryProofDataFromProof } from '../types/eip712';

/**
 * ProofGenerator - Content hashing and delivery proofs
 * Reference: Yellow Paper §11.4.1
 */
export class ProofGenerator {
  /**
   * Hash deliverable content
   * Uses Keccak256 per Yellow Paper §11.4.1
   */
  hashContent(content: string | Buffer): string {
    const buffer = typeof content === 'string' ? utils.toUtf8Bytes(content) : content;

    return utils.keccak256(buffer);
  }

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
  }): DeliveryProof {
    const { txId, deliverable, deliveryUrl, metadata = {} } = params;

    const contentHash = this.hashContent(deliverable);
    const size =
      typeof deliverable === 'string'
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
  toDeliveryProofTypedData(proof: DeliveryProof): DeliveryProofData {
    return deliveryProofDataFromProof(proof);
  }

  /**
   * Encode proof for on-chain submission
   */
  encodeProof(proof: DeliveryProof): BytesLike {
    return utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'uint256'],
      [proof.txId, proof.contentHash, proof.timestamp]
    );
  }

  /**
   * Decode proof from on-chain data
   */
  decodeProof(proofData: BytesLike): {
    txId: string;
    contentHash: string;
    timestamp: number;
  } {
    const [txId, contentHash, timestamp] = utils.defaultAbiCoder.decode(
      ['bytes32', 'bytes32', 'uint256'],
      proofData
    );

    return {
      txId,
      contentHash,
      timestamp: timestamp.toNumber()
    };
  }

  /**
   * Verify deliverable matches expected hash
   */
  verifyDeliverable(deliverable: string | Buffer, expectedHash: string): boolean {
    const actualHash = this.hashContent(deliverable);
    return actualHash.toLowerCase() === expectedHash.toLowerCase();
  }

  /**
   * Generate content hash from URL (for IPFS/Arweave)
   */
  async hashFromUrl(url: string): Promise<string> {
    // In browser/Node.js environment with fetch
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return this.hashContent(buffer);
    } catch (error) {
      throw new Error(`Failed to fetch content from ${url}: ${error}`);
    }
  }
}
