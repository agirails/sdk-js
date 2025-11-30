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

import { Signer, verifyTypedData } from 'ethers';
import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk';
import { computeResultHash } from '../utils/canonicalJson';
import { IPFSClient } from '../utils/IPFSClient';
import { NonceManager } from '../utils/NonceManager';
import { DeliveryProofMessage } from '../types/message';
import { AIP4DeliveryProofTypes, AIP4DeliveryProofData, EIP712Domain } from '../types/eip712';

/**
 * AGIRAILS Delivery Schema UID (Base Sepolia)
 * TODO: Update after schema deployment
 */
export const AGIRAILS_DELIVERY_SCHEMA_UID = '0x0000000000000000000000000000000000000000000000000000000000000000'; // PENDING

/**
 * Delivery proof build parameters
 */
export interface DeliveryProofParams {
  txId: string; // bytes32 (0x-prefixed)
  provider: string; // DID (e.g., "did:ethr:84532:0x...")
  consumer: string; // DID
  resultData: any; // Service result data (will be uploaded to IPFS)
  metadata?: {
    executionTime?: number;
    outputFormat?: string;
    outputSize?: number;
    notes?: string;
  };
  chainId: number; // 84532 (Base Sepolia) or 8453 (Base Mainnet)
  kernelAddress: string; // ACTPKernel contract address
}

// IPFSClient and NonceManager interfaces imported from utils

/**
 * DeliveryProofBuilder - Main Builder Class
 */
export class DeliveryProofBuilder {
  constructor(
    private ipfs: IPFSClient,
    private signer: Signer,
    private nonceManager: NonceManager,
    private eas: EAS
  ) {}

  /**
   * Build complete delivery proof
   * Reference: AIP-4 §5.1 (Provider workflow steps 1-9)
   *
   * @param params - Delivery proof parameters
   * @returns Delivery proof message, IPFS CID, and attestation UID
   */
  async build(params: DeliveryProofParams): Promise<{
    deliveryProof: DeliveryProofMessage;
    deliveryProofCID: string;
    attestationUID: string;
  }> {
    // Step 1: Upload result to IPFS
    const resultCID = await this.ipfs.add(JSON.stringify(params.resultData));
    await this.ipfs.pin(resultCID); // Permanent pinning

    // Step 2: Compute result hash (canonical JSON)
    const resultHash = computeResultHash(params.resultData);

    // Step 3: Create EAS attestation on-chain
    const deliveredAt = Math.floor(Date.now() / 1000);

    const schemaEncoder = new SchemaEncoder(
      'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt'
    );

    // Extract Ethereum address from consumer DID
    const consumerAddress = this.extractAddressFromDID(params.consumer);

    const encodedData = schemaEncoder.encodeData([
      { name: 'txId', value: params.txId, type: 'bytes32' },
      { name: 'resultCID', value: resultCID, type: 'string' },
      { name: 'resultHash', value: resultHash, type: 'bytes32' },
      { name: 'deliveredAt', value: deliveredAt, type: 'uint256' }
    ]);

    const tx = await this.eas.attest({
      schema: AGIRAILS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: consumerAddress,
        expirationTime: 0n, // No expiration (use bigint)
        revocable: false,
        data: encodedData
      }
    });

    const receipt = await tx.wait();
    // EAS SDK returns attestation UID directly in newAttestationUID
    const attestationUID = (receipt as any).newAttestationUID || (receipt as any);

    // Step 4: Build delivery proof message (unsigned)
    const deliveryProof: DeliveryProofMessage = {
      type: 'agirails.delivery.v1',
      version: '1.0.0',
      txId: params.txId,
      provider: params.provider,
      consumer: params.consumer,
      resultCID,
      resultHash,
      metadata: params.metadata || {},
      easAttestationUID: attestationUID,
      deliveredAt,
      chainId: params.chainId,
      nonce: this.nonceManager.getNextNonce('agirails.delivery.v1'),
      signature: '' // Filled in next step
    };

    // Step 5: Sign with EIP-712
    const signature = await this.signDeliveryProof(deliveryProof, params.kernelAddress);
    deliveryProof.signature = signature;

    // Step 6: Upload delivery proof to IPFS
    const deliveryProofCID = await this.ipfs.add(JSON.stringify(deliveryProof));
    await this.ipfs.pin(deliveryProofCID); // Permanent

    // Record nonce usage
    this.nonceManager.recordNonce('agirails.delivery.v1', deliveryProof.nonce);

    return {
      deliveryProof,
      deliveryProofCID,
      attestationUID
    };
  }

  /**
   * Verify delivery proof signature and integrity
   * Reference: AIP-4 §5.2 (Consumer verification)
   *
   * @param deliveryProof - Delivery proof message
   * @param resultData - Actual result data (from IPFS)
   * @param kernelAddress - ACTPKernel contract address
   * @returns true if valid, throws error otherwise
   */
  async verify(
    deliveryProof: DeliveryProofMessage,
    resultData: any,
    kernelAddress: string
  ): Promise<boolean> {
    // 1. Verify signature
    const recoveredAddress = await this.recoverDeliveryProofSigner(deliveryProof, kernelAddress);
    const expectedAddress = this.extractAddressFromDID(deliveryProof.provider);

    if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error('Invalid signature: recovered address does not match provider');
    }

    // 2. Verify result hash
    const computedHash = computeResultHash(resultData);

    if (computedHash !== deliveryProof.resultHash) {
      throw new Error('Result hash mismatch - data may be tampered');
    }

    // 3. Verify EAS attestation exists and is valid
    const attestation = await this.eas.getAttestation(deliveryProof.easAttestationUID);

    if (!attestation) {
      throw new Error('Attestation not found on EAS');
    }

    if (attestation.schema !== AGIRAILS_DELIVERY_SCHEMA_UID) {
      throw new Error(`Invalid attestation schema: expected ${AGIRAILS_DELIVERY_SCHEMA_UID}, got ${attestation.schema}`);
    }

    // Check if attestation is revoked (property may not exist in all EAS SDK versions)
    if ('revoked' in attestation && (attestation as any).revoked) {
      throw new Error('Attestation was revoked');
    }

    if ('revocationTime' in attestation && (attestation as any).revocationTime > 0) {
      throw new Error('Attestation was revoked');
    }

    // 4. Verify attestation data matches delivery proof
    const schemaEncoder = new SchemaEncoder(
      'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt'
    );
    const decodedData = schemaEncoder.decodeData(attestation.data);

    const attestationTxId = decodedData.find((d) => d.name === 'txId')?.value.value;
    const attestationResultCID = decodedData.find((d) => d.name === 'resultCID')?.value.value;
    const attestationResultHash = decodedData.find((d) => d.name === 'resultHash')?.value.value;

    if (attestationTxId !== deliveryProof.txId) {
      throw new Error('Attestation txId mismatch');
    }

    if (attestationResultCID !== deliveryProof.resultCID) {
      throw new Error('Attestation resultCID mismatch');
    }

    if (attestationResultHash !== deliveryProof.resultHash) {
      throw new Error('Attestation resultHash mismatch');
    }

    return true;
  }

  /**
   * Sign delivery proof with EIP-712
   * Reference: AIP-4 §3.3
   *
   * @param deliveryProof - Delivery proof message (unsigned)
   * @param kernelAddress - ACTPKernel contract address
   * @returns EIP-712 signature (0x-prefixed, 130 chars)
   */
  private async signDeliveryProof(
    deliveryProof: DeliveryProofMessage,
    kernelAddress: string
  ): Promise<string> {
    const domain: EIP712Domain = {
      name: 'AGIRAILS',
      version: '1',
      chainId: deliveryProof.chainId,
      verifyingContract: kernelAddress
    };

    const message: AIP4DeliveryProofData = {
      txId: deliveryProof.txId,
      provider: deliveryProof.provider,
      consumer: deliveryProof.consumer,
      resultCID: deliveryProof.resultCID,
      resultHash: deliveryProof.resultHash,
      easAttestationUID: deliveryProof.easAttestationUID,
      deliveredAt: deliveryProof.deliveredAt,
      chainId: deliveryProof.chainId,
      nonce: deliveryProof.nonce
    };

    // Sign using ethers v6 signTypedData API
    // ethers v6 uses signTypedData() (without underscore)
    if ('signTypedData' in this.signer && typeof (this.signer as any).signTypedData === 'function') {
      const signature = await (this.signer as any).signTypedData(
        domain,
        AIP4DeliveryProofTypes,
        message
      );
      return signature;
    }

    throw new Error('Signer does not support EIP-712 typed data signing (ethers v6+)');

  }

  /**
   * Recover signer address from delivery proof signature
   *
   * @param deliveryProof - Delivery proof message
   * @param kernelAddress - ACTPKernel contract address
   * @returns Recovered Ethereum address
   */
  private async recoverDeliveryProofSigner(
    deliveryProof: DeliveryProofMessage,
    kernelAddress: string
  ): Promise<string> {
    const domain: EIP712Domain = {
      name: 'AGIRAILS',
      version: '1',
      chainId: deliveryProof.chainId,
      verifyingContract: kernelAddress
    };

    const message: AIP4DeliveryProofData = {
      txId: deliveryProof.txId,
      provider: deliveryProof.provider,
      consumer: deliveryProof.consumer,
      resultCID: deliveryProof.resultCID,
      resultHash: deliveryProof.resultHash,
      easAttestationUID: deliveryProof.easAttestationUID,
      deliveredAt: deliveryProof.deliveredAt,
      chainId: deliveryProof.chainId,
      nonce: deliveryProof.nonce
    };

    // Recover address using ethers.js verifyTypedData
    // Wrap in try-catch to handle low-level cryptographic errors gracefully
    try {
      const recoveredAddress = verifyTypedData(
        domain,
        AIP4DeliveryProofTypes,
        message,
        deliveryProof.signature
      );

      return recoveredAddress;
    } catch (error: any) {
      // Wrap low-level cryptographic errors in meaningful error message
      throw new Error(`Invalid signature: ${error.message || 'signature verification failed'}`);
    }
  }

  /**
   * Extract Ethereum address from DID
   * Supports: did:ethr:0x... and did:ethr:84532:0x...
   *
   * @param did - DID string
   * @returns Ethereum address (0x-prefixed, checksummed)
   */
  private extractAddressFromDID(did: string): string {
    const parts = did.replace('did:ethr:', '').split(':');
    const address = parts.length === 2 ? parts[1] : parts[0];

    if (!address.startsWith('0x') || address.length !== 42) {
      throw new Error(`Invalid DID format: ${did}`);
    }

    return address;
  }
}
