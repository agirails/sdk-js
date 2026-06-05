/**
 * Buyer Link Module — gasless gate marker for pure buyers (AIP-18).
 *
 * A pure buyer (`intent: pay`) never registers on AgentRegistry and therefore
 * has no on-chain `configHash` and no `pending-publish` file (DEC-3/DEC-4).
 * Without a signal the SDK's auto-wallet gate (see ACTPClient) would fall back
 * to the EOA wallet and the buyer would have to fund ETH — contradicting
 * DEC-8 ("buyers are gasless, they need only USDC").
 *
 * When `actp publish` LINKS a pay-only agent, it writes this marker. The gate
 * treats its presence the same way it treats a pending-publish: proof of a
 * legitimate AGIRAILS agent, so the sponsored auto wallet is used. Unlike
 * pending-publish it triggers NO lazy on-chain activation — a buyer never
 * registers.
 *
 * The marker is intentionally network-agnostic (one `buyer-link.json`): an
 * agent's buyer intent does not change between testnet and mainnet, and a
 * buyer's only costly on-chain action — `pay()` — locks USDC in escrow, which
 * is itself the anti-DOS backstop (see threat-model). So granting the
 * sponsored wallet on this marker does not open a free-gas vector.
 *
 * @module config/buyerLink
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync, lstatSync } from 'fs';
import { join } from 'path';
import { getActpDir } from './pendingPublish';

// ============================================================================
// Types
// ============================================================================

/**
 * Buyer link state — saved to `.actp/buyer-link.json`.
 */
export interface BuyerLink {
  /** Schema version */
  version: 1;
  /** The agent's slug (for debuggability / dashboard linking) */
  slug: string;
  /** The signer/EOA address that performed the link */
  wallet: string;
  /** ISO 8601 timestamp of when the link was created */
  linkedAt: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Path to the buyer-link marker. Network-agnostic by design.
 */
export function getBuyerLinkPath(): string {
  return join(getActpDir(), 'buyer-link.json');
}

/**
 * Save the buyer-link marker to `.actp/buyer-link.json`.
 *
 * Mirrors pending-publish: creates `.actp/` if missing, refuses to write
 * through a symlinked directory, and writes atomically with mode 0o600.
 */
export function saveBuyerLink(link: BuyerLink): void {
  const dir = getActpDir();

  // Verify .actp/ is a real directory (symlink-attack prevention) — use
  // lstatSync so a symlinked or broken-symlink .actp is rejected, not followed.
  let dirExists = false;
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Security: ${dir} is not a real directory (symlink attack prevention)`);
    }
    dirExists = true;
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!dirExists) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const filePath = getBuyerLinkPath();
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(link, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/**
 * Load the buyer-link marker, or null if the agent is not a linked buyer.
 *
 * @param network - accepted for call-site symmetry with loadPendingPublish;
 *   the marker is network-agnostic so the argument is ignored.
 */
export function loadBuyerLink(_network?: string): BuyerLink | null {
  const filePath = getBuyerLinkPath();
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as BuyerLink;
  } catch {
    // Corrupt marker → treat as absent rather than crash client creation.
    return null;
  }
}

/** Whether a buyer-link marker exists. */
export function hasBuyerLink(network?: string): boolean {
  return loadBuyerLink(network) !== null;
}

/**
 * Delete the buyer-link marker. Best-effort — never throws.
 *
 * Called when an agent transitions away from pure-buyer (e.g. it now publishes
 * a provider config and gains a real configHash), so the marker doesn't linger.
 */
export function deleteBuyerLink(): void {
  try {
    const filePath = getBuyerLinkPath();
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}
