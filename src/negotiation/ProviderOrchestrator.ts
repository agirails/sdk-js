/**
 * ProviderOrchestrator — autonomous provider-side quote flow.
 *
 * Symmetric to BuyerOrchestrator but smaller: one decision per incoming
 * request (quote-or-skip, at what price), one submitQuote tx on-chain,
 * one off-chain POST to the buyer's quote channel. Counter-offer
 * evaluation is delegated to the policy engine; counter-counter
 * strategies are Phase 3 territory and out of scope here.
 *
 * This module does NOT listen to the chain. Callers (Agent.ts in
 * Phase 3) surface an IncomingRequest + consumer endpoint; the
 * orchestrator decides + acts + returns the outcome.
 *
 * @module negotiation/ProviderOrchestrator
 * @see Protocol/aips/AIP-2.1-DRAFT.md §5.2
 */

import { Signer } from 'ethers';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import {
  CounterOfferBuilder,
  CounterOfferMessage,
} from '../builders/CounterOfferBuilder';
import { NonceManager, InMemoryNonceManager } from '../utils/NonceManager';
import { QuoteChannelClient } from '../transport/QuoteChannel';
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
  /** Provider's EOA signer — signs QuoteMessages. */
  signer: Signer;
  /** Kernel address the signer will use for EIP-712 domain. */
  kernelAddress: string;
  /** Chain id the signer is on (84532 or 8453). */
  chainId: number;
  /**
   * Nonce manager for provider's quote messages. Defaults to an
   * in-memory manager. Production providers should pass a persistent
   * one so restarts don't replay nonces (NonceManager has a FileBased
   * variant).
   */
  nonceManager?: NonceManager;
  /** Channel client for off-chain delivery. Defaults to a fresh one. */
  channel?: QuoteChannelClient;
}

export type QuoteDecision =
  | { action: 'quote'; amount: number; reason: string }
  | { action: 'skip'; reason: string; violations: ReadonlyArray<{ rule: string; detail: string }> };

export interface QuoteResult {
  decision: QuoteDecision;
  /** Set when action === 'quote' and both on-chain + off-chain calls succeeded. */
  quote?: QuoteMessage;
  /** Set when action === 'quote' and the off-chain POST failed (on-chain still succeeded — caller should retry channel only). */
  channelError?: string;
}

export type CounterDecision =
  | { action: 'accept'; reason: string }
  | { action: 'reject'; reason: string };

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
  private readonly nonceManager: NonceManager;
  private readonly channel: QuoteChannelClient;
  private readonly quoteBuilder: QuoteBuilder;
  private readonly counterVerifier: CounterOfferBuilder;

  constructor(cfg: ProviderOrchestratorConfig) {
    this.policy = cfg.policy;
    this.policyEngine = new ProviderPolicyEngine(cfg.policy);
    this.runtime = cfg.runtime;
    this.signer = cfg.signer;
    this.kernelAddress = cfg.kernelAddress;
    this.chainId = cfg.chainId;
    this.nonceManager = cfg.nonceManager ?? new InMemoryNonceManager();
    this.channel = cfg.channel ?? new QuoteChannelClient();
    this.quoteBuilder = new QuoteBuilder(this.signer, this.nonceManager);
    // Verifier side — builder instance is signer-independent for verify().
    // We hand it the same signer to keep the construction trivial.
    this.counterVerifier = new CounterOfferBuilder(this.signer, this.nonceManager);
  }

  /**
   * Decide whether to quote. Does NOT touch the chain — pure policy.
   * Use `quote()` below to act on the decision.
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
      amount: result.recommended_quote_amount!,
      reason: `Policy passed; recommended quote $${result.recommended_quote_amount}`,
    };
  }

  /**
   * Full quote flow: evaluate → build signed QuoteMessage → submit
   * on-chain → POST to buyer's endpoint.
   *
   * On-chain failure → throws (caller decides retry / cancel).
   * Off-chain POST failure → returns successfully with `channelError`
   * set so caller knows to retry only the delivery step. Preserves the
   * invariant "on-chain tx is what buyer observes regardless of our
   * off-chain delivery".
   */
  async quote(
    req: IncomingRequest,
    providerDID: string,
    consumerEndpoint?: string,
  ): Promise<QuoteResult> {
    const decision = this.evaluateRequest(req);
    if (decision.action === 'skip') {
      return { decision };
    }

    // Build + sign QuoteMessage.
    const quotedAmountBaseUnits = BigInt(Math.round(decision.amount * 1_000_000)).toString();
    const now = Math.floor(Date.now() / 1000);
    const quote = await this.quoteBuilder.build({
      txId: req.txId,
      provider: providerDID,
      consumer: req.consumer,
      quotedAmount: quotedAmountBaseUnits,
      originalAmount: req.offeredAmount,
      maxPrice: req.maxPrice,
      currency: 'USDC',
      decimals: 6,
      expiresAt: now + this.policyEngine.quoteTtlSeconds,
      chainId: this.chainId,
      kernelAddress: this.kernelAddress,
    });

    // On-chain: INITIATED → QUOTED, hash stored in tx.metadata.
    await this.runtime.submitQuote(req.txId, quote);

    // Off-chain: deliver the signed message so buyer can verify.
    // Caller may omit consumerEndpoint when the transport is handled
    // outside this orchestrator (e.g. Telegram, IPFS pubsub adapter).
    if (consumerEndpoint) {
      try {
        await this.channel.sendQuote(consumerEndpoint, quote);
      } catch (err) {
        return {
          decision,
          quote,
          channelError: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { decision, quote };
  }

  /**
   * Verify + evaluate a buyer counter-offer. Returns the decision;
   * does NOT send any response — Phase 3 wires the response path.
   *
   * @throws if the counter signature / band / expiry fails verify.
   */
  async evaluateCounter(counter: CounterOfferMessage): Promise<CounterDecision> {
    await this.counterVerifier.verify(counter, this.kernelAddress);
    const verdict = this.policyEngine.evaluateCounter(counter.counterAmount);
    // Engine returns `{decision, reason}`; orchestrator API uses
    // `{action, reason}` — reshape at the boundary.
    return { action: verdict.decision, reason: verdict.reason };
  }

  /** Read-only policy accessor for UIs and tests. */
  getPolicy(): ProviderPolicy {
    return this.policy;
  }
}
