import { AbiCoder, Signer } from 'ethers';
import { EAS } from '@ethereum-attestation-service/eas-sdk';
import { DeliveryProof } from '../types';
import { deliveryProofDataFromProof } from '../types/eip712';
import {
  IUsedAttestationTracker,
  InMemoryUsedAttestationTracker
} from '../utils/UsedAttestationTracker';
import { sdkLogger } from '../utils/Logger';

export interface EASConfig {
  contractAddress: string;
  deliveryProofSchemaId: string;
}

export interface AttestationResponse {
  uid: string;
  transactionHash: string;
}

/**
 * EASHelper - utility wrapper for Ethereum Attestation Service interactions
 */
export class EASHelper {
  private readonly eas: EAS;
  private readonly attestationTracker: IUsedAttestationTracker;

  /**
   * Create EASHelper instance
   *
   * @param signer - Ethers signer for signing attestations
   * @param config - EAS configuration
   * @param attestationTracker - Optional tracker for replay attack prevention (C-1 fix)
   *
   * SECURITY FIX (NEW-M-2): Validates schema UID format in constructor
   */
  constructor(
    signer: Signer,
    private readonly config: EASConfig,
    attestationTracker?: IUsedAttestationTracker
  ) {
    // SECURITY FIX (NEW-M-2): Validate schema UID format
    if (!config.deliveryProofSchemaId || !/^0x[a-fA-F0-9]{64}$/.test(config.deliveryProofSchemaId)) {
      throw new Error(
        `Invalid deliveryProofSchemaId: must be bytes32 hex string (0x...). ` +
        `Got: ${config.deliveryProofSchemaId}`
      );
    }

    if (config.deliveryProofSchemaId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      throw new Error('deliveryProofSchemaId cannot be zero bytes32');
    }

    // Use official EAS SDK wrapper to ensure ABI correctness across deployments
    // (includes fields like revocationTime that are required for security checks).
    this.eas = new EAS(config.contractAddress);
    this.eas.connect(signer as any);
    // SECURITY FIX (C-1): Use provided tracker or create new in-memory one
    if (!attestationTracker) {
      // SECURITY WARNING (HIGH-5): In-memory tracker does not persist across restarts!
      // For production use, provide a FileBasedUsedAttestationTracker with a stateDirectory:
      //
      //   import { FileBasedUsedAttestationTracker } from '../utils/UsedAttestationTracker';
      //   const tracker = new FileBasedUsedAttestationTracker('/path/to/state');
      //   const easHelper = new EASHelper(signer, config, tracker);
      //
      // Without persistence, attestation replay protection is lost on process restart,
      // allowing potential double-spend attacks.
      sdkLogger.warn('Using in-memory attestation tracker - replay protection lost on restart (use FileBasedUsedAttestationTracker for production)');
    }
    this.attestationTracker = attestationTracker || new InMemoryUsedAttestationTracker();
  }

  /**
   * Get the attestation tracker for external use
   */
  getAttestationTracker(): IUsedAttestationTracker {
    return this.attestationTracker;
  }

  /**
   * Create an attestation for a delivery proof. Returns the attestation UID and transaction hash.
   */
  async attestDeliveryProof(
    proof: DeliveryProof,
    recipient: string,
    options?: { expirationTime?: number; revocable?: boolean }
  ): Promise<AttestationResponse> {
    const { expirationTime = 0, revocable = true } = options || {};
    const proofData = deliveryProofDataFromProof(proof);

    const abiCoder = AbiCoder.defaultAbiCoder();
    const encodedData = abiCoder.encode(
      ['bytes32', 'bytes32', 'uint256', 'string', 'uint256', 'string'],
      [
        proofData.txId,
        proofData.contentHash,
        proofData.timestamp,
        proofData.deliveryUrl || '',
        proofData.size,
        proofData.mimeType
      ]
    );

    const tx = await this.eas.attest({
      schema: this.config.deliveryProofSchemaId,
      data: {
        recipient,
        expirationTime: BigInt(expirationTime),
        revocable,
        refUID: proof.txId,
        data: encodedData,
        // For Base EAS, value is typically 0. Keep explicit to avoid ambiguity.
        value: 0n
      }
    });

    const uid = await tx.wait();
    if (!uid || !/^0x[a-fA-F0-9]{64}$/.test(uid)) {
      throw new Error(`Failed to obtain attestation UID from EAS transaction. Got: ${String(uid)}`);
    }
    if (uid === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      throw new Error('EAS returned zero UID for attestation (unexpected).');
    }

    return {
      uid,
      transactionHash: tx.tx.hash
    };
  }

  /**
   * Revoke a previously issued attestation by UID.
   */
  async revokeAttestation(uid: string): Promise<string> {
    if (!uid || !/^0x[a-fA-F0-9]{64}$/.test(uid)) {
      throw new Error(`Invalid attestation UID format: ${uid}`);
    }
    const tx = await this.eas.revoke({
      schema: this.config.deliveryProofSchemaId,
      data: { uid }
    });
    await tx.wait();
    return tx.tx.hash;
  }

  /**
   * Fetch attestation data from the EAS contract.
   */
  async getAttestation(uid: string) {
    if (!uid || !/^0x[a-fA-F0-9]{64}$/.test(uid)) {
      throw new Error(`Invalid attestation UID format: ${uid}`);
    }
    return await this.eas.getAttestation(uid);
  }

  /**
   * Verify that a delivery attestation belongs to the specified transaction.
   *
   * SECURITY: ACTPKernel V1 accepts any bytes32 as attestationUID without validation.
   * This means a malicious provider could submit attestation from Transaction A
   * for Transaction B. This method provides SDK-side protection by verifying:
   *
   * 1. Attestation exists and is not revoked
   * 2. Attestation uses the canonical delivery schema UID
   * 3. Attestation's txId matches the expected transaction ID
   * 4. Attestation has not expired
   *
   * @param txId - Expected transaction ID (bytes32)
   * @param attestationUID - Attestation UID to verify (bytes32)
   * @returns true if attestation is valid for this transaction, false otherwise
   * @throws Error if attestation is revoked, expired, schema mismatch, or txId mismatch
   */
  async verifyDeliveryAttestation(
    txId: string,
    attestationUID: string
  ): Promise<boolean> {
    if (!txId || !/^0x[a-fA-F0-9]{64}$/.test(txId)) {
      throw new Error(`Invalid txId format (expected bytes32): ${txId}`);
    }
    if (!attestationUID || !/^0x[a-fA-F0-9]{64}$/.test(attestationUID)) {
      throw new Error(`Invalid attestationUID format (expected bytes32): ${attestationUID}`);
    }

    // 1. Fetch attestation from EAS contract
    const attestation = await this.eas.getAttestation(attestationUID);

    // 2. Check if attestation exists (uid should match)
    if (attestation.uid !== attestationUID) {
      throw new Error(`Attestation not found: ${attestationUID}`);
    }

    // 3. Check schema UID matches canonical delivery schema (B2 blocker fix)
    // This prevents accepting attestations from unrelated EAS schemas
    if (attestation.schema !== this.config.deliveryProofSchemaId) {
      throw new Error(
        `Schema UID mismatch: expected canonical delivery schema ${this.config.deliveryProofSchemaId}, ` +
        `got ${attestation.schema}. Attestation may be from a different schema!`
      );
    }

    // 4. Check revocation - EAS uses revocationTime field (not revoked boolean)
    // revocationTime = 0 means not revoked
    // revocationTime > 0 means revoked at that timestamp
    const revocationTime = BigInt((attestation as any).revocationTime ?? 0);
    const isRevoked = revocationTime > 0n;

    if (isRevoked) {
      throw new Error(
        `Attestation has been revoked: ${attestationUID} (revoked at timestamp ${revocationTime})`
      );
    }

    // 5. Check expiration
    // expirationTime = 0 means no expiration
    // expirationTime > 0 means expires at that timestamp
    const expirationTime = BigInt((attestation as any).expirationTime ?? 0);
    if (expirationTime > 0n) {
      const now = Math.floor(Date.now() / 1000);
      if (Number(expirationTime) < now) {
        throw new Error(
          `Attestation has expired: ${attestationUID} (expired at ${expirationTime})`
        );
      }
    }

    // 6. Decode attestation data to extract txId
    let attestedTxId: string = '';

    try {
      const abiCoder = AbiCoder.defaultAbiCoder();
      const rawData: string = (attestation as any).data;

      // Prefer AIP-6 decoding (current DX Playground schema)
      // - Official AIP-6: bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt
      // - Test schema:    + uint256 testTimestamp
      try {
        const decoded = abiCoder.decode(
          ['bytes32', 'string', 'bytes32', 'uint256', 'uint256'],
          rawData
        );
        attestedTxId = decoded[0];
        const resultCID: string = decoded[1];
        const resultHash: string = decoded[2];
        const deliveredAt: bigint = decoded[3];

        if (!attestedTxId || !/^0x[a-fA-F0-9]{64}$/.test(attestedTxId)) {
          throw new Error(`Decoded txId is not valid bytes32: ${attestedTxId}`);
        }
        if (typeof resultCID !== 'string' || resultCID.length === 0 || resultCID.length > 2048) {
          throw new Error(`Decoded resultCID invalid length: ${resultCID?.length}`);
        }
        if (!resultHash || !/^0x[a-fA-F0-9]{64}$/.test(resultHash)) {
          throw new Error(`Decoded resultHash is not valid bytes32: ${resultHash}`);
        }
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (deliveredAt > now + 86400n) {
          throw new Error(`Decoded deliveredAt is in far future: ${deliveredAt.toString()}`);
        }
      } catch (_e) {
        // Fallback: official AIP-6 schema without testTimestamp
        try {
          const decoded = abiCoder.decode(
            ['bytes32', 'string', 'bytes32', 'uint256'],
            rawData
          );
          attestedTxId = decoded[0];
          const resultCID: string = decoded[1];
          const resultHash: string = decoded[2];
          const deliveredAt: bigint = decoded[3];

          if (!attestedTxId || !/^0x[a-fA-F0-9]{64}$/.test(attestedTxId)) {
            throw new Error(`Decoded txId is not valid bytes32: ${attestedTxId}`);
          }
          if (typeof resultCID !== 'string' || resultCID.length === 0 || resultCID.length > 2048) {
            throw new Error(`Decoded resultCID invalid length: ${resultCID?.length}`);
          }
          if (!resultHash || !/^0x[a-fA-F0-9]{64}$/.test(resultHash)) {
            throw new Error(`Decoded resultHash is not valid bytes32: ${resultHash}`);
          }
          const now = BigInt(Math.floor(Date.now() / 1000));
          if (deliveredAt > now + 86400n) {
            throw new Error(`Decoded deliveredAt is in far future: ${deliveredAt.toString()}`);
          }
        } catch (__e) {
          // Final fallback: legacy AIP-4 schema
          // Schema: bytes32 txId, bytes32 contentHash, uint256 timestamp, string deliveryUrl, uint256 size, string mimeType
          const decoded = abiCoder.decode(
            ['bytes32', 'bytes32', 'uint256', 'string', 'uint256', 'string'],
            rawData
          );
          attestedTxId = decoded[0];
          const contentHash: string = decoded[1];
          const timestamp: bigint = decoded[2];
          const deliveryUrl: string = decoded[3];
          const size: bigint = decoded[4];
          const mimeType: string = decoded[5];

          if (!attestedTxId || !/^0x[a-fA-F0-9]{64}$/.test(attestedTxId)) {
            throw new Error(`Decoded txId is not valid bytes32: ${attestedTxId}`);
          }
          if (!contentHash || !/^0x[a-fA-F0-9]{64}$/.test(contentHash)) {
            throw new Error(`Decoded contentHash is not valid bytes32: ${contentHash}`);
          }
          const now = BigInt(Math.floor(Date.now() / 1000));
          if (timestamp > now + 86400n) {
            throw new Error(`Decoded timestamp is in far future: ${timestamp.toString()}`);
          }
          if (typeof deliveryUrl !== 'string' || deliveryUrl.length > 2048) {
            throw new Error('Decoded deliveryUrl too long');
          }
          if (size < 0n) {
            throw new Error(`Decoded size is negative: ${size}`);
          }
          if (typeof mimeType !== 'string' || mimeType.length > 256) {
            throw new Error('Decoded mimeType too long');
          }
        }
      }

    } catch (error: any) {
      throw new Error(
        `Attestation data format mismatch: cannot decode attestation ${attestationUID}. ` +
        `Expected AIP-6 (preferred) or AIP-4 (legacy) delivery proof schema format. ` +
        `Original error: ${error.message}`
      );
    }

    // 7. Verify attestation txId matches expected transaction ID
    if (attestedTxId.toLowerCase() !== txId.toLowerCase()) {
      throw new Error(
        `Attestation txId mismatch: expected ${txId}, got ${attestedTxId}. ` +
        `Provider may be attempting to use attestation from different transaction!`
      );
    }

    // SECURITY FIX (C-1): Check if attestation has been used for a different transaction
    if (!this.attestationTracker.isValidForTransaction(attestationUID, txId)) {
      const usedFor = this.attestationTracker.getUsageForAttestation(attestationUID);
      throw new Error(
        `Attestation replay attack detected: attestation ${attestationUID} ` +
        `was already used for transaction ${usedFor}. ` +
        `Cannot reuse for transaction ${txId}.`
      );
    }

    // Record this attestation as used for this transaction
    const recorded = await this.attestationTracker.recordUsage(attestationUID, txId);
    if (!recorded) {
      const usedFor = this.attestationTracker.getUsageForAttestation(attestationUID);
      throw new Error(
        `Attestation replay attack detected: attestation ${attestationUID} ` +
          `was already used for transaction ${usedFor}. Cannot reuse for ${txId}.`
      );
    }

    // All checks passed
    return true;
  }

  /**
   * Verify attestation for escrow release with mandatory replay protection
   *
   * SECURITY FIX (C-4): This method MUST be called before releaseEscrow()
   * to prevent attestation replay attacks.
   *
   * @param txId - Expected transaction ID (bytes32)
   * @param attestationUID - Attestation UID to verify (bytes32)
   * @throws Error if verification fails or replay attack detected
   */
  async verifyAndRecordForRelease(
    txId: string,
    attestationUID: string
  ): Promise<void> {
    // Verify the attestation
    await this.verifyDeliveryAttestation(txId, attestationUID);
  }
}
