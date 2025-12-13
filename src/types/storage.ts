/**
 * Storage Types (AIP-7)
 *
 * Placeholder types for content storage - to be expanded
 */

/**
 * Storage provider configuration
 */
export interface StorageConfig {
  /** Provider type: ipfs, arweave, s3 */
  provider: 'ipfs' | 'arweave' | 's3';
  /** Gateway URL for retrieval */
  gatewayUrl?: string;
}

/**
 * Content identifier for stored data
 */
export interface ContentReference {
  /** Content identifier (CID for IPFS, txId for Arweave) */
  id: string;
  /** Provider that stores the content */
  provider: string;
  /** Full retrieval URL */
  url: string;
}
