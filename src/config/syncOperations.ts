/**
 * Sync Operations - Pull + Diff for AGIRAILS.md
 *
 * Terraform-style sync: compare local AGIRAILS.md with on-chain state.
 * Never auto-overwrites — shows diff and requires explicit confirmation.
 *
 * @module config/syncOperations
 */

import { readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'fs';
import { Provider } from 'ethers';
import { computeConfigHash, parseAgirailsMd, serializeAgirailsMd } from './agirailsmd';
import { validateCID } from '../utils/validation';
import { AgentRegistryClient } from '../registry/AgentRegistryClient';

/** agirails.app base URL — serves the canonical web copy + sync headers. */
const AGIRAILS_APP_BASE_URL = process.env.AGIRAILS_APP_URL || 'https://www.agirails.app';

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

  // Write the stamped file atomically (tmp + rename)
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, stamped, 'utf-8');
  renameSync(tmpPath, path);

  return {
    written: true,
    content: stamped,
    cid: diffResult.onChainCID,
    status: `Pulled and verified config from IPFS (${diffResult.onChainCID}) → ${path}`,
  };
}

// ============================================================================
// Bidirectional reconcile (Faza B) — local ⟷ web ⟷ chain
// ============================================================================

/**
 * Current web (agirails.app) state for an agent, read from the served
 * identity file + its sync headers. configHash/updatedAt come from the
 * X-Config-Hash / X-Updated-At response headers.
 */
export interface WebState {
  configHash: string | null;
  updatedAtMs: number | null;
  content: string | null;
}

export type ReconcileAction =
  | 'in-sync'
  | 'pull-web'            // web changed, local didn't → take web
  | 'push-local'          // local changed (or local==web), chain behind → publish
  | 'conflict-web-wins'   // both changed, web is newer
  | 'conflict-local-wins'; // both changed, local is newer

export interface ReconcileDecisionInput {
  /** On-chain configHash — the "last agreed" anchor (ZERO_HASH if none). */
  anchorHash: string;
  localHash: string | null;
  localMtimeMs: number;
  webHash: string | null;
  webUpdatedAtMs: number | null;
  /** Whether we actually have the web content available to write locally. */
  webHasContent: boolean;
}

export interface ReconcileDecision {
  action: ReconcileAction;
  /** Overwrite the local file with web content. */
  pullWebToLocal: boolean;
  /** Back up the local file before overwriting (conflict, web wins). */
  snapshotLocal: boolean;
  /** Save the web content as a snapshot for reference (conflict, local wins). */
  snapshotWeb: boolean;
  /** Caller should publish the (winning) local file → chain + web afterwards. */
  needsPublish: boolean;
}

/**
 * Pure three-way reconcile decision. Compares each plane to the on-chain
 * anchor: a side "changed" when its hash differs from the anchor. Single-sided
 * changes propagate with no conflict; only a genuine double-edit conflicts, and
 * then the newest edit (by timestamp) wins while the loser is snapshotted —
 * never silently clobbered.
 *
 * Exported for unit testing.
 */
export function decideReconcile(i: ReconcileDecisionInput): ReconcileDecision {
  const webAhead = !!i.webHash && i.webHash !== i.anchorHash && i.webHasContent;
  const localAhead = !!i.localHash && i.localHash !== i.anchorHash;

  const noop: ReconcileDecision = {
    action: 'in-sync', pullWebToLocal: false, snapshotLocal: false, snapshotWeb: false, needsPublish: false,
  };

  if (!webAhead && !localAhead) return noop;

  if (webAhead && !localAhead) {
    return { action: 'pull-web', pullWebToLocal: true, snapshotLocal: false, snapshotWeb: false, needsPublish: true };
  }
  if (localAhead && !webAhead) {
    return { action: 'push-local', pullWebToLocal: false, snapshotLocal: false, snapshotWeb: false, needsPublish: true };
  }

  // Both ahead of the anchor.
  if (i.localHash === i.webHash) {
    // Same content on both sides — no conflict, just chain is behind.
    return { action: 'push-local', pullWebToLocal: false, snapshotLocal: false, snapshotWeb: false, needsPublish: true };
  }

  // Genuine conflict — newest wins, loser is snapshotted (recoverable).
  const webNewer = (i.webUpdatedAtMs ?? 0) > i.localMtimeMs;
  if (webNewer) {
    return { action: 'conflict-web-wins', pullWebToLocal: true, snapshotLocal: true, snapshotWeb: false, needsPublish: true };
  }
  return { action: 'conflict-local-wins', pullWebToLocal: false, snapshotLocal: false, snapshotWeb: true, needsPublish: true };
}

/**
 * Fetch the web copy of an agent's identity file plus its sync headers.
 * Best-effort: any failure returns an all-null state (treated as "no web").
 */
export async function fetchWebState(slug: string): Promise<WebState> {
  try {
    const res = await fetch(`${AGIRAILS_APP_BASE_URL}/a/${slug}/${slug}.md`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { configHash: null, updatedAtMs: null, content: null };
    const content = await res.text();
    const configHash = res.headers.get('X-Config-Hash');
    const updatedAt = res.headers.get('X-Updated-At');
    const parsedUpdatedAt = updatedAt ? Date.parse(updatedAt) : NaN;
    return {
      configHash: configHash || null,
      updatedAtMs: Number.isNaN(parsedUpdatedAt) ? null : parsedUpdatedAt,
      content,
    };
  } catch {
    return { configHash: null, updatedAtMs: null, content: null };
  }
}

export interface ReconcileResult {
  action: ReconcileAction;
  /** Caller should run publish to bring chain (+ web) up to the local file. */
  needsPublish: boolean;
  /** Local file was rewritten from the web copy. */
  wroteLocal: boolean;
  /** Where the losing side was backed up, if a conflict occurred. */
  snapshotPath?: string;
  localHash: string | null;
  onChainHash: string;
  webHash: string | null;
  status: string;
}

/**
 * Reconcile local ⟷ web ⟷ chain. Performs the file-level side of sync (pull
 * web → local, write conflict snapshots) and returns whether the caller should
 * publish to push the winning config on-chain. Chain writes stay in the publish
 * flow (only the keyholder can sign).
 */
export async function reconcile(options: DiffOptions & { slug: string }): Promise<ReconcileResult> {
  const { path, agentAddress, registryAddress, provider, slug } = options;

  const registryClient = AgentRegistryClient.readOnly(registryAddress, provider);
  const onChainState = await registryClient.getConfig(agentAddress);
  const anchorHash = onChainState.configHash;

  const hasLocalFile = existsSync(path);
  const localContent = hasLocalFile ? readFileSync(path, 'utf-8') : null;
  const localHash = localContent ? computeConfigHash(localContent).configHash : null;
  const localMtimeMs = hasLocalFile ? statSync(path).mtimeMs : 0;

  const web = await fetchWebState(slug);

  const decision = decideReconcile({
    anchorHash,
    localHash,
    localMtimeMs,
    webHash: web.configHash,
    webUpdatedAtMs: web.updatedAtMs,
    webHasContent: !!web.content,
  });

  let wroteLocal = false;
  let snapshotPath: string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Snapshot the local file before it is overwritten by web (conflict).
  if (decision.snapshotLocal && localContent) {
    snapshotPath = path.replace(/\.md$/, '') + `.conflict-${stamp}.md`;
    writeFileSync(snapshotPath, localContent, 'utf-8');
  }
  // Save the web copy for reference when local wins a conflict.
  if (decision.snapshotWeb && web.content) {
    snapshotPath = path.replace(/\.md$/, '') + `.web-conflict-${stamp}.md`;
    writeFileSync(snapshotPath, web.content, 'utf-8');
  }
  // Pull web → local.
  if (decision.pullWebToLocal && web.content) {
    const tmp = path + '.tmp';
    writeFileSync(tmp, web.content, 'utf-8');
    renameSync(tmp, path);
    wroteLocal = true;
  }

  const statusByAction: Record<ReconcileAction, string> = {
    'in-sync': 'Local, web, and chain are in sync.',
    'pull-web': `Web is ahead — pulled web config → ${path}. Publish to update chain.`,
    'push-local': 'Local is ahead — publish to update chain and web.',
    'conflict-web-wins': `Conflict: web is newer. Took web; backed up local → ${snapshotPath}. Publish to update chain.`,
    'conflict-local-wins': `Conflict: local is newer. Kept local; saved web copy → ${snapshotPath}. Publish to update chain and web.`,
  };

  return {
    action: decision.action,
    needsPublish: decision.needsPublish,
    wroteLocal,
    snapshotPath,
    localHash,
    onChainHash: anchorHash,
    webHash: web.configHash,
    status: statusByAction[decision.action],
  };
}
