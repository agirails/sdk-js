/**
 * Storage Types (AIP-7 §4)
 *
 * Type definitions for the AGIRAILS hybrid storage architecture:
 * - Tier 1: IPFS (Filebase) for hot storage
 * - Tier 2: Arweave (Irys) for permanent archive
 */

// ============================================================================
// Filebase Configuration
// ============================================================================

/**
 * Configuration for Filebase S3-compatible IPFS client
 */
export interface FilebaseConfig {
  /**
   * Filebase access key ID
   * Get from: https://console.filebase.com/keys
   */
  accessKey: string;

  /**
   * Filebase secret access key
   * SECURITY: Store in environment variable, never in code
   */
  secretKey: string;

  /**
   * Filebase bucket name
   * @default 'agirails-storage'
   */
  bucket?: string;

  /**
   * Filebase S3 endpoint
   * @default 'https://s3.filebase.com'
   */
  endpoint?: string;

  /**
   * IPFS gateway URL for retrieval
   * @default 'https://ipfs.filebase.io/ipfs/'
   */
  gatewayUrl?: string;

  /**
   * Request timeout in milliseconds
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Maximum file size in bytes for uploads
   * @default 104857600 (100MB)
   */
  maxFileSize?: number;

  /**
   * Maximum download size in bytes (P1-1: DoS protection)
   * Downloads exceeding this limit will be rejected
   * @default 52428800 (50MB)
   */
  maxDownloadSize?: number;

  /**
   * Circuit breaker configuration for gateway health tracking
   * When enabled, tracks gateway failures and temporarily blocks
   * requests to unhealthy gateways (retry amplification protection)
   */
  circuitBreaker?: {
    /** Enable circuit breaker (default: true) */
    enabled?: boolean;
    /** Number of failures before opening circuit (default: 5) */
    failureThreshold?: number;
    /** Cooldown period in ms before attempting reset (default: 60000) */
    resetTimeoutMs?: number;
    /** Time window in ms for counting failures (default: 300000) */
    failureWindowMs?: number;
    /** Number of successes in half-open to close circuit (default: 2) */
    successThreshold?: number;
  };
}

// ============================================================================
// Arweave Configuration
// ============================================================================

/**
 * Supported Irys payment tokens
 * @see https://docs.irys.xyz/build/d/features/supported-tokens
 */
export type IrysCurrency =
  | 'base-eth'      // RECOMMENDED: Base ETH (native to AGIRAILS)
  | 'ethereum'      // Ethereum mainnet ETH
  | 'matic'         // Polygon MATIC
  | 'arbitrum'      // Arbitrum ETH
  | 'usdc-eth'      // USDC on Ethereum
  | 'usdc-polygon'; // USDC on Polygon

/**
 * Irys network
 */
export type IrysNetwork = 'mainnet' | 'devnet';

/**
 * Configuration for Arweave client via Irys
 */
export interface ArweaveConfig {
  /**
   * Private key for signing transactions
   * SECURITY: Store in environment variable, never in code
   */
  privateKey: string;

  /**
   * RPC URL for the payment chain
   * Required for blockchain operations
   */
  rpcUrl: string;

  /**
   * Payment currency/token
   * @default 'base-eth'
   */
  currency?: IrysCurrency;

  /**
   * Irys network (mainnet or devnet)
   * @default 'mainnet'
   */
  network?: IrysNetwork;

  /**
   * Request timeout in milliseconds
   * @default 60000 (60 seconds)
   */
  timeout?: number;

  /**
   * Circuit breaker configuration for gateway health tracking
   * When enabled, tracks gateway failures and temporarily blocks
   * requests to unhealthy gateways (retry amplification protection)
   */
  circuitBreaker?: {
    /** Enable circuit breaker (default: true) */
    enabled?: boolean;
    /** Number of failures before opening circuit (default: 5) */
    failureThreshold?: number;
    /** Cooldown period in ms before attempting reset (default: 60000) */
    resetTimeoutMs?: number;
    /** Time window in ms for counting failures (default: 300000) */
    failureWindowMs?: number;
    /** Number of successes in half-open to close circuit (default: 2) */
    successThreshold?: number;
  };
}

// ============================================================================
// Archive Bundle Types (AIP-7 §4.4)
// ============================================================================

/**
 * Archive bundle type identifier
 */
export const ARCHIVE_BUNDLE_TYPE = 'actp.archive.v1.minimal' as const;

/**
 * Supported chain IDs for archive bundles
 */
export type ArchiveChainId = 8453 | 84532; // Base Mainnet | Base Sepolia

/**
 * Final transaction states that can be archived
 */
export type ArchiveFinalState = 'SETTLED' | 'CANCELLED';

/**
 * Transaction participants (addresses only, not full profiles)
 */
export interface ArchiveParticipants {
  /** Requester Ethereum address */
  requester: string;
  /** Provider Ethereum address */
  provider: string;
}

/**
 * IPFS CID references to full content
 */
export interface ArchiveReferences {
  /** IPFS CID of AIP-1 request metadata */
  requestCID: string;
  /** IPFS CID of AIP-4 delivery proof */
  deliveryCID: string;
  /** IPFS CID of actual result/output (optional) */
  resultCID?: string;
}

/**
 * Cryptographic hashes for verification
 */
export interface ArchiveHashes {
  /** keccak256 of canonical request metadata JSON */
  requestHash: string;
  /** keccak256 of canonical delivery proof JSON */
  deliveryHash: string;
  /** serviceHash from ACTPKernel transaction */
  serviceHash: string;
}

/**
 * Cryptographic signatures for self-verification
 */
export interface ArchiveSignatures {
  /** EIP-712 signature by provider over deliveryHash */
  providerDeliverySignature: string;
  /** Optional: requester signature authorizing settlement */
  requesterSettlementSignature?: string;
}

/**
 * EAS attestation reference
 */
export interface ArchiveAttestation {
  /** Ethereum Attestation Service UID */
  easUID: string;
  /** EAS schema UID used for attestation (optional) */
  schemaUID?: string;
}

/**
 * Escrow release details
 */
export interface EscrowRelease {
  /** Recipient address (provider or requester) */
  to: string;
  /** Released amount (USDC base units, string for BigInt safety) */
  amount: string;
}

/**
 * Settlement information
 */
export interface ArchiveSettlement {
  /** Settlement timestamp (Unix seconds) */
  settledAt: number;
  /** Final transaction state */
  finalState: ArchiveFinalState;
  /** Escrow release details */
  escrowReleased: EscrowRelease;
  /** Platform fee collected (USDC base units) */
  platformFee: string;
  /** Whether transaction went through dispute */
  wasDisputed: boolean;
}

/**
 * Archive Bundle (AIP-7 §4.4 - Minimal Hash-First)
 *
 * Contains minimal metadata with cryptographic hashes and references.
 * Full content (request metadata, delivery proof) remains on IPFS.
 */
export interface ArchiveBundle {
  /** AGIRAILS protocol version (e.g., "1.0.0") */
  protocolVersion: string;
  /** Archive bundle schema version (e.g., "1.0.0") */
  archiveSchemaVersion: string;
  /** Archive bundle type identifier */
  type: typeof ARCHIVE_BUNDLE_TYPE;
  /** ACTP transaction ID (bytes32) */
  txId: string;
  /** Blockchain network chain ID */
  chainId: ArchiveChainId;
  /** Archive timestamp (Unix seconds) */
  archivedAt: number;
  /** Transaction participants (addresses only) */
  participants: ArchiveParticipants;
  /** IPFS CID references to full content */
  references: ArchiveReferences;
  /** Cryptographic hashes for verification */
  hashes: ArchiveHashes;
  /** Cryptographic signatures */
  signatures: ArchiveSignatures;
  /** EAS attestation reference (optional for cancelled transactions) */
  attestation?: ArchiveAttestation;
  /** Settlement information */
  settlement: ArchiveSettlement;
}

// ============================================================================
// Upload/Download Results
// ============================================================================

/**
 * Result of uploading to IPFS
 */
export interface IPFSUploadResult {
  /** IPFS CID (CIDv1, base32) */
  cid: string;
  /** Size of uploaded content in bytes */
  size: number;
  /** Upload timestamp */
  uploadedAt: Date;
}

/**
 * Result of uploading to Arweave
 */
export interface ArweaveUploadResult {
  /** Arweave transaction ID */
  txId: string;
  /** Size of uploaded content in bytes */
  size: number;
  /** Upload timestamp */
  uploadedAt: Date;
  /** Cost in the payment currency (wei for ETH) */
  cost: string;
}

/**
 * Result of downloading content
 */
export interface DownloadResult<T = unknown> {
  /** Downloaded and parsed content */
  data: T;
  /** Size of downloaded content in bytes */
  size: number;
  /** Download timestamp */
  downloadedAt: Date;
}

// ============================================================================
// Irys Tags
// ============================================================================

/**
 * Arweave/Irys tags for archive bundles
 */
export interface ArchiveTags {
  'Content-Type': 'application/json';
  Protocol: 'AGIRAILS';
  Version: string;
  Schema: string;
  Type: typeof ARCHIVE_BUNDLE_TYPE;
  ChainId: string;
  TxId: string;
}
