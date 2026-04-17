/**
 * QuoteChannel — HTTPS transport for AIP-2.1 quote + counter-offer messages.
 *
 * Split into three responsibilities so the SDK is framework-agnostic:
 *
 *  1. `QuoteChannelClient`  — sends a signed message to a peer's endpoint.
 *     Used by buyers (posting counter-offers to the provider) and by
 *     providers (posting quotes to the buyer). Plain fetch + timeout.
 *
 *  2. `QuoteChannelHandler` — framework-agnostic receive-side handler.
 *     Callers wire it into whatever HTTP framework they use (Express,
 *     Next.js route handler, Fastify, etc). Enforces the security model
 *     from AIP-2.1-DRAFT §8:
 *        - URL path binding: `/quote-channel/{chainId}/{txId}` must
 *          match message.chainId / message.txId (closes T2 + T5).
 *        - EIP-712 signature verification (closes "anyone can POST").
 *        - TTL + grace window (closes T3).
 *        - Nonce LRU dedup (closes T1, idempotent replay).
 *     Rate limiting is intentionally out of scope — framework-level
 *     concern (Next.js middleware, Express rate-limit, nginx, etc).
 *
 *  3. `DedupStore` — swappable backing for the nonce LRU. In-memory
 *     default for single-process use; callers can plug Redis etc. for
 *     multi-worker production.
 *
 * @module transport/QuoteChannel
 * @see Protocol/aips/AIP-2.1-DRAFT.md §8 (threat model + mitigations)
 */

import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import { CounterOfferBuilder, CounterOfferMessage } from '../builders/CounterOfferBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import { Wallet } from 'ethers';

// ============================================================================
// Constants (exported for tests + callers that want to align)
// ============================================================================

/** Path pattern builders use / handlers expect. */
export function buildChannelPath(chainId: number, txId: string): string {
  return `/quote-channel/${chainId}/${txId}`;
}

export const TTL_GRACE_SECONDS = 30;
export const DEDUP_TTL_SECONDS = 90_000; // 25h (covers max quote TTL + grace)

// ============================================================================
// Transport payload wrapper
// ============================================================================

/**
 * Wire payload posted by the client and parsed by the handler.
 * Discriminated by `type` so the same endpoint serves both directions.
 */
export type ChannelPayload =
  | { type: 'agirails.quote.v1'; message: QuoteMessage }
  | { type: 'agirails.counteroffer.v1'; message: CounterOfferMessage };

// ============================================================================
// Dedup store
// ============================================================================

export interface DedupStore {
  /** Return 'duplicate' if key was seen within TTL; 'fresh' otherwise. */
  check(key: string): Promise<'fresh' | 'duplicate'>;
  /** Record a fresh key with TTL (ms). Idempotent. */
  record(key: string, ttlMs: number): Promise<void>;
}

/**
 * Single-process in-memory LRU. Callers replace this in production
 * with Redis or whatever distributed store they prefer.
 */
export class InMemoryDedupStore implements DedupStore {
  private readonly entries: Map<string, number> = new Map(); // key → expires_at_ms
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  async check(key: string): Promise<'fresh' | 'duplicate'> {
    this.evict();
    const exp = this.entries.get(key);
    if (!exp) return 'fresh';
    if (exp <= Date.now()) {
      this.entries.delete(key);
      return 'fresh';
    }
    return 'duplicate';
  }

  async record(key: string, ttlMs: number): Promise<void> {
    this.evict();
    this.entries.set(key, Date.now() + ttlMs);
  }

  /** Remove expired + bound the map size. */
  private evict(): void {
    const now = Date.now();
    for (const [k, exp] of this.entries) {
      if (exp <= now) this.entries.delete(k);
    }
    // Bound on size (approximate LRU by insertion order — Map preserves it).
    while (this.entries.size > this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey === undefined) break;
      this.entries.delete(firstKey);
    }
  }
}

// ============================================================================
// Client
// ============================================================================

export interface QuoteChannelClientConfig {
  /** Per-request timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Override fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class QuoteChannelClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: QuoteChannelClientConfig = {}) {
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** POST a provider quote to the buyer's endpoint. */
  async sendQuote(peerEndpoint: string, quote: QuoteMessage): Promise<void> {
    await this.post(peerEndpoint, quote.chainId, quote.txId, {
      type: 'agirails.quote.v1',
      message: quote,
    });
  }

  /** POST a buyer counter-offer to the provider's endpoint. */
  async sendCounter(peerEndpoint: string, counter: CounterOfferMessage): Promise<void> {
    await this.post(peerEndpoint, counter.chainId, counter.txId, {
      type: 'agirails.counteroffer.v1',
      message: counter,
    });
  }

  private async post(
    peerEndpoint: string,
    chainId: number,
    txId: string,
    payload: ChannelPayload,
  ): Promise<void> {
    const url = `${stripTrailingSlash(peerEndpoint)}${buildChannelPath(chainId, txId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `Quote channel POST failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================================
// Handler (receive side)
// ============================================================================

export interface QuoteChannelHandlerConfig {
  /** Kernel address per chainId — used for EIP-712 domain when verifying. */
  kernelAddressByChainId: Record<number, string>;
  /** Dedup store. Defaults to in-memory (single process). */
  dedupStore?: DedupStore;
  /** TTL grace window in seconds for `expiresAt` check. Defaults to 30s. */
  ttlGraceSeconds?: number;
}

export interface HandlerContext {
  /** Chain ID parsed from the URL path. */
  pathChainId: number;
  /** txId parsed from the URL path (0x-prefixed 64-hex). */
  pathTxId: string;
}

export type HandlerResult =
  | { status: 201; body: { accepted: true; duplicate: false } }
  | { status: 200; body: { accepted: true; duplicate: true } } // idempotent replay
  | { status: 400; body: { accepted: false; reason: string } }
  | { status: 401; body: { accepted: false; reason: string } } // signature failure
  | { status: 410; body: { accepted: false; reason: string } } // expired
  | { status: 422; body: { accepted: false; reason: string } }; // schema / band violation

export class QuoteChannelHandler {
  private readonly kernelAddressByChainId: Record<number, string>;
  private readonly dedupStore: DedupStore;
  private readonly ttlGraceSeconds: number;
  // Builders are used only for their verify() + nonce-key helpers; the
  // signer / nonceManager args are irrelevant on the verify path, so we
  // hand them throwaway instances.
  private readonly quoteVerifier: QuoteBuilder;
  private readonly counterVerifier: CounterOfferBuilder;

  constructor(cfg: QuoteChannelHandlerConfig) {
    this.kernelAddressByChainId = cfg.kernelAddressByChainId;
    this.dedupStore = cfg.dedupStore ?? new InMemoryDedupStore();
    this.ttlGraceSeconds = cfg.ttlGraceSeconds ?? TTL_GRACE_SECONDS;

    const throwawayWallet = Wallet.createRandom();
    const throwawayNonces = new InMemoryNonceManager();
    this.quoteVerifier = new QuoteBuilder(throwawayWallet, throwawayNonces);
    this.counterVerifier = new CounterOfferBuilder(throwawayWallet, throwawayNonces);
  }

  /**
   * Validate + dedup an incoming POST.
   * Caller is responsible for: parsing URL path into `pathChainId` /
   * `pathTxId`, parsing request body into `ChannelPayload`, and rate
   * limiting the endpoint at the framework level.
   */
  async handle(payload: unknown, ctx: HandlerContext): Promise<HandlerResult> {
    // 1. Shape check on the payload wrapper.
    if (!isChannelPayload(payload)) {
      return {
        status: 400,
        body: { accepted: false, reason: 'Invalid payload shape' },
      };
    }

    // 2. Path binding — the URL path chainId/txId MUST match the inner message.
    if (payload.message.chainId !== ctx.pathChainId) {
      return {
        status: 400,
        body: { accepted: false, reason: 'chainId mismatch between URL and message' },
      };
    }
    if (payload.message.txId.toLowerCase() !== ctx.pathTxId.toLowerCase()) {
      return {
        status: 400,
        body: { accepted: false, reason: 'txId mismatch between URL and message' },
      };
    }

    // 3. Kernel address must be configured for this chain.
    const kernelAddress = this.kernelAddressByChainId[payload.message.chainId];
    if (!kernelAddress) {
      return {
        status: 400,
        body: { accepted: false, reason: `Unsupported chainId: ${payload.message.chainId}` },
      };
    }

    // 4. TTL + grace. Check expiry BEFORE signature to fast-reject stale traffic
    // cheaply; signature verification is the expensive step.
    const now = Math.floor(Date.now() / 1000);
    if (payload.message.expiresAt + this.ttlGraceSeconds < now) {
      return {
        status: 410,
        body: { accepted: false, reason: 'Message expired' },
      };
    }

    // 5. Signature verification + business rules (delegated to the builder).
    try {
      if (payload.type === 'agirails.quote.v1') {
        await this.quoteVerifier.verify(payload.message, kernelAddress);
      } else {
        await this.counterVerifier.verify(payload.message, kernelAddress);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Signature failures vs schema/band failures are both client errors;
      // distinguish with 401 (auth) vs 422 (validation) for better diagnostics.
      const isAuth = /signature|Invalid signature|recovered/i.test(reason);
      return {
        status: isAuth ? 401 : 422,
        body: { accepted: false, reason },
      };
    }

    // 6. Dedup via nonce LRU. Key is (type, signerDID, nonce) — uniquely
    // identifies a signed message within its issuing agent's nonce space.
    const signerDID = payload.type === 'agirails.quote.v1'
      ? payload.message.provider
      : payload.message.consumer;
    const dedupKey = `${payload.type}:${signerDID}:${payload.message.nonce}`;

    const check = await this.dedupStore.check(dedupKey);
    if (check === 'duplicate') {
      return { status: 200, body: { accepted: true, duplicate: true } };
    }
    await this.dedupStore.record(dedupKey, DEDUP_TTL_SECONDS * 1000);

    return { status: 201, body: { accepted: true, duplicate: false } };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function isChannelPayload(x: unknown): x is ChannelPayload {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  if (p.type !== 'agirails.quote.v1' && p.type !== 'agirails.counteroffer.v1') return false;
  if (!p.message || typeof p.message !== 'object') return false;
  const msg = p.message as Record<string, unknown>;
  if (typeof msg.chainId !== 'number') return false;
  if (typeof msg.txId !== 'string') return false;
  if (typeof msg.nonce !== 'number') return false;
  if (typeof msg.expiresAt !== 'number') return false;
  if (typeof msg.signature !== 'string') return false;
  return true;
}
