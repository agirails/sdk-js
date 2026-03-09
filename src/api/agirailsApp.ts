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
  process.env.AGIRAILS_APP_URL || 'https://agirails.app';

// ============================================================================
// Types
// ============================================================================

export interface CheckSlugResult {
  available: boolean;
  /** If not available, the next available slug (e.g. "code-reviewer-2") */
  suggestion?: string;
}

export interface UpsertAgentParams {
  slug: string;
  agentId: string;
  wallet: string;
  configCid: string;
  configHash: string;
  /** Wallet signature proving ownership (signs a message containing agentId) */
  signature: string;
  /** The message that was signed */
  message: string;
}

export interface UpsertAgentResult {
  success: boolean;
  profileUrl: string;
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

/** Single agent in discover results */
export interface DiscoverAgent {
  slug: string;
  wallet_address: string;
  published_config?: DiscoverAgentConfig;
  published_at?: string;
  status?: string;
}

/** API response from /api/v1/discover */
export interface DiscoverResult {
  agents: DiscoverAgent[];
  total: number;
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
