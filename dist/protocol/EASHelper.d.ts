import { Signer } from 'ethers';
import { DeliveryProof } from '../types';
import { IUsedAttestationTracker } from '../utils/UsedAttestationTracker';
export interface EASConfig {
    contractAddress: string;
    deliveryProofSchemaId: string;
}
export interface AttestationResponse {
    uid: string;
    transactionHash: string;
}
export declare class EASHelper {
    private readonly config;
    private readonly eas;
    private readonly attestationTracker;
    /**
     * Create EASHelper instance
     *
     * @param signer - Ethers signer for signing attestations
     * @param config - EAS configuration
     * @param attestationTracker - Optional tracker for replay attack prevention (C-1 fix)
     *
     * SECURITY FIX (NEW-M-2): Validates schema UID format in constructor
     */
    constructor(signer: Signer, config: EASConfig, attestationTracker?: IUsedAttestationTracker);
    /**
     * Get the attestation tracker for external use
     */
    getAttestationTracker(): IUsedAttestationTracker;
    /**
     * Create an attestation for a delivery proof. Returns the attestation UID and transaction hash.
     */
    attestDeliveryProof(proof: DeliveryProof, recipient: string, options?: {
        expirationTime?: number;
        revocable?: boolean;
    }): Promise<AttestationResponse>;
    /**
     * Revoke a previously issued attestation by UID.
     */
    revokeAttestation(uid: string): Promise<string>;
    /**
     * Fetch attestation data from the EAS contract.
     */
    getAttestation(uid: string): Promise<any>;
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
    verifyDeliveryAttestation(txId: string, attestationUID: string): Promise<boolean>;
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
    verifyAndRecordForRelease(txId: string, attestationUID: string): Promise<void>;
}
//# sourceMappingURL=EASHelper.d.ts.map