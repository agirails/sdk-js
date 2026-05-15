/**
 * resolveAgent — slug → on-chain agent identity lookup for CLI commands.
 *
 * PRD-event-driven-provider-listening §5.7 + §A.6. Backs the new
 * `actp test` onboarding flow (`runRequest` targets a known-named agent
 * rather than a user-supplied address) and is reusable for future
 * built-in references to SDK-published agents.
 *
 * ## Resolution order
 *
 * 1. **Env var override.** If the slug has a registered env var in
 *    `ENV_OVERRIDES` and the value is set, parse it as an Ethereum
 *    address. This is the rotation escape hatch: if a known agent's
 *    wallet is compromised or rotated, operators set
 *    `ACTP_SENTINEL_ADDRESS=0x...` and recover without an SDK republish.
 * 2. **Constant table.** Per-network mapping in `KNOWN_AGENTS`. Returns
 *    a checksummed address.
 * 3. **Miss.** Throws `AgentNotFoundError`.
 *
 * ## NOT in scope for this helper
 *
 * - Generic on-chain `AgentRegistry.resolveAgent` lookup. Deferred (PRD §11)
 *   because the SDK currently has no full agent-registry view and the
 *   built-in slugs (just `sentinel` today) cover Phase 0.
 * - The `agirails.app/a/<slug>` URL form used by `actp pay` / `actp request`
 *   for arbitrary user-supplied slugs. That path goes through the
 *   `discoverAgents` HTTP API; this helper is for SDK-internal known names.
 *
 * @module cli/lib/resolveAgent
 */

import { isAddress, getAddress } from 'ethers';

export type ResolvedAgentSource = 'env' | 'table';

export interface ResolvedAgent {
  /** Canonical slug used to look up the agent (e.g. `'sentinel'`). */
  slug: string;
  /** Checksummed Ethereum address. */
  address: string;
  /** Network the resolution applies to. */
  network: string;
  /** Where the address came from — useful for diagnostic logging. */
  source: ResolvedAgentSource;
}

export class AgentNotFoundError extends Error {
  constructor(public readonly slug: string, public readonly network: string) {
    super(
      `Agent '${slug}' is not registered for network '${network}'. ` +
      `Known agents on this network: ${listKnownAgents(network).join(', ') || '(none)'}.`
    );
    this.name = 'AgentNotFoundError';
  }
}

export class InvalidAgentAddressError extends Error {
  constructor(public readonly envVar: string, public readonly value: string) {
    super(
      `Env var ${envVar} contains an invalid Ethereum address: "${value}". ` +
      `Expected a 0x-prefixed 40-character hex string.`
    );
    this.name = 'InvalidAgentAddressError';
  }
}

/**
 * Built-in slug → address table. Lookups are case-insensitive on the slug.
 * Add an entry here only for SDK-shipped reference agents that callers
 * should be able to reach without external discovery (e.g. Sentinel's
 * Base Sepolia identity used by `actp test`).
 */
const KNOWN_AGENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  sentinel: Object.freeze({
    // Source of truth: Public Agents/seed-sentinel/sentinel.md (wallet field),
    // committed at agent publish time. If Sentinel rotates, set
    // ACTP_SENTINEL_ADDRESS or republish the SDK.
    'base-sepolia': '0x3813A642C57CF3c20ff1170C0646c309B4bf6d64',
  }),
});

/**
 * Slug → env var name. Lets operators override the constant table without
 * republishing the SDK. Match key casing to `KNOWN_AGENTS`.
 */
const ENV_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  sentinel: 'ACTP_SENTINEL_ADDRESS',
});

/**
 * Resolve a known agent slug on a given network.
 *
 * @throws {InvalidAgentAddressError} when an env var override is set to a
 *         non-address value.
 * @throws {AgentNotFoundError} when no override is set and no table entry
 *         exists for the (slug, network) pair.
 *
 * @example
 * ```ts
 * const sentinel = resolveAgent('sentinel', 'base-sepolia');
 * console.log(sentinel.address, sentinel.source);
 * ```
 */
export function resolveAgent(slug: string, network: string): ResolvedAgent {
  const normalizedSlug = slug.trim().toLowerCase();

  // 1. Env var override path — rotation escape hatch (PRD §A.6).
  const envVar = ENV_OVERRIDES[normalizedSlug];
  if (envVar) {
    const raw = process.env[envVar];
    if (raw !== undefined && raw !== '') {
      if (!isAddress(raw)) throw new InvalidAgentAddressError(envVar, raw);
      return { slug: normalizedSlug, address: getAddress(raw), network, source: 'env' };
    }
  }

  // 2. Constant table.
  const addr = KNOWN_AGENTS[normalizedSlug]?.[network];
  if (!addr) throw new AgentNotFoundError(normalizedSlug, network);
  return { slug: normalizedSlug, address: getAddress(addr), network, source: 'table' };
}

/**
 * List the slugs that have a constant-table entry on the given network.
 * Used by `AgentNotFoundError` for a helpful "did you mean..." hint.
 */
function listKnownAgents(network: string): string[] {
  return Object.keys(KNOWN_AGENTS).filter((slug) => KNOWN_AGENTS[slug][network] !== undefined);
}
