/**
 * AIP-16 Delivery Surface — Channel Abstraction (Phase 2b)
 * =========================================================
 *
 * Transport-agnostic interface for posting and observing delivery
 * setup + envelope wire objects between requester and provider.
 *
 * The delivery channel is the wire-level boundary between the two
 * participants of an AIP-16 delivery exchange. It does NOT participate
 * in any cryptographic verification — its only job is to transport
 * already-signed {@link DeliverySetupWireV1} and {@link DeliveryEnvelopeWireV1}
 * objects between participants.
 *
 * ## Concrete implementations
 *
 *  - **MockDeliveryChannel** — in-process loopback used by tests and
 *    MockRuntime flows. Implements dedup-after-verify on the read side
 *    (see {@link MockChannel} in `src/negotiation/` for the reference
 *    pattern). Useful for end-to-end tests without network setup.
 *  - **RelayDeliveryChannel** — HTTP client against the AGIRAILS relay
 *    (or any compatible relay implementing the same REST surface). Uses
 *    cursor pagination, polling at `POLL_INTERVAL_MS = 1000`, and an
 *    SSRF guard on the relay URL (see {@link RelayChannel} in
 *    `src/negotiation/` for the reference pattern).
 *
 * ## Security invariants (binding on ALL implementations)
 *
 * 1. **Dedup AFTER verify.** Implementations that deduplicate
 *    incoming setups/envelopes MUST verify signatures BEFORE adding any
 *    identifier (txId, sig hash, etc.) to a dedup set. Otherwise an
 *    attacker can post malformed signatures to permanently suppress
 *    the legitimate signed object that arrives later.
 *
 * 2. **Subscriber error isolation.** Subscriber callbacks may throw
 *    arbitrary errors (consumer code is not the channel's problem).
 *    Implementations MUST catch and silently swallow callback errors —
 *    NEVER propagate them into the channel's read loop, since one bad
 *    subscriber would otherwise halt delivery for all other subscribers
 *    sharing the same channel.
 *
 * 3. **No verification at the channel layer.** Channels do NOT call
 *    `recoverSetupSigner` / `recoverEnvelopeSigner` or any other
 *    cryptographic check. Verification is the consumer's responsibility
 *    (typically via {@link DeliverySetupBuilder.verify} /
 *    {@link DeliveryEnvelopeBuilder.verify}). The channel is a dumb pipe.
 *
 * 4. **Address comparison case-insensitivity.** Where addresses appear
 *    in dedup keys (e.g. `signerAddress`), implementations MUST normalize
 *    to lowercase on both sides of any comparison.
 *
 * ## Subscription semantics
 *
 *  - `subscribeSetups` / `subscribeEnvelopes` are scoped to a single
 *    `txId`. A subscription begins emitting from "now" — that is, from
 *    objects that are NOT already known to the channel at subscribe time
 *    are guaranteed to be delivered; objects that ARE already known MAY
 *    or MAY NOT be re-delivered depending on the implementation. Code
 *    that needs the full historical set should call the optional
 *    `getSetups` / `getEnvelopes` methods.
 *
 *  - Returning a {@link DeliverySubscription} whose `close()` is invoked
 *    MUST stop further callbacks from firing on that subscription. It
 *    SHOULD also free any underlying transport (polling timer, HTTP
 *    connection, etc.).
 *
 *  - Multiple subscribers on the same `txId` MUST each receive all
 *    matching objects (fan-out, not steal). One subscriber's `close()`
 *    MUST NOT affect other subscribers.
 *
 * @module delivery/channel
 * @see {@link DeliverySetupWireV1}
 * @see {@link DeliveryEnvelopeWireV1}
 */

import type {
  DeliverySetupWireV1,
  DeliveryEnvelopeWireV1,
} from './types';

// ============================================================================
// Subscription handle
// ============================================================================

/**
 * Handle returned from a `subscribe*` call. Calling `close()` cancels
 * the subscription — the corresponding callback will not fire again.
 *
 * `close()` is idempotent: calling it multiple times is safe and a no-op
 * after the first call. It MAY return a Promise (e.g. when the
 * implementation needs to await an in-flight HTTP request); callers
 * SHOULD `await` it when they need to confirm teardown completed
 * before, e.g., asserting that no further callbacks fire.
 *
 * @example
 * ```typescript
 * const sub = await channel.subscribeEnvelopes(txId, async (env) => {
 *   await processEnvelope(env);
 * });
 * // …later
 * await sub.close();
 * ```
 */
export interface DeliverySubscription {
  /**
   * Cancel this subscription. Idempotent. MAY return a Promise that
   * resolves once the underlying transport (polling timer, HTTP
   * connection) has been torn down.
   */
  close(): void | Promise<void>;
}

// ============================================================================
// Callback shapes
// ============================================================================

/**
 * Callback fired for each verified-then-deduped setup observed on the
 * channel for the subscribed `txId`.
 *
 * NOTE: "verified-then-deduped" is the dedup-after-verify ordering
 * invariant — implementations call this callback only for setups whose
 * signature has been verified (and which have not already been delivered
 * to this subscriber).
 *
 * The callback MAY be async. Errors thrown from the callback (sync or
 * async) MUST be caught and swallowed by the channel implementation —
 * see security invariant #2 in the module-level JSDoc.
 */
export type SetupCallback = (setup: DeliverySetupWireV1) => void | Promise<void>;

/**
 * Callback fired for each verified-then-deduped envelope observed on
 * the channel for the subscribed `txId`.
 *
 * Same semantics as {@link SetupCallback}: dedup-after-verify ordering,
 * may be async, errors are isolated by the channel.
 */
export type EnvelopeCallback = (envelope: DeliveryEnvelopeWireV1) => void | Promise<void>;

// ============================================================================
// Channel interface
// ============================================================================

/**
 * Transport-agnostic delivery channel.
 *
 * Implementations are responsible for transporting already-signed
 * setup and envelope wire objects between requester and provider. The
 * channel does NOT verify signatures, hashes, or schemes; that is the
 * caller's responsibility (see the builder `verify()` methods).
 *
 * ## Contract summary
 *
 *  - `publishSetup` / `publishEnvelope` post a wire object to the
 *    channel. Implementations MAY perform best-effort validation (e.g.
 *    rejecting obviously malformed `txId` strings) but MUST NOT make
 *    cryptographic verification a precondition of publish — the channel
 *    is dumb on the write side, just as it is on the read side.
 *
 *  - `subscribeSetups` / `subscribeEnvelopes` register a callback that
 *    fires for each verified-then-deduped object observed on the
 *    channel for the given `txId`. Returns a {@link DeliverySubscription}
 *    whose `close()` cancels the subscription.
 *
 *  - `getSetups` / `getEnvelopes` (optional) return the full set of
 *    objects the channel currently knows about for a given `txId`.
 *    Useful for "catch up to current state" flows where a participant
 *    starts late and needs to see what was already posted. Implementations
 *    that cannot enumerate prior state (e.g. fire-and-forget transports)
 *    MAY omit these methods.
 *
 *  - `close()` (optional) releases all channel-level resources (e.g.
 *    open HTTP connections, polling timers shared across subscriptions).
 *    Implementations that have no global state MAY omit it.
 *
 * @example In-process loopback (MockRuntime tests)
 * ```typescript
 * const channel: DeliveryChannel = new MockDeliveryChannel();
 *
 * await channel.publishSetup(setupWire);
 * const sub = await channel.subscribeEnvelopes(txId, async (env) => {
 *   const result = await envelopeBuilder.verify(env);
 *   if (result.valid) await consumeEnvelope(env);
 * });
 * // …later
 * await sub.close();
 * ```
 *
 * @example HTTP relay
 * ```typescript
 * const channel: DeliveryChannel = new RelayDeliveryChannel({
 *   baseUrl: 'https://relay.agirails.io',
 *   relayId: 'agirails-relay-v1',
 * });
 * await channel.publishEnvelope(envelopeWire);
 * await channel.close?.();
 * ```
 */
export interface DeliveryChannel {
  /**
   * Post a fully-signed {@link DeliverySetupWireV1} to the channel.
   *
   * Implementations SHOULD:
   *  - Perform shape validation (txId is a 32-byte hex, signature is
   *    65 bytes, etc.) and reject early on obvious malformations.
   *  - NOT perform cryptographic verification — that is the verifier's
   *    job, and pushing it down into the channel layer would tie the
   *    transport to a specific kernel address / chainId universe.
   *  - Surface transport-level errors as rejected Promises with a
   *    structured `DeliveryError` of code `channel_post_failed` or
   *    `channel_unreachable`, depending on the failure class.
   *
   * @param setup The setup wire object to publish.
   * @returns A Promise that resolves once the channel has accepted
   *   the publish (in a relay-backed implementation, after the relay
   *   acknowledges the POST; in a loopback implementation, after the
   *   in-memory write completes).
   */
  publishSetup(setup: DeliverySetupWireV1): Promise<void>;

  /**
   * Post a fully-signed {@link DeliveryEnvelopeWireV1} to the channel.
   *
   * Same contract as {@link publishSetup} — shape validation OK,
   * crypto verification NOT permitted at this layer, transport errors
   * surfaced as rejected Promises.
   *
   * @param envelope The envelope wire object to publish.
   * @returns A Promise that resolves once the channel has accepted
   *   the publish.
   */
  publishEnvelope(envelope: DeliveryEnvelopeWireV1): Promise<void>;

  /**
   * Subscribe to setups observed on the channel for a given `txId`.
   *
   * The callback fires once per verified-then-deduped setup
   * (dedup-after-verify ordering, see module JSDoc). Multiple
   * subscriptions on the same `txId` each receive all matching
   * setups (fan-out).
   *
   * Callback errors are isolated per security invariant #2 — the
   * channel MUST catch and swallow them, never propagating into its
   * own read loop or affecting other subscribers.
   *
   * @param txId The transaction id to scope the subscription to,
   *   as a `bytes32` hex-encoded string (`0x` + 64 hex chars).
   * @param callback Invoked for each setup observed.
   * @returns A {@link DeliverySubscription} whose `close()` cancels.
   */
  subscribeSetups(
    txId: `0x${string}`,
    callback: SetupCallback,
  ): Promise<DeliverySubscription>;

  /**
   * Subscribe to envelopes observed on the channel for a given `txId`.
   *
   * Same semantics as {@link subscribeSetups}.
   *
   * @param txId The transaction id to scope the subscription to.
   * @param callback Invoked for each envelope observed.
   * @returns A {@link DeliverySubscription} whose `close()` cancels.
   */
  subscribeEnvelopes(
    txId: `0x${string}`,
    callback: EnvelopeCallback,
  ): Promise<DeliverySubscription>;

  /**
   * Optional: return all setups the channel currently knows about for
   * a given `txId`.
   *
   * Useful when a participant joins late and needs to see historical
   * state. The returned array MUST be ordered by channel-observation
   * order (oldest first) so callers can implement "process all then
   * subscribe to new" flows deterministically.
   *
   * Implementations that cannot enumerate prior state (e.g.
   * fire-and-forget transports, transports without server-side
   * storage) MAY omit this method. Consumers MUST check for its
   * presence (`if (channel.getSetups)`).
   *
   * @param txId The transaction id to fetch setups for.
   * @returns All known setups for `txId`, oldest first.
   */
  getSetups?(txId: `0x${string}`): Promise<DeliverySetupWireV1[]>;

  /**
   * Optional: return all envelopes the channel currently knows about
   * for a given `txId`. Same contract as {@link getSetups}.
   *
   * @param txId The transaction id to fetch envelopes for.
   * @returns All known envelopes for `txId`, oldest first.
   */
  getEnvelopes?(txId: `0x${string}`): Promise<DeliveryEnvelopeWireV1[]>;

  /**
   * Optional: release any channel-level resources (HTTP connections,
   * polling timers shared across subscriptions, etc.).
   *
   * After `close()` resolves, the channel MUST NOT fire any further
   * subscriber callbacks and SHOULD reject any subsequent `publish*`
   * call with `channel_unreachable`.
   *
   * Implementations with no global state (e.g. a pure in-memory
   * loopback that closes per-subscription only) MAY omit this method.
   *
   * `close()` is idempotent: calling it multiple times is safe and
   * a no-op after the first call.
   */
  close?(): void | Promise<void>;
}
