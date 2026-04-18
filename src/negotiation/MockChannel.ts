/**
 * MockChannel — in-memory NegotiationChannel for unit tests.
 *
 * Two parties can share the same MockChannel instance (or two instances
 * connected via a shared store) and exchange messages without any
 * network. Message verification is identical to RelayChannel — same
 * EIP-712 verifiers — so security regression tests work the same way.
 *
 * Default behavior: messages POSTed are delivered synchronously to all
 * matching subscribers on the next microtask. No polling timer.
 *
 * @module negotiation/MockChannel
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

interface StoredMessage {
  cursor: string;
  txId: string;
  envelope: NegotiationMessage;
  receivedAt: number;
}

interface TxIdSubscriber {
  kind: 'txId';
  txId: string;
  callback: (delivered: DeliveredMessage) => void | Promise<void>;
  delivered: Set<string>;
  cancelled: boolean;
}

interface AgentSubscriber {
  kind: 'agent';
  agentDid: string;
  callback: (txId: string, delivered: DeliveredMessage) => void | Promise<void>;
  delivered: Set<string>;
  cancelled: boolean;
}

type Subscriber = TxIdSubscriber | AgentSubscriber;

export interface MockChannelConfig {
  /**
   * Kernel address per chainId — used by the channel's EIP-712 verify
   * step. If missing for a chainId, the message is dropped silently
   * (matches RelayChannel behavior).
   */
  kernelAddressByChainId?: Record<number, string>;
  /**
   * If true, skip signature verification (useful for tests that want
   * to inject malformed messages). Default: false.
   */
  skipVerify?: boolean;
}

/**
 * In-memory channel. Multiple orchestrators can share one instance
 * to simulate "both parties on the same relay".
 */
export class MockChannel implements NegotiationChannel {
  private readonly subscribers = new Set<Subscriber>();
  private readonly messages: StoredMessage[] = [];
  private cursorCounter = 0;
  private readonly kernelAddressByChainId: Record<number, string>;
  private readonly skipVerify: boolean;
  private readonly quoteVerifier = new QuoteBuilder();
  private readonly counterVerifier = new CounterOfferBuilder();
  private readonly counterAcceptVerifier = new CounterAcceptBuilder();

  constructor(cfg: MockChannelConfig = {}) {
    this.kernelAddressByChainId = cfg.kernelAddressByChainId ?? {};
    this.skipVerify = cfg.skipVerify ?? false;
  }

  async post(txId: string, envelope: NegotiationMessage): Promise<void> {
    const stored: StoredMessage = {
      cursor: String(++this.cursorCounter),
      txId,
      envelope,
      receivedAt: Math.floor(Date.now() / 1000),
    };
    this.messages.push(stored);
    // Schedule fan-out on the next microtask so post() always returns
    // before any subscriber callback runs — mirrors RelayChannel's
    // poll-tick boundary.
    queueMicrotask(() => this.fanout(stored));
  }

  subscribeTxId(
    txId: string,
    onMessage: (delivered: DeliveredMessage) => void | Promise<void>,
  ): Subscription {
    const sub: TxIdSubscriber = {
      kind: 'txId', txId, callback: onMessage,
      delivered: new Set(), cancelled: false,
    };
    this.subscribers.add(sub);
    // Replay any messages already in store for this txId.
    queueMicrotask(() => {
      for (const m of this.messages) {
        if (sub.cancelled) break;
        if (m.txId === txId) void this.deliverToSub(sub, m);
      }
    });
    return {
      unsubscribe: () => { sub.cancelled = true; this.subscribers.delete(sub); },
    };
  }

  subscribeAgent(
    agentDid: string,
    onMessage: (txId: string, delivered: DeliveredMessage) => void | Promise<void>,
  ): Subscription {
    const sub: AgentSubscriber = {
      kind: 'agent', agentDid, callback: onMessage,
      delivered: new Set(), cancelled: false,
    };
    this.subscribers.add(sub);
    queueMicrotask(() => {
      for (const m of this.messages) {
        if (sub.cancelled) break;
        if (this.envelopeAddressesAgent(m.envelope, agentDid)) {
          void this.deliverToSub(sub, m);
        }
      }
    });
    return {
      unsubscribe: () => { sub.cancelled = true; this.subscribers.delete(sub); },
    };
  }

  async close(): Promise<void> {
    for (const s of this.subscribers) s.cancelled = true;
    this.subscribers.clear();
  }

  // ----- test introspection helpers (NOT part of NegotiationChannel) -----

  /** All messages ever posted, in order. */
  getAllMessages(): ReadonlyArray<StoredMessage> {
    return this.messages;
  }

  /** Filter messages by txId. */
  getMessagesForTxId(txId: string): ReadonlyArray<StoredMessage> {
    return this.messages.filter((m) => m.txId === txId);
  }

  /** Number of currently-active subscriptions. Useful for leak tests. */
  activeSubscriptionCount(): number {
    return this.subscribers.size;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async fanout(stored: StoredMessage): Promise<void> {
    for (const sub of this.subscribers) {
      if (sub.cancelled) continue;
      if (sub.kind === 'txId' && sub.txId === stored.txId) {
        await this.deliverToSub(sub, stored);
      } else if (sub.kind === 'agent' && this.envelopeAddressesAgent(stored.envelope, sub.agentDid)) {
        await this.deliverToSub(sub, stored);
      }
    }
  }

  private envelopeAddressesAgent(envelope: NegotiationMessage, agentDid: string): boolean {
    const lc = agentDid.toLowerCase();
    const m = envelope.message;
    return (
      ('provider' in m && m.provider.toLowerCase() === lc) ||
      ('consumer' in m && m.consumer.toLowerCase() === lc)
    );
  }

  private async deliverToSub(sub: Subscriber, stored: StoredMessage): Promise<void> {
    // Same dedup-after-verify ordering as RelayChannel — see security
    // comment there. Without it, a tampered message with reused
    // signature would poison the dedup-set and silently drop the
    // subsequent legitimate message.
    const sig = stored.envelope.message.signature;
    if (sub.delivered.has(sig)) return;

    if (!this.skipVerify) {
      const chainId = stored.envelope.message.chainId;
      const kernelAddress = this.kernelAddressByChainId[chainId];
      if (!kernelAddress) return; // silently drop unknown chain
      try {
        if (isQuoteEnvelope(stored.envelope)) {
          await this.quoteVerifier.verify(stored.envelope.message, kernelAddress);
        } else if (isCounterOfferEnvelope(stored.envelope)) {
          await this.counterVerifier.verify(stored.envelope.message, kernelAddress);
        } else if (isCounterAcceptEnvelope(stored.envelope)) {
          await this.counterAcceptVerifier.verify(stored.envelope.message, kernelAddress);
        }
      } catch {
        return; // verify failure → drop, mirror RelayChannel
      }
    }

    // Verify passed (or was skipped) → safe to dedup.
    sub.delivered.add(sig);

    const delivered: DeliveredMessage = {
      cursor: stored.cursor,
      receivedAt: stored.receivedAt,
      envelope: stored.envelope,
    };
    try {
      if (sub.kind === 'txId') {
        await sub.callback(delivered);
      } else {
        await sub.callback(stored.txId, delivered);
      }
    } catch {
      // Swallow subscriber errors — channel must not propagate.
    }
  }
}
