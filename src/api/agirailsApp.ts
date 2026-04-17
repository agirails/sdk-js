/**
 * agirails.app API Client
 *
 * Handles API calls to agirails.app for:
 * - Slug availability check (pre-chain, no auth)
 * - Agent upsert after publish (post-chain, wallet signature auth)
 * - Dashboard claim (wallet signature auth)
 *
 * STATUS: All API routes are implemented on agirails.app:
 *   - GET  /api/v1/agents/check-slug?slug=... (rate-limited, slug validation)
 *   - POST /api/v1/agents (dual auth: session + wallet-sig via EIP-712)
 *   - POST /api/v1/agents/claim/challenge (Redis-backed challenge)
 *   - POST /api/v1/agents/claim (on-chain ownerOf verification)
 *   - GET  /a/{slug} (SSR profile page with OpenGraph)
 *
 * All callers handle API failures gracefully (non-blocking).
 *
 * @module api/agirailsApp
 */

// ============================================================================
// Constants
// ============================================================================

const AGIRAILS_APP_BASE_URL =
  process.env.AGIRAILS_APP_URL || 'https://www.agirails.app';

// ============================================================================
// Types
// ============================================================================

export interface CheckSlugResult {
  available: boolean;
  /** If not available, the next available slug (e.g. "code-reviewer-2") */
  suggestion?: string;
  /**
   * Public on-chain identity of the agent that already owns this slug.
   * Present only when `available === false` AND the slug has been
   * published on-chain (drafts won't carry an owner block).
   *
   * Used by the SDK publish flow to detect "I already own this slug,
   * recover my agent_id" instead of silently auto-renaming to slug-2.
   */
  owner?: {
    /** Owner's on-chain wallet (lowercase hex) — Smart Wallet if AA */
    wallet: string;
    /** AgentRegistry tokenId / on_chain_id as a string */
    agentId: string;
  };
}

export interface UpsertAgentParams {
  slug: string;
  /**
   * AgentRegistry tokenId. Optional: pay-only buyer agents do not
   * register on AgentRegistry (no NFT minted), so they have no
   * agent_id. Omit to upsert without on-chain ownership check —
   * the wallet signature alone proves the wallet controls the slug.
   */
  agentId?: string;
  /** On-chain wallet address (Smart Wallet if AA-enabled, EOA otherwise) */
  wallet: string;
  /**
   * EOA signer address when wallet is a Smart Wallet.
   * Server verifies: recoverSigner(msg, sig) == signer, then derives
   * Smart Wallet from signer to confirm signer controls wallet.
   * Omit if wallet == signer (non-AA flow).
   */
  signer?: string;
  configCid: string;
  configHash: string;
  /** Wallet signature proving ownership (signs a message containing agentId) */
  signature: string;
  /** The message that was signed */
  message: string;
  /** Unix timestamp (seconds) — part of signed message, server rejects if >5min old */
  timestamp: number;
  /** Network name (e.g. "base-sepolia") — bound in signed message, verified server-side */
  network?: string;
  /** Agent config (name, description, capabilities, pricing) for profile display */
  config?: Record<string, unknown>;
}

export interface UpsertAgentResult {
  success: boolean;
  profileUrl: string;
  claimCode?: string;
}

export interface ClaimCodeResult {
  claimCode: string;
}

export interface ClaimChallengeResult {
  challenge: string;
  expiresAt: number;
}

export interface ClaimParams {
  agentId: string;
  wallet: string;
  signature: string;
  challenge: string;
}

export interface ClaimResult {
  success: boolean;
  agentId: string;
  profileUrl: string;
}

/** Published config shape embedded in discover response */
export interface DiscoverAgentConfig {
  name?: string;
  description?: string;
  capabilities?: string[];
  pricing?: {
    amount?: number;
    currency?: string;
    unit?: string;
  };
  payment_mode?: string;
  sla?: Record<string, unknown>;
  endpoints?: Record<string, string>;
}

/** Stats embedded in discover results (when sort=reputation) */
export interface DiscoverAgentStats {
  reputation_score: number;
  completed_transactions: number;
  failed_transactions: number;
  success_rate: number;
  total_gmv_usdc: string;
  avg_completion_time_seconds: number | null;
}

/** Single agent in discover results */
export interface DiscoverAgent {
  slug: string;
  wallet_address: string;
  published_config?: DiscoverAgentConfig;
  published_at?: string;
  status?: string;
  stats?: DiscoverAgentStats;
}

/** LLM-ranked agent entry */
export interface RankedAgent {
  slug: string;
  reason: string;
  risk: string;
  confidence: 'high' | 'medium' | 'low';
}

/** LLM ranking metadata */
export interface RankingInfo {
  version: string;
  model: string;
  ranked: RankedAgent[];
}

/** API response from /api/v1/discover */
export interface DiscoverResult {
  agents: DiscoverAgent[];
  total: number;
  ranking?: RankingInfo;
}

/** Parameters for the discover endpoint */
export interface DiscoverParams {
  search?: string;
  capability?: string;
  paymentMode?: string;
  sort?: 'reputation' | 'price' | 'recent';
  limit?: number;
  offset?: number;
  maxPrice?: number;
  rank?: 'llm';
  priority?: 'quality' | 'price' | 'speed';
}

// ============================================================================
// API Client
// ============================================================================

/**
 * Check if a slug is available on agirails.app.
 *
 * Pre-chain call, no auth required. Read-only.
 *
 * @param slug - The slug to check
 * @returns Availability result with optional suggestion
 */
export async function checkSlug(slug: string): Promise<CheckSlugResult> {
  const url = `${AGIRAILS_APP_BASE_URL}/api/v1/agents/check-slug?slug=${encodeURIComponent(slug)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`check-slug API failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<CheckSlugResult>;
}

/**
 * Upsert an agent on agirails.app after successful on-chain publish.
 *
 * Post-chain call, requires wallet signature. The API verifies
 * `ownerOf(agentId) == signer` on-chain before accepting.
 *
 * @param params - Agent data + wallet signature
 * @returns Upsert result with profile URL
 */
export async function upsertAgent(params: UpsertAgentParams): Promise<UpsertAgentResult> {
  const url = `${AGIRAILS_APP_BASE_URL}/api/v1/agents`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`upsert agent API failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }

  return res.json() as Promise<UpsertAgentResult>;
}

/**
 * Request a claim challenge from the dashboard.
 *
 * @param wallet - The wallet address requesting the challenge
 * @returns Challenge string + expiration
 */
export async function getClaimChallenge(wallet: string): Promise<ClaimChallengeResult> {
  const url = `${AGIRAILS_APP_BASE_URL}/api/v1/agents/claim/challenge`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });

  if (!res.ok) {
    throw new Error(`claim challenge API failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<ClaimChallengeResult>;
}

/**
 * Claim an agent on the dashboard by proving wallet ownership.
 *
 * The API verifies `ownerOf(agentId) == signer` on-chain.
 *
 * @param params - Claim data with challenge signature
 * @returns Claim result with profile URL
 */
export async function claimAgent(params: ClaimParams): Promise<ClaimResult> {
  const url = `${AGIRAILS_APP_BASE_URL}/api/v1/agents/claim`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`claim API failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }

  return res.json() as Promise<ClaimResult>;
}

/**
 * Request a new claim code for an agent (proves ownership via wallet signature).
 *
 * @param params - Agent ID + wallet signature
 * @returns Claim code
 */
export async function requestClaimCode(params: {
  agentId: string;
  wallet: string;
  signer?: string;
  signature: string;
  message: string;
  network?: string;
  /** Agent config (name, description, capabilities, pricing) for profile display */
  config?: Record<string, unknown>;
}): Promise<ClaimCodeResult> {
  const url = `${AGIRAILS_APP_BASE_URL}/api/v1/agents/claim-code`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`claim-code API failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }

  return res.json() as Promise<ClaimCodeResult>;
}

/**
 * Discover published agents on agirails.app.
 *
 * Public read-only endpoint, no auth required. Supports filtering
 * by capability, payment mode, search text, and sorting.
 *
 * @param params - Discovery filter parameters
 * @returns Paginated list of agents with total count
 */
export async function discoverAgents(params: DiscoverParams = {}): Promise<DiscoverResult> {
  const qs = new URLSearchParams();
  if (params.search)          qs.set('search',      params.search);
  if (params.capability)      qs.set('capability',  params.capability);
  if (params.paymentMode)     qs.set('paymentMode', params.paymentMode);
  if (params.sort)            qs.set('sort',        params.sort);
  if (params.limit != null)   qs.set('limit',       String(params.limit));
  if (params.offset != null)  qs.set('offset',      String(params.offset));
  if (params.maxPrice != null) qs.set('maxPrice',   String(params.maxPrice));
  if (params.rank)            qs.set('rank',        params.rank);
  if (params.priority)        qs.set('priority',    params.priority);

  const queryString = qs.toString();
  const url = `${AGIRAILS_APP_BASE_URL}/api/v1/discover${queryString ? `?${queryString}` : ''}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`discover API failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<DiscoverResult>;
}
