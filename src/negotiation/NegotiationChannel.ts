/**
 * NegotiationChannel — single transport abstraction for AIP-2.1 messages.
 *
 * Replaces the leaky `setReceivedQuote` / `setCounterAccepted` / direct
 * HTTP `QuoteChannelClient.sendCounter` patchwork from 3.4.x. All
 * negotiation message flow — buyer↔provider, both directions, all
 * message types — funnels through ONE interface so:
 *
 *   1. Verification + binding live in ONE place (closes the entire
 *      class of injection bugs the 3.4.1 audit caught: every signed
 *      message is verified at the channel boundary; orchestrators
 *      never see unverified payloads.)
 *
 *   2. Transport is pluggable. v1 ships RelayChannel (default;
 *      polls agirails.app — works for buyers without endpoints).
 *      Future: HttpChannel (peer-to-peer fast path), IpfsChannel
 *      (pubsub), OnChainEventChannel (zero-trust). Orchestrators
 *      don't care.
 *
 *   3. Test surface collapses. MockChannel in-memory = no HTTP
 *      mocks, no fake servers. One swap, full coverage.
 *
 * @module negotiation/NegotiationChannel
 * @see Protocol/aips/AIP-2.1.md §6 (Negotiation Relay Protocol)
 */

import type { QuoteMessage } from '../builders/QuoteBuilder';
import type { CounterOfferMessage } from '../builders/CounterOfferBuilder';
import type { CounterAcceptMessage } from '../builders/CounterAcceptBuilder';

// ============================================================================
// Wire types
// ============================================================================

/**
 * Discriminated union of every signed message type that can flow over
 * a NegotiationChannel. The channel's `post` accepts any of these; the
 * channel's verify-on-receive ensures only well-formed signed messages
 * reach the subscriber callback.
 */
export type NegotiationMessage =
  | { type: 'agirails.quote.v1'; message: QuoteMessage }
  | { type: 'agirails.counteroffer.v1'; message: CounterOfferMessage }
  | { type: 'agirails.counteraccept.v1'; message: CounterAcceptMessage };

/**
 * Unsubscribe handle. `unsubscribe()` MUST be idempotent; callers
 * should call it exactly once but the impl tolerates double-unsubscribe
 * to keep cleanup paths simple.
 */
export interface Subscription {
  unsubscribe(): void;
}

/**
 * Per-message metadata the channel attaches when delivering.
 *
 * `cursor` lets a subscriber persist resume-point across restarts.
 * `receivedAt` is the channel's perspective of when it learned about
 * the message (NOT the message's signed `quotedAt` / `counteredAt` —
 * those live inside `message`).
 */
export interface DeliveredMessage {
  cursor: string;
  receivedAt: number;
  envelope: NegotiationMessage;
}

// ============================================================================
// Channel interface
// ============================================================================

/**
 * Transport-agnostic AIP-2.1 message bus.
 *
 * Implementations are responsible for:
 *  - EIP-712 signature verification BEFORE invoking subscriber callback
 *  - dedup (the same signed message MUST NOT be delivered twice to the
 *    same subscription, even on poll-loop overlap)
 *  - liveness (subscribe must keep delivering until unsubscribe)
 *  - error isolation (a throw in one subscriber callback MUST NOT kill
 *    siblings on the same channel)
 *
 * Implementations are NOT responsible for:
 *  - business-logic verification (orchestrator decides accept/reject)
 *  - retry of orchestrator failures (channel delivers once, orchestrator
 *    is in charge of state)
 */
export interface NegotiationChannel {
  /**
   * Send a signed message into the channel for `txId`. The message
   * MUST be already signed; the channel does not modify it.
   *
   * @throws Error on transport failure (network, auth) — caller decides retry policy.
   */
  post(txId: string, envelope: NegotiationMessage): Promise<void>;

  /**
   * Subscribe to all messages for a specific transaction.
   * Buyer use case: knows the txId from `createTransaction`, wants
   * every quote / counter-accept that arrives for it.
   *
   * Callback is invoked once per unique message (dedup'd by message hash
   * within the subscription's lifetime). Throws inside the callback do
   * NOT cancel the subscription — the channel logs and continues.
   */
  subscribeTxId(
    txId: string,
    onMessage: (delivered: DeliveredMessage) => void | Promise<void>,
  ): Subscription;

  /**
   * Subscribe to all messages addressed to an agent DID (by virtue of
   * being listed as `provider` or `consumer` in the message body),
   * across ALL txIds.
   *
   * Provider use case: doesn't know future txIds in advance — wants
   * a firehose of incoming counter-offers for any tx where they're
   * listed as the provider.
   *
   * Implementations may filter server-side or client-side; either
   * way the subscriber sees only messages where `agentDid` matches
   * the relevant role on the inner message.
   */
  subscribeAgent(
    agentDid: string,
    onMessage: (txId: string, delivered: DeliveredMessage) => void | Promise<void>,
  ): Subscription;

  /**
   * Best-effort cleanup. Implementations should release polling timers,
   * close keep-alive connections, etc. Optional — process exit handles
   * cleanup for short-lived clients.
   */
  close?(): Promise<void>;
}

// ============================================================================
// Type guards (for impl + test convenience)
// ============================================================================

export function isQuoteEnvelope(
  e: NegotiationMessage,
): e is { type: 'agirails.quote.v1'; message: QuoteMessage } {
  return e.type === 'agirails.quote.v1';
}

export function isCounterOfferEnvelope(
  e: NegotiationMessage,
): e is { type: 'agirails.counteroffer.v1'; message: CounterOfferMessage } {
  return e.type === 'agirails.counteroffer.v1';
}

export function isCounterAcceptEnvelope(
  e: NegotiationMessage,
): e is { type: 'agirails.counteraccept.v1'; message: CounterAcceptMessage } {
  return e.type === 'agirails.counteraccept.v1';
}

/**
 * Extract the txId carried inside the envelope's signed message.
 * Useful for impls that need to dispatch by txId without parsing.
 */
export function envelopeTxId(e: NegotiationMessage): string {
  return e.message.txId;
}

/**
 * Extract the chainId carried inside the envelope's signed message.
 */
export function envelopeChainId(e: NegotiationMessage): number {
  return e.message.chainId;
}
