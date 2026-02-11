/**
 * Pending Publish Module — Deferred on-chain activation for Lazy Publish.
 *
 * When `actp publish` runs, it saves a `pending-publish.json` file instead of
 * making on-chain calls. The first real payment triggers activation (registerAgent,
 * publishConfig, setListed) in a single UserOp alongside the payment calls.
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
 * Pending publish state — saved to `.actp/pending-publish.json`.
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
 * Get the path to pending-publish.json.
 */
export function getPendingPublishPath(): string {
  return join(getActpDir(), 'pending-publish.json');
}

/**
 * Save a pending publish to `.actp/pending-publish.json`.
 *
 * Creates the .actp directory if it doesn't exist.
 * File is written atomically with mode 0o600 (owner read/write only).
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
  };

  const filePath = getPendingPublishPath();
  writeFileSync(filePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
}

/**
 * Load a pending publish from `.actp/pending-publish.json`.
 *
 * Returns null if the file doesn't exist.
 */
export function loadPendingPublish(): PendingPublish | null {
  const filePath = getPendingPublishPath();
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, 'utf-8');
  const serialized: SerializedPendingPublish = JSON.parse(raw);

  return {
    version: serialized.version,
    configHash: serialized.configHash,
    cid: serialized.cid,
    endpoint: serialized.endpoint,
    serviceDescriptors: serialized.serviceDescriptors.map(deserializeDescriptor),
    createdAt: serialized.createdAt,
  };
}

/**
 * Delete the pending-publish.json file.
 *
 * No-op if the file doesn't exist.
 */
export function deletePendingPublish(): void {
  const filePath = getPendingPublishPath();
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
