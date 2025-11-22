import { Contract, Signer, utils } from 'ethers';
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

    const encodedData = utils.defaultAbiCoder.encode(
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
    const attestedEvent = receipt.events?.find((event: any) => event.event === 'Attested');
    const uid = attestedEvent?.args?.uid ?? receipt.events?.[0]?.args?.uid ?? utils.hexZeroPad('0x0', 32);

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
}
