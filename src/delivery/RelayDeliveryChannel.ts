/**
 * AIP-16 Delivery Surface — RelayDeliveryChannel (Phase 2b)
 * ===========================================================
 *
 * HTTP-backed {@link DeliveryChannel} implementation that talks to the
 * AGIRAILS relay (or any compatible relay implementing the same REST
 * surface) for posting and observing delivery setup + envelope wire
 * objects.
 *
 * Mirrors the design of `src/negotiation/RelayChannel.ts`:
 *
 *  - POST / GET endpoints follow the same `/api/v1/delivery/...` shape
 *    as the negotiation relay's `/api/v1/negotiations/...` endpoints.
 *  - Subscriptions poll on a fixed interval (1000ms by default — slightly
 *    faster than negotiation since delivery is the final-mile step the
 *    requester is actively waiting on).
 *  - Cursor pagination on GETs so a polling subscriber only sees new
 *    items per tick.
 *  - SSRF guard on `baseUrl` so a misconfigured agent cannot be steered
 *    at cloud-metadata services, RFC1918 hosts, or loopback addresses
 *    in production. `allowPrivateHosts: true` bypasses for dev / tests.
 *  - 8-second timeout on every POST + GET via AbortController so a
 *    hung relay cannot wedge the SDK indefinitely.
 *  - Dedup-after-verify on read: each item is verified BEFORE its
 *    identifier is added to the dedup set. An attacker who posts a
 *    valid-looking-but-malformed wire to the relay cannot poison the
 *    dedup set and suppress later legitimate items.
 *  - Subscriber errors are caught + logged so one bad subscriber cannot
 *    halt the polling loop.
 *
 * @module delivery/RelayDeliveryChannel
 * @see {@link DeliveryChannel}
 * @see ../negotiation/RelayChannel — reference pattern this mirrors.
 */

import { assertSafePeerUrl } from '../transport/QuoteChannel';

import type {
  DeliveryChannel,
  DeliverySubscription,
  SetupCallback,
  EnvelopeCallback,
} from './channel';
import { type LogFn, noopLog } from './channelLog';
import { DeliveryEnvelopeBuilder } from './envelopeBuilder';
import { DeliverySetupBuilder } from './setupBuilder';
import type {
  DeliverySetupWireV1,
  DeliveryEnvelopeWireV1,
} from './types';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default polling cadence for `subscribeSetups` / `subscribeEnvelopes`,
 * in milliseconds. 1000ms balances snappy delivery (p95 latency below 1s
 * per round trip) against poll-amplification cost when many parallel
 * subscriptions are armed.
 */
export const POLL_INTERVAL_MS = 1000;

/**
 * Default request timeout for POSTs and GETs to the relay, in milliseconds.
 * 8000ms is short enough that a hung relay surfaces quickly but long
 * enough that genuinely slow networks (mobile, satellite) don't
 * spurious-abort under normal load.
 */
export const REQUEST_TIMEOUT_MS = 8000;

/** Default base URL — production AGIRAILS relay. */
const DEFAULT_BASE_URL = 'https://agirails.app';

// ============================================================================
// Public options
// ============================================================================

/**
 * Construction options for {@link RelayDeliveryChannel}.
 *
 * `baseUrl` defaults to the production AGIRAILS relay. All other fields
 * are pure tuning / observability knobs.
 */
export interface RelayDeliveryChannelOptions {
  /**
   * Base URL of the relay. Defaults to `https://agirails.app`.
   * Trailing slash is stripped; the channel will append the
   * `/api/v1/delivery/...` path as needed.
   */
  baseUrl?: string;

  /**
   * Polling interval for subscribers, in milliseconds. Defaults to
   * {@link POLL_INTERVAL_MS} (1000). Tests typically pass a much
   * smaller value (e.g. 25ms) so they can verify polling behavior
   * without blowing through Jest's default timeouts.
   */
  pollIntervalMs?: number;

  /**
   * Request timeout for POSTs and GETs, in milliseconds. Defaults to
   * {@link REQUEST_TIMEOUT_MS} (8000). Implemented via
   * `AbortController` so the underlying `fetch` can be cancelled.
   */
  requestTimeoutMs?: number;

  /**
   * `fetch` implementation. Defaults to the global `fetch` (Node 18+
   * has it built in). Tests inject a mock here to assert on the
   * request shape and to short-circuit network IO.
   */
  fetchImpl?: typeof fetch;

  /**
   * Pluggable logger. Defaults to {@link noopLog} (silent).
   *
   * Logged events:
   *  - `warn`: poll loop error, item dropped after verify failure,
   *    subscriber callback threw and was swallowed.
   *  - `error`: POST returned non-2xx (also propagated as a rejected
   *    Promise to the caller).
   */
  log?: LogFn;

  /**
   * If `true`, allow the SSRF guard to accept loopback / RFC1918 /
   * link-local hosts. ONLY for local development and test setups
   * against a Vitest / Jest in-process server. Defaults to `false`.
   */
  allowPrivateHosts?: boolean;

  /**
   * Allowlisted kernel address for verification. When set, verification
   * enforces this value (production posture). When unset, falls back
   * to the wire's self-asserted `signed.kernelAddress`.
   */
  expectedKernelAddress?: string;

  /**
   * Allowlisted chainId for verification. Same fallback semantics as
   * {@link expectedKernelAddress}.
   */
  expectedChainId?: number;

  /**
   * Injectable wall clock returning Unix seconds. Passed to the
   * underlying `verify()` calls so timestamp skew / expiry checks are
   * deterministic in tests.
   */
  now?: () => number;
}

// ============================================================================
// Internal types
// ============================================================================

/**
 * Wire shape of a single relay-returned setup item, including the
 * server-side cursor used for pagination.
 */
interface RelaySetupItem {
  cursor: string;
  wire: DeliverySetupWireV1;
}

/**
 * Wire shape of a single relay-returned envelope item.
 */
interface RelayEnvelopeItem {
  cursor: string;
  wire: DeliveryEnvelopeWireV1;
}

/** Internal subscription state for the polling loop. */
interface PollState {
  cursor: string | null;
  /** Dedup set keyed by computed wire hash. */
  delivered: Set<string>;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

// ============================================================================
// RelayDeliveryChannel
// ============================================================================

/**
 * HTTP relay-backed delivery channel. Production transport for AIP-16
 * setups + envelopes.
 *
 * @example
 * ```typescript
 * const channel = new RelayDeliveryChannel({
 *   baseUrl: 'https://agirails.app',
 * });
 * await channel.publishSetup(setupWire);
 * const sub = await channel.subscribeEnvelopes(txId, async (env) => {
 *   await processEnvelope(env);
 * });
 * // …later
 * await sub.close();
 * await channel.close();
 * ```
 */
export class RelayDeliveryChannel implements DeliveryChannel {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: LogFn;
  private readonly expectedKernelAddress?: string;
  private readonly expectedChainId?: number;
  private readonly nowFn?: () => number;

  private readonly pollStates = new Set<PollState>();
  private closed = false;

  constructor(opts: RelayDeliveryChannelOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    assertSafePeerUrl(this.baseUrl, opts.allowPrivateHosts ?? false);
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? noopLog;
    this.expectedKernelAddress = opts.expectedKernelAddress;
    this.expectedChainId = opts.expectedChainId;
    this.nowFn = opts.now;
  }

  // --------------------------------------------------------------------------
  // publish
  // --------------------------------------------------------------------------

  async publishSetup(setup: DeliverySetupWireV1): Promise<void> {
    if (this.closed) {
      throw new Error('RelayDeliveryChannel: channel is closed');
    }
    const url = `${this.baseUrl}/api/v1/delivery/setup`;
    await this.postJson(url, setup);
  }

  async publishEnvelope(envelope: DeliveryEnvelopeWireV1): Promise<void> {
    if (this.closed) {
      throw new Error('RelayDeliveryChannel: channel is closed');
    }
    const url = `${this.baseUrl}/api/v1/delivery`;
    await this.postJson(url, envelope);
  }

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------

  async getSetups(
    txId: `0x${string}`,
    after?: string,
  ): Promise<DeliverySetupWireV1[]> {
    const url = new URL(
      `${this.baseUrl}/api/v1/delivery/setup/${encodeURIComponent(txId)}`,
    );
    if (after) {
      url.searchParams.set('after', after);
    }
    const items = await this.getJson<{ items: RelaySetupItem[] }>(url.toString());
    return (items.items ?? []).map((item) => item.wire);
  }

  async getEnvelopes(
    txId: `0x${string}`,
    after?: string,
  ): Promise<DeliveryEnvelopeWireV1[]> {
    const url = new URL(
      `${this.baseUrl}/api/v1/delivery/${encodeURIComponent(txId)}`,
    );
    if (after) {
      url.searchParams.set('after', after);
    }
    const items = await this.getJson<{ items: RelayEnvelopeItem[] }>(url.toString());
    return (items.items ?? []).map((item) => item.wire);
  }

  // --------------------------------------------------------------------------
  // subscribe
  // --------------------------------------------------------------------------

  async subscribeSetups(
    txId: `0x${string}`,
    callback: SetupCallback,
  ): Promise<DeliverySubscription> {
    if (this.closed) {
      throw new Error('RelayDeliveryChannel: channel is closed');
    }
    const state: PollState = {
      cursor: null,
      delivered: new Set(),
      cancelled: false,
    };
    this.pollStates.add(state);

    const pollOnce = async (): Promise<void> => {
      if (state.cancelled) return;
      try {
        const url = new URL(
          `${this.baseUrl}/api/v1/delivery/setup/${encodeURIComponent(txId)}`,
        );
        if (state.cursor) {
          url.searchParams.set('after', state.cursor);
        }
        const body = await this.getJson<{ items: RelaySetupItem[] }>(url.toString());
        for (const item of body.items ?? []) {
          if (state.cancelled) break;
          await this.deliverSetup(item, state, callback);
          state.cursor = item.cursor;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('warn', 'RelayDeliveryChannel: setup poll error', {
          txId,
          error: msg,
        });
      }
      if (!state.cancelled) {
        state.timer = setTimeout(pollOnce, this.pollIntervalMs);
        // Allow process to exit even if subscription is still armed.
        const t = state.timer as unknown as { unref?: () => void };
        if (typeof t.unref === 'function') t.unref();
      }
    };

    state.timer = setTimeout(pollOnce, 0);
    const t = state.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();

    return {
      close: () => {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
        this.pollStates.delete(state);
      },
    };
  }

  async subscribeEnvelopes(
    txId: `0x${string}`,
    callback: EnvelopeCallback,
  ): Promise<DeliverySubscription> {
    if (this.closed) {
      throw new Error('RelayDeliveryChannel: channel is closed');
    }
    const state: PollState = {
      cursor: null,
      delivered: new Set(),
      cancelled: false,
    };
    this.pollStates.add(state);

    const pollOnce = async (): Promise<void> => {
      if (state.cancelled) return;
      try {
        const url = new URL(
          `${this.baseUrl}/api/v1/delivery/${encodeURIComponent(txId)}`,
        );
        if (state.cursor) {
          url.searchParams.set('after', state.cursor);
        }
        const body = await this.getJson<{ items: RelayEnvelopeItem[] }>(url.toString());
        for (const item of body.items ?? []) {
          if (state.cancelled) break;
          await this.deliverEnvelope(item, state, callback);
          state.cursor = item.cursor;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log('warn', 'RelayDeliveryChannel: envelope poll error', {
          txId,
          error: msg,
        });
      }
      if (!state.cancelled) {
        state.timer = setTimeout(pollOnce, this.pollIntervalMs);
        const t = state.timer as unknown as { unref?: () => void };
        if (typeof t.unref === 'function') t.unref();
      }
    };

    state.timer = setTimeout(pollOnce, 0);
    const t = state.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();

    return {
      close: () => {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
        this.pollStates.delete(state);
      },
    };
  }

  // --------------------------------------------------------------------------
  // close
  // --------------------------------------------------------------------------

  async close(): Promise<void> {
    this.closed = true;
    for (const state of this.pollStates) {
      state.cancelled = true;
      if (state.timer) clearTimeout(state.timer);
    }
    this.pollStates.clear();
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Deliver a single setup item — verify, dedup-after-verify, isolate
   * subscriber errors.
   */
  private async deliverSetup(
    item: RelaySetupItem,
    state: PollState,
    callback: SetupCallback,
  ): Promise<void> {
    // Verify FIRST — dedup AFTER verify so a malformed sig cannot
    // poison the dedup set.
    const verifyResult = DeliverySetupBuilder.verify(item.wire, {
      expectedKernelAddress:
        this.expectedKernelAddress ?? item.wire.signed.kernelAddress,
      expectedChainId: this.expectedChainId ?? item.wire.signed.chainId,
      now: this.nowFn?.(),
    });
    if (!verifyResult.ok) {
      this.log('warn', 'RelayDeliveryChannel: dropping unverified setup', {
        code: verifyResult.code,
        error: verifyResult.error,
        txId: item.wire.signed.txId,
      });
      return;
    }

    const hash = DeliverySetupBuilder.computeHash(item.wire);
    if (state.delivered.has(hash)) return;
    state.delivered.add(hash);

    try {
      await callback(item.wire);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('warn', 'RelayDeliveryChannel: setup subscriber threw', {
        error: msg,
        txId: item.wire.signed.txId,
      });
    }
  }

  /**
   * Deliver a single envelope item — verify, dedup-after-verify, isolate
   * subscriber errors.
   */
  private async deliverEnvelope(
    item: RelayEnvelopeItem,
    state: PollState,
    callback: EnvelopeCallback,
  ): Promise<void> {
    const verifyResult = DeliveryEnvelopeBuilder.verify(item.wire, {
      expectedKernelAddress:
        this.expectedKernelAddress ?? item.wire.signed.kernelAddress,
      expectedChainId: this.expectedChainId ?? item.wire.signed.chainId,
      now: this.nowFn?.(),
    });
    if (!verifyResult.ok) {
      this.log('warn', 'RelayDeliveryChannel: dropping unverified envelope', {
        code: verifyResult.code,
        error: verifyResult.error,
        txId: item.wire.signed.txId,
      });
      return;
    }

    const hash = DeliveryEnvelopeBuilder.computeHash(item.wire);
    if (state.delivered.has(hash)) return;
    state.delivered.add(hash);

    try {
      await callback(item.wire);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('warn', 'RelayDeliveryChannel: envelope subscriber threw', {
        error: msg,
        txId: item.wire.signed.txId,
      });
    }
  }

  /**
   * Issue a POST with JSON body and an AbortController-driven timeout.
   * Resolves on 2xx, rejects on non-2xx with the response body as the
   * error message.
   */
  private async postJson(url: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log('warn', 'RelayDeliveryChannel: POST non-2xx', {
          url,
          status: res.status,
          body: text.slice(0, 256),
        });
        throw new Error(
          `RelayDeliveryChannel POST ${res.status}: ${text.slice(0, 200)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Issue a GET and decode JSON, with an AbortController-driven timeout.
   */
  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `RelayDeliveryChannel GET ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
