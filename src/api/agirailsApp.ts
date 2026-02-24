/**
 * agirails.app API Client
 *
 * Handles API calls to agirails.app for:
 * - Slug availability check (pre-chain, no auth)
 * - Agent upsert after publish (post-chain, wallet signature auth)
 * - Dashboard claim (wallet signature auth)
 *
 * STATUS: These API routes are SDK-side ready but NOT YET deployed
 * on agirails.app. The web app currently has only GET/POST /api/v1/agents
 * with session auth. The following routes need to be created:
 *   - GET  /api/v1/agents/check-slug?slug=...
 *   - POST /api/v1/agents (with wallet signature auth, not session auth)
 *   - POST /api/v1/agents/claim/challenge
 *   - POST /api/v1/agents/claim
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
