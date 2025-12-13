/**
 * Archive Types (AIP-7)
 *
 * Types for transaction archival and retrieval
 */

/**
 * Archived transaction record
 */
export interface ArchivedTransaction {
  /** Transaction hash */
  txHash: string;
  /** Block number when archived */
  blockNumber: number;
  /** Archive timestamp */
  archivedAt: number;
  /** Content reference for archived data */
  contentRef: string;
}

/**
 * Archive query parameters
 */
export interface ArchiveQueryParams {
  /** Filter by agent address */
  agentAddress?: string;
  /** Filter by transaction state */
  state?: string;
  /** Start timestamp */
  fromTimestamp?: number;
  /** End timestamp */
  toTimestamp?: number;
  /** Pagination offset */
  offset?: number;
  /** Maximum results */
  limit?: number;
}
