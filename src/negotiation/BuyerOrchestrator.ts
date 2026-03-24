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

import { discoverAgents, DiscoverAgent, DiscoverParams } from '../api/agirailsApp';
import { PolicyEngine, BuyerPolicy, QuoteOffer } from './PolicyEngine';
import { DecisionEngine, CandidateStats } from './DecisionEngine';
import { SessionStore } from './SessionStore';
import { IACTPRuntime, CreateTransactionParams } from '../runtime/IACTPRuntime';

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

export class BuyerOrchestrator {
  private policy: BuyerPolicy;
  private policyEngine: PolicyEngine;
  private decisionEngine: DecisionEngine;
  private sessionStore: SessionStore;
  private runtime: IACTPRuntime;
  private requesterAddress: string;

  constructor(
    policy: BuyerPolicy,
    runtime: IACTPRuntime,
    requesterAddress: string,
    actpDir?: string,
  ) {
    this.policy = policy;
    this.runtime = runtime;
    this.requesterAddress = requesterAddress;
    this.policyEngine = new PolicyEngine(policy, actpDir);
    this.decisionEngine = new DecisionEngine(policy.selection.weights);
    this.sessionStore = new SessionStore(actpDir);
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
