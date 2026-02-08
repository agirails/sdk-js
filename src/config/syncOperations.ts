/**
 * Sync Operations - Pull + Diff for AGIRAILS.md
 *
 * Terraform-style sync: compare local AGIRAILS.md with on-chain state.
 * Never auto-overwrites — shows diff and requires explicit confirmation.
 *
 * @module config/syncOperations
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Provider } from 'ethers';
import { computeConfigHash, parseAgirailsMd, serializeAgirailsMd } from './agirailsmd';
import { validateCID } from '../utils/validation';
import { AgentRegistryClient } from '../registry/AgentRegistryClient';

// ============================================================================
// Constants
// ============================================================================

/** Public IPFS gateways for read-only access (no credentials needed) */
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

// ============================================================================
// Types
// ============================================================================

export interface DiffResult {
  /** Whether local and on-chain are in sync */
  inSync: boolean;
  /** Local config hash (or null if no local file) */
  localHash: string | null;
  /** On-chain config hash (or zero hash if not published) */
  onChainHash: string;
  /** On-chain IPFS CID (or empty if not published) */
  onChainCID: string;
  /** Whether on-chain has a published config */
  hasOnChainConfig: boolean;
  /** Whether local file exists */
  hasLocalFile: boolean;
  /** Human-readable status message */
  status: 'in-sync' | 'local-ahead' | 'remote-ahead' | 'diverged' | 'no-local' | 'no-remote';
}

export interface PullResult {
  /** Whether a file was written */
  written: boolean;
  /** The pulled content (if any) */
  content?: string;
  /** IPFS CID that was fetched */
  cid?: string;
  /** Status message */
  status: string;
}

export interface DiffOptions {
  /** Path to local AGIRAILS.md */
  path: string;
  /** Agent address to check on-chain */
  agentAddress: string;
  /** AgentRegistry contract address */
  registryAddress: string;
  /** Provider for reading on-chain state */
  provider: Provider;
}

export interface PullOptions extends DiffOptions {
  /** Force overwrite without confirmation */
  force?: boolean;
}

// ============================================================================
// Diff
// ============================================================================

const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * Compare local AGIRAILS.md with on-chain config state.
 *
 * @param options - Diff configuration
 * @returns Diff result showing sync status
 */
export async function diff(options: DiffOptions): Promise<DiffResult> {
  const { path, agentAddress, registryAddress, provider } = options;

  // Read on-chain state
  const registryClient = AgentRegistryClient.readOnly(registryAddress, provider);
  const onChainState = await registryClient.getConfig(agentAddress);

  const hasOnChainConfig = onChainState.configHash !== ZERO_HASH && onChainState.configCID !== '';
  const onChainHash = onChainState.configHash;
  const onChainCID = onChainState.configCID;

  // Read local state
  const hasLocalFile = existsSync(path);
  let localHash: string | null = null;

  if (hasLocalFile) {
    const content = readFileSync(path, 'utf-8');
    const { configHash } = computeConfigHash(content);
    localHash = configHash;
  }

  // Determine status
  let status: DiffResult['status'];
  let inSync: boolean;

  if (!hasLocalFile && !hasOnChainConfig) {
    status = 'no-local';
    inSync = true; // both empty = in sync
  } else if (!hasLocalFile && hasOnChainConfig) {
    status = 'remote-ahead';
    inSync = false;
  } else if (hasLocalFile && !hasOnChainConfig) {
    status = 'no-remote';
    inSync = false;
  } else if (localHash === onChainHash) {
    status = 'in-sync';
    inSync = true;
  } else {
    // Both exist but hashes differ. Use the stored config_hash in frontmatter
    // to determine directionality:
    // - config_hash matches on-chain → user edited locally after last publish → local-ahead
    // - config_hash doesn't match on-chain → remote was updated too → diverged
    // - no config_hash → never published from this file → local-ahead
    status = 'diverged';
    inSync = false;

    if (hasLocalFile) {
      try {
        const content = readFileSync(path, 'utf-8');
        const { frontmatter } = parseAgirailsMd(content);
        if (!frontmatter.config_hash) {
          // Never published — local is the only source
          status = 'local-ahead';
        } else if (frontmatter.config_hash === onChainHash) {
          // Last publish matches on-chain, so local edits are newer
          status = 'local-ahead';
        }
        // else: frontmatter.config_hash !== onChainHash → remote updated → diverged
      } catch {
        // Parse error — keep as diverged
      }
    }
  }

  return {
    inSync,
    localHash,
    onChainHash,
    onChainCID,
    hasOnChainConfig,
    hasLocalFile,
    status,
  };
}

// ============================================================================
// IPFS Fetch (public gateway, no credentials needed)
// ============================================================================

/**
 * Fetch content from IPFS using public gateways (no Filebase credentials needed).
 * Tries multiple gateways with fallback.
 *
 * @param cid - IPFS CID to fetch (validated before use)
 * @returns Raw content as string
 * @throws InvalidCIDError if CID format is invalid
 * @throws Error if all gateways fail
 */
async function fetchFromIPFS(cid: string): Promise<string> {
  // Validate CID format before hitting any gateway
  validateCID(cid, 'onChainCID');

  const errors: string[] = [];

  for (const gateway of IPFS_GATEWAYS) {
    try {
      const response = await fetch(`${gateway}${cid}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        errors.push(`${gateway}: HTTP ${response.status}`);
        continue;
      }
      return await response.text();
    } catch (err) {
      errors.push(`${gateway}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `Failed to fetch CID ${cid} from all IPFS gateways:\n${errors.map(e => `  - ${e}`).join('\n')}`
  );
}

// ============================================================================
// Pull
// ============================================================================

/**
 * Pull on-chain config to local AGIRAILS.md.
 *
 * Downloads from IPFS via public gateways (no Filebase credentials needed),
 * verifies integrity against on-chain configHash, then writes locally.
 *
 * @param options - Pull configuration
 * @returns Pull result
 */
export async function pull(options: PullOptions): Promise<PullResult> {
  const { path, agentAddress, registryAddress, provider, force = false } = options;

  // First, run diff
  const diffResult = await diff({ path, agentAddress, registryAddress, provider });

  if (!diffResult.hasOnChainConfig) {
    return {
      written: false,
      status: 'No config published on-chain for this agent.',
    };
  }

  if (diffResult.inSync) {
    return {
      written: false,
      status: 'Already in sync. No changes needed.',
    };
  }

  // Fetch raw AGIRAILS.md from IPFS (public gateway, no credentials)
  const content = await fetchFromIPFS(diffResult.onChainCID);

  // Integrity verification: hash downloaded content and compare with on-chain hash
  const { configHash: downloadedHash } = computeConfigHash(content);
  if (downloadedHash !== diffResult.onChainHash) {
    return {
      written: false,
      cid: diffResult.onChainCID,
      status: `Integrity check failed! Downloaded content hash (${downloadedHash}) does not match on-chain hash (${diffResult.onChainHash}). The IPFS content may have been tampered with.`,
    };
  }

  // Check if local file exists and we're not forcing
  if (diffResult.hasLocalFile && !force) {
    return {
      written: false,
      content,
      cid: diffResult.onChainCID,
      status: `Remote config differs from local. Use --force to overwrite. CID: ${diffResult.onChainCID}`,
    };
  }

  // Stamp on-chain metadata into frontmatter so diff heuristic can detect
  // future remote changes (without this, pulled files have no config_hash
  // and diff would always report "local-ahead" instead of "diverged")
  const { frontmatter, body } = parseAgirailsMd(content);
  const stamped = serializeAgirailsMd(
    {
      ...frontmatter,
      config_hash: diffResult.onChainHash,
      config_cid: diffResult.onChainCID,
    },
    body
  );

  // Write the stamped file
  writeFileSync(path, stamped, 'utf-8');

  return {
    written: true,
    content: stamped,
    cid: diffResult.onChainCID,
    status: `Pulled and verified config from IPFS (${diffResult.onChainCID}) → ${path}`,
  };
}
