/**
 * Publish Pipeline - AGIRAILS.md → IPFS → Arweave → On-Chain
 *
 * Orchestrates the full publish flow:
 * 1. Read AGIRAILS.md → parse → compute configHash
 * 2. Upload to Filebase (IPFS pinning)
 * 3. Upload to Arweave (permanent storage) [optional]
 * 4. Call AgentRegistry.publishConfig(cid, hash) on-chain
 * 5. Update AGIRAILS.md frontmatter with config_hash and published_at
 *
 * @module config/publishPipeline
 */

import { readFileSync, writeFileSync } from 'fs';
import { Signer, keccak256, toUtf8Bytes } from 'ethers';
import { parseAgirailsMd, computeConfigHash, serializeAgirailsMd } from './agirailsmd';
import { AgentRegistryClient } from '../registry/AgentRegistryClient';
import { AgentRegistry } from '../protocol/AgentRegistry';
import { FilebaseClient } from '../storage/FilebaseClient';
import { ArweaveClient } from '../storage/ArweaveClient';
import { ServiceDescriptor } from '../types';

// ============================================================================
// Types
// ============================================================================

export interface PublishOptions {
  /** Path to AGIRAILS.md file */
  path: string;
  /** Network name (for registry address lookup) */
  network: string;
  /** AgentRegistry contract address */
  registryAddress: string;
  /** Signer for on-chain transactions */
  signer: Signer;
  /** Filebase client for IPFS upload */
  filebaseClient: FilebaseClient;
  /** Arweave client for permanent storage (optional) */
  arweaveClient?: ArweaveClient;
  /** Skip Arweave upload (dev mode) */
  skipArweave?: boolean;
  /** Dry run - compute and show but don't execute */
  dryRun?: boolean;
  /** Gas settings */
  gasSettings?: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
}

export interface PublishResult {
  /** IPFS CID of the uploaded AGIRAILS.md */
  cid: string;
  /** Canonical config hash (bytes32) */
  configHash: string;
  /** On-chain transaction hash */
  txHash?: string;
  /** Arweave transaction ID (if uploaded) */
  arweaveTxId?: string;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Whether the agent was auto-registered during this publish */
  registered?: boolean;
}

// ============================================================================
// Registration Helpers
// ============================================================================

export const PENDING_ENDPOINT = 'https://pending.agirails.io';

/** Default values for capabilities-to-services conversion */
const SERVICE_DEFAULTS = {
  schemaURI: '',
  minPrice: 0n,
  maxPrice: 1_000_000_000n, // 1000 USDC
  avgCompletionTime: 3600,  // 1 hour
  metadataCID: '',
};

/** Max safe USDC value before BigInt conversion loses precision */
const MAX_SAFE_USDC = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);

/** Validate service type format (must match contract requirements) */
function validateServiceType(serviceType: string, source: string): void {
  if (!serviceType) {
    throw new Error(`Empty service type in ${source}`);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(serviceType)) {
    throw new Error(
      `Invalid service type "${serviceType}" in ${source}. ` +
      'Must be lowercase alphanumeric with hyphens (e.g., "text-generation").'
    );
  }
}

/** Convert human-readable USDC to 6-decimal base units with overflow check */
function usdcToBaseUnits(value: number, fieldName: string): bigint {
  if (value < 0) throw new Error(`${fieldName} cannot be negative`);
  if (value > MAX_SAFE_USDC) throw new Error(`${fieldName} exceeds maximum safe value (${MAX_SAFE_USDC} USDC)`);
  return BigInt(Math.round(value * 1_000_000));
}

/**
 * Extract registration params from AGIRAILS.md frontmatter.
 *
 * Supports two formats:
 * - `services`: full ServiceDescriptor objects with pricing
 * - `capabilities`: simple string list, auto-converted with defaults
 *
 * @throws Error if neither services nor capabilities are present
 */
export function extractRegistrationParams(
  frontmatter: Record<string, unknown>
): { endpoint: string; serviceDescriptors: ServiceDescriptor[] } {
  // Endpoint: use frontmatter field or placeholder
  const endpoint = typeof frontmatter.endpoint === 'string' && frontmatter.endpoint
    ? frontmatter.endpoint
    : PENDING_ENDPOINT;

  // Try explicit services first
  if (Array.isArray(frontmatter.services) && frontmatter.services.length > 0) {
    const serviceDescriptors = (frontmatter.services as Record<string, unknown>[]).map(svc => {
      const serviceType = String(svc.type || svc.service_type || '').trim().toLowerCase();
      validateServiceType(serviceType, 'services');

      // Parse price range: "1.0-100.0" or separate min/max
      let minPrice = SERVICE_DEFAULTS.minPrice;
      let maxPrice = SERVICE_DEFAULTS.maxPrice;
      if (typeof svc.price === 'string' && svc.price.includes('-')) {
        const [min, max] = svc.price.split('-').map(Number);
        minPrice = usdcToBaseUnits(min, 'min_price');
        maxPrice = usdcToBaseUnits(max, 'max_price');
      } else {
        if (svc.min_price !== undefined) minPrice = usdcToBaseUnits(Number(svc.min_price), 'min_price');
        if (svc.max_price !== undefined) maxPrice = usdcToBaseUnits(Number(svc.max_price), 'max_price');
      }

      return {
        serviceTypeHash: keccak256(toUtf8Bytes(serviceType)),
        serviceType,
        schemaURI: String(svc.schema_uri || svc.schemaURI || SERVICE_DEFAULTS.schemaURI),
        minPrice,
        maxPrice,
        avgCompletionTime: Number(svc.avg_completion_time || svc.avgCompletionTime || SERVICE_DEFAULTS.avgCompletionTime),
        metadataCID: String(svc.metadata_cid || svc.metadataCID || SERVICE_DEFAULTS.metadataCID),
      };
    });
    return { endpoint, serviceDescriptors };
  }

  // Fallback: convert capabilities list to services with defaults
  if (Array.isArray(frontmatter.capabilities) && frontmatter.capabilities.length > 0) {
    const serviceDescriptors = (frontmatter.capabilities as string[]).map(cap => {
      const serviceType = String(cap).trim().toLowerCase();
      validateServiceType(serviceType, 'capabilities');
      return {
        serviceTypeHash: keccak256(toUtf8Bytes(serviceType)),
        serviceType,
        schemaURI: SERVICE_DEFAULTS.schemaURI,
        minPrice: SERVICE_DEFAULTS.minPrice,
        maxPrice: SERVICE_DEFAULTS.maxPrice,
        avgCompletionTime: SERVICE_DEFAULTS.avgCompletionTime,
        metadataCID: SERVICE_DEFAULTS.metadataCID,
      };
    });
    return { endpoint, serviceDescriptors };
  }

  throw new Error(
    'AGIRAILS.md must have "services" or "capabilities" in frontmatter for agent registration.\n' +
    'Add at least one, e.g.:\n' +
    '  capabilities:\n' +
    '    - text-generation\n'
  );
}

// ============================================================================
// Prepare Publish (offline — no on-chain calls)
// ============================================================================

export interface PreparePublishOptions {
  /** Path to AGIRAILS.md file */
  path: string;
  /** Filebase client for IPFS upload */
  filebaseClient: FilebaseClient;
  /** Arweave client for permanent storage (optional) */
  arweaveClient?: ArweaveClient;
  /** Skip Arweave upload */
  skipArweave?: boolean;
  /** Dry run — compute and show but don't execute */
  dryRun?: boolean;
}

export interface PreparePublishResult {
  /** IPFS CID of uploaded AGIRAILS.md */
  cid: string;
  /** Canonical config hash (bytes32) */
  configHash: string;
  /** Arweave transaction ID (if uploaded) */
  arweaveTxId?: string;
  /** Parsed frontmatter */
  frontmatter: Record<string, unknown>;
  /** Parsed body */
  body: string;
  /** Whether this was a dry run */
  dryRun: boolean;
}

/**
 * Prepare publish — IPFS upload + hash computation only.
 *
 * No on-chain calls. Returns the CID and configHash for
 * saving to pending-publish.json (lazy publish flow).
 */
export async function preparePublish(options: PreparePublishOptions): Promise<PreparePublishResult> {
  const {
    path,
    filebaseClient,
    arweaveClient,
    skipArweave = false,
    dryRun = false,
  } = options;

  // Read and parse
  const content = readFileSync(path, 'utf-8');
  const { frontmatter, body } = parseAgirailsMd(content);
  const { configHash } = computeConfigHash(content);

  if (dryRun) {
    return { cid: '(dry-run)', configHash, frontmatter, body, dryRun: true };
  }

  // Upload to IPFS
  const ipfsResult = await filebaseClient.uploadBinary(
    Buffer.from(content, 'utf-8'),
    'text/markdown',
    { metadata: { type: 'agirails-config', version: '1.0' } }
  );
  const cid = ipfsResult.cid;

  // Arweave (optional)
  let arweaveTxId: string | undefined;
  if (!skipArweave && arweaveClient) {
    const arweaveResult = await arweaveClient.uploadJSON(
      { frontmatter, body, _format: 'agirails.md.v1' },
      [
        { name: 'Type', value: 'agent-config' },
        { name: 'ConfigHash', value: configHash },
        { name: 'IPFS-CID', value: cid },
      ]
    );
    arweaveTxId = arweaveResult.txId;
  }

  return { cid, configHash, arweaveTxId, frontmatter, body, dryRun: false };
}

// ============================================================================
// Pipeline (legacy — makes on-chain calls)
// ============================================================================

/**
 * Execute the full publish pipeline.
 *
 * @param options - Publish configuration
 * @returns Publish result with CID, hash, and transaction hashes
 */
export async function publishAgirailsMd(options: PublishOptions): Promise<PublishResult> {
  const {
    path,
    registryAddress,
    signer,
    filebaseClient,
    arweaveClient,
    skipArweave = false,
    dryRun = false,
    gasSettings,
  } = options;

  // Step 1: Read and parse
  const content = readFileSync(path, 'utf-8');
  const { frontmatter, body } = parseAgirailsMd(content);
  const { configHash } = computeConfigHash(content);

  if (dryRun) {
    return {
      cid: '(dry-run)',
      configHash,
      dryRun: true,
      registered: false,
    };
  }

  // Step 2: Upload raw AGIRAILS.md to IPFS via Filebase
  // Upload the actual markdown file (not a JSON wrapper) so CID points to the real file
  const ipfsResult = await filebaseClient.uploadBinary(
    Buffer.from(content, 'utf-8'),
    'text/markdown',
    { metadata: { type: 'agirails-config', version: '1.0' } }
  );
  const cid = ipfsResult.cid;

  // Step 3: Upload to Arweave (optional)
  // Arweave stores the JSON-structured form for archival querying.
  // uploadJSON already sets Content-Type: application/json and Protocol: AGIRAILS as defaults.
  let arweaveTxId: string | undefined;
  if (!skipArweave && arweaveClient) {
    const arweaveResult = await arweaveClient.uploadJSON(
      { frontmatter, body, _format: 'agirails.md.v1' },
      [
        { name: 'Type', value: 'agent-config' },
        { name: 'ConfigHash', value: configHash },
        { name: 'IPFS-CID', value: cid },
      ]
    );
    arweaveTxId = arweaveResult.txId;
  }

  // Step 4: Auto-register if needed, then publish on-chain
  const registry = new AgentRegistry(registryAddress, signer, gasSettings);
  const registryClient = new AgentRegistryClient(registryAddress, signer, gasSettings);
  let registered = false;

  const signerAddress = await signer.getAddress();
  const profile = await registry.getAgent(signerAddress);

  if (!profile) {
    // Not registered — extract params from frontmatter and auto-register
    const regParams = extractRegistrationParams(frontmatter);
    await registry.registerAgent(regParams);
    registered = true;
  }

  const { txHash } = await registryClient.publishConfig(cid, configHash);

  // Step 5: Update frontmatter with publish metadata
  const updatedFrontmatter = {
    ...frontmatter,
    config_hash: configHash,
    published_at: new Date().toISOString(),
    config_cid: cid,
    ...(arweaveTxId ? { arweave_tx: arweaveTxId } : {}),
  };

  const updatedContent = serializeAgirailsMd(updatedFrontmatter, body);
  writeFileSync(path, updatedContent, 'utf-8');

  return {
    cid,
    configHash,
    txHash,
    arweaveTxId,
    dryRun: false,
    registered,
  };
}
