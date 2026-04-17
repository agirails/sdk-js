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
import { IACTPRuntime, CreateTransactionParams } from '../runtime/IACTPRuntime';
import { QuoteMessage } from '../builders/QuoteBuilder';
import { CounterOfferBuilder } from '../builders/CounterOfferBuilder';
import { QuoteChannelClient } from '../transport/QuoteChannel';
import { NonceManager, InMemoryNonceManager } from '../utils/NonceManager';
import { verifyQuoteHashOnChain, VerifySource } from './verifyQuoteOnChain';

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
 * AIP-2.1 extras — all optional so existing constructor call sites
 * keep working unchanged. Wire them in when the caller wants real
 * negotiation (counter-offers). Without them the orchestrator still
 * runs the fixed-price flow.
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
  /** Off-chain transport used to POST counter-offers. */
  channel?: QuoteChannelClient;
}

/**
 * Cached context for a received quote. Pushed by caller via
 * `setReceivedQuote` when their quote-channel handler validates an
 * incoming provider quote.
 */
interface ReceivedQuote {
  quote: QuoteMessage;
  /** Endpoint to POST counter-offers to (provider's quote channel). */
  providerEndpoint?: string;
  /** Provider EOA address — used for legacy hash fallback. */
  providerAddress?: string;
  /** tx.amount at QUOTED — used for legacy hash fallback. */
  actualEscrow?: string;
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

  /** Quotes pushed in by the caller's quote-channel handler, keyed by txId. */
  private receivedQuotes = new Map<string, ReceivedQuote>();
  /** Provider-acceptance-of-counter signal, keyed by txId. */
  private counterAccepted = new Map<string, { amountBaseUnits: string }>();
  /** Resolvers waiting on counter acceptance — woken by setCounterAccepted. */
  private counterWaiters = new Map<string, () => void>();

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

  /**
   * Push a verified QuoteMessage into the orchestrator. Callers wire
   * this from their QuoteChannel handler so the negotiation loop can
   * pick it up on the next poll tick.
   *
   * Caller is responsible for validating the signature before pushing
   * (the QuoteChannel handler already does this); the orchestrator
   * layers on top by cross-referencing against on-chain hash (with
   * legacy fallback, §3.6).
   */
  setReceivedQuote(
    txId: string,
    quote: QuoteMessage,
    opts: { providerEndpoint?: string; providerAddress?: string; actualEscrow?: string } = {},
  ): void {
    this.receivedQuotes.set(txId, {
      quote,
      providerEndpoint: opts.providerEndpoint,
      providerAddress: opts.providerAddress,
      actualEscrow: opts.actualEscrow,
    });
  }

  /**
   * Signal that the provider has accepted our counter-offer off-chain.
   * Callers wire this from their quote-channel handler when an
   * "accepted" notification arrives. Wakes any negotiation round
   * waiting on counter acceptance for this txId.
   */
  setCounterAccepted(txId: string, finalAmountBaseUnits: string): void {
    this.counterAccepted.set(txId, { amountBaseUnits: finalAmountBaseUnits });
    const waiter = this.counterWaiters.get(txId);
    if (waiter) {
      waiter();
      this.counterWaiters.delete(txId);
    }
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

      // 3d-bis. AIP-2.1 negotiation branch: if the caller pushed in a
      // signed QuoteMessage via setReceivedQuote, verify it against
      // on-chain hash (with legacy fallback) and run evaluateQuote.
      // The branch ONLY triggers when reachedState === 'QUOTED' — the
      // COMMITTED fast-path below bypasses negotiation entirely because
      // the provider already locked the deal at buyer's offered amount.
      if (reachedState === 'QUOTED') {
        const received = this.receivedQuotes.get(txId);
        if (received) {
          const negResult = await this._runNegotiationRound({
            txId,
            received,
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
   * Run a negotiation decision for a single incoming provider quote.
   * Called ONLY when the caller has pushed in a signed QuoteMessage via
   * setReceivedQuote and the tx has reached QUOTED on-chain.
   *
   * Returns `{ done: true, success: bool, reason }` when a terminal
   * decision is reached (accept landed COMMITTED, or candidate rejected).
   * Returns `{ done: false }` when the caller should fall through to the
   * existing fixed-price flow (verification failed, missing negotiation
   * context, etc).
   */
  private async _runNegotiationRound(args: {
    txId: string;
    received: ReceivedQuote;
    candidateSlug: string;
    providerAddress: string;
    offer: QuoteOffer;
    round: number;
    rounds: RoundResult[];
    emit: (event: ProgressEvent) => void;
  }): Promise<{ done: boolean; success?: boolean; reason?: string }> {
    const { txId, received, candidateSlug, providerAddress, offer, round, rounds, emit } = args;

    // Any `done: true` return from this method means the tx reached a
    // terminal decision — cleanup per-tx state before returning so
    // long-running daemon callers don't accumulate entries in
    // receivedQuotes / counterAccepted over thousands of negotiations.
    const terminate = (
      result: { done: true; success: boolean; reason: string },
    ): { done: true; success: boolean; reason: string } => {
      this._cleanupTxState(txId);
      return result;
    };

    // 1. Cross-reference the off-chain quote with the on-chain hash.
    //    Without a match we cannot trust the pushed message, so fall
    //    through to the existing fixed-price flow rather than negotiate
    //    on unverified data.
    const onChainTx = await this.runtime.getTransaction(txId);
    const onChainHash = onChainTx && (onChainTx as unknown as { quoteHash?: string | null }).quoteHash;
    if (!onChainHash) {
      // Drop the pushed quote even though we're falling through to the
      // fixed-price flow — keeping it would leak memory in daemon-style
      // runners. The pushed quote was specific to THIS round; if a new
      // (real) quote arrives later for the same txId, callers must push
      // again. Targeted cleanup here pairs with terminate() on the
      // done:true paths.
      this._cleanupTxState(txId);
      return { done: false };
    }
    const verify = verifyQuoteHashOnChain(received.quote, onChainHash, {
      providerAddress: received.providerAddress,
      actualEscrow: received.actualEscrow,
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
    // Attach source tag onto the round record for observability.
    const hashSource: VerifySource = verify.source!;

    // 2. Decide accept / counter / reject.
    const evaluation = this.decisionEngine.evaluateQuote(received.quote, this.policy);

    if (evaluation.action === 'reject') {
      try {
        await this.runtime.transitionState(txId, 'CANCELLED');
      } catch {
        // Best-effort; if the tx is already terminal the cancel call
        // may revert and that's fine.
      }
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'rejected',
        reason: `${evaluation.reason} (quote source: ${hashSource})`,
        tx_id: txId,
        quoted_price: this._baseUnitsForLog(received.quote.quotedAmount),
      });
      emit({ type: 'round_end', round: round + 1, action: 'rejected', reason: evaluation.reason });
      return terminate({ done: true, success: false, reason: evaluation.reason });
    }

    if (evaluation.action === 'accept') {
      // Commit at provider's quoted amount. AIP-2 sequence:
      //   acceptQuote(txId, quotedAmount) → updates tx.amount,
      //   linkEscrow(txId, quotedAmount) → COMMITTED.
      const amountBaseUnits = received.quote.quotedAmount;
      try {
        await this.runtime.acceptQuote(txId, amountBaseUnits);
        await this.runtime.linkEscrow(txId, amountBaseUnits);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        rounds.push({
          round: round + 1,
          provider_slug: candidateSlug,
          provider_address: providerAddress,
          action: 'error',
          reason: `Accept flow failed: ${reason}`,
          tx_id: txId,
        });
        emit({ type: 'round_end', round: round + 1, action: 'error', reason });
        return terminate({ done: true, success: false, reason });
      }
      // Update local ledger for daily-spend accounting; tolerate
      // reservation failure (it's bookkeeping — the on-chain escrow
      // is already locked).
      try {
        this.policyEngine.reserve(offer.commerce_session_id || '', this._baseUnitsForLog(amountBaseUnits), offer.currency);
      } catch {
        // swallow
      }
      const reason = `Quote accepted at ${amountBaseUnits} base units (source: ${hashSource})`;
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
      return terminate({ done: true, success: true, reason });
    }

    // evaluation.action === 'counter'.
    if (!this.counterBuilder || !this.negotiation.kernelAddress || !this.negotiation.chainId) {
      // Caller requested counter-offers but didn't wire the signer.
      // Log + fall through to accept/reject at max guard rails
      // (treating as if counter_strategy were 'walk' would be less
      // surprising than silently accepting above target).
      try {
        await this.runtime.transitionState(txId, 'CANCELLED');
      } catch {
        /* best-effort */
      }
      const reason = 'counter_strategy set but no signer/kernelAddress/chainId in BuyerNegotiationContext';
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'error',
        reason,
        tx_id: txId,
      });
      emit({ type: 'round_end', round: round + 1, action: 'error', reason });
      return terminate({ done: true, success: false, reason });
    }

    // Build + send counter-offer. Then wait for provider's off-chain
    // acceptance (setCounterAccepted) or timeout.
    const channel = this.negotiation.channel ?? new QuoteChannelClient();
    const counterTtlSec = this.policy.negotiation.counter_response_ttl_seconds
      ?? PolicyEngine.parseTtl(this.policy.negotiation.quote_ttl);
    const now = Math.floor(Date.now() / 1000);

    let counter;
    try {
      counter = await this.counterBuilder.build({
        txId,
        consumer: `did:ethr:${this.negotiation.chainId}:${(await this.negotiation.signer!.getAddress()).toLowerCase()}`,
        provider: received.quote.provider,
        quoteAmount: received.quote.quotedAmount,
        counterAmount: evaluation.amountBaseUnits,
        maxPrice: received.quote.maxPrice,
        inReplyTo: verify.canonicalHash!,
        chainId: this.negotiation.chainId,
        kernelAddress: this.negotiation.kernelAddress,
        expiresAt: now + counterTtlSec,
      });
    } catch (err) {
      const reason = `Counter build failed: ${err instanceof Error ? err.message : String(err)}`;
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'error',
        reason,
        tx_id: txId,
      });
      emit({ type: 'round_end', round: round + 1, action: 'error', reason });
      return terminate({ done: true, success: false, reason });
    }

    // Without an endpoint we have nowhere to deliver the signed counter.
    // Cancel immediately rather than wait counter_response_ttl seconds
    // for a provider that can't possibly hear from us.
    if (!received.providerEndpoint) {
      try {
        await this.runtime.transitionState(txId, 'CANCELLED');
      } catch {
        /* best-effort */
      }
      const reason = 'Cannot deliver counter — no providerEndpoint set on received quote';
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'error',
        reason,
        tx_id: txId,
      });
      emit({ type: 'round_end', round: round + 1, action: 'error', reason });
      return terminate({ done: true, success: false, reason });
    }

    try {
      await channel.sendCounter(received.providerEndpoint, counter);
    } catch (err) {
      const reason = `Counter channel POST failed: ${err instanceof Error ? err.message : String(err)}`;
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'error',
        reason,
        tx_id: txId,
      });
      emit({ type: 'round_end', round: round + 1, action: 'error', reason });
      return terminate({ done: true, success: false, reason });
    }

    // Wait for provider's acceptance signal or timeout.
    const accepted = await this._waitForCounterAcceptance(txId, counterTtlSec * 1000);
    if (!accepted) {
      try {
        await this.runtime.transitionState(txId, 'CANCELLED');
      } catch {
        /* best-effort */
      }
      const reason = `Counter acceptance not received within ${counterTtlSec}s`;
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'timeout',
        reason,
        tx_id: txId,
      });
      emit({ type: 'round_end', round: round + 1, action: 'timeout', reason });
      return terminate({ done: true, success: false, reason });
    }

    const finalAmount = accepted.amountBaseUnits;
    try {
      await this.runtime.acceptQuote(txId, finalAmount);
      await this.runtime.linkEscrow(txId, finalAmount);
    } catch (err) {
      const reason = `Accept-counter flow failed: ${err instanceof Error ? err.message : String(err)}`;
      rounds.push({
        round: round + 1,
        provider_slug: candidateSlug,
        provider_address: providerAddress,
        action: 'error',
        reason,
        tx_id: txId,
      });
      emit({ type: 'round_end', round: round + 1, action: 'error', reason });
      return terminate({ done: true, success: false, reason });
    }
    const reason = `Counter accepted at ${finalAmount} base units (source: ${hashSource})`;
    rounds.push({
      round: round + 1,
      provider_slug: candidateSlug,
      provider_address: providerAddress,
      action: 'accepted',
      reason,
      tx_id: txId,
      quoted_price: this._baseUnitsForLog(finalAmount),
    });
    emit({ type: 'round_end', round: round + 1, action: 'accepted', reason });
    return terminate({ done: true, success: true, reason });
  }

  /** Resolve when setCounterAccepted(txId, …) is called, or on timeout. */
  private async _waitForCounterAcceptance(
    txId: string,
    timeoutMs: number,
  ): Promise<{ amountBaseUnits: string } | null> {
    // Already accepted before we started waiting? Return immediately.
    const existing = this.counterAccepted.get(txId);
    if (existing) return existing;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.counterWaiters.delete(txId);
        resolve(null);
      }, timeoutMs);
      this.counterWaiters.set(txId, () => {
        clearTimeout(timer);
        resolve(this.counterAccepted.get(txId) ?? null);
      });
    });
  }

  /**
   * Free per-tx negotiation state at terminal outcomes (accept commits,
   * reject CANCELLED, timeout). Long-running daemon-style runners would
   * otherwise leak both maps unbounded as txIds accumulate.
   *
   * Idempotent — safe to call from multiple cleanup sites.
   */
  private _cleanupTxState(txId: string): void {
    this.receivedQuotes.delete(txId);
    this.counterAccepted.delete(txId);
    this.counterWaiters.delete(txId);
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
