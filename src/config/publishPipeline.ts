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
import { Signer } from 'ethers';
import { parseAgirailsMd, computeConfigHash, computeConfigHashFromParts, serializeAgirailsMd } from './agirailsmd';
import { AgentRegistryClient } from '../registry/AgentRegistryClient';
import { FilebaseClient } from '../storage/FilebaseClient';
import { ArweaveClient } from '../storage/ArweaveClient';

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
}

// ============================================================================
// Pipeline
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

  // Step 4: Publish on-chain
  const registryClient = new AgentRegistryClient(registryAddress, signer, gasSettings);
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
  };
}
