/**
 * Storage Module - Hybrid Storage Architecture (AIP-7 §4)
 *
 * Two-tier storage model:
 * - Tier 1: IPFS (Filebase) for hot storage
 * - Tier 2: Arweave (Irys) for permanent archive
 *
 * @module storage
 *
 * @example
 * ```typescript
 * import {
 *   FilebaseClient,
 *   ArweaveClient,
 *   ArchiveBundleBuilder
 * } from '@agirails/sdk/storage';
 *
 * // IPFS hot storage
 * const ipfs = new FilebaseClient({
 *   accessKey: process.env.FILEBASE_ACCESS_KEY!,
 *   secretKey: process.env.FILEBASE_SECRET_KEY!
 * });
 *
 * // Arweave permanent storage
 * const arweave = await ArweaveClient.create({
 *   privateKey: process.env.ARCHIVE_KEY!,
 *   rpcUrl: process.env.BASE_RPC!
 * });
 *
 * // Build archive bundle
 * const bundle = new ArchiveBundleBuilder()
 *   .setTransactionId(txId)
 *   .setChainId(8453)
 *   // ... other fields
 *   .build();
 *
 * // Upload to Arweave
 * const result = await arweave.uploadBundle(bundle);
 * console.log('Archived at:', result.txId);
 * ```
 */

// ============================================================================
// Clients
// ============================================================================

export { FilebaseClient } from './FilebaseClient';
export { ArweaveClient } from './ArweaveClient';

// ============================================================================
// Builders
// ============================================================================

export {
  ArchiveBundleBuilder,
  computeContentHash,
  validateArchiveBundle
} from './ArchiveBundleBuilder';

// ============================================================================
// Types
// ============================================================================

export type {
  // Filebase
  FilebaseConfig,

  // Arweave
  ArweaveConfig,
  IrysCurrency,
  IrysNetwork,

  // Archive Bundle
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
  ArchiveTags,

  // Results
  IPFSUploadResult,
  ArweaveUploadResult,
  DownloadResult
} from './types';

// ============================================================================
// Constants
// ============================================================================

export { ARCHIVE_BUNDLE_TYPE } from './types';
