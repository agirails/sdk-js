/**
 * ArchiveBundleBuilder - Builder for Archive Bundles (AIP-7 §4.4)
 *
 * Provides a fluent builder pattern for constructing archive bundles
 * that will be stored permanently on Arweave.
 *
 * Archive bundles contain minimal metadata with cryptographic hashes
 * and references. Full content remains on IPFS.
 *
 * @module storage/ArchiveBundleBuilder
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { ValidationError } from '../errors';
import {
  ArchiveBundle,
  ArchiveChainId,
  ArchiveFinalState,
  ArchiveParticipants,
  ArchiveReferences,
  ArchiveHashes,
  ArchiveSignatures,
  ArchiveAttestation,
  ArchiveSettlement,
  EscrowRelease,
  ARCHIVE_BUNDLE_TYPE
} from './types';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PROTOCOL_VERSION = '1.0.0';
const DEFAULT_ARCHIVE_SCHEMA_VERSION = '1.0.0';

// Address validation pattern
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

// Transaction ID validation pattern
const TX_ID_PATTERN = /^0x[a-fA-F0-9]{64}$/;

// Hash validation pattern
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

// Signature validation pattern (65 bytes = 130 hex chars)
const SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;

// CID validation pattern (CIDv0 or CIDv1)
const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

// ============================================================================
// ArchiveBundleBuilder Class
// ============================================================================

/**
 * ArchiveBundleBuilder - Fluent builder for archive bundles
 *
 * @example
 * ```typescript
 * const bundle = new ArchiveBundleBuilder()
 *   .setTransactionId('0x1234...')
 *   .setChainId(8453)
 *   .setParticipants({
 *     requester: '0xRequester...',
 *     provider: '0xProvider...'
 *   })
 *   .setReferences({
 *     requestCID: 'bafybei...',
 *     deliveryCID: 'bafybei...'
 *   })
 *   .setHashes({
 *     requestHash: '0xabc...',
 *     deliveryHash: '0xdef...',
 *     serviceHash: '0x123...'
 *   })
 *   .setSignatures({
 *     providerDeliverySignature: '0xsig...'
 *   })
 *   .setAttestation({ easUID: '0xeas...' })
 *   .setSettlement({
 *     settledAt: Date.now() / 1000,
 *     finalState: 'SETTLED',
 *     escrowReleased: { to: '0xProvider...', amount: '100000000' },
 *     platformFee: '1000000',
 *     wasDisputed: false
 *   })
 *   .build();
 * ```
 */
export class ArchiveBundleBuilder {
  private protocolVersion: string = DEFAULT_PROTOCOL_VERSION;
  private archiveSchemaVersion: string = DEFAULT_ARCHIVE_SCHEMA_VERSION;
  private txId?: string;
  private chainId?: ArchiveChainId;
  private archivedAt?: number;
  private participants?: ArchiveParticipants;
  private references?: ArchiveReferences;
  private hashes?: ArchiveHashes;
  private signatures?: ArchiveSignatures;
  private attestation?: ArchiveAttestation;
  private settlement?: ArchiveSettlement;

  /**
   * Create a new ArchiveBundleBuilder
   */
  constructor() {}

  // ==========================================================================
  // Version Setters
  // ==========================================================================

  /**
   * Set protocol version
   * @default '1.0.0'
   */
  setProtocolVersion(version: string): this {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new ValidationError('protocolVersion', 'Must be semver format (e.g., 1.0.0)');
    }
    this.protocolVersion = version;
    return this;
  }

  /**
   * Set archive schema version
   * @default '1.0.0'
   */
  setArchiveSchemaVersion(version: string): this {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new ValidationError('archiveSchemaVersion', 'Must be semver format (e.g., 1.0.0)');
    }
    this.archiveSchemaVersion = version;
    return this;
  }

  // ==========================================================================
  // Transaction Identity Setters
  // ==========================================================================

  /**
   * Set ACTP transaction ID (bytes32)
   */
  setTransactionId(txId: string): this {
    if (!TX_ID_PATTERN.test(txId)) {
      throw new ValidationError('txId', 'Must be bytes32 hex string (0x + 64 hex chars)');
    }
    this.txId = txId.toLowerCase();
    return this;
  }

  /**
   * Set blockchain chain ID
   * @param chainId - 8453 (Base Mainnet) or 84532 (Base Sepolia)
   */
  setChainId(chainId: ArchiveChainId): this {
    if (chainId !== 8453 && chainId !== 84532) {
      throw new ValidationError('chainId', 'Must be 8453 (Base Mainnet) or 84532 (Base Sepolia)');
    }
    this.chainId = chainId;
    return this;
  }

  /**
   * Set archive timestamp
   * @param timestamp - Unix timestamp in seconds (defaults to now)
   */
  setArchivedAt(timestamp?: number): this {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    if (ts <= 0) {
      throw new ValidationError('archivedAt', 'Must be positive Unix timestamp');
    }
    this.archivedAt = ts;
    return this;
  }

  // ==========================================================================
  // Participant Setters
  // ==========================================================================

  /**
   * Set transaction participants
   */
  setParticipants(participants: ArchiveParticipants): this {
    if (!ADDRESS_PATTERN.test(participants.requester)) {
      throw new ValidationError('participants.requester', 'Invalid Ethereum address');
    }
    if (!ADDRESS_PATTERN.test(participants.provider)) {
      throw new ValidationError('participants.provider', 'Invalid Ethereum address');
    }

    this.participants = {
      requester: participants.requester.toLowerCase(),
      provider: participants.provider.toLowerCase()
    };
    return this;
  }

  // ==========================================================================
  // Reference Setters
  // ==========================================================================

  /**
   * Set IPFS CID references
   */
  setReferences(references: ArchiveReferences): this {
    if (!CID_PATTERN.test(references.requestCID)) {
      throw new ValidationError('references.requestCID', 'Invalid IPFS CID format');
    }
    if (!CID_PATTERN.test(references.deliveryCID)) {
      throw new ValidationError('references.deliveryCID', 'Invalid IPFS CID format');
    }
    if (references.resultCID && !CID_PATTERN.test(references.resultCID)) {
      throw new ValidationError('references.resultCID', 'Invalid IPFS CID format');
    }

    this.references = {
      requestCID: references.requestCID,
      deliveryCID: references.deliveryCID,
      ...(references.resultCID && { resultCID: references.resultCID })
    };
    return this;
  }

  // ==========================================================================
  // Hash Setters
  // ==========================================================================

  /**
   * Set cryptographic hashes
   */
  setHashes(hashes: ArchiveHashes): this {
    if (!HASH_PATTERN.test(hashes.requestHash)) {
      throw new ValidationError('hashes.requestHash', 'Invalid hash format (bytes32)');
    }
    if (!HASH_PATTERN.test(hashes.deliveryHash)) {
      throw new ValidationError('hashes.deliveryHash', 'Invalid hash format (bytes32)');
    }
    if (!HASH_PATTERN.test(hashes.serviceHash)) {
      throw new ValidationError('hashes.serviceHash', 'Invalid hash format (bytes32)');
    }

    this.hashes = {
      requestHash: hashes.requestHash.toLowerCase(),
      deliveryHash: hashes.deliveryHash.toLowerCase(),
      serviceHash: hashes.serviceHash.toLowerCase()
    };
    return this;
  }

  /**
   * Compute and set hashes from raw data
   *
   * @param request - Request metadata JSON
   * @param delivery - Delivery proof JSON
   * @param serviceHash - Service hash from transaction (already computed)
   */
  setHashesFromData(request: unknown, delivery: unknown, serviceHash: string): this {
    if (!HASH_PATTERN.test(serviceHash)) {
      throw new ValidationError('serviceHash', 'Invalid hash format (bytes32)');
    }

    // Compute canonical hashes (sorted keys JSON)
    const requestJson = JSON.stringify(this.sortObjectKeys(request));
    const deliveryJson = JSON.stringify(this.sortObjectKeys(delivery));

    this.hashes = {
      requestHash: keccak256(toUtf8Bytes(requestJson)),
      deliveryHash: keccak256(toUtf8Bytes(deliveryJson)),
      serviceHash: serviceHash.toLowerCase()
    };

    return this;
  }

  // ==========================================================================
  // Signature Setters
  // ==========================================================================

  /**
   * Set cryptographic signatures
   */
  setSignatures(signatures: ArchiveSignatures): this {
    if (!SIGNATURE_PATTERN.test(signatures.providerDeliverySignature)) {
      throw new ValidationError(
        'signatures.providerDeliverySignature',
        'Invalid signature format (65 bytes = 0x + 130 hex chars)'
      );
    }
    if (signatures.requesterSettlementSignature &&
        !SIGNATURE_PATTERN.test(signatures.requesterSettlementSignature)) {
      throw new ValidationError(
        'signatures.requesterSettlementSignature',
        'Invalid signature format'
      );
    }

    this.signatures = {
      providerDeliverySignature: signatures.providerDeliverySignature,
      ...(signatures.requesterSettlementSignature && {
        requesterSettlementSignature: signatures.requesterSettlementSignature
      })
    };
    return this;
  }

  // ==========================================================================
  // Attestation Setters
  // ==========================================================================

  /**
   * Set EAS attestation reference
   */
  setAttestation(attestation: ArchiveAttestation): this {
    if (!HASH_PATTERN.test(attestation.easUID)) {
      throw new ValidationError('attestation.easUID', 'Invalid EAS UID format (bytes32)');
    }

    this.attestation = {
      easUID: attestation.easUID.toLowerCase(),
      ...(attestation.schemaUID && { schemaUID: attestation.schemaUID.toLowerCase() })
    };
    return this;
  }

  // ==========================================================================
  // Settlement Setters
  // ==========================================================================

  /**
   * Set settlement information
   */
  setSettlement(settlement: ArchiveSettlement): this {
    // Validate settledAt
    if (settlement.settledAt <= 0) {
      throw new ValidationError('settlement.settledAt', 'Must be positive Unix timestamp');
    }

    // Validate finalState
    if (settlement.finalState !== 'SETTLED' && settlement.finalState !== 'CANCELLED') {
      throw new ValidationError('settlement.finalState', 'Must be SETTLED or CANCELLED');
    }

    // Validate escrowReleased
    if (!ADDRESS_PATTERN.test(settlement.escrowReleased.to)) {
      throw new ValidationError('settlement.escrowReleased.to', 'Invalid Ethereum address');
    }
    if (!/^\d+$/.test(settlement.escrowReleased.amount)) {
      throw new ValidationError(
        'settlement.escrowReleased.amount',
        'Must be numeric string (USDC base units)'
      );
    }

    // Validate platformFee
    if (!/^\d+$/.test(settlement.platformFee)) {
      throw new ValidationError('settlement.platformFee', 'Must be numeric string');
    }

    this.settlement = {
      settledAt: settlement.settledAt,
      finalState: settlement.finalState,
      escrowReleased: {
        to: settlement.escrowReleased.to.toLowerCase(),
        amount: settlement.escrowReleased.amount
      },
      platformFee: settlement.platformFee,
      wasDisputed: Boolean(settlement.wasDisputed)
    };
    return this;
  }

  // ==========================================================================
  // Build Method
  // ==========================================================================

  /**
   * Build the archive bundle
   *
   * @returns Complete archive bundle ready for Arweave upload
   * @throws {ValidationError} If required fields are missing
   */
  build(): ArchiveBundle {
    // Validate all required fields
    if (!this.txId) {
      throw new ValidationError('build', 'Transaction ID is required');
    }
    if (this.chainId === undefined) {
      throw new ValidationError('build', 'Chain ID is required');
    }
    if (!this.participants) {
      throw new ValidationError('build', 'Participants are required');
    }
    if (!this.references) {
      throw new ValidationError('build', 'References are required');
    }
    if (!this.hashes) {
      throw new ValidationError('build', 'Hashes are required');
    }
    if (!this.signatures) {
      throw new ValidationError('build', 'Signatures are required');
    }
    if (!this.settlement) {
      throw new ValidationError('build', 'Settlement info is required');
    }

    // Set archivedAt if not set
    const archivedAt = this.archivedAt ?? Math.floor(Date.now() / 1000);

    const bundle: ArchiveBundle = {
      protocolVersion: this.protocolVersion,
      archiveSchemaVersion: this.archiveSchemaVersion,
      type: ARCHIVE_BUNDLE_TYPE,
      txId: this.txId,
      chainId: this.chainId,
      archivedAt,
      participants: this.participants,
      references: this.references,
      hashes: this.hashes,
      signatures: this.signatures,
      settlement: this.settlement
    };

    // Add attestation if present (optional for CANCELLED transactions)
    if (this.attestation) {
      bundle.attestation = this.attestation;
    }

    return bundle;
  }

  // ==========================================================================
  // Static Factory Methods
  // ==========================================================================

  /**
   * Create builder from existing bundle (for modifications)
   */
  static fromBundle(bundle: ArchiveBundle): ArchiveBundleBuilder {
    const builder = new ArchiveBundleBuilder();

    builder.protocolVersion = bundle.protocolVersion;
    builder.archiveSchemaVersion = bundle.archiveSchemaVersion;
    builder.txId = bundle.txId;
    builder.chainId = bundle.chainId;
    builder.archivedAt = bundle.archivedAt;
    builder.participants = { ...bundle.participants };
    builder.references = { ...bundle.references };
    builder.hashes = { ...bundle.hashes };
    builder.signatures = { ...bundle.signatures };
    builder.settlement = { ...bundle.settlement };

    if (bundle.attestation) {
      builder.attestation = { ...bundle.attestation };
    }

    return builder;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Sort object keys recursively for canonical JSON
   */
  private sortObjectKeys(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObjectKeys(item));
    }

    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();

    for (const key of keys) {
      sorted[key] = this.sortObjectKeys((obj as Record<string, unknown>)[key]);
    }

    return sorted;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute keccak256 hash of canonical JSON
 *
 * @param data - Data to hash
 * @returns keccak256 hash (0x-prefixed)
 */
export function computeContentHash(data: unknown): string {
  const sorted = sortObjectKeysRecursive(data);
  const json = JSON.stringify(sorted);
  return keccak256(toUtf8Bytes(json));
}

/**
 * Sort object keys recursively
 */
function sortObjectKeysRecursive(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sortObjectKeysRecursive(item));
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();

  for (const key of keys) {
    sorted[key] = sortObjectKeysRecursive((obj as Record<string, unknown>)[key]);
  }

  return sorted;
}

/**
 * Validate archive bundle structure
 *
 * @param bundle - Bundle to validate
 * @throws {ValidationError} If bundle is invalid
 */
export function validateArchiveBundle(bundle: unknown): bundle is ArchiveBundle {
  if (!bundle || typeof bundle !== 'object') {
    throw new ValidationError('bundle', 'Archive bundle must be an object');
  }

  const b = bundle as Record<string, unknown>;

  // Type check
  if (b.type !== ARCHIVE_BUNDLE_TYPE) {
    throw new ValidationError('bundle.type', `Expected ${ARCHIVE_BUNDLE_TYPE}`);
  }

  // Required fields
  const required = [
    'protocolVersion',
    'archiveSchemaVersion',
    'txId',
    'chainId',
    'archivedAt',
    'participants',
    'references',
    'hashes',
    'signatures',
    'settlement'
  ];

  for (const field of required) {
    if (!(field in b)) {
      throw new ValidationError(`bundle.${field}`, 'Required field missing');
    }
  }

  return true;
}
