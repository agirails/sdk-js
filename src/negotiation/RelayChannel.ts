/**
 * RelayChannel — default NegotiationChannel impl, polls agirails.app.
 *
 * Both buyer and provider can use this — neither needs to host an HTTP
 * endpoint. Messages are POSTed to and pulled from agirails.app's
 * negotiation relay (see Protocol/aips/AIP-2.1.md §6).
 *
 * Verification model: relay stores messages opaquely (just bytes +
 * cursor + indexes). The receiving SDK runs full EIP-712 verify
 * BEFORE delivering to the orchestrator subscriber, so a malicious
 * relay or intercepted POST can at worst spam the subscriber's
 * deduper with junk that fails verify on the receive side.
 *
 * Polling cadence: 1500ms by default. Conservative: short enough that
 * negotiations feel snappy (< 1.5s p95 latency per round trip), long
 * enough that 100 idle subscriptions don't burn a CPU. Tunable via
 * `pollIntervalMs` for tests.
 *
 * @module negotiation/RelayChannel
 */

import { QuoteBuilder } from '../builders/QuoteBuilder';
import { CounterOfferBuilder } from '../builders/CounterOfferBuilder';
import { CounterAcceptBuilder } from '../builders/CounterAcceptBuilder';
import {
  NegotiationChannel,
  NegotiationMessage,
  Subscription,
  DeliveredMessage,
  isQuoteEnvelope,
  isCounterOfferEnvelope,
  isCounterAcceptEnvelope,
} from './NegotiationChannel';

// ============================================================================
// Config
// ============================================================================

export interface RelayChannelConfig {
  /** Base URL of the relay. Default: https://agirails.app */
  baseUrl?: string;
  /**
   * Kernel address per chainId — needed for EIP-712 verify on receive.
   * If a message arrives for a chainId not in this map, it's dropped
   * (channel logs + skips delivery).
   */
  kernelAddressByChainId: Record<number, string>;
  /** Poll interval in ms. Default: 1500. Tests use 50. */
  pollIntervalMs?: number;
  /** fetch override (Node 18+ has it built-in; injected for tests). */
  fetchImpl?: typeof fetch;
  /** Logger. Default: noop. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void;
}

const DEFAULT_BASE_URL = 'https://agirails.app';
const DEFAULT_POLL_MS = 1500;

// ============================================================================
// Implementation
// ============================================================================

interface PollState {
  cursor: string | null;
  /** Messages already delivered (by hash) — guards against poll-loop overlap. */
  delivered: Set<string>;
  /** Set when unsubscribe() is called — poll loop exits on next tick. */
  cancelled: boolean;
  /** Active timer handle for interval cleanup. */
  timer?: ReturnType<typeof setTimeout>;
}

export class RelayChannel implements NegotiationChannel {
  private readonly baseUrl: string;
  private readonly kernelAddressByChainId: Record<number, string>;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<RelayChannelConfig['log']>;
  // Verifier instances are signer-independent (verify-only) — see CounterOfferBuilder/CounterAcceptBuilder.
  private readonly quoteVerifier = new QuoteBuilder();
  private readonly counterVerifier = new CounterOfferBuilder();
  private readonly counterAcceptVerifier = new CounterAcceptBuilder();

  private readonly subscriptions = new Set<PollState>();

  constructor(cfg: RelayChannelConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.kernelAddressByChainId = cfg.kernelAddressByChainId;
    this.pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.log = cfg.log ?? (() => undefined);
  }

  async post(txId: string, envelope: NegotiationMessage): Promise<void> {
    const url = `${this.baseUrl}/api/v1/negotiations/${encodeURIComponent(txId)}/messages`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Relay POST ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  subscribeTxId(
    txId: string,
    onMessage: (delivered: DeliveredMessage) => void | Promise<void>,
  ): Subscription {
    const state: PollState = { cursor: null, delivered: new Set(), cancelled: false };
    this.subscriptions.add(state);

    const pollOnce = async (): Promise<void> => {
      if (state.cancelled) return;
      try {
        const url = new URL(`${this.baseUrl}/api/v1/negotiations/${encodeURIComponent(txId)}/messages`);
        if (state.cursor) url.searchParams.set('after', state.cursor);
        const res = await this.fetchImpl(url.toString());
        if (res.ok) {
          const body = await res.json() as { messages: Array<{ cursor: string; envelope: NegotiationMessage; receivedAt?: number }> };
          for (const item of body.messages ?? []) {
            await this.deliver(item, state, (d) => onMessage(d));
            state.cursor = item.cursor;
          }
        } else {
          this.log('warn', `Relay GET ${res.status} for tx ${txId.slice(0, 12)}…`);
        }
      } catch (err) {
        this.log('warn', `Relay poll error for tx ${txId.slice(0, 12)}…`, err);
      }
      if (!state.cancelled) {
        state.timer = setTimeout(pollOnce, this.pollIntervalMs);
        // Allow process to exit even if subscription is still armed
        // (matches Node's `unref()` convention; no-op in browsers).
        if (typeof (state.timer as unknown as { unref?: () => void }).unref === 'function') {
          (state.timer as unknown as { unref: () => void }).unref();
        }
      }
    };

    // Kick off first poll on next tick so subscribers can attach handlers
    // synchronously before the first delivery attempt.
    state.timer = setTimeout(pollOnce, 0);

    return {
      unsubscribe: () => {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
        this.subscriptions.delete(state);
      },
    };
  }

  subscribeAgent(
    agentDid: string,
    onMessage: (txId: string, delivered: DeliveredMessage) => void | Promise<void>,
  ): Subscription {
    const state: PollState = { cursor: null, delivered: new Set(), cancelled: false };
    this.subscriptions.add(state);

    const pollOnce = async (): Promise<void> => {
      if (state.cancelled) return;
      try {
        const url = new URL(`${this.baseUrl}/api/v1/negotiations/inbox/${encodeURIComponent(agentDid)}`);
        if (state.cursor) url.searchParams.set('after', state.cursor);
        const res = await this.fetchImpl(url.toString());
        if (res.ok) {
          const body = await res.json() as { messages: Array<{ cursor: string; txId: string; envelope: NegotiationMessage; receivedAt?: number }> };
          for (const item of body.messages ?? []) {
            await this.deliver(item, state, (d) => onMessage(item.txId, d));
            state.cursor = item.cursor;
          }
        } else {
          this.log('warn', `Relay agent-inbox GET ${res.status} for ${agentDid}`);
        }
      } catch (err) {
        this.log('warn', `Relay agent-inbox poll error for ${agentDid}`, err);
      }
      if (!state.cancelled) {
        state.timer = setTimeout(pollOnce, this.pollIntervalMs);
        if (typeof (state.timer as unknown as { unref?: () => void }).unref === 'function') {
          (state.timer as unknown as { unref: () => void }).unref();
        }
      }
    };

    state.timer = setTimeout(pollOnce, 0);

    return {
      unsubscribe: () => {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
        this.subscriptions.delete(state);
      },
    };
  }

  async close(): Promise<void> {
    for (const state of this.subscriptions) {
      state.cancelled = true;
      if (state.timer) clearTimeout(state.timer);
    }
    this.subscriptions.clear();
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Verify + dedup + dispatch one item. Errors in the subscriber callback
   * are caught + logged so a single bad handler doesn't kill the loop.
   */
  private async deliver(
    item: { cursor: string; envelope: NegotiationMessage; receivedAt?: number },
    state: PollState,
    invoke: (d: DeliveredMessage) => void | Promise<void>,
  ): Promise<void> {
    // Dedup by signature (every signed message has a unique sig per nonce).
    const sig = item.envelope.message.signature;
    if (state.delivered.has(sig)) return;
    state.delivered.add(sig);

    // Verify EIP-712 against the kernel address for this chainId.
    const chainId = item.envelope.message.chainId;
    const kernelAddress = this.kernelAddressByChainId[chainId];
    if (!kernelAddress) {
      this.log('warn', `Dropping message for unknown chainId ${chainId}`);
      return;
    }
    try {
      if (isQuoteEnvelope(item.envelope)) {
        await this.quoteVerifier.verify(item.envelope.message, kernelAddress);
      } else if (isCounterOfferEnvelope(item.envelope)) {
        await this.counterVerifier.verify(item.envelope.message, kernelAddress);
      } else if (isCounterAcceptEnvelope(item.envelope)) {
        await this.counterAcceptVerifier.verify(item.envelope.message, kernelAddress);
      }
    } catch (err) {
      this.log('warn', `Dropping message that failed verify`, err);
      return;
    }

    const delivered: DeliveredMessage = {
      cursor: item.cursor,
      receivedAt: item.receivedAt ?? Math.floor(Date.now() / 1000),
      envelope: item.envelope,
    };
    try {
      await invoke(delivered);
    } catch (err) {
      this.log('error', 'Subscriber callback threw', err);
    }
  }
}
