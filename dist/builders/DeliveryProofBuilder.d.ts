/**
 * DeliveryProofBuilder - AIP-4 Delivery Proof Construction
 * Reference: AIP-4 §9.1
 *
 * Builds complete delivery proofs with:
 * - IPFS upload of result data
 * - EAS attestation creation
 * - EIP-712 signature
 * - Canonical JSON hashing
 */
import { Signer } from 'ethers';
import { EAS } from '@ethereum-attestation-service/eas-sdk';
import { IPFSClient } from '../utils/IPFSClient';
import { NonceManager } from '../utils/NonceManager';
import { DeliveryProofMessage } from '../types/message';
/**
 * AGIRAILS Delivery Schema UID (Base Sepolia)
 * TODO: Update after schema deployment
 */
export declare const AGIRAILS_DELIVERY_SCHEMA_UID = "0x0000000000000000000000000000000000000000000000000000000000000000";
/**
 * Delivery proof build parameters
 */
export interface DeliveryProofParams {
    txId: string;
    provider: string;
    consumer: string;
    resultData: any;
    metadata?: {
        executionTime?: number;
        outputFormat?: string;
        outputSize?: number;
        notes?: string;
    };
    chainId: number;
    kernelAddress: string;
}
/**
 * DeliveryProofBuilder - Main Builder Class
 */
export declare class DeliveryProofBuilder {
    private ipfs;
    private signer;
    private nonceManager;
    private eas;
    constructor(ipfs: IPFSClient, signer: Signer, nonceManager: NonceManager, eas: EAS);
    /**
     * Build complete delivery proof
     * Reference: AIP-4 §5.1 (Provider workflow steps 1-9)
     *
     * @param params - Delivery proof parameters
     * @returns Delivery proof message, IPFS CID, and attestation UID
     */
    build(params: DeliveryProofParams): Promise<{
        deliveryProof: DeliveryProofMessage;
        deliveryProofCID: string;
        attestationUID: string;
    }>;
    /**
     * Verify delivery proof signature and integrity
     * Reference: AIP-4 §5.2 (Consumer verification)
     *
     * @param deliveryProof - Delivery proof message
     * @param resultData - Actual result data (from IPFS)
     * @param kernelAddress - ACTPKernel contract address
     * @returns true if valid, throws error otherwise
     */
    verify(deliveryProof: DeliveryProofMessage, resultData: any, kernelAddress: string): Promise<boolean>;
    /**
     * Sign delivery proof with EIP-712
     * Reference: AIP-4 §3.3
     *
     * @param deliveryProof - Delivery proof message (unsigned)
     * @param kernelAddress - ACTPKernel contract address
     * @returns EIP-712 signature (0x-prefixed, 130 chars)
     */
    private signDeliveryProof;
    /**
     * Recover signer address from delivery proof signature
     *
     * @param deliveryProof - Delivery proof message
     * @param kernelAddress - ACTPKernel contract address
     * @returns Recovered Ethereum address
     */
    private recoverDeliveryProofSigner;
    /**
     * Extract Ethereum address from DID
     * Supports: did:ethr:0x... and did:ethr:84532:0x...
     *
     * @param did - DID string
     * @returns Ethereum address (0x-prefixed, checksummed)
     */
    private extractAddressFromDID;
}
//# sourceMappingURL=DeliveryProofBuilder.d.ts.map