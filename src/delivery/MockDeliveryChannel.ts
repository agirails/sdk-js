/**
 * AIP-16 Delivery Surface — MockDeliveryChannel (Phase 2b)
 * =========================================================
 *
 * In-process loopback {@link DeliveryChannel} implementation used by
 * unit tests and `MockRuntime` flows. Both parties of an AIP-16
 * delivery exchange share a single MockDeliveryChannel instance and
 * exchange already-signed wire objects without any network transport.
 *
 * Verification is performed in-channel — the same builder `verify()`
 * methods that `RelayDeliveryChannel` consumers run on read — so
 * security regression tests using the mock exercise the same code
 * paths as production deployments.
 *
 * ## Critical security invariants (mirror MockChannel / RelayChannel)
 *
 *  1. **Dedup AFTER verify.** A signature is added to a txId's dedup
 *     set ONLY after the signature has been verified. Otherwise an
 *     attacker who replays a malformed payload with a stolen signature
 *     could poison the dedup set — the later legitimate signed object
 *     would be silently dropped because its identifier was already
 *     "seen". This is identical to the ordering used in
 *     `src/negotiation/MockChannel.ts` ~line 189.
 *
 *  2. **Subscriber error isolation.** Subscriber callbacks may throw
 *     synchronously or asynchronously. Every invocation is wrapped in
 *     `Promise.resolve(...).catch(...)` so one bad subscriber can never
 *     halt fan-out to peer subscribers and cannot propagate up into
 *     the channel's publish loop.
 *
 *  3. **Replay on subscribe.** Subscribers receive the FULL historical
 *     set of already-published wire objects for the subscribed `txId`
 *     before any future objects fire. This matches the test-ergonomic
 *     behavior of `MockChannel`: tests can publish first then subscribe
 *     and still see what was posted. Each callback maintains its own
 *     per-subscription `delivered` set so a replay does not double-fire
 *     and so a slow subscriber can stagger its consumption without
 *     missing messages.
 *
 *  4. **Address comparison case-insensitivity.** All comparisons that
 *     touch addresses (none directly in this file — verification is
 *     delegated to builders which already lowercase both sides) are
 *     case-insensitive by construction.
 *
 * ## Verification opts derivation
 *
 * Verification calls `DeliverySetupBuilder.verify` / `DeliveryEnvelopeBuilder.verify`
 * with `{ expectedKernelAddress, expectedChainId, now }`. The resolution
 * order is:
 *
 *  - `expectedKernelAddress`: `opts.expectedKernelAddress` if set, else
 *    `signed.kernelAddress` (the wire's self-asserted kernel).
 *  - `expectedChainId`: `opts.expectedChainId` if set, else
 *    `signed.chainId`.
 *  - `now`: `opts.now?.()` if set, else the builder's default (which
 *    reads its own injectable clock).
 *
 * Using the wire's self-asserted values is intentional for the *mock*
 * — tests typically don't care to plumb an explicit kernel address per
 * channel instance and want the channel to "just accept" whatever the
 * test signed. Tests that DO want allowlist enforcement pass
 * `expectedKernelAddress` / `expectedChainId` explicitly.
 *
 * @module delivery/MockDeliveryChannel
 * @see {@link DeliveryChannel}
 * @see {@link DeliverySetupBuilder.verify}
 * @see {@link DeliveryEnvelopeBuilder.verify}
 */

import type {
  DeliveryChannel,
  DeliverySubscription,
  SetupCallback,
  EnvelopeCallback,
} from './channel';
import type {
  DeliverySetupWireV1,
  DeliveryEnvelopeWireV1,
} from './types';
import { DeliverySetupBuilder } from './setupBuilder';
import { DeliveryEnvelopeBuilder } from './envelopeBuilder';
import { type LogFn, noopLog } from './channelLog';

// ============================================================================
// Public options
// ============================================================================

/**
 * Construction options for {@link MockDeliveryChannel}.
 *
 * All fields are optional. Defaults are tuned for the most common case
 * (unit tests that publish locally-signed wire objects and expect them
 * to round-trip without configuration).
 */
export interface MockDeliveryChannelOptions {
  /**
   * Pluggable logger. Defaults to {@link noopLog} (silent).
   *
   * Channels log at `warn` when:
   *  - a publish is rejected because verification failed (one record
   *    per rejected publish, with the structured error code),
   *  - a subscriber callback threw and was swallowed (per security
   *    invariant #2).
   */
  log?: LogFn;

  /**
   * If `true`, skip signature verification on publish. The channel will
   * still compute the dedup hash and fan out, but it will accept
   * malformed or tampered wires.
   *
   * Used by tests that need to inject poisoned signatures to exercise
   * dedup-after-verify behavior, channel-level rejection paths, or
   * subscriber error isolation under malformed input. Defaults to
   * `false`.
   */
  skipVerifyForTests?: boolean;

  /**
   * Allowlisted kernel address. When set, verification enforces this
   * value (matches the production posture). When unset, verification
   * falls back to `signed.kernelAddress` (the wire's self-asserted
   * kernel), which is the convenient default for tests that have
   * already signed under an arbitrary kernel and just want it accepted.
   */
  expectedKernelAddress?: string;

  /**
   * Allowlisted chainId. Same fallback semantics as
   * {@link expectedKernelAddress} — when unset, defaults to
   * `signed.chainId`.
   */
  expectedChainId?: number;

  /**
   * Injectable wall clock returning Unix seconds. When set, passed
   * through to the underlying builder `verify()` calls so timestamp
   * skew and expiry checks are deterministic across tests.
   */
  now?: () => number;
}

// ============================================================================
// Internal state
// ============================================================================

interface SetupStore {
  /** Per-txId list of accepted setups, in publication order. */
  setups: DeliverySetupWireV1[];
  /** Per-txId dedup set keyed by `DeliverySetupBuilder.computeHash(wire)`. */
  dedup: Set<string>;
}

interface EnvelopeStore {
  /** Per-txId list of accepted envelopes, in publication order. */
  envelopes: DeliveryEnvelopeWireV1[];
  /** Per-txId dedup set keyed by `DeliveryEnvelopeBuilder.computeHash(wire)`. */
  dedup: Set<string>;
}

interface SetupSubscriber {
  callback: SetupCallback;
  /** Per-subscription dedup so replay-on-subscribe does not double-fire. */
  delivered: Set<string>;
  cancelled: boolean;
}

interface EnvelopeSubscriber {
  callback: EnvelopeCallback;
  /** Per-subscription dedup so replay-on-subscribe does not double-fire. */
  delivered: Set<string>;
  cancelled: boolean;
}

// ============================================================================
// MockDeliveryChannel
// ============================================================================

/**
 * In-process loopback delivery channel.
 *
 * Two parties (or any number) share a single instance and exchange
 * wire objects via `publishSetup` / `publishEnvelope` / `subscribe*`.
 * No network transport.
 *
 * @example
 * ```typescript
 * const channel = new MockDeliveryChannel();
 *
 * // Provider subscribes for setups on a txId.
 * const sub = await channel.subscribeSetups(txId, async (wire) => {
 *   // wire has already been verified by the channel.
 *   await onSetup(wire);
 * });
 *
 * // Requester publishes the setup.
 * await channel.publishSetup(setupWire);
 *
 * // …later
 * await sub.close();
 * channel.close();
 * ```
 */
export class MockDeliveryChannel implements DeliveryChannel {
  private readonly log: LogFn;
  private readonly skipVerifyForTests: boolean;
  private readonly expectedKernelAddress?: string;
  private readonly expectedChainId?: number;
  private readonly nowFn?: () => number;

  private readonly setupStoreByTxId = new Map<string, SetupStore>();
  private readonly envelopeStoreByTxId = new Map<string, EnvelopeStore>();
  private readonly setupSubscribersByTxId = new Map<string, Set<SetupSubscriber>>();
  private readonly envelopeSubscribersByTxId = new Map<string, Set<EnvelopeSubscriber>>();

  private closed = false;

  constructor(opts: MockDeliveryChannelOptions = {}) {
    this.log = opts.log ?? noopLog;
    this.skipVerifyForTests = opts.skipVerifyForTests ?? false;
    this.expectedKernelAddress = opts.expectedKernelAddress;
    this.expectedChainId = opts.expectedChainId;
    this.nowFn = opts.now;
  }

  // --------------------------------------------------------------------------
  // publish
  // --------------------------------------------------------------------------

  async publishSetup(setup: DeliverySetupWireV1): Promise<void> {
    if (this.closed) {
      throw new Error('MockDeliveryChannel: channel is closed');
    }

    // Step 1: verify (unless explicitly disabled for tests).
    if (!this.skipVerifyForTests) {
      const verifyResult = DeliverySetupBuilder.verify(setup, {
        expectedKernelAddress:
          this.expectedKernelAddress ?? setup.signed.kernelAddress,
        expectedChainId: this.expectedChainId ?? setup.signed.chainId,
        now: this.nowFn?.(),
      });
      if (!verifyResult.ok) {
        this.log('warn', 'MockDeliveryChannel: setup verify failed', {
          code: verifyResult.code,
          error: verifyResult.error,
          txId: setup.signed.txId,
        });
        const err = new Error(
          `MockDeliveryChannel: setup verify failed: ${verifyResult.code}: ${verifyResult.error}`,
        ) as Error & { code: string };
        err.code = verifyResult.code;
        throw err;
      }
    }

    // Step 2: dedup hash (computed AFTER verify succeeded — see security
    // invariant #1 in the module header).
    const hash = DeliverySetupBuilder.computeHash(setup);

    const txId = setup.signed.txId.toLowerCase();
    let store = this.setupStoreByTxId.get(txId);
    if (!store) {
      store = { setups: [], dedup: new Set() };
      this.setupStoreByTxId.set(txId, store);
    }

    if (store.dedup.has(hash)) {
      // Idempotent: re-publishing the same wire is a no-op. Not a
      // warning — duplicate publish under retry semantics is normal.
      return;
    }

    store.dedup.add(hash);
    store.setups.push(setup);

    // Step 3: fan out asynchronously so publish() resolves before any
    // subscriber callback runs (mirrors RelayChannel's poll-tick
    // boundary). Errors thrown by subscribers are isolated.
    this.fanoutSetup(txId, setup);
  }

  async publishEnvelope(envelope: DeliveryEnvelopeWireV1): Promise<void> {
    if (this.closed) {
      throw new Error('MockDeliveryChannel: channel is closed');
    }

    if (!this.skipVerifyForTests) {
      const verifyResult = DeliveryEnvelopeBuilder.verify(envelope, {
        expectedKernelAddress:
          this.expectedKernelAddress ?? envelope.signed.kernelAddress,
        expectedChainId: this.expectedChainId ?? envelope.signed.chainId,
        now: this.nowFn?.(),
      });
      if (!verifyResult.ok) {
        this.log('warn', 'MockDeliveryChannel: envelope verify failed', {
          code: verifyResult.code,
          error: verifyResult.error,
          txId: envelope.signed.txId,
        });
        const err = new Error(
          `MockDeliveryChannel: envelope verify failed: ${verifyResult.code}: ${verifyResult.error}`,
        ) as Error & { code: string };
        err.code = verifyResult.code;
        throw err;
      }
    }

    const hash = DeliveryEnvelopeBuilder.computeHash(envelope);

    const txId = envelope.signed.txId.toLowerCase();
    let store = this.envelopeStoreByTxId.get(txId);
    if (!store) {
      store = { envelopes: [], dedup: new Set() };
      this.envelopeStoreByTxId.set(txId, store);
    }

    if (store.dedup.has(hash)) {
      return;
    }

    store.dedup.add(hash);
    store.envelopes.push(envelope);

    this.fanoutEnvelope(txId, envelope);
  }

  // --------------------------------------------------------------------------
  // subscribe
  // --------------------------------------------------------------------------

  async subscribeSetups(
    txId: `0x${string}`,
    callback: SetupCallback,
  ): Promise<DeliverySubscription> {
    if (this.closed) {
      throw new Error('MockDeliveryChannel: channel is closed');
    }

    const txIdLc = txId.toLowerCase();
    const sub: SetupSubscriber = {
      callback,
      delivered: new Set(),
      cancelled: false,
    };

    let subs = this.setupSubscribersByTxId.get(txIdLc);
    if (!subs) {
      subs = new Set();
      this.setupSubscribersByTxId.set(txIdLc, subs);
    }
    subs.add(sub);

    // Replay-on-subscribe: schedule on next microtask so subscribe()
    // returns the handle BEFORE any callback fires (mirrors MockChannel
    // semantics — callers can rely on `const s = await subscribe(...);
    // s.close()` being effective for messages they haven't yet processed).
    const store = this.setupStoreByTxId.get(txIdLc);
    if (store) {
      const snapshot = store.setups.slice();
      queueMicrotask(() => {
        if (sub.cancelled) return;
        for (const wire of snapshot) {
          if (sub.cancelled) break;
          this.deliverSetup(sub, wire);
        }
      });
    }

    return {
      close: () => {
        sub.cancelled = true;
        const currentSubs = this.setupSubscribersByTxId.get(txIdLc);
        if (currentSubs) {
          currentSubs.delete(sub);
          if (currentSubs.size === 0) {
            this.setupSubscribersByTxId.delete(txIdLc);
          }
        }
      },
    };
  }

  async subscribeEnvelopes(
    txId: `0x${string}`,
    callback: EnvelopeCallback,
  ): Promise<DeliverySubscription> {
    if (this.closed) {
      throw new Error('MockDeliveryChannel: channel is closed');
    }

    const txIdLc = txId.toLowerCase();
    const sub: EnvelopeSubscriber = {
      callback,
      delivered: new Set(),
      cancelled: false,
    };

    let subs = this.envelopeSubscribersByTxId.get(txIdLc);
    if (!subs) {
      subs = new Set();
      this.envelopeSubscribersByTxId.set(txIdLc, subs);
    }
    subs.add(sub);

    const store = this.envelopeStoreByTxId.get(txIdLc);
    if (store) {
      const snapshot = store.envelopes.slice();
      queueMicrotask(() => {
        if (sub.cancelled) return;
        for (const wire of snapshot) {
          if (sub.cancelled) break;
          this.deliverEnvelope(sub, wire);
        }
      });
    }

    return {
      close: () => {
        sub.cancelled = true;
        const currentSubs = this.envelopeSubscribersByTxId.get(txIdLc);
        if (currentSubs) {
          currentSubs.delete(sub);
          if (currentSubs.size === 0) {
            this.envelopeSubscribersByTxId.delete(txIdLc);
          }
        }
      },
    };
  }

  // --------------------------------------------------------------------------
  // Snapshot accessors (DeliveryChannel interface)
  // --------------------------------------------------------------------------

  async getSetups(txId?: `0x${string}`): Promise<DeliverySetupWireV1[]> {
    return this.getAllSetups(txId);
  }

  async getEnvelopes(txId?: `0x${string}`): Promise<DeliveryEnvelopeWireV1[]> {
    return this.getAllEnvelopes(txId);
  }

  // --------------------------------------------------------------------------
  // Test helpers (NOT part of DeliveryChannel)
  // --------------------------------------------------------------------------

  /**
   * Synchronous snapshot of all setups currently stored for `txId`,
   * or all setups across every txId when `txId` is omitted. Returns a
   * defensive copy.
   */
  getAllSetups(txId?: string): DeliverySetupWireV1[] {
    if (txId === undefined) {
      const out: DeliverySetupWireV1[] = [];
      for (const store of this.setupStoreByTxId.values()) {
        out.push(...store.setups);
      }
      return out;
    }
    const store = this.setupStoreByTxId.get(txId.toLowerCase());
    return store ? store.setups.slice() : [];
  }

  /**
   * Synchronous snapshot of all envelopes currently stored for `txId`,
   * or all envelopes across every txId when `txId` is omitted. Returns
   * a defensive copy.
   */
  getAllEnvelopes(txId?: string): DeliveryEnvelopeWireV1[] {
    if (txId === undefined) {
      const out: DeliveryEnvelopeWireV1[] = [];
      for (const store of this.envelopeStoreByTxId.values()) {
        out.push(...store.envelopes);
      }
      return out;
    }
    const store = this.envelopeStoreByTxId.get(txId.toLowerCase());
    return store ? store.envelopes.slice() : [];
  }

  /**
   * Count of currently-active subscriptions (setup + envelope combined).
   * Useful for leak tests.
   */
  activeSubscriptionCount(): number {
    let n = 0;
    for (const subs of this.setupSubscribersByTxId.values()) n += subs.size;
    for (const subs of this.envelopeSubscribersByTxId.values()) n += subs.size;
    return n;
  }

  /**
   * Reset all stored state. Does NOT touch subscriber lists — existing
   * subscribers remain registered for future publishes.
   */
  clear(): void {
    this.setupStoreByTxId.clear();
    this.envelopeStoreByTxId.clear();
  }

  /**
   * Mark all current subscriptions cancelled and drop them. Storage is
   * preserved so tests can still assert on what was published. Future
   * `publish*` / `subscribe*` calls reject with a closed-channel error.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subs of this.setupSubscribersByTxId.values()) {
      for (const s of subs) s.cancelled = true;
    }
    for (const subs of this.envelopeSubscribersByTxId.values()) {
      for (const s of subs) s.cancelled = true;
    }
    this.setupSubscribersByTxId.clear();
    this.envelopeSubscribersByTxId.clear();
  }

  // --------------------------------------------------------------------------
  // Internals — fan-out
  // --------------------------------------------------------------------------

  private fanoutSetup(txIdLc: string, wire: DeliverySetupWireV1): void {
    const subs = this.setupSubscribersByTxId.get(txIdLc);
    if (!subs || subs.size === 0) return;
    // Snapshot to defend against subscribers mutating the set (close()
    // during fan-out).
    const snapshot = Array.from(subs);
    queueMicrotask(() => {
      for (const sub of snapshot) {
        if (sub.cancelled) continue;
        this.deliverSetup(sub, wire);
      }
    });
  }

  private fanoutEnvelope(txIdLc: string, wire: DeliveryEnvelopeWireV1): void {
    const subs = this.envelopeSubscribersByTxId.get(txIdLc);
    if (!subs || subs.size === 0) return;
    const snapshot = Array.from(subs);
    queueMicrotask(() => {
      for (const sub of snapshot) {
        if (sub.cancelled) continue;
        this.deliverEnvelope(sub, wire);
      }
    });
  }

  /**
   * Deliver a setup to a single subscriber, honoring per-subscription
   * dedup and isolating subscriber errors.
   *
   * NOTE on dedup ordering: the channel-wide dedup happens at publish
   * time AFTER verify; the per-subscription dedup here is purely to
   * prevent double-fire when replay-on-subscribe races with a live
   * fanout for the same wire. It does NOT defend against signature
   * poisoning — that's handled at publish time.
   */
  private deliverSetup(sub: SetupSubscriber, wire: DeliverySetupWireV1): void {
    const sig = wire.requesterSig;
    if (sub.delivered.has(sig)) return;
    sub.delivered.add(sig);

    Promise.resolve()
      .then(() => sub.callback(wire))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.log('warn', 'MockDeliveryChannel: setup subscriber threw', {
          error: msg,
          txId: wire.signed.txId,
        });
      });
  }

  private deliverEnvelope(
    sub: EnvelopeSubscriber,
    wire: DeliveryEnvelopeWireV1,
  ): void {
    const sig = wire.providerSig;
    if (sub.delivered.has(sig)) return;
    sub.delivered.add(sig);

    Promise.resolve()
      .then(() => sub.callback(wire))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.log('warn', 'MockDeliveryChannel: envelope subscriber threw', {
          error: msg,
          txId: wire.signed.txId,
        });
      });
  }
}
