/**
 * BuyerOrchestrator — Autonomous buyer-side negotiation orchestrator.
 *
 * Flow:
 *   1. Discover candidates (via agirails.app API)
 *   2. Score with DecisionEngine (weighted ranking)
 *   3. Validate with PolicyEngine (5 guardrails)
 *   4. For each candidate (up to rounds_max):
 *      a. createTransaction → INITIATED
 *      b. Poll for QUOTED state (within quote_ttl)
 *      c. Validate quote against policy
 *      d. Accept → linkEscrow → COMMITTED
 *      e. OR reject → try next candidate
 *   5. Track everything via SessionStore
 *
 * Accepts ACTPClient for on-chain operations. Caller manages lifecycle.
 */

import type { Signer } from 'ethers';
import { discoverAgents, DiscoverAgent, DiscoverParams } from '../api/agirailsApp';
import { PolicyEngine, BuyerPolicy, QuoteOffer } from './PolicyEngine';
import { DecisionEngine, CandidateStats } from './DecisionEngine';
import { SessionStore } from './SessionStore';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { QuoteBuilder } from '../builders/QuoteBuilder';
import { CounterOfferBuilder, CounterOfferMessage } from '../builders/CounterOfferBuilder';
import { NonceManager, InMemoryNonceManager } from '../utils/NonceManager';
import { verifyQuoteHashOnChain, VerifySource } from './verifyQuoteOnChain';
import {
  NegotiationChannel,
  NegotiationMessage,
  Subscription,
  DeliveredMessage,
  isQuoteEnvelope,
  isCounterAcceptEnvelope,
} from './NegotiationChannel';

// ============================================================================
// Types
// ============================================================================

export interface NegotiationResult {
  success: boolean;
  commerce_session_id: string;
  actp_tx_id?: string;
  selected_provider?: string;
  rounds_used: number;
  /** Why negotiation ended (settled, exhausted, budget_exceeded, etc.) */
  reason: string;
  /** Per-round details for traceability */
  rounds: RoundResult[];
  /** True if repeated identical prices were detected across rounds (price deadlock) */
  deadlock_detected?: boolean;
}

export interface RoundResult {
  round: number;
  provider_slug: string;
  provider_address: string;
  action: 'accepted' | 'rejected' | 'timeout' | 'error';
  reason: string;
  tx_id?: string;
  /** Actual quoted price from on-chain (USDC float), if quote was received */
  quoted_price?: number;
}

export interface OrchestratorConfig {
  /** Override discover params (search, capability, etc.) */
  discover?: Partial<DiscoverParams>;
  /** Poll interval for checking quote state (ms). Default: 3000 */
  pollIntervalMs?: number;
  /** If true, run discovery + scoring but don't create transactions */
  dryRun?: boolean;
  /** Callback for progress events */
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: 'discovery'; candidates: number }
  | { type: 'scoring'; ranked: number }
  | { type: 'round_start'; round: number; provider: string }
  | { type: 'waiting_quote'; txId: string; ttlSeconds: number }
  | { type: 'quote_received'; txId: string }
  | { type: 'round_end'; round: number; action: string; reason: string }
  | { type: 'complete'; success: boolean; reason: string };

// ============================================================================
// BuyerOrchestrator
// ============================================================================

/**
 * AIP-2.1 negotiation context — wires the orchestrator into the
 * NegotiationChannel transport. All fields optional: without them the
 * orchestrator runs the legacy fixed-price flow only (no counters).
 *
 * To enable multi-round negotiation, supply ALL of:
 *   - signer (signs CounterOfferMessages)
 *   - kernelAddress (EIP-712 domain)
 *   - chainId
 *   - negotiationChannel (transport — RelayChannel default, MockChannel for tests)
 */
export interface BuyerNegotiationContext {
  /** Buyer's EOA signer — signs CounterOfferMessages. */
  signer?: Signer;
  /** ACTPKernel address for the chain. Required for counter signing. */
  kernelAddress?: string;
  /** Chain id (84532 / 8453). Required for counter signing. */
  chainId?: number;
  /** Nonce manager for counter messages. Defaults to an in-memory one. */
  nonceManager?: NonceManager;
  /**
   * Transport for receiving quotes / acceptances + sending counters.
   * Required for any negotiation feature; without it the orchestrator
   * is fixed-price only. Use RelayChannel in production, MockChannel
   * in tests.
   */
  negotiationChannel?: NegotiationChannel;
}

export class BuyerOrchestrator {
  private policy: BuyerPolicy;
  private policyEngine: PolicyEngine;
  private decisionEngine: DecisionEngine;
  private sessionStore: SessionStore;
  private runtime: IACTPRuntime;
  private requesterAddress: string;
  private negotiation: BuyerNegotiationContext;
  private counterBuilder?: CounterOfferBuilder;

  /**
   * Per-txId inbound message queue. Channel callbacks push here; the
   * orchestrator's negotiation loop drains via `_waitForNextMessage`.
   * Bounded implicitly by `_cleanupTxState` at terminal outcomes.
   */
  private inboundQueues = new Map<string, NegotiationMessage[]>();
  /**
   * Per-txId resolver for the orchestrator's "wait for next message"
   * await. When a message arrives and a resolver is set, the message
   * is delivered immediately instead of queued.
   */
  private inboundResolvers = new Map<string, (msg: NegotiationMessage) => void>();
  /**
   * Active subscriptions opened by `negotiate()`. Closed at end of
   * each negotiation. Multiple concurrent calls are supported.
   */
  private activeSubscriptions = new Map<string, Subscription>();

  constructor(
    policy: BuyerPolicy,
    runtime: IACTPRuntime,
    requesterAddress: string,
    actpDir?: string,
    negotiation: BuyerNegotiationContext = {},
  ) {
    this.policy = policy;
    this.runtime = runtime;
    this.requesterAddress = requesterAddress;
    this.policyEngine = new PolicyEngine(policy, actpDir);
    this.decisionEngine = new DecisionEngine(policy.selection.weights);
    this.sessionStore = new SessionStore(actpDir);
    this.negotiation = negotiation;

    if (negotiation.signer) {
      this.counterBuilder = new CounterOfferBuilder(
        negotiation.signer,
        negotiation.nonceManager ?? new InMemoryNonceManager(),
      );
    }
  }

  // --------------------------------------------------------------------------
  // Channel inbound dispatch
  // --------------------------------------------------------------------------

  /**
   * Channel delivered a verified message for `txId`. If a round is
   * awaiting the next message, hand it directly; otherwise queue.
   *
   * NOTE: the channel has already verified EIP-712 signature + chainId
   * before invoking us. This handler is concerned only with routing.
   */
  private _onChannelMessage(txId: string, delivered: DeliveredMessage): void {
    const resolver = this.inboundResolvers.get(txId);
    if (resolver) {
      this.inboundResolvers.delete(txId);
      resolver(delivered.envelope);
      return;
    }
    const queue = this.inboundQueues.get(txId) ?? [];
    queue.push(delivered.envelope);
    this.inboundQueues.set(txId, queue);
  }

  /**
   * Await the next inbound message matching one of `acceptedTypes`.
   * Returns null on timeout (caller decides how to handle: cancel,
   * accept-if-affordable, etc).
   *
   * Drains the queue first so messages buffered while we were busy
   * processing the previous round are picked up immediately.
   */
  private _waitForNextMessage(
    txId: string,
    acceptedTypes: ReadonlyArray<NegotiationMessage['type']>,
    timeoutMs: number,
  ): Promise<NegotiationMessage | null> {
    return new Promise((resolve) => {
      // Drain queue first — non-matching types stay queued for later.
      const queue = this.inboundQueues.get(txId) ?? [];
      const idx = queue.findIndex((m) => acceptedTypes.includes(m.type));
      if (idx >= 0) {
        const [msg] = queue.splice(idx, 1);
        if (queue.length === 0) this.inboundQueues.delete(txId);
        else this.inboundQueues.set(txId, queue);
        resolve(msg);
        return;
      }
      const timer = setTimeout(() => {
        if (this.inboundResolvers.get(txId) === filteredResolver) {
          this.inboundResolvers.delete(txId);
        }
        resolve(null);
      }, timeoutMs);
      const filteredResolver = (msg: NegotiationMessage): void => {
        if (acceptedTypes.includes(msg.type)) {
          clearTimeout(timer);
          resolve(msg);
        } else {
          // Wrong type — push back to queue and keep waiting.
          const q = this.inboundQueues.get(txId) ?? [];
          q.push(msg);
          this.inboundQueues.set(txId, q);
          this.inboundResolvers.set(txId, filteredResolver);
        }
      };
      this.inboundResolvers.set(txId, filteredResolver);
    });
  }

  /**
   * Execute the full negotiation flow.
   */
  async negotiate(config: OrchestratorConfig = {}): Promise<NegotiationResult> {
    const pollInterval = config.pollIntervalMs ?? 3000;
    const emit = config.onProgress ?? (() => {});

    // Create session
    const session = this.sessionStore.create(this.policy.task);
    const rounds: RoundResult[] = [];

    try {
      return await this._negotiate(session, rounds, config, pollInterval, emit);
    } catch (err) {
      // Guarantee session reaches terminal status on any uncaught throw
      const currentSession = this.sessionStore.get(session.commerce_session_id);
      if (currentSession && currentSession.status === 'active') {
        this.sessionStore.updateStatus(session.commerce_session_id, 'failed');
      }
      throw err;
    }
  }

  private async _negotiate(
    session: ReturnType<SessionStore['create']>,
    rounds: RoundResult[],
    config: OrchestratorConfig,
    pollInterval: number,
    emit: (event: ProgressEvent) => void,
  ): Promise<NegotiationResult> {
    // 1. Discover candidates
    const discoverParams: DiscoverParams = {
      search: this.policy.task,
      sort: 'reputation',
      limit: 20,
      maxPrice: this.policy.constraints.max_unit_price.amount,
      ...config.discover,
    };

    const discovered = await discoverAgents(discoverParams);
    emit({ type: 'discovery', candidates: discovered.agents.length });

    if (discovered.agents.length === 0) {
      emit({ type: 'complete', success: false, reason: 'No candidates found' });
      this.sessionStore.updateStatus(session.commerce_session_id, 'failed');
      return {
        success: false,
        commerce_session_id: session.commerce_session_id,
        rounds_used: 0,
        reason: 'No candidates found',
        rounds,
      };
    }

    // 2. Score candidates with DecisionEngine
    const candidateStats = this.mapToCandidateStats(discovered.agents);
    const ranked = this.decisionEngine.rank(
      candidateStats,
      this.policy.constraints.max_unit_price.amount,
    );
    emit({ type: 'scoring', ranked: ranked.length });

    if (ranked.length === 0) {
      emit({ type: 'complete', success: false, reason: 'No candidates within budget' });
      this.sessionStore.updateStatus(session.commerce_session_id, 'failed');
      return {
        success: false,
        commerce_session_id: session.commerce_session_id,
        rounds_used: 0,
        reason: 'No candidates within budget after scoring',
        rounds,
      };
    }

    // Dry-run: return ranked candidates without creating transactions
    if (config.dryRun) {
      this.sessionStore.updateStatus(session.commerce_session_id, 'completed');
      emit({ type: 'complete', success: true, reason: 'Dry run complete' });
      return {
        success: true,
        commerce_session_id: session.commerce_session_id,
        rounds_used: 0,
        reason: `Dry run: ${ranked.length} candidates ranked`,
        rounds: ranked.map((c, i) => ({
          round: i + 1,
          provider_slug: c.slug,
          provider_address: this.findAgentAddress(discovered.agents, c.slug),
          action: 'accepted' as const,
          reason: `Score: ${c.score.toFixed(3)}`,
        })),
      };
    }

    // 3. Try candidates up to rounds_max
    const maxRounds = Math.min(this.policy.negotiation.rounds_max, ranked.length);
    const quoteTtlSeconds = PolicyEngine.parseTtl(this.policy.negotiation.quote_ttl);

    // Price tracking for deadlock detection (PRD-5B)
    const priceHistory: number[] = [];
    let deadlockDetected = false;

    for (let round = 0; round < maxRounds; round++) {
      const candidate = ranked[round];
      const providerAddress = this.findAgentAddress(discovered.agents, candidate.slug);

      emit({ type: 'round_start', round: round + 1, provider: candidate.slug });
      this.sessionStore.recordAttempt(session.commerce_session_id, candidate.slug);

      // 3a. Pre-validate with PolicyEngine
      const offer: QuoteOffer = {
        provider: candidate.slug,
        unit_price: this.findAgentPrice(discovered.agents, candidate.slug),
        currency: this.policy.constraints.max_unit_price.currency,
        unit: this.policy.constraints.max_unit_price.unit,
        reputation_score: this.findAgentReputation(discovered.agents, candidate.slug),
        commerce_session_id: session.commerce_session_id,
        expires_at: Math.floor(Date.now() / 1000) + quoteTtlSeconds,
        final_offer: deadlockDetected,
      };

      const validation = this.policyEngine.validate(offer);
      if (!validation.allowed) {
        const reason = validation.violations.map(v => `${v.rule}: ${v.detail}`).join('; ');
        rounds.push({
          round: round + 1,
          provider_slug: candidate.slug,
          provider_address: providerAddress,
          action: 'rejected',
          reason: `Policy violation: ${reason}`,
        });
        emit({ type: 'round_end', round: round + 1, action: 'rejected', reason });
        continue;
      }

      // 3b. Create transaction
      let txId: string;
      try {
        const amount = this.toBaseUnits(offer.unit_price);
        txId = await this.runtime.createTransaction({
          provider: providerAddress,
          requester: this.requesterAddress,
          amount,
          deadline: Math.floor(Date.now() / 1000) + quoteTtlSeconds + 3600, // quote TTL + 1h buffer
          serviceDescription: JSON.stringify({ service: this.policy.task, session: session.commerce_session_id }),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        rounds.push({
          round: round + 1,
          provider_slug: candidate.slug,
          provider_address: providerAddress,
          action: 'error',
          reason: `createTransaction failed: ${reason}`,
        });
        emit({ type: 'round_end', round: round + 1, action: 'error', reason });
        continue;
      }

      // Open negotiation channel subscription for this txId. All inbound
      // quote / counteraccept messages from the provider will land in
      // our internal queue (via _onChannelMessage) for the negotiation
      // round loop to consume. Subscription is closed in _cleanupTxState.
      if (this.negotiation.negotiationChannel) {
        const sub = this.negotiation.negotiationChannel.subscribeTxId(
          txId,
          (delivered) => this._onChannelMessage(txId, delivered),
        );
        this.activeSubscriptions.set(txId, sub);
      }

      // 3c. Wait for quote or direct commit (ACTP allows INITIATED → COMMITTED fast path)
      emit({ type: 'waiting_quote', txId, ttlSeconds: quoteTtlSeconds });

      const reachedState = await this.waitForState(txId, ['QUOTED', 'COMMITTED'], quoteTtlSeconds * 1000, pollInterval);

      if (!reachedState) {
        // Timeout or cancelled — cancel and try next
        try {
          await this.runtime.transitionState(txId, 'CANCELLED');
        } catch {
          // Best-effort cancel
        }
        rounds.push({
          round: round + 1,
          provider_slug: candidate.slug,
          provider_address: providerAddress,
          action: 'timeout',
          reason: `No quote within ${quoteTtlSeconds}s`,
          tx_id: txId,
        });
        emit({ type: 'round_end', round: round + 1, action: 'timeout', reason: 'Quote TTL expired' });
        // External caller may have pushed a quote between createTransaction
        // and timeout — clear so a long-running daemon doesn't accumulate
        // entries in receivedQuotes / sentCounters.
        this._cleanupTxState(txId);
        continue;
      }

      emit({ type: 'quote_received', txId });

      // 3d. Read quoted price from on-chain for tracking (PRD-5B)
      let quotedPrice: number | undefined;
      try {
        const quotedTx = await this.runtime.getTransaction(txId);
        if (quotedTx && quotedTx.amount) {
          const rawAmount = typeof quotedTx.amount === 'string' ? parseFloat(quotedTx.amount) : quotedTx.amount;
          quotedPrice = rawAmount / 1_000_000; // Convert base units to USDC
          priceHistory.push(quotedPrice);

          // Deadlock detection: if 2+ consecutive identical prices, flag deadlock
          if (priceHistory.length >= 2) {
            const last = priceHistory[priceHistory.length - 1];
            const prev = priceHistory[priceHistory.length - 2];
            if (last === prev) {
              deadlockDetected = true;
            }
          }
        }
      } catch {
        // Non-fatal — price tracking is best-effort
      }

      // 3d-bis. AIP-2.1 negotiation branch: if the orchestrator has a
      // negotiationChannel configured, drain the inbound queue for any
      // quote that arrived via the channel and run the multi-round
      // counter-offer loop. The branch ONLY triggers when reachedState
      // === 'QUOTED' — the COMMITTED fast-path below bypasses negotiation
      // entirely because the provider already locked the deal at buyer's
      // offered amount.
      if (reachedState === 'QUOTED' && this.negotiation.negotiationChannel) {
        const negResult = await this._runNegotiationRound({
          txId,
          candidateSlug: candidate.slug,
          providerAddress,
          offer,
          round,
          rounds,
          emit,
        });
        if (negResult.done) {
          // Negotiation reached a terminal decision (accept or
          // reject) — short-circuit the existing escrow logic below.
          if (negResult.success) {
            this.sessionStore.linkTransaction(session.commerce_session_id, txId, candidate.slug);
            const negReason = negResult.reason ?? 'Negotiation complete';
            emit({ type: 'complete', success: true, reason: negReason });
            return {
              success: true,
              commerce_session_id: session.commerce_session_id,
              actp_tx_id: txId,
              selected_provider: candidate.slug,
              rounds_used: round + 1,
              reason: negReason,
              rounds,
              deadlock_detected: deadlockDetected,
            };
          }
          // negResult.success === false → candidate rejected; continue
          // outer loop to try the next one. The existing code below
          // would attempt linkEscrow at buyer's offered price, which
          // would happily succeed and silently ignore our rejection.
          continue;
        }
      }

      // 3e. Reserve budget and link escrow (or recognize already-committed).
      // ACTP invariant: tx.amount is immutable (set at createTransaction).
      // Policy was already validated pre-round, so offer.unit_price
      // is the correct amount for both reservation and escrow.

      if (reachedState === 'COMMITTED') {
        // COMMITTED is terminal on-chain — this is a success regardless of local ledger state.
        // Best-effort reserve for local budget tracking; failure is non-fatal.
        try {
          this.policyEngine.reserve(session.commerce_session_id, offer.unit_price, offer.currency);
        } catch {
          // Local ledger out of sync — log but don't fail the already-committed tx
        }

        this.sessionStore.linkTransaction(session.commerce_session_id, txId, candidate.slug);

        const reason = 'Provider already committed, escrow recognized';
        rounds.push({
          round: round + 1,
          provider_slug: candidate.slug,
          provider_address: providerAddress,
          action: 'accepted',
          reason,
          tx_id: txId,
          quoted_price: quotedPrice,
        });

        emit({ type: 'round_end', round: round + 1, action: 'accepted', reason });
        emit({ type: 'complete', success: true, reason: 'Negotiation complete' });

        // COMMITTED fast-path bypassed _runNegotiationRound (which is
        // the usual cleanup site) — drop any stashed quote/counter
        // state so daemon callers don't leak across negotiations.
        this._cleanupTxState(txId);

        return {
          success: true,
          commerce_session_id: session.commerce_session_id,
          actp_tx_id: txId,
          selected_provider: candidate.slug,
          rounds_used: round + 1,
          reason: 'Negotiation complete — already committed',
          rounds,
          deadlock_detected: deadlockDetected,
        };
      }

      // QUOTED path: reserve budget + link escrow (both must succeed, or try next candidate)
      const escrowAmount = this.toBaseUnits(offer.unit_price);
      try {
        this.policyEngine.reserve(session.commerce_session_id, offer.unit_price, offer.currency);
        await this.runtime.linkEscrow(txId, escrowAmount);

        // Success
        this.sessionStore.linkTransaction(session.commerce_session_id, txId, candidate.slug);

        const reason = 'Quote accepted, escrow linked';
        rounds.push({
          round: round + 1,
          provider_slug: candidate.slug,
          provider_address: providerAddress,
          action: 'accepted',
          reason,
          tx_id: txId,
          quoted_price: quotedPrice,
        });

        emit({ type: 'round_end', round: round + 1, action: 'accepted', reason });
        emit({ type: 'complete', success: true, reason: 'Negotiation complete' });

        // Symmetric to the COMMITTED fast-path above — this success exit
        // also bypassed _runNegotiationRound's cleanup site.
        this._cleanupTxState(txId);

        return {
          success: true,
          commerce_session_id: session.commerce_session_id,
          actp_tx_id: txId,
          selected_provider: candidate.slug,
          rounds_used: round + 1,
          reason: 'Negotiation complete — escrow linked',
          rounds,
          deadlock_detected: deadlockDetected,
        };
      } catch (err) {
        // Reserve or linkEscrow failed — release and try next
        this.policyEngine.release(session.commerce_session_id);
        const reason = err instanceof Error ? err.message : String(err);
        rounds.push({
          round: round + 1,
          provider_slug: candidate.slug,
          provider_address: providerAddress,
          action: 'error',
          reason: `Escrow failed: ${reason}`,
          tx_id: txId,
          quoted_price: quotedPrice,
        });
        emit({ type: 'round_end', round: round + 1, action: 'error', reason });
        // Same daemon-leak rationale as the timeout `continue` above.
        this._cleanupTxState(txId);
        continue;
      }
    }

    // All rounds exhausted
    this.sessionStore.updateStatus(session.commerce_session_id, 'failed');
    emit({ type: 'complete', success: false, reason: 'All candidates exhausted' });

    const exhaustedReason = deadlockDetected
      ? `All ${rounds.length} candidates exhausted (price deadlock detected)`
      : `All ${rounds.length} candidates exhausted`;

    return {
      success: false,
      commerce_session_id: session.commerce_session_id,
      rounds_used: rounds.length,
      reason: exhaustedReason,
      rounds,
      deadlock_detected: deadlockDetected,
    };
  }

  // ============================================================================
  // AIP-2.1 negotiation round
  // ============================================================================

  /**
   * Run the multi-round AIP-2.1 negotiation flow for one provider/txId.
   *
   * Channel-driven: this method never reads `setReceivedQuote` state;
   * all inbound messages flow through the orchestrator's NegotiationChannel
   * subscription (opened in `_negotiate` after createTransaction).
   *
   * Inner loop walks up to `policy.negotiation.rounds_per_provider`
   * counter exchanges:
   *
   *   await first quote (channel)
   *   for round in 0..rounds_per_provider:
   *     evaluate(currentQuote, roundsUsedSoFar = round)
   *     accept  → on-chain acceptQuote+linkEscrow, return success
   *     reject  → on-chain CANCELLED, return failure
   *     counter → channel.post(counter), await NEXT message:
   *               counteraccept → bind to last counter, on-chain accept+link, return success
   *               new quote     → currentQuote = new quote, loop
   *               timeout       → on-chain CANCELLED, return failure
   *
   * Returns `{done: false}` when the channel has no quote but the tx
   * reached QUOTED via raw transitionState (legacy flow caller wants
   * to fall through to fixed-price). Returns `{done: true, success?,
   * reason?}` for any terminal outcome.
   */
  private async _runNegotiationRound(args: {
    txId: string;
    candidateSlug: string;
    providerAddress: string;
    offer: QuoteOffer;
    round: number;
    rounds: RoundResult[];
    emit: (event: ProgressEvent) => void;
  }): Promise<{ done: boolean; success?: boolean; reason?: string }> {
    const { txId, candidateSlug, providerAddress, offer, round, rounds, emit } = args;

    // Cleanup hook fires on any `done: true` return — closes the channel
    // subscription opened in _negotiate so daemon callers don't leak.
    const terminate = (
      result: { done: true; success: boolean; reason: string },
    ): { done: true; success: boolean; reason: string } => {
      this._cleanupTxState(txId);
      return result;
    };

    if (!this.counterBuilder || !this.negotiation.kernelAddress || !this.negotiation.chainId) {
      // Channel was provided but not the rest of the negotiation context.
      // Fall through to fixed-price flow rather than try to negotiate.
      this._cleanupTxState(txId);
      return { done: false };
    }

    const counterTtlSec = this.policy.negotiation.counter_response_ttl_seconds
      ?? PolicyEngine.parseTtl(this.policy.negotiation.quote_ttl);
    const counterTtlMs = counterTtlSec * 1000;
    const roundsBudget = this.policy.negotiation.rounds_per_provider ?? 1;

    // Wait for the FIRST quote on the channel. The provider posts it
    // after on-chain submitQuote — channel + chain may race so we
    // also tolerate the quote arriving slightly before the kernel
    // hash is readable (we re-read on-chain inside the loop).
    const firstQuoteEnv = await this._waitForNextMessage(txId, ['agirails.quote.v1'], counterTtlMs);
    if (!firstQuoteEnv || !isQuoteEnvelope(firstQuoteEnv)) {
      // No quote arrived on the channel within TTL — fall through to
      // fixed-price (the on-chain hash + waitForState already proved
      // the tx hit QUOTED, so this is a legacy-provider scenario).
      this._cleanupTxState(txId);
      return { done: false };
    }
    let currentQuote = firstQuoteEnv.message;

    // Multi-round inner loop. Each iteration:
    //  - on FIRST round: cross-check on-chain hash (anchored proof that
    //    the off-chain quote we're seeing matches what provider committed
    //    on-chain via submitQuote — defense against MITM substitution).
    //  - on subsequent rounds: trust the channel's EIP-712 verify alone.
    //    Re-quotes are off-chain only by design (kernel forbids QUOTED →
    //    QUOTED on-chain transitions per Q4 audit). The provider DID is
    //    already authenticated by the channel's signature recovery, and
    //    the FINAL agreed amount is anchored on acceptQuote+linkEscrow.
    let hashSource: VerifySource = 'aip2';
    for (let counterRound = 0; counterRound < roundsBudget; counterRound++) {
      if (counterRound === 0) {
        const onChainTx = await this.runtime.getTransaction(txId);
        const onChainHash = onChainTx && (onChainTx as unknown as { quoteHash?: string | null }).quoteHash;
        if (!onChainHash) {
          // No anchored quote — fall through to fixed-price.
          this._cleanupTxState(txId);
          return { done: false };
        }
        const verify = verifyQuoteHashOnChain(currentQuote, onChainHash, {
          providerAddress: providerAddress,
        });
        if (!verify.match) {
          rounds.push({
            round: round + 1,
            provider_slug: candidateSlug,
            provider_address: providerAddress,
            action: 'error',
            reason: `Quote hash mismatch: expected ${verify.canonicalHash}, on-chain ${onChainHash}`,
            tx_id: txId,
          });
          emit({ type: 'round_end', round: round + 1, action: 'error', reason: 'Quote hash mismatch' });
          return terminate({ done: true, success: false, reason: 'hash mismatch' });
        }
        hashSource = verify.source!;
      } else {
        // Subsequent re-quotes: guard against two attacker-controlled
        // mutations the channel-level EIP-712 verify cannot catch on
        // its own (same provider can sign anything, including poisoned
        // re-quotes):
        //
        //   (a) provider DID switched mid-negotiation
        //   (b) maxPrice inflated mid-negotiation — without this
        //       guard, the buyer's `evaluateQuote` accept-if-affordable
        //       branch on the last round would compare against the
        //       attacker's inflated max, committing the buyer above
        //       its own policy ceiling. (P0 audit finding.)
        //
        // We anchor BOTH provider and maxPrice to the FIRST quote
        // (which already cross-checked on-chain hash on round 0).
        if (currentQuote.provider !== firstQuoteEnv.message.provider) {
          try { await this.runtime.transitionState(txId, 'CANCELLED'); } catch { /* best-effort */ }
          rounds.push({
            round: round + 1,
            provider_slug: candidateSlug,
            provider_address: providerAddress,
            action: 'error',
            reason: `Re-quote provider mismatch: ${currentQuote.provider} vs original ${firstQuoteEnv.message.provider}`,
            tx_id: txId,
          });
          emit({ type: 'round_end', round: round + 1, action: 'error', reason: 'provider mismatch on re-quote' });
          return terminate({ done: true, success: false, reason: 'provider mismatch' });
        }
        if (currentQuote.maxPrice !== firstQuoteEnv.message.maxPrice) {
          try { await this.runtime.transitionState(txId, 'CANCELLED'); } catch { /* best-effort */ }
          rounds.push({
            round: round + 1,
            provider_slug: candidateSlug,
            provider_address: providerAddress,
            action: 'error',
            reason: `Re-quote maxPrice mismatch: ${currentQuote.maxPrice} vs original ${firstQuoteEnv.message.maxPrice} — provider may not raise the ceiling mid-negotiation`,
            tx_id: txId,
          });
          emit({ type: 'round_end', round: round + 1, action: 'error', reason: 'maxPrice substitution attempt on re-quote' });
          return terminate({ done: true, success: false, reason: 'maxPrice substitution' });
        }
        hashSource = 'aip2';
      }

      const evaluation = this.decisionEngine.evaluateQuote(currentQuote, this.policy, counterRound);

      // ----- reject -----
      if (evaluation.action === 'reject') {
        try { await this.runtime.transitionState(txId, 'CANCELLED'); } catch { /* best-effort */ }
        rounds.push({
          round: round + 1,
          provider_slug: candidateSlug,
          provider_address: providerAddress,
          action: 'rejected',
          reason: `${evaluation.reason} (round ${counterRound + 1}/${roundsBudget}, source: ${hashSource})`,
          tx_id: txId,
          quoted_price: this._baseUnitsForLog(currentQuote.quotedAmount),
        });
        emit({ type: 'round_end', round: round + 1, action: 'rejected', reason: evaluation.reason });
        return terminate({ done: true, success: false, reason: evaluation.reason });
      }

      // ----- accept (at provider's quoted amount) -----
      if (evaluation.action === 'accept') {
        const result = await this._commitAtAmount(
          txId, currentQuote.quotedAmount, candidateSlug, providerAddress,
          offer, round, rounds, emit, hashSource, counterRound,
        );
        return terminate(result);
      }

      // ----- counter -----
      // Build counter, post on channel, await next message.
      let counter: CounterOfferMessage;
      try {
        const consumerDID = `did:ethr:${this.negotiation.chainId}:${(await this.negotiation.signer!.getAddress()).toLowerCase()}`;
        const now = Math.floor(Date.now() / 1000);
        // inReplyTo is the canonical hash of the quote we're countering
        // — recompute on every round (subsequent re-quotes have their
        // own hash, distinct from the on-chain anchored first quote).
        const currentQuoteHash = new QuoteBuilder().computeHash(currentQuote);
        counter = await this.counterBuilder.build({
          txId,
          consumer: consumerDID,
          provider: currentQuote.provider,
          quoteAmount: currentQuote.quotedAmount,
          counterAmount: evaluation.amountBaseUnits,
          maxPrice: currentQuote.maxPrice,
          inReplyTo: currentQuoteHash,
          chainId: this.negotiation.chainId,
          kernelAddress: this.negotiation.kernelAddress,
          expiresAt: now + counterTtlSec,
        });
      } catch (err) {
        const reason = `Counter build failed on round ${counterRound + 1}: ${err instanceof Error ? err.message : String(err)}`;
        rounds.push({ round: round + 1, provider_slug: candidateSlug, provider_address: providerAddress, action: 'error', reason, tx_id: txId });
        emit({ type: 'round_end', round: round + 1, action: 'error', reason });
        return terminate({ done: true, success: false, reason });
      }

      try {
        await this.negotiation.negotiationChannel!.post(txId, {
          type: 'agirails.counteroffer.v1', message: counter,
        });
      } catch (err) {
        const reason = `Counter post failed on round ${counterRound + 1}: ${err instanceof Error ? err.message : String(err)}`;
        rounds.push({ round: round + 1, provider_slug: candidateSlug, provider_address: providerAddress, action: 'error', reason, tx_id: txId });
        emit({ type: 'round_end', round: round + 1, action: 'error', reason });
        return terminate({ done: true, success: false, reason });
      }

      // Await provider's response: counteraccept (deal closed) or new quote (provider re-quote → next round).
      const next = await this._waitForNextMessage(
        txId,
        ['agirails.counteraccept.v1', 'agirails.quote.v1'],
        counterTtlMs,
      );
      if (!next) {
        try { await this.runtime.transitionState(txId, 'CANCELLED'); } catch { /* best-effort */ }
        const reason = `No response within ${counterTtlSec}s on round ${counterRound + 1}`;
        rounds.push({ round: round + 1, provider_slug: candidateSlug, provider_address: providerAddress, action: 'timeout', reason, tx_id: txId });
        emit({ type: 'round_end', round: round + 1, action: 'timeout', reason });
        return terminate({ done: true, success: false, reason });
      }

      if (isCounterAcceptEnvelope(next)) {
        // Provider accepted our counter — verify binding (channel already
        // verified EIP-712, here we bind to the counter WE sent).
        const accept = next.message;
        const counterHash = new CounterOfferBuilder().computeHash(counter);
        if (
          accept.txId !== txId ||
          accept.inReplyTo !== counterHash ||
          accept.acceptedAmount !== counter.counterAmount
        ) {
          const reason = `CounterAccept binding mismatch on round ${counterRound + 1}`;
          rounds.push({ round: round + 1, provider_slug: candidateSlug, provider_address: providerAddress, action: 'error', reason, tx_id: txId });
          emit({ type: 'round_end', round: round + 1, action: 'error', reason });
          return terminate({ done: true, success: false, reason });
        }
        const result = await this._commitAtAmount(
          txId, accept.acceptedAmount, candidateSlug, providerAddress,
          offer, round, rounds, emit, 'counteraccept', counterRound,
        );
        return terminate(result);
      }

      if (isQuoteEnvelope(next)) {
        // Provider re-quoted — replace currentQuote and loop.
        currentQuote = next.message;
        continue;
      }
    }

    // Budget exhausted without accept — DecisionEngine's last-round
    // branch should have triggered accept-if-affordable; reaching here
    // implies provider re-quoted to the very last round and we still
    // saw 'counter'. Cancel.
    try { await this.runtime.transitionState(txId, 'CANCELLED'); } catch { /* best-effort */ }
    const reason = `Negotiation budget (${roundsBudget} rounds) exhausted without accept`;
    rounds.push({ round: round + 1, provider_slug: candidateSlug, provider_address: providerAddress, action: 'timeout', reason, tx_id: txId });
    emit({ type: 'round_end', round: round + 1, action: 'timeout', reason });
    return terminate({ done: true, success: false, reason });
  }

  /**
   * Shared accept+linkEscrow with atomic rollback. Used by both the
   * "accept the quote" and "accept the counter" terminal branches.
   */
  private async _commitAtAmount(
    txId: string,
    amountBaseUnits: string,
    candidateSlug: string,
    providerAddress: string,
    offer: QuoteOffer,
    round: number,
    rounds: RoundResult[],
    emit: (event: ProgressEvent) => void,
    sourceTag: string,
    counterRound: number,
  ): Promise<{ done: true; success: boolean; reason: string }> {
    let acceptQuoteSucceeded = false;
    try {
      await this.runtime.acceptQuote(txId, amountBaseUnits);
      acceptQuoteSucceeded = true;
      await this.runtime.linkEscrow(txId, amountBaseUnits);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (acceptQuoteSucceeded) {
        try { await this.runtime.transitionState(txId, 'CANCELLED'); } catch { /* best-effort */ }
      }
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'error',
        reason: `Commit failed (round ${counterRound + 1}): ${reason}`,
        tx_id: txId,
      });
      emit({ type: 'round_end', round: round + 1, action: 'error', reason });
      return { done: true, success: false, reason };
    }
    try {
      this.policyEngine.reserve(offer.commerce_session_id || '', this._baseUnitsForLog(amountBaseUnits), offer.currency);
    } catch { /* best-effort budget bookkeeping */ }

    const reason = `Committed at ${amountBaseUnits} base units (round ${counterRound + 1}, source: ${sourceTag})`;
    rounds.push({
      round: round + 1,
      provider_slug: candidateSlug,
      provider_address: providerAddress,
      action: 'accepted',
      reason,
      tx_id: txId,
      quoted_price: this._baseUnitsForLog(amountBaseUnits),
    });
    emit({ type: 'round_end', round: round + 1, action: 'accepted', reason });
    return { done: true, success: true, reason };
  }

  /**
   * Free per-tx negotiation state at terminal outcomes (accept commits,
   * reject CANCELLED, timeout). Closes the channel subscription too so
   * long-running daemon callers don't leak inbound-message resolvers.
   *
   * Idempotent — safe to call from multiple cleanup sites.
   */
  private _cleanupTxState(txId: string): void {
    this.inboundQueues.delete(txId);
    const pending = this.inboundResolvers.get(txId);
    if (pending) {
      // No more messages will arrive for this tx; resolve waiter as
      // a timeout-equivalent so awaiters don't hang.
      this.inboundResolvers.delete(txId);
      // Note: pending resolver expects a NegotiationMessage; we let
      // the timeout in _waitForNextMessage fire instead by NOT
      // calling pending here. The resolver is removed; setTimeout
      // wins on its own clock.
      void pending;
    }
    const sub = this.activeSubscriptions.get(txId);
    if (sub) {
      sub.unsubscribe();
      this.activeSubscriptions.delete(txId);
    }
  }

  /**
   * Display-only downcast: USDC base-units string → Number for the
   * RoundResult.quoted_price log field. Loses precision above
   * Number.MAX_SAFE_INTEGER / 1e6 (~$9 quadrillion) but every
   * comparison the orchestrator actually MAKES uses the bigint
   * string. The on-chain tx.amount is the source of truth.
   */
  private _baseUnitsForLog(baseUnitsStr: string): number {
    return Number(BigInt(baseUnitsStr)) / 1_000_000;
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Poll until tx reaches one of the target states.
   * Returns the reached state, or null on timeout/cancelled.
   * Resilient to transient RPC errors (retries until deadline).
   */
  private async waitForState(
    txId: string,
    targetStates: string[],
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const tx = await this.runtime.getTransaction(txId);
        if (tx && targetStates.includes(tx.state)) return tx.state;
        // Exit early if CANCELLED by provider
        if (tx && tx.state === 'CANCELLED') return null;
      } catch {
        // Transient error (RPC timeout, network blip) — keep polling until deadline
      }

      await this.sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  private mapToCandidateStats(agents: DiscoverAgent[]): CandidateStats[] {
    return agents
      .filter(a => a.wallet_address && a.published_config?.pricing)
      .map(a => ({
        slug: a.slug,
        unit_price: typeof a.published_config!.pricing!.amount === 'string'
          ? parseFloat(a.published_config!.pricing!.amount)
          : (a.published_config!.pricing!.amount ?? 0),
        reputation_score: a.stats?.reputation_score ?? 0,
        success_rate: a.stats?.success_rate ?? 0,
        avg_completion_time_seconds: a.stats?.avg_completion_time_seconds ?? null,
        completed_transactions: a.stats?.completed_transactions ?? 0,
      }));
  }

  private findAgentAddress(agents: DiscoverAgent[], slug: string): string {
    return agents.find(a => a.slug === slug)?.wallet_address ?? '';
  }

  private findAgentPrice(agents: DiscoverAgent[], slug: string): number {
    const agent = agents.find(a => a.slug === slug);
    const amount = agent?.published_config?.pricing?.amount;
    if (typeof amount === 'string') return parseFloat(amount);
    return amount ?? 0;
  }

  private findAgentReputation(agents: DiscoverAgent[], slug: string): number | undefined {
    return agents.find(a => a.slug === slug)?.stats?.reputation_score;
  }

  /** Convert a USDC amount (e.g. 0.80) to base units string (e.g. "800000") */
  private toBaseUnits(amount: number): string {
    return String(Math.round(amount * 1_000_000));
  }
}
