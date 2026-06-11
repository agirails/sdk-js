/**
 * ProviderOrchestrator — autonomous provider-side negotiation flow.
 *
 * Two responsibilities:
 *
 *   1. Accept an incoming request → decide whether to quote → if yes,
 *      build + sign a QuoteMessage, anchor on-chain via submitQuote,
 *      post it on the NegotiationChannel for the buyer.
 *
 *   2. (3.5.0) Run a long-lived `start()` listener on the channel:
 *      every counter that arrives is evaluated against ProviderPolicy;
 *      based on `counter_strategy` we either auto-accept (build + post
 *      CounterAcceptMessage), auto-requote (build + post a new
 *      QuoteMessage with the conceded amount), or walk (log + drop).
 *
 * Symmetric to BuyerOrchestrator's channel-driven multi-round loop —
 * together they implement the full AIP-2.1 §6 negotiation protocol
 * without either party needing to host an HTTP endpoint.
 *
 * @module negotiation/ProviderOrchestrator
 * @see Protocol/aips/AIP-2.1.md §5.2 (provider quote flow)
 * @see Protocol/aips/AIP-2.1.md §6 (NegotiationChannel)
 */

import { Signer } from 'ethers';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import {
  CounterOfferBuilder,
  CounterOfferMessage,
} from '../builders/CounterOfferBuilder';
import {
  CounterAcceptBuilder,
} from '../builders/CounterAcceptBuilder';
import { NonceManager, InMemoryNonceManager } from '../utils/NonceManager';
import {
  NegotiationChannel,
  Subscription,
  isCounterOfferEnvelope,
} from './NegotiationChannel';
import {
  ProviderPolicy,
  ProviderPolicyEngine,
  IncomingRequest,
} from './ProviderPolicy';

// ============================================================================
// Types
// ============================================================================

export interface ProviderOrchestratorConfig {
  policy: ProviderPolicy;
  runtime: IACTPRuntime;
  /** Provider's EOA signer — signs QuoteMessages + CounterAcceptMessages. */
  signer: Signer;
  /** Kernel address for EIP-712 domain. */
  kernelAddress: string;
  /** Chain id (84532 or 8453). */
  chainId: number;
  /**
   * Provider's DID — used for `subscribeAgent` filter on the channel
   * AND as the `provider` field on outbound QuoteMessage /
   * CounterAcceptMessage. Required for `start()`.
   */
  providerDID?: string;
  /**
   * Persistent nonce manager. Defaults to in-memory (fine for dev;
   * production should pass a FileBased one so restarts don't replay).
   */
  nonceManager?: NonceManager;
  /**
   * Negotiation channel. Required for `start()` long-running mode.
   * Optional for the one-shot `quote()` method (caller may handle
   * delivery via direct HTTP / IPFS / etc).
   */
  negotiationChannel?: NegotiationChannel;
  /**
   * Logger for observability. Default: noop. `actp agent` wires this
   * to its terminal Output.
   */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * BYO-brain: override the accept/reject/requote decision. When omitted, the
   * built-in ProviderPolicyEngine is used (zero behavior change). Signature
   * verification ALWAYS runs first regardless. Async-tolerant for LLM deciders.
   */
  counterDecider?: CounterDecider;
}

export type QuoteDecision =
  | {
      action: 'quote';
      /** Quote amount in base units (bigint-as-string) to avoid float drift. */
      amountBaseUnits: string;
      reason: string;
    }
  | { action: 'skip'; reason: string; violations: ReadonlyArray<{ rule: string; detail: string }> };

export interface QuoteResult {
  decision: QuoteDecision;
  /** Set when action === 'quote' and on-chain anchoring succeeded. */
  quote?: QuoteMessage;
  /** Set when channel post failed (on-chain still succeeded). */
  channelError?: string;
}

export type CounterDecision =
  | { action: 'accept'; reason: string }
  | { action: 'reject'; reason: string }
  | { action: 'requote'; amountBaseUnits: string; reason: string };

/**
 * Context handed to a provider counter-decider. Surfaces everything the
 * built-in ProviderPolicyEngine.evaluateCounter reads (floor = pricing
 * .min_acceptable, counter_strategy, concede_pct, max_requotes all live on
 * `policy`) plus the per-tx baseline, so a BYO decider isn't blind. The counter
 * is ALREADY signature/band/expiry verified before the decider runs.
 */
export interface CounterContext {
  /** Verified incoming counter (counter.counterAmount = buyer's bid). */
  counter: CounterOfferMessage;
  /** Provider's most recent quote amount for this tx (base units). */
  lastQuoteAmountBaseUnits: string;
  /** Re-quotes already sent this tx (0 on first counter). */
  requotesUsed: number;
  /** Provider policy (floor, counter_strategy, concede_pct, max_requotes). */
  policy: ProviderPolicy;
}

/**
 * BYO-brain hook for the accept/reject/requote decision. Async-tolerant.
 * Verification is NOT part of the hook — it always runs before the decider.
 * Contract: a 'requote'.amountBaseUnits MUST be a valid quote amount (>= the
 * provider floor), else quoteBuilder.build throws deep in the re-quote path
 * (caught by start()'s handler try/catch).
 */
export type CounterDecider = (
  ctx: CounterContext,
) => CounterDecision | Promise<CounterDecision>;

/** Per-tx state the orchestrator tracks while listening on the channel. */
interface TxState {
  /** Provider's most recent QuoteMessage for this tx (initial or re-quote). */
  lastQuote: QuoteMessage;
  /** How many re-quotes we've sent so far (0 = only initial quote). */
  requotesUsed: number;
  /** Buyer's DID — captured from incoming counter so we can address acceptance. */
  consumerDID: string;
}

// ============================================================================
// Orchestrator
// ============================================================================

export class ProviderOrchestrator {
  private readonly policy: ProviderPolicy;
  private readonly policyEngine: ProviderPolicyEngine;
  private readonly runtime: IACTPRuntime;
  private readonly signer: Signer;
  private readonly kernelAddress: string;
  private readonly chainId: number;
  private readonly providerDID?: string;
  private readonly nonceManager: NonceManager;
  private readonly negotiationChannel?: NegotiationChannel;
  private readonly quoteBuilder: QuoteBuilder;
  private readonly counterVerifier: CounterOfferBuilder;
  private readonly counterAcceptBuilder: CounterAcceptBuilder;
  private readonly log: NonNullable<ProviderOrchestratorConfig['log']>;
  private readonly counterDecider?: CounterDecider;

  /** Per-tx state for the multi-round counter listener. */
  private readonly txStates = new Map<string, TxState>();
  /** Active channel subscription opened by `start()`. */
  private channelSubscription?: Subscription;

  constructor(cfg: ProviderOrchestratorConfig) {
    this.policy = cfg.policy;
    this.policyEngine = new ProviderPolicyEngine(cfg.policy);
    this.runtime = cfg.runtime;
    this.signer = cfg.signer;
    this.kernelAddress = cfg.kernelAddress;
    this.chainId = cfg.chainId;
    this.providerDID = cfg.providerDID;
    this.nonceManager = cfg.nonceManager ?? new InMemoryNonceManager();
    this.negotiationChannel = cfg.negotiationChannel;
    this.log = cfg.log ?? (() => undefined);
    this.counterDecider = cfg.counterDecider;
    this.quoteBuilder = new QuoteBuilder(this.signer, this.nonceManager);
    this.counterVerifier = new CounterOfferBuilder(); // verify-only
    this.counterAcceptBuilder = new CounterAcceptBuilder(this.signer, this.nonceManager);
  }

  // --------------------------------------------------------------------------
  // One-shot quote (caller-driven)
  // --------------------------------------------------------------------------

  /**
   * Decide whether to quote. Pure policy — no chain, no channel.
   */
  evaluateRequest(req: IncomingRequest): QuoteDecision {
    const result = this.policyEngine.evaluate(req);
    if (!result.allowed) {
      return {
        action: 'skip',
        reason: result.violations.map((v) => `${v.rule}: ${v.detail}`).join('; '),
        violations: result.violations,
      };
    }
    return {
      action: 'quote',
      amountBaseUnits: result.recommended_quote_amount_base_units!,
      reason: `Policy passed; recommended quote ${result.recommended_quote_amount_base_units} base units`,
    };
  }

  /**
   * Full quote flow: evaluate → build signed QuoteMessage → submit
   * on-chain → post on negotiationChannel.
   *
   * Channel post failure is non-fatal: on-chain anchor succeeded so
   * buyer can still observe the quote, just won't see the off-chain
   * signed body. Caller can retry channel post separately.
   */
  async quote(req: IncomingRequest, providerDID: string): Promise<QuoteResult> {
    const decision = this.evaluateRequest(req);
    if (decision.action === 'skip') return { decision };

    const now = Math.floor(Date.now() / 1000);
    const currency = this.policyEngine.policyCurrency;
    const decimals = currency.toUpperCase() === 'USDC' ? 6 : 6;
    const quote = await this.quoteBuilder.build({
      txId: req.txId,
      provider: providerDID,
      consumer: req.consumer,
      quotedAmount: decision.amountBaseUnits,
      originalAmount: req.offeredAmount,
      maxPrice: req.maxPrice,
      currency,
      decimals,
      expiresAt: now + this.policyEngine.quoteTtlSeconds,
      chainId: this.chainId,
      kernelAddress: this.kernelAddress,
    });

    await this.runtime.submitQuote(req.txId, quote);

    if (this.negotiationChannel) {
      try {
        await this.negotiationChannel.post(req.txId, { type: 'agirails.quote.v1', message: quote });
      } catch (err) {
        return { decision, quote, channelError: err instanceof Error ? err.message : String(err) };
      }
    }

    // Seed per-tx state so a follow-up counter is evaluated with the
    // right `lastQuote` baseline if the listener is running.
    this.txStates.set(req.txId, {
      lastQuote: quote,
      requotesUsed: 0,
      consumerDID: req.consumer,
    });

    return { decision, quote };
  }

  // --------------------------------------------------------------------------
  // Long-running listener (channel-driven, multi-round)
  // --------------------------------------------------------------------------

  /**
   * Subscribe to the negotiation channel and auto-respond to incoming
   * counter-offers per `counter_strategy`. Idempotent — calling start()
   * twice replaces the previous subscription.
   *
   * Returns a Subscription so the caller can stop the daemon cleanly.
   *
   * @throws if `negotiationChannel` or `providerDID` was not set in config.
   */
  async start(): Promise<Subscription> {
    if (!this.negotiationChannel) {
      throw new Error('ProviderOrchestrator.start() requires negotiationChannel in config');
    }
    if (!this.providerDID) {
      throw new Error('ProviderOrchestrator.start() requires providerDID in config');
    }

    // Replace any prior subscription.
    if (this.channelSubscription) {
      this.channelSubscription.unsubscribe();
    }

    const sub = this.negotiationChannel.subscribeAgent(this.providerDID, async (txId, delivered) => {
      if (!isCounterOfferEnvelope(delivered.envelope)) return;
      try {
        await this._handleIncomingCounter(txId, delivered.envelope.message);
      } catch (err) {
        this.log('error', `Counter handler crashed for tx ${txId.slice(0, 12)}…: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.channelSubscription = sub;
    this.log('info', `ProviderOrchestrator listening on channel for ${this.providerDID}`);
    return {
      unsubscribe: () => {
        sub.unsubscribe();
        this.channelSubscription = undefined;
        this.log('info', 'ProviderOrchestrator stopped');
      },
    };
  }

  /**
   * Stop the active channel subscription if any. Idempotent.
   */
  stop(): void {
    if (this.channelSubscription) {
      this.channelSubscription.unsubscribe();
      this.channelSubscription = undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Single-shot counter evaluation (tests + callers that want manual control)
  // --------------------------------------------------------------------------

  /**
   * Verify + evaluate a buyer counter-offer. Returns the decision
   * (accept / reject / requote with concession amount). Does NOT send
   * any response — caller drives the next step. Use `start()` for
   * autonomous operation.
   *
   * `lastQuoteAmountBaseUnits` — provider's most recent quote amount
   * for this tx. On the first counter pass `counter.quoteAmount`.
   *
   * `requotesUsed` — defaults to 0; pass the real count for multi-round.
   *
   * @throws if the counter signature / band / expiry fails verify.
   */
  async evaluateCounter(
    counter: CounterOfferMessage,
    lastQuoteAmountBaseUnits?: string,
    requotesUsed = 0,
  ): Promise<CounterDecision> {
    await this.counterVerifier.verify(counter, this.kernelAddress); // always runs — verify is mandatory
    const lastAmount = lastQuoteAmountBaseUnits ?? counter.quoteAmount;

    // BYO-brain: a custom decider replaces ONLY the decision (verify above
    // still ran). When absent, the built-in policy engine runs verbatim.
    if (this.counterDecider) {
      return await this.counterDecider({
        counter,
        lastQuoteAmountBaseUnits: lastAmount,
        requotesUsed,
        policy: this.policy,
      });
    }

    const verdict = this.policyEngine.evaluateCounter(counter.counterAmount, lastAmount, requotesUsed);
    if (verdict.decision === 'requote') {
      return { action: 'requote', amountBaseUnits: verdict.amountBaseUnits!, reason: verdict.reason };
    }
    return { action: verdict.decision, reason: verdict.reason };
  }

  /** Read-only policy accessor for UIs and tests. */
  getPolicy(): ProviderPolicy {
    return this.policy;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async _handleIncomingCounter(txId: string, counter: CounterOfferMessage): Promise<void> {
    if (!this.providerDID || !this.negotiationChannel) return;

    // Look up per-tx state. If we never quoted (counter arrived without
    // prior `quote()` call), we still process — `counter.quoteAmount`
    // is the provider's quote per buyer's view, so we use it as baseline.
    const state = this.txStates.get(txId) ?? {
      lastQuote: null as unknown as QuoteMessage,
      requotesUsed: 0,
      consumerDID: counter.consumer,
    };
    const lastAmount = state.lastQuote?.quotedAmount ?? counter.quoteAmount;

    let decision: CounterDecision;
    try {
      decision = await this.evaluateCounter(counter, lastAmount, state.requotesUsed);
    } catch (err) {
      this.log('warn', `[counter] tx=${txId.slice(0, 12)}… verify failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.log('info', `[counter] tx=${txId.slice(0, 12)}… counter=${counter.counterAmount} → ${decision.action}: ${decision.reason}`);

    if (decision.action === 'accept') {
      const accept = await this.counterAcceptBuilder.build({
        txId,
        provider: this.providerDID,
        consumer: counter.consumer,
        acceptedAmount: counter.counterAmount,
        inReplyTo: new CounterOfferBuilder().computeHash(counter),
        chainId: this.chainId,
        kernelAddress: this.kernelAddress,
      });
      await this.negotiationChannel.post(txId, { type: 'agirails.counteraccept.v1', message: accept });
      this.txStates.delete(txId); // terminal
      return;
    }

    if (decision.action === 'requote') {
      const now = Math.floor(Date.now() / 1000);
      const currency = this.policyEngine.policyCurrency;
      const decimals = currency.toUpperCase() === 'USDC' ? 6 : 6;
      // QuoteBuilder enforces `quotedAmount >= originalAmount` (AIP-2
      // invariant: provider can't quote below buyer's offered amount).
      // For re-quotes the buyer's original amount lives on-chain
      // as tx.amount (set at createTransaction, immutable until
      // acceptQuote). Fall back to counter.counterAmount if read
      // fails (matches what buyer is willing to pay anyway).
      let originalAmount = counter.counterAmount;
      try {
        const onChainTx = await this.runtime.getTransaction(txId);
        if (onChainTx?.amount) originalAmount = String(onChainTx.amount);
      } catch {
        /* fall back to counter.counterAmount */
      }
      const newQuote = await this.quoteBuilder.build({
        txId,
        provider: this.providerDID,
        consumer: counter.consumer,
        quotedAmount: decision.amountBaseUnits,
        originalAmount,
        maxPrice: counter.maxPrice,
        currency,
        decimals,
        expiresAt: now + this.policyEngine.quoteTtlSeconds,
        chainId: this.chainId,
        kernelAddress: this.kernelAddress,
      });
      // Re-quotes are off-chain only — kernel forbids QUOTED → QUOTED.
      await this.negotiationChannel.post(txId, { type: 'agirails.quote.v1', message: newQuote });
      this.txStates.set(txId, {
        lastQuote: newQuote,
        requotesUsed: state.requotesUsed + 1,
        consumerDID: counter.consumer,
      });
      return;
    }

    // reject — let buyer's TTL expire to CANCELLED. Drop state.
    this.txStates.delete(txId);
  }
}
