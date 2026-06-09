/**
 * DeliveryProofBuilder - AIP-4 / AIP-16 Delivery Proof Construction
 * Reference: AIP-4 §9.1, AIP-16 Rev 5 §6 (DEC-3 split)
 *
 * Builds complete delivery proofs in TWO variants:
 *
 * 1. `buildPublicProof(params)` — the original AIP-4 behavior. Uploads the
 *    plaintext result JSON to IPFS, computes `resultHash = keccak256(...)`
 *    over the canonical JSON, and creates an EAS attestation that
 *    references `resultCID` (IPFS pointer to the plaintext) and
 *    `resultHash` (canonical plaintext hash).
 *
 *    `build()` remains as a deprecated alias to `buildPublicProof()` so
 *    every existing AIP-4 caller continues to work unmodified.
 *
 * 2. `buildEncryptedProof(params)` — AIP-16 Rev 5 §6 DEC-3 variant. Takes
 *    a *signed AIP-16 envelope wire object* as input (i.e. the ciphertext
 *    has already been produced by the delivery channel + envelope
 *    builder). Uploads the **ENCRYPTED ENVELOPE WIRE JSON** to IPFS (NOT
 *    the plaintext) and uses `envelopeHash =
 *    DeliveryEnvelopeBuilder.computeHash(envelopeWire)` (i.e.
 *    `keccak256(utf8(canonicalJson(envelopeWire.signed)))`) as the EAS
 *    `resultHash`. The EAS `resultCID` points at the encrypted-wire CID.
 *
 *    **The plaintext NEVER leaves the buyer/provider channel.** It is
 *    never written to IPFS, never written to EAS, never hashed into the
 *    EAS attestation.
 *
 * ## DEC-3 design choice (IPFS payload for encrypted variant)
 *
 * Three options were considered for what the encrypted variant uploads
 * to IPFS:
 *
 *   (a) plaintext bytes — **rejected** (defeats the purpose of encryption;
 *       the whole point of the encrypted scheme is to keep plaintext off
 *       any public surface).
 *   (b) only the envelope hash, no IPFS upload — rejected because dispute
 *       resolution then requires the original delivery channel to still
 *       be live. Channels are ephemeral; this would break archival
 *       guarantees.
 *   (c) the encrypted envelope wire JSON (full `DeliveryEnvelopeWireV1`,
 *       signed projection + ciphertext body + provider signature) —
 *       **CHOSEN.** Gives arbitrators a durable, content-addressable
 *       artifact: they can fetch the envelope from IPFS, verify the
 *       provider EIP-712 signature, and confirm `envelopeHash` matches the
 *       value in the EAS attestation, all without ever decrypting the
 *       body. The buyer (who holds the X25519 secret) can additionally
 *       reproduce plaintext on demand.
 *
 * Hence: encrypted variant uploads the encrypted wire to IPFS, EAS
 * references envelope-hash, plaintext stays in the channel.
 *
 * ## Common to both variants
 *
 * - EIP-712 signature over the `DeliveryProofMessage` using the AIP-4
 *   `AGIRAILS` domain (NOT the AIP-16 `AGIRAILS Delivery` domain — they
 *   are deliberately separate to prevent cross-feature signature reuse).
 * - Anti-replay nonce tracked through {@link NonceManager} under
 *   namespace `agirails.delivery.v1`.
 * - The delivery proof itself is uploaded to IPFS and pinned.
 */

import { Signer, verifyTypedData } from 'ethers';
import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk';
import { computeResultHash } from '../utils/canonicalJson';
import { IPFSClient } from '../utils/IPFSClient';
import { NonceManager } from '../utils/NonceManager';
import { DeliveryProofMessage } from '../types/message';
import { AIP4DeliveryProofTypes, AIP4DeliveryProofData, EIP712Domain } from '../types/eip712';
import { DeliveryEnvelopeWireV1 } from '../delivery/types';
import { DeliveryEnvelopeBuilder } from '../delivery/envelopeBuilder';

/**
 * Module-local unix-seconds helper (AIP-16 timing rule #12).
 *
 * All wall-clock reads inside this module go through this single helper
 * so tests can inject a fake clock by spying on / mocking it, and so the
 * code never directly inlines `Math.floor(Date.now() / 1000)`.
 *
 * @returns Current unix time in seconds (integer).
 */
function secondsNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * AGIRAILS Delivery Schema UID (Base Sepolia)
 * Deployed 2025-11-23 - AIP-4 delivery proof schema
 * Schema: bytes32 txId, string resultCID, bytes32 resultHash, uint256 deliveredAt
 */
export const AGIRAILS_DELIVERY_SCHEMA_UID = '0x1b0ebdf0bd20c28ec9d5362571ce8715a55f46e81c3de2f9b0d8e1b95fb5ffce';

/**
 * Public delivery proof build parameters.
 *
 * Used by {@link DeliveryProofBuilder.buildPublicProof} (and by the
 * deprecated {@link DeliveryProofBuilder.build} alias). The plaintext
 * `resultData` is uploaded to IPFS and hashed into the EAS attestation;
 * anyone with the CID can read it.
 *
 * For private/encrypted deliveries, see {@link DeliveryProofEncryptedParams}
 * and {@link DeliveryProofBuilder.buildEncryptedProof}.
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

/**
 * Encrypted delivery proof build parameters (AIP-16 §6 DEC-3 variant).
 *
 * Carries the *already-signed* AIP-16 envelope wire object. The plaintext
 * has already been encrypted by the delivery channel layer; this builder
 * never sees and never touches it.
 *
 * On-chain anchoring is via `envelopeHash =
 * DeliveryEnvelopeBuilder.computeHash(envelopeWire)`. IPFS upload is the
 * encrypted envelope wire JSON (see top-of-file DEC-3 note for the
 * rationale).
 *
 * `provider` / `consumer` are DIDs (matching the AIP-4 shape). The
 * `txId` MUST equal `envelopeWire.signed.txId`; the `chainId` MUST equal
 * `envelopeWire.signed.chainId`; these consistency checks are enforced
 * by `buildEncryptedProof` before any IPFS or EAS calls so that the
 * signing layer fails fast on mismatched inputs.
 */
export interface DeliveryProofEncryptedParams {
  /** bytes32 transaction id (0x-prefixed). MUST equal `envelopeWire.signed.txId`. */
  txId: string;
  /** Provider DID (e.g. `did:ethr:84532:0x...`). */
  provider: string;
  /** Consumer DID. */
  consumer: string;
  /**
   * The signed AIP-16 envelope wire. Either `scheme: "x25519-aes256gcm-v1"`
   * (true encrypted delivery) or — in principle — `scheme: "public-v1"`
   * (transports plaintext but still routes through the envelope channel).
   * Either way, the wire object as supplied is what gets pinned to IPFS,
   * verbatim, and `envelopeHash` is the EAS anchor.
   */
  envelopeWire: DeliveryEnvelopeWireV1;
  /** Optional metadata (same shape as the public variant). */
  metadata?: {
    executionTime?: number;
    outputFormat?: string;
    outputSize?: number;
    notes?: string;
  };
  /** EVM chain id. MUST equal `envelopeWire.signed.chainId`. */
  chainId: number;
  /** ACTPKernel contract address (EIP-712 `verifyingContract`). */
  kernelAddress: string;
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
   * Build a *public* delivery proof — the original AIP-4 §5.1 flow.
   *
   * Steps:
   *  1. Upload `params.resultData` (plaintext JSON) to IPFS, pin it.
   *  2. Compute `resultHash = computeResultHash(params.resultData)`
   *     (keccak256 over canonical JSON).
   *  3. Create EAS attestation with `(txId, resultCID, resultHash,
   *     deliveredAt)`. `deliveredAt` is `secondsNow()`.
   *  4. Construct unsigned `DeliveryProofMessage`, allocate and record
   *     an anti-replay nonce.
   *  5. Sign the proof with EIP-712 over the AIP-4 `AGIRAILS` domain.
   *  6. Upload signed delivery proof JSON to IPFS, pin it.
   *
   * This variant is appropriate when the deliverable is intentionally
   * public (open data, demo outputs, etc.) and the buyer is fine with
   * the result being readable by anyone with the CID.
   *
   * For confidential deliveries, use {@link buildEncryptedProof}.
   *
   * @param params - Public delivery proof parameters.
   * @returns Signed delivery proof message, CID of the proof on IPFS,
   *          and EAS attestation UID.
   */
  async buildPublicProof(params: DeliveryProofParams): Promise<{
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
    const deliveredAt = secondsNow();

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

    // Record nonce as used BEFORE signing/uploading to prevent replay
    // if IPFS upload fails and the same nonce is reused on retry.
    this.nonceManager.recordNonce('agirails.delivery.v1', deliveryProof.nonce);

    // Step 5: Sign with EIP-712
    const signature = await this.signDeliveryProof(deliveryProof, params.kernelAddress);
    deliveryProof.signature = signature;

    // Step 6: Upload delivery proof to IPFS
    const deliveryProofCID = await this.ipfs.add(JSON.stringify(deliveryProof));
    await this.ipfs.pin(deliveryProofCID); // Permanent

    return {
      deliveryProof,
      deliveryProofCID,
      attestationUID
    };
  }

  /**
   * Build complete delivery proof.
   *
   * @deprecated Use {@link buildPublicProof} for explicit intent, or
   * {@link buildEncryptedProof} for the AIP-16 §6 encrypted variant.
   * Retained as an alias to `buildPublicProof` so all existing AIP-4
   * call sites continue to work without modification (DEC-3 backward
   * compatibility requirement).
   *
   * @param params - Delivery proof parameters (public variant shape).
   * @returns Same shape as {@link buildPublicProof}.
   */
  async build(params: DeliveryProofParams): Promise<{
    deliveryProof: DeliveryProofMessage;
    deliveryProofCID: string;
    attestationUID: string;
  }> {
    return this.buildPublicProof(params);
  }

  /**
   * Build an *encrypted* delivery proof (AIP-16 Rev 5 §6 DEC-3 variant).
   *
   * Takes a *signed AIP-16 envelope wire* as input. The plaintext is
   * NEVER touched by this builder — the encryption was performed
   * upstream by the channel/envelope layer.
   *
   * Steps:
   *  1. Sanity-check `params.txId` and `params.chainId` against the
   *     signed envelope projection. Mismatch → fail fast.
   *  2. Compute `envelopeHash =
   *     DeliveryEnvelopeBuilder.computeHash(envelopeWire)` (keccak256
   *     over canonical JSON of the SIGNED projection — stable across
   *     SDK languages and immune to `serverMeta` decoration).
   *  3. Upload the ENCRYPTED ENVELOPE WIRE JSON (the full
   *     `DeliveryEnvelopeWireV1`, including signed projection,
   *     ciphertext body, and provider signature) to IPFS. Pin it.
   *     **NEVER upload plaintext.**
   *  4. Create EAS attestation with `(txId, encryptedEnvelopeCID,
   *     envelopeHash, deliveredAt)`. EAS now anchors the envelope hash,
   *     NOT a plaintext content hash.
   *  5. Construct the `DeliveryProofMessage` with `resultCID =
   *     encryptedEnvelopeCID` and `resultHash = envelopeHash`. Sign
   *     with EIP-712 over the AIP-4 `AGIRAILS` domain (same domain as
   *     the public variant — both are AIP-4 delivery proofs).
   *  6. Upload signed delivery proof JSON to IPFS, pin it.
   *
   * ## IPFS upload set
   *
   *  - The encrypted envelope wire JSON (NOT the plaintext).
   *  - The signed delivery proof JSON itself.
   *
   * ## EAS attestation contents
   *
   *  - `txId` — same as the envelope.
   *  - `resultCID` — IPFS CID of the encrypted envelope wire.
   *  - `resultHash` — `envelopeHash` (keccak256 of canonical signed
   *    envelope projection), NOT a plaintext content hash.
   *  - `deliveredAt` — `secondsNow()`.
   *
   * ## Confidentiality invariant
   *
   * Anyone with the EAS attestation can:
   *  - Verify a specific envelope was signed by the provider for a
   *    specific txId (fetch from IPFS via `resultCID`, recompute
   *    `envelopeHash`, compare to EAS `resultHash`, recover signature).
   *  - Confirm the timing of delivery via `deliveredAt`.
   * They CANNOT:
   *  - Read the plaintext. It is never on IPFS, never on EAS, never
   *    in any signed structure produced by this builder.
   *
   * Only the buyer (who holds the X25519 ephemeral secret) can decrypt
   * the body; only the channel can serve the original wire object if
   * the buyer didn't archive it. In a dispute, the encrypted wire from
   * IPFS plus the buyer's secret reproduces the plaintext deterministically.
   *
   * @param params - Encrypted delivery proof parameters; carries the
   *                 signed envelope wire.
   * @returns Signed delivery proof message, CID of the proof on IPFS,
   *          EAS attestation UID, the IPFS CID of the encrypted envelope
   *          wire (for downstream wiring / logs), and the envelope hash
   *          used as the EAS anchor.
   * @throws If `params.txId` / `params.chainId` disagree with the
   *         signed envelope projection.
   */
  async buildEncryptedProof(params: DeliveryProofEncryptedParams): Promise<{
    deliveryProof: DeliveryProofMessage;
    deliveryProofCID: string;
    attestationUID: string;
    encryptedEnvelopeCID: string;
    envelopeHash: string;
  }> {
    // Step 1: Consistency checks. Bail before any IPFS / EAS side effects
    // if the caller's claimed (txId, chainId) disagree with the envelope.
    const signed = params.envelopeWire.signed;
    if (params.txId.toLowerCase() !== signed.txId.toLowerCase()) {
      throw new Error(
        `DeliveryProofBuilder.buildEncryptedProof: txId mismatch — params.txId=${params.txId} but envelopeWire.signed.txId=${signed.txId}`
      );
    }
    if (params.chainId !== signed.chainId) {
      throw new Error(
        `DeliveryProofBuilder.buildEncryptedProof: chainId mismatch — params.chainId=${params.chainId} but envelopeWire.signed.chainId=${signed.chainId}`
      );
    }

    // Step 2: Compute envelope hash (cross-SDK stable, signature- and
    // serverMeta-independent). This is the EAS anchor.
    const envelopeHash = DeliveryEnvelopeBuilder.computeHash(params.envelopeWire);

    // Step 3: Upload ENCRYPTED envelope wire JSON to IPFS. NEVER upload
    // plaintext. The wire object as supplied — signed projection +
    // ciphertext body + provider signature — is what gets pinned.
    const encryptedEnvelopeCID = await this.ipfs.add(JSON.stringify(params.envelopeWire));
    await this.ipfs.pin(encryptedEnvelopeCID); // Permanent pinning

    // Step 4: EAS attestation. Schema is identical to the public variant
    // (the AIP-4 delivery schema is intentionally generic over resultCID
    // / resultHash semantics) — the differentiation is that `resultHash`
    // is the *envelope hash*, not a plaintext content hash.
    const deliveredAt = secondsNow();

    const schemaEncoder = new SchemaEncoder(
      'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt'
    );

    const consumerAddress = this.extractAddressFromDID(params.consumer);

    const encodedData = schemaEncoder.encodeData([
      { name: 'txId', value: params.txId, type: 'bytes32' },
      { name: 'resultCID', value: encryptedEnvelopeCID, type: 'string' },
      { name: 'resultHash', value: envelopeHash, type: 'bytes32' },
      { name: 'deliveredAt', value: deliveredAt, type: 'uint256' }
    ]);

    const tx = await this.eas.attest({
      schema: AGIRAILS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: consumerAddress,
        expirationTime: 0n,
        revocable: false,
        data: encodedData
      }
    });

    const receipt = await tx.wait();
    const attestationUID = (receipt as any).newAttestationUID || (receipt as any);

    // Step 5: Build delivery proof message (unsigned), then sign.
    const deliveryProof: DeliveryProofMessage = {
      type: 'agirails.delivery.v1',
      version: '1.0.0',
      txId: params.txId,
      provider: params.provider,
      consumer: params.consumer,
      resultCID: encryptedEnvelopeCID,
      resultHash: envelopeHash,
      metadata: params.metadata || {},
      easAttestationUID: attestationUID,
      deliveredAt,
      chainId: params.chainId,
      nonce: this.nonceManager.getNextNonce('agirails.delivery.v1'),
      signature: ''
    };

    // Record nonce BEFORE sign/upload to bound replay on retry.
    this.nonceManager.recordNonce('agirails.delivery.v1', deliveryProof.nonce);

    const signature = await this.signDeliveryProof(deliveryProof, params.kernelAddress);
    deliveryProof.signature = signature;

    // Step 6: Upload signed delivery proof JSON to IPFS.
    const deliveryProofCID = await this.ipfs.add(JSON.stringify(deliveryProof));
    await this.ipfs.pin(deliveryProofCID);

    return {
      deliveryProof,
      deliveryProofCID,
      attestationUID,
      encryptedEnvelopeCID,
      envelopeHash
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
