import { Contract, Signer, AbiCoder, zeroPadValue } from 'ethers';
import { DeliveryProof } from '../types';
import { deliveryProofDataFromProof } from '../types/eip712';

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

  constructor(signer: Signer, private readonly config: EASConfig) {
    this.eas = new Contract(config.contractAddress, EAS_ABI, signer);
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
   * 2. Attestation's txId matches the expected transaction ID
   * 3. Attestation has not expired
   *
   * @param txId - Expected transaction ID (bytes32)
   * @param attestationUID - Attestation UID to verify (bytes32)
   * @returns true if attestation is valid for this transaction, false otherwise
   * @throws Error if attestation is revoked, expired, or txId mismatch
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

    // 3. Check revocation - EAS uses revocationTime field (not revoked boolean)
    // revocationTime = 0 means not revoked
    // revocationTime > 0 means revoked at that timestamp
    // NOTE: attestation.revoked field does NOT exist! (see genetic-memory.md)
    const isRevoked = attestation.revocationTime > 0n;
    if (isRevoked) {
      throw new Error(
        `Attestation has been revoked: ${attestationUID} (revoked at timestamp ${attestation.revocationTime})`
      );
    }

    // 4. Check expiration
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

    // 5. Decode attestation data to extract txId
    // Schema: bytes32 txId, bytes32 contentHash, uint256 timestamp, string deliveryUrl, uint256 size, string mimeType
    const abiCoder = AbiCoder.defaultAbiCoder();
    const decoded = abiCoder.decode(
      ['bytes32', 'bytes32', 'uint256', 'string', 'uint256', 'string'],
      attestation.data
    );

    const attestedTxId = decoded[0]; // First field is txId

    // 6. Verify attestation txId matches expected transaction ID
    if (attestedTxId !== txId) {
      throw new Error(
        `Attestation txId mismatch: expected ${txId}, got ${attestedTxId}. ` +
        `Provider may be attempting to use attestation from different transaction!`
      );
    }

    // All checks passed
    return true;
  }
}
