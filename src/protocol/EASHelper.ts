import { Contract, Signer, AbiCoder, zeroPadValue } from 'ethers';
import { DeliveryProof } from '../types';
import { deliveryProofDataFromProof } from '../types/eip712';
import {
  IUsedAttestationTracker,
  InMemoryUsedAttestationTracker
} from '../utils/UsedAttestationTracker';

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
const EAS_ABI = [
  'event Attested(address indexed attester, bytes32 indexed uid, bytes32 indexed schema)',
  'function attest(tuple(bytes32 schema, tuple(address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data) data) request) external returns (bytes32)',
  'function revoke(tuple(bytes32 schema, bytes32 uid) request) external returns (bytes32)',
  'function getAttestation(bytes32 uid) external view returns (tuple(bytes32 uid, bytes32 schema, address recipient, address attester, uint64 time, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint32 bump))'
];

export class EASHelper {
  private readonly eas: Contract;
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

    this.eas = new Contract(config.contractAddress, EAS_ABI, signer);
    // SECURITY FIX (C-1): Use provided tracker or create new in-memory one
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
        expirationTime,
        revocable,
        refUID: proof.txId,
        data: encodedData
      }
    });

    const receipt = await tx.wait();
    // ethers v6: events → logs, and logs are parsed differently
    const attestedLog = receipt?.logs?.find((log: any) => {
      try {
        const parsed = this.eas.interface.parseLog(log);
        return parsed?.name === 'Attested';
      } catch {
        return false;
      }
    });

    const uid = attestedLog
      ? this.eas.interface.parseLog(attestedLog)?.args?.uid
      : zeroPadValue('0x00', 32);

    return {
      uid,
      transactionHash: receipt.transactionHash
    };
  }

  /**
   * Revoke a previously issued attestation by UID.
   */
  async revokeAttestation(uid: string): Promise<string> {
    const tx = await this.eas.revoke({
      schema: this.config.deliveryProofSchemaId,
      uid
    });
    const receipt = await tx.wait();
    return receipt.transactionHash;
  }

  /**
   * Fetch attestation data from the EAS contract.
   */
  async getAttestation(uid: string) {
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
    // NOTE: attestation.revoked field does NOT exist! (see genetic-memory.md)
    //
    // SECURITY FIX (NEW-M-1): Fallback check for both revocationTime and revoked field
    // Some EAS contract versions may use different field names
    const isRevoked = (attestation.revocationTime && attestation.revocationTime > 0n) ||
                      (attestation.revoked === true);

    if (isRevoked) {
      const revokedAt = attestation.revocationTime || 'unknown';
      throw new Error(
        `Attestation has been revoked: ${attestationUID} (revoked at timestamp ${revokedAt})`
      );
    }

    // 5. Check expiration
    // expirationTime = 0 means no expiration
    // expirationTime > 0 means expires at that timestamp
    if (attestation.expirationTime > 0n) {
      const now = Math.floor(Date.now() / 1000);
      if (Number(attestation.expirationTime) < now) {
        throw new Error(
          `Attestation has expired: ${attestationUID} (expired at ${attestation.expirationTime})`
        );
      }
    }

    // 6. Decode attestation data to extract txId
    // Schema: bytes32 txId, bytes32 contentHash, uint256 timestamp, string deliveryUrl, uint256 size, string mimeType
    let attestedTxId: string;
    let contentHash: string;
    let timestamp: bigint;
    let deliveryUrl: string;
    let size: bigint;
    let mimeType: string;

    try {
      const abiCoder = AbiCoder.defaultAbiCoder();
      const decoded = abiCoder.decode(
        ['bytes32', 'bytes32', 'uint256', 'string', 'uint256', 'string'],
        attestation.data
      );

      // SECURITY FIX (NEW-M-3): Validate decoded values explicitly
      attestedTxId = decoded[0];
      contentHash = decoded[1];
      timestamp = decoded[2];
      deliveryUrl = decoded[3];
      size = decoded[4];
      mimeType = decoded[5];

      // Validate txId is bytes32 format
      if (!attestedTxId || !/^0x[a-fA-F0-9]{64}$/.test(attestedTxId)) {
        throw new Error(`Decoded txId is not valid bytes32: ${attestedTxId}`);
      }

      // Validate contentHash is bytes32 format
      if (!contentHash || !/^0x[a-fA-F0-9]{64}$/.test(contentHash)) {
        throw new Error(`Decoded contentHash is not valid bytes32: ${contentHash}`);
      }

      // Validate timestamp is reasonable (not in far future)
      const now = Math.floor(Date.now() / 1000);
      const maxFutureTime = now + 86400; // Allow 1 day clock skew
      if (Number(timestamp) > maxFutureTime) {
        throw new Error(
          `Decoded timestamp is in far future: ${timestamp} (current time: ${now})`
        );
      }

      // Validate size is non-negative
      if (size < 0n) {
        throw new Error(`Decoded size is negative: ${size}`);
      }

    } catch (error: any) {
      throw new Error(
        `Attestation data format mismatch: cannot decode attestation ${attestationUID}. ` +
        `Expected AIP-4 delivery proof schema format. ` +
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
    this.attestationTracker.recordUsage(attestationUID, txId);

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

    // Additional check: Ensure it's recorded (verifyDeliveryAttestation already does this,
    // but we explicitly verify here for safety)
    if (!this.attestationTracker.isValidForTransaction(attestationUID, txId)) {
      throw new Error(
        `Attestation ${attestationUID} cannot be used for transaction ${txId}. ` +
        `It may have been used for another transaction.`
      );
    }
  }
}
