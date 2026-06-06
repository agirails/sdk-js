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

/**
 * @deprecated Use `defaultDiscoveryEndpoint(slug)` instead. Kept for
 * backward compatibility with code that compares against this exact
 * sentinel — new agents should never see this URL because we now
 * default to the agent's agirails.app profile when no endpoint is set.
 */
export const PENDING_ENDPOINT = 'https://pending.agirails.io';

const AGIRAILS_PROFILE_BASE = 'https://agirails.app/a';

/**
 * Default discovery endpoint when the owner doesn't set one.
 *
 * Spec: endpoint is OPTIONAL. AgentRegistry.registerAgent requires a
 * non-empty string at the contract level (kernel guard), so we send
 * the agent's public profile URL as a meaningful default — anyone
 * resolving the endpoint can navigate to the agent's page and learn
 * how to interact off-protocol. Beats `pending.agirails.io` (404).
 */
export function defaultDiscoveryEndpoint(slug: string | undefined): string {
  if (!slug) return PENDING_ENDPOINT;
  return `${AGIRAILS_PROFILE_BASE}/${slug}`;
}

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
 * Pay-only intent: returns an empty serviceDescriptors[] regardless of
 * any `services` field that may be present. Pay-only agents do not
 * register as providers on AgentRegistry — they only call request().
 * This guard is the protocol-level safeguard; CLI front-ends should
 * also reject the misshape upstream with a clearer error.
 *
 * @throws Error if intent is earn/both and neither services nor capabilities are present
 */
export function extractRegistrationParams(
  frontmatter: Record<string, unknown>
): { endpoint: string; serviceDescriptors: ServiceDescriptor[] } {
  const slug = typeof frontmatter.slug === 'string' ? frontmatter.slug : undefined;
  const fallbackEndpoint = defaultDiscoveryEndpoint(slug);

  // Pay-only short-circuit: never register as provider on-chain.
  const intent = typeof frontmatter.intent === 'string'
    ? frontmatter.intent.toLowerCase()
    : 'earn';
  if (intent === 'pay') {
    const endpoint = typeof frontmatter.endpoint === 'string' && frontmatter.endpoint
      ? frontmatter.endpoint
      : fallbackEndpoint;
    return { endpoint, serviceDescriptors: [] };
  }

  // Normalize legacy serviceTypes → capabilities (backward compat)
  if (Array.isArray(frontmatter.serviceTypes) && !frontmatter.capabilities) {
    frontmatter = { ...frontmatter, capabilities: frontmatter.serviceTypes };
  }

  // Endpoint: use frontmatter field or default to the agent's profile URL
  // (slug-derived). Beats the legacy `pending.agirails.io` sentinel.
  const endpoint = typeof frontmatter.endpoint === 'string' && frontmatter.endpoint
    ? frontmatter.endpoint
    : fallbackEndpoint;

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
    'AGIRAILS.md must have "services" (with type field) or "capabilities" in frontmatter for agent registration.\n' +
    'Add at least one, e.g.:\n' +
    '  services:\n' +
    '    - name: my-service\n' +
    '      type: text-generation\n' +
    '      price: 1.00\n'
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

  // AIP-18 DEC-2/DEC-4: a pure buyer (intent: pay) publishes NO service file.
  // Detect intent up front and skip the IPFS/Arweave upload entirely so the
  // buyer's file — which may carry a private `budget` — never leaves the
  // machine. The CLI `actp publish` already does this; guarding the exported
  // helper here means a direct caller can't break the budget-privacy invariant.
  const intent = typeof frontmatter.intent === 'string'
    ? frontmatter.intent.toLowerCase()
    : 'earn';

  let cid = '';
  let arweaveTxId: string | undefined;

  if (intent !== 'pay') {
    // Step 2: Upload raw AGIRAILS.md to IPFS via Filebase
    // Upload the actual markdown file (not a JSON wrapper) so CID points to the real file
    const ipfsResult = await filebaseClient.uploadBinary(
      Buffer.from(content, 'utf-8'),
      'text/markdown',
      { metadata: { type: 'agirails-config', version: '1.0' } }
    );
    cid = ipfsResult.cid;

    // Step 3: Upload to Arweave (optional)
    // Arweave stores the JSON-structured form for archival querying.
    // uploadJSON already sets Content-Type: application/json and Protocol: AGIRAILS as defaults.
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
  }

  // Step 4: Auto-register if needed, then publish on-chain.
  //
  // Pay-only short-circuit: AgentRegistry.registerAgent requires
  // serviceDescriptors > 0 (contract guard), so a buyer-only agent
  // cannot be on-chain at all under the current kernel. We skip both
  // registerAgent and publishConfig — pay-only identity lives off-chain
  // (wallet + agirails.app DB record). The IPFS upload was also skipped
  // above, so a buyer publishes nothing. (`intent` computed above.)
  let registered = false;
  let txHash: string | undefined;

  if (intent !== 'pay') {
    const registry = new AgentRegistry(registryAddress, signer, gasSettings);
    const registryClient = new AgentRegistryClient(registryAddress, signer, gasSettings);

    const signerAddress = await signer.getAddress();
    const profile = await registry.getAgent(signerAddress);

    if (!profile) {
      // Not registered — extract params from frontmatter and auto-register
      const regParams = extractRegistrationParams(frontmatter);
      await registry.registerAgent(regParams);
      registered = true;
    }

    const result = await registryClient.publishConfig(cid, configHash);
    txHash = result.txHash;
  }

  // Step 5: Update frontmatter with publish metadata
  const updatedFrontmatter = {
    ...frontmatter,
    config_hash: configHash,
    published_at: new Date().toISOString(),
    // Pay-only agents have no CID (nothing uploaded) — omit rather than write "".
    ...(cid ? { config_cid: cid } : {}),
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
