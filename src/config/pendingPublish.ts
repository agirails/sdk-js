/**
 * Pending Publish Module — Deferred on-chain activation for Lazy Publish.
 *
 * When `actp publish` runs, it saves a `pending-publish.{network}.json` file
 * instead of making on-chain calls. The first real payment triggers activation
 * (registerAgent, publishConfig, setListed) in a single UserOp alongside the
 * payment calls.
 *
 * Files are chain-scoped: testnet and mainnet pending publishes coexist independently.
 * Legacy `pending-publish.json` (unscoped) is supported for migration.
 *
 * The file is deleted after successful on-chain activation.
 *
 * @module config/pendingPublish
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ServiceDescriptor } from '../types/agent';

// ============================================================================
// Types
// ============================================================================

/**
 * Serializable representation of a ServiceDescriptor.
 * BigInt fields are stored as strings for JSON compatibility.
 */
interface SerializedServiceDescriptor {
  serviceTypeHash: string;
  serviceType: string;
  schemaURI: string;
  minPrice: string;
  maxPrice: string;
  avgCompletionTime: number;
  metadataCID: string;
}

/**
 * Pending publish state — saved to `.actp/pending-publish.{network}.json`.
 */
export interface PendingPublish {
  /** Schema version */
  version: 1;
  /** Canonical config hash (bytes32) */
  configHash: string;
  /** IPFS CID of uploaded AGIRAILS.md */
  cid: string;
  /** Agent endpoint URL */
  endpoint: string;
  /** Service descriptors from AGIRAILS.md frontmatter */
  serviceDescriptors: ServiceDescriptor[];
  /** ISO 8601 timestamp of when pending-publish.json was created */
  createdAt: string;
  /** Network identifier (e.g. 'base-sepolia', 'base-mainnet') */
  network?: string;
}

/**
 * JSON-serializable form of PendingPublish (bigints as strings).
 */
interface SerializedPendingPublish {
  version: 1;
  configHash: string;
  cid: string;
  endpoint: string;
  serviceDescriptors: SerializedServiceDescriptor[];
  createdAt: string;
  network?: string;
}

// ============================================================================
// Serialization Helpers
// ============================================================================

function serializeDescriptor(sd: ServiceDescriptor): SerializedServiceDescriptor {
  return {
    serviceTypeHash: sd.serviceTypeHash,
    serviceType: sd.serviceType,
    schemaURI: sd.schemaURI,
    minPrice: sd.minPrice.toString(),
    maxPrice: sd.maxPrice.toString(),
    avgCompletionTime: sd.avgCompletionTime,
    metadataCID: sd.metadataCID,
  };
}

function deserializeDescriptor(sd: SerializedServiceDescriptor): ServiceDescriptor {
  return {
    serviceTypeHash: sd.serviceTypeHash,
    serviceType: sd.serviceType,
    schemaURI: sd.schemaURI,
    minPrice: BigInt(sd.minPrice),
    maxPrice: BigInt(sd.maxPrice),
    avgCompletionTime: sd.avgCompletionTime,
    metadataCID: sd.metadataCID,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the .actp directory path.
 *
 * Respects `ACTP_DIR` env var for custom locations.
 * Defaults to `{cwd}/.actp`.
 */
export function getActpDir(): string {
  return process.env.ACTP_DIR || join(process.cwd(), '.actp');
}

/**
 * Get the path to a pending-publish file.
 *
 * @param network - Optional network identifier. If provided, returns
 *   `pending-publish.{network}.json`. Otherwise returns legacy `pending-publish.json`.
 */
export function getPendingPublishPath(network?: string): string {
  if (network) {
    return join(getActpDir(), `pending-publish.${network}.json`);
  }
  return join(getActpDir(), 'pending-publish.json');
}

/**
 * Save a pending publish to `.actp/pending-publish.{network}.json`.
 *
 * Creates the .actp directory if it doesn't exist.
 * File is written atomically with mode 0o600 (owner read/write only).
 *
 * If `pending.network` is set, saves to network-scoped file.
 * Otherwise saves to legacy `pending-publish.json`.
 */
export function savePendingPublish(pending: PendingPublish): void {
  const dir = getActpDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const serialized: SerializedPendingPublish = {
    version: pending.version,
    configHash: pending.configHash,
    cid: pending.cid,
    endpoint: pending.endpoint,
    serviceDescriptors: pending.serviceDescriptors.map(serializeDescriptor),
    createdAt: pending.createdAt,
    ...(pending.network ? { network: pending.network } : {}),
  };

  const filePath = getPendingPublishPath(pending.network);
  writeFileSync(filePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
}

/**
 * Load a pending publish from `.actp/pending-publish.{network}.json`.
 *
 * If `network` is provided:
 *   1. Try `pending-publish.{network}.json`
 *   2. Fall back to legacy `pending-publish.json` (migration)
 *
 * If no `network`: loads legacy `pending-publish.json`.
 *
 * Returns null if no file found.
 */
export function loadPendingPublish(network?: string): PendingPublish | null {
  // Try network-scoped file first
  if (network) {
    const scopedPath = getPendingPublishPath(network);
    if (existsSync(scopedPath)) {
      return deserializePendingPublish(readFileSync(scopedPath, 'utf-8'));
    }
  }

  // Fall back to legacy file
  const legacyPath = getPendingPublishPath();
  if (!existsSync(legacyPath)) {
    return null;
  }

  return deserializePendingPublish(readFileSync(legacyPath, 'utf-8'));
}

/**
 * Delete the pending-publish file for a given network.
 *
 * Deletes both the network-scoped file and legacy file (cleanup).
 * No-op if files don't exist. Best-effort — never throws.
 */
export function deletePendingPublish(network?: string): void {
  try {
    // Delete network-scoped file
    if (network) {
      const scopedPath = getPendingPublishPath(network);
      if (existsSync(scopedPath)) {
        unlinkSync(scopedPath);
      }
    }

    // Also delete legacy file if it exists (cleanup)
    const legacyPath = getPendingPublishPath();
    if (existsSync(legacyPath)) {
      unlinkSync(legacyPath);
    }
  } catch {
    // Best-effort: file deletion should never crash post-payment UX
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function deserializePendingPublish(raw: string): PendingPublish {
  const serialized: SerializedPendingPublish = JSON.parse(raw);
  return {
    version: serialized.version,
    configHash: serialized.configHash,
    cid: serialized.cid,
    endpoint: serialized.endpoint,
    serviceDescriptors: serialized.serviceDescriptors.map(deserializeDescriptor),
    createdAt: serialized.createdAt,
    ...(serialized.network ? { network: serialized.network } : {}),
  };
}
