/**
 * BuyerOrchestrator AIP-2.1 negotiation tests — focuses on the new
 * setReceivedQuote/setCounterAccepted + _runNegotiationRound path.
 *
 * Existing fixed-price flow is exercised by the rest of the test
 * suite; this file isolates the negotiation branch.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Wallet, HDNodeWallet } from 'ethers';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import { BuyerOrchestrator } from './BuyerOrchestrator';
import { BuyerPolicy } from './PolicyEngine';
import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import { CounterAcceptBuilder } from '../builders/CounterAcceptBuilder';
import { CounterOfferBuilder } from '../builders/CounterOfferBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import { QuoteChannelClient } from '../transport/QuoteChannel';
import * as agirailsApp from '../api/agirailsApp';

const KERNEL = '0x1234567890123456789012345678901234567890';

describe('BuyerOrchestrator — AIP-2.1 negotiation', () => {
  let testDir: string;
  let runtime: MockRuntime;
  let providerWallet: HDNodeWallet;
  let buyerWallet: HDNodeWallet;
  let providerDID: string;
  let consumerDID: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buyer-orch-neg-'));
    runtime = new MockRuntime(new MockStateManager(testDir));
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
    providerDID = `did:ethr:84532:${providerWallet.address}`;
    consumerDID = `did:ethr:84532:${buyerWallet.address}`;

    // Mock discoverAgents — shape matches what mapToCandidateStats
    // expects (filter requires published_config.pricing).
    jest.spyOn(agirailsApp, 'discoverAgents').mockResolvedValue({
      agents: [
        {
          slug: 'test-provider',
          wallet_address: providerWallet.address,
          name: 'Test Provider',
          description: 'mock',
          published_config: {
            pricing: { amount: '5', currency: 'USDC', unit: 'job' },
          },
          stats: {
            reputation_score: 80,
            success_rate: 95,
            avg_completion_time_seconds: 60,
            completed_transactions: 100,
          },
        } as unknown as agirailsApp.DiscoverAgent,
      ],
      total: 1,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function makePolicy(over: Partial<BuyerPolicy['negotiation']> & { target_unit_price?: BuyerPolicy['target_unit_price'] } = {}): BuyerPolicy {
    const { target_unit_price, ...neg } = over;
    return {
      task: 'code-review',
      constraints: {
        max_unit_price: { amount: 10, currency: 'USDC', unit: 'job' },
        max_daily_spend: { amount: 100, currency: 'USDC' },
      },
      negotiation: {
        rounds_max: 1,
        quote_ttl: '1m',
        ...neg,
      },
      selection: { prioritize: ['price'] },
      ...(target_unit_price ? { target_unit_price } : {}),
    };
  }

  async function preparePushedQuote(txId: string, quotedAmount: string): Promise<QuoteMessage> {
    // Provider builds + signs the quote and submits it via the
    // canonical runtime path (so on-chain hash matches).
    const builder = new QuoteBuilder(providerWallet, new InMemoryNonceManager());
    const quote = await builder.build({
      txId,
      provider: providerDID,
      consumer: consumerDID,
      quotedAmount,
      originalAmount: '5000000',
      maxPrice: '10000000',
      chainId: 84532,
      kernelAddress: KERNEL,
    });
    await runtime.submitQuote(txId, quote);
    return quote;
  }

  // ==========================================================================
  // accept path
  // ==========================================================================

  it('accepts a quote at-or-below target via the AIP-2.1 path (acceptQuote+linkEscrow at quote amount)', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const orch = new BuyerOrchestrator(
      makePolicy({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } }),
      runtime,
      buyerWallet.address,
      testDir,
    );

    // Spawn the negotiation in parallel; it'll createTransaction +
    // poll for QUOTED. Once we see INITIATED hit the chain we
    // submitQuote on the provider side and push the message in.
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });

    // Wait briefly for the orchestrator to issue createTransaction
    // (poll up to 2s).
    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    // Provider quotes $7 — within $8 target, so orchestrator accepts.
    const quote = await preparePushedQuote(txId!, '7000000');
    orch.setReceivedQuote(txId!, quote, {
      providerAddress: providerWallet.address,
      actualEscrow: '5000000',
    });

    const result = await negPromise;
    expect(result.success).toBe(true);
    const tx = await runtime.getTransaction(txId!);
    // Accept path: amount updated to provider's quote, escrow linked → COMMITTED.
    expect(tx!.amount).toBe('7000000');
    expect(tx!.state).toBe('COMMITTED');
  }, 10_000);

  // ==========================================================================
  // reject path (counter_strategy=walk above target)
  // ==========================================================================

  it('rejects quote above target with counter_strategy=walk (CANCELLED on-chain)', async () => {
    const orch = new BuyerOrchestrator(
      makePolicy({
        rounds_per_provider: 3,
        counter_strategy: 'walk',
        target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
      }),
      runtime,
      buyerWallet.address,
      testDir,
    );

    const negPromise = orch.negotiate({ pollIntervalMs: 50 });

    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    // Provider quotes $7, way above $5 target with walk strategy → reject.
    const quote = await preparePushedQuote(txId!, '7000000');
    orch.setReceivedQuote(txId!, quote, {
      providerAddress: providerWallet.address,
      actualEscrow: '5000000',
    });

    const result = await negPromise;
    expect(result.success).toBe(false);
    const tx = await runtime.getTransaction(txId!);
    expect(tx!.state).toBe('CANCELLED');
  }, 10_000);

  // ==========================================================================
  // counter path with provider acceptance
  // ==========================================================================

  it('counters and commits at counter amount when provider accepts in-window', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');

    // Capture the counter the buyer POSTs so the simulated provider
    // can sign a real CounterAcceptMessage that binds to it.
    let postedCounter: import('../builders/CounterOfferBuilder').CounterOfferMessage | undefined;
    const channel = new QuoteChannelClient({
      fetchImpl: (async (_url: string, init: { body?: string } = {}) => {
        if (init.body) {
          try {
            const parsed = JSON.parse(init.body);
            if (parsed?.type === 'agirails.counteroffer.v1' && parsed.message) {
              postedCounter = parsed.message;
            }
          } catch { /* not JSON, ignore */ }
        }
        return new Response('{}', { status: 201 });
      }) as unknown as typeof fetch,
      allowInsecureTargets: true,
    });

    const orch = new BuyerOrchestrator(
      makePolicy({
        rounds_per_provider: 3,
        counter_strategy: 'midpoint',
        target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
        counter_response_ttl_seconds: 5,
      }),
      runtime,
      buyerWallet.address,
      testDir,
      {
        signer: buyerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
        channel,
      },
    );

    const negPromise = orch.negotiate({ pollIntervalMs: 50 });

    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    // Provider quotes $7. Buyer counters at midpoint = ($7+$5)/2 = $6.
    const quote = await preparePushedQuote(txId!, '7000000');
    orch.setReceivedQuote(txId!, quote, {
      providerEndpoint: 'https://provider.test',
      providerAddress: providerWallet.address,
      actualEscrow: '5000000',
    });

    // Wait until buyer POSTs the counter, then provider signs an
    // acceptance bound to it (real EIP-712 verify path).
    (async () => {
      for (let i = 0; i < 100 && !postedCounter; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!postedCounter) return;
      const counterHash = new CounterOfferBuilder().computeHash(postedCounter);
      const accept = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
        txId: txId!,
        provider: providerDID,
        consumer: consumerDID,
        acceptedAmount: postedCounter.counterAmount,
        inReplyTo: counterHash,
        chainId: 84532,
        kernelAddress: KERNEL,
      });
      await orch.setCounterAccepted(txId!, accept);
    })();

    const result = await negPromise;
    expect(result.success).toBe(true);
    const tx = await runtime.getTransaction(txId!);
    expect(tx!.amount).toBe('6000000');
    expect(tx!.state).toBe('COMMITTED');
  }, 15_000);

  // ==========================================================================
  // counter timeout path
  // ==========================================================================

  it('cancels when provider does not accept counter within TTL', async () => {
    const channel = new QuoteChannelClient({
      fetchImpl: (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch,
      allowInsecureTargets: true,
    });

    const orch = new BuyerOrchestrator(
      makePolicy({
        rounds_per_provider: 3,
        counter_strategy: 'midpoint',
        target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
        counter_response_ttl_seconds: 1, // 1 second — quick timeout for the test
      }),
      runtime,
      buyerWallet.address,
      testDir,
      { signer: buyerWallet, kernelAddress: KERNEL, chainId: 84532, channel },
    );

    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    const quote = await preparePushedQuote(txId!, '7000000');
    orch.setReceivedQuote(txId!, quote, {
      providerEndpoint: 'https://provider.test',
      providerAddress: providerWallet.address,
      actualEscrow: '5000000',
    });
    // No setCounterAccepted call → provider "ignored" us → timeout.

    const result = await negPromise;
    expect(result.success).toBe(false);
    const tx = await runtime.getTransaction(txId!);
    expect(tx!.state).toBe('CANCELLED');
  }, 15_000);

  // ==========================================================================
  // counter without providerEndpoint must fail-fast (no TTL wait)
  // ==========================================================================

  it('counter path with no providerEndpoint cancels immediately, does not wait TTL', async () => {
    // counter_response_ttl_seconds is 60s. Test runs in well under 5s.
    // If we accidentally wait for the timeout, this fails on jest's
    // own test timeout long before the 60s expires.
    const channel = new QuoteChannelClient({
      fetchImpl: (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch,
      allowInsecureTargets: true,
    });
    const orch = new BuyerOrchestrator(
      makePolicy({
        rounds_per_provider: 3,
        counter_strategy: 'midpoint',
        target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
        counter_response_ttl_seconds: 60, // long TTL — must NOT be hit
      }),
      runtime,
      buyerWallet.address,
      testDir,
      { signer: buyerWallet, kernelAddress: KERNEL, chainId: 84532, channel },
    );

    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    // Push quote WITHOUT providerEndpoint — counter has nowhere to go.
    const quote = await preparePushedQuote(txId!, '7000000');
    orch.setReceivedQuote(txId!, quote, {
      providerAddress: providerWallet.address,
      actualEscrow: '5000000',
      // providerEndpoint deliberately omitted
    });

    const start = Date.now();
    const result = await negPromise;
    const elapsed = Date.now() - start;
    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(3000); // way under the 60s TTL
    const lastRound = result.rounds[result.rounds.length - 1];
    expect(lastRound.action).toBe('error');
    expect(lastRound.reason).toMatch(/no providerEndpoint/);
    const tx = await runtime.getTransaction(txId!);
    expect(tx!.state).toBe('CANCELLED');
  }, 10_000);

  // ==========================================================================
  // memory cleanup after terminal outcome
  // ==========================================================================

  it('frees per-tx state after a terminal negotiation outcome (memory hygiene)', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const orch = new BuyerOrchestrator(
      makePolicy({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } }),
      runtime,
      buyerWallet.address,
      testDir,
    );

    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    const quote = await preparePushedQuote(txId!, '7000000');
    orch.setReceivedQuote(txId!, quote, {
      providerAddress: providerWallet.address,
      actualEscrow: '5000000',
    });

    const result = await negPromise;
    expect(result.success).toBe(true);

    // Reach into private state to verify cleanup.
    const internal = orch as unknown as {
      receivedQuotes: Map<string, unknown>;
      counterAccepted: Map<string, unknown>;
      counterWaiters: Map<string, unknown>;
    };
    expect(internal.receivedQuotes.has(txId!)).toBe(false);
    expect(internal.counterAccepted.has(txId!)).toBe(false);
    expect(internal.counterWaiters.has(txId!)).toBe(false);
    expect((internal as unknown as { sentCounters: Map<string, unknown> }).sentCounters.has(txId!)).toBe(false);
  }, 10_000);

  // ==========================================================================
  // cleanup also fires on the done:false fallback path (no on-chain hash)
  // ==========================================================================

  it('frees per-tx state when negotiation falls through to fixed-price (done:false path)', async () => {
    // Scenario: tx reaches QUOTED via raw transitionState (legacy
    // path from a pre-AIP-2.1 agent that never wrote a canonical
    // hash). Orchestrator enters the negotiation branch, sees no
    // on-chain hash, returns done:false, falls through to fixed-
    // price flow. Pre-fix bug: the pushed quote stayed in
    // receivedQuotes forever because cleanup only ran via the
    // terminate() wrapper on done:true paths.
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const orch = new BuyerOrchestrator(
      makePolicy({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } }),
      runtime,
      buyerWallet.address,
      testDir,
    );

    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    // Push a quote the orchestrator can't verify on-chain.
    const builder = new QuoteBuilder(providerWallet, new InMemoryNonceManager());
    const orphanQuote = await builder.build({
      txId: txId!,
      provider: providerDID,
      consumer: consumerDID,
      quotedAmount: '7000000',
      originalAmount: '5000000',
      maxPrice: '10000000',
      chainId: 84532,
      kernelAddress: KERNEL,
    });
    orch.setReceivedQuote(txId!, orphanQuote, {
      providerAddress: providerWallet.address,
      actualEscrow: '5000000',
    });

    // Transition to QUOTED via the raw path — simulates a legacy
    // agent that uses transitionState(QUOTED, ...) without the
    // canonical hash format. Mock runtime stores no quoteHash in
    // this path, so the negotiation branch's onChainHash check
    // returns null → done:false with cleanup.
    setTimeout(async () => {
      try {
        await runtime.transitionState(txId!, 'QUOTED');
      } catch {
        /* best-effort */
      }
    }, 100);

    await negPromise;
    const internal = orch as unknown as { receivedQuotes: Map<string, unknown> };
    expect(internal.receivedQuotes.has(txId!)).toBe(false);
  }, 10_000);

  // ==========================================================================
  // hash-mismatch path falls through to legacy or rejects
  // ==========================================================================

  it('rejects when received quote does not match on-chain hash (no legacy fallback context)', async () => {
    const orch = new BuyerOrchestrator(
      makePolicy({
        rounds_per_provider: 3,
        counter_strategy: 'walk',
        target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
      }),
      runtime,
      buyerWallet.address,
      testDir,
    );

    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    let txId: string | undefined;
    for (let i = 0; i < 40; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) {
        txId = all[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(txId).toBeDefined();

    // Submit one quote on-chain, push a DIFFERENT quote to the orchestrator.
    await preparePushedQuote(txId!, '7000000');
    const otherBuilder = new QuoteBuilder(providerWallet, new InMemoryNonceManager());
    const wrongQuote = await otherBuilder.build({
      txId: txId!,
      provider: providerDID,
      consumer: consumerDID,
      quotedAmount: '8000000', // different amount → different hash
      originalAmount: '5000000',
      maxPrice: '10000000',
      chainId: 84532,
      kernelAddress: KERNEL,
    });

    orch.setReceivedQuote(txId!, wrongQuote);

    const result = await negPromise;
    expect(result.success).toBe(false);
    // Top-level reason summarizes the outer loop ("candidates exhausted");
    // the per-round detail carries the actual hash mismatch error.
    const lastRound = result.rounds[result.rounds.length - 1];
    expect(lastRound.action).toBe('error');
    expect(lastRound.reason).toMatch(/hash mismatch/i);
  }, 10_000);

  // ==========================================================================
  // setCounterAccepted security — verify EIP-712 + binding to sent counter
  // ==========================================================================

  describe('setCounterAccepted security', () => {
    /**
     * All five tests share the same shape: spin a real negotiation
     * round so a counter exists in `sentCounters`, then attempt
     * `setCounterAccepted` with a malicious or malformed message.
     * The orchestrator must reject every variant.
     */
    async function setupRoundWithSentCounter(): Promise<{
      orch: BuyerOrchestrator;
      txId: string;
      postedCounter: import('../builders/CounterOfferBuilder').CounterOfferMessage;
      counterHash: string;
    }> {
      await runtime.mintTokens(buyerWallet.address, '100000000');
      let postedCounter: import('../builders/CounterOfferBuilder').CounterOfferMessage | undefined;
      const channel = new QuoteChannelClient({
        fetchImpl: (async (_url: string, init: { body?: string } = {}) => {
          if (init.body) {
            try {
              const parsed = JSON.parse(init.body);
              if (parsed?.type === 'agirails.counteroffer.v1' && parsed.message) postedCounter = parsed.message;
            } catch { /* */ }
          }
          return new Response('{}', { status: 201 });
        }) as unknown as typeof fetch,
        allowInsecureTargets: true,
      });
      const orch = new BuyerOrchestrator(
        makePolicy({
          rounds_per_provider: 3,
          counter_strategy: 'midpoint',
          target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
          counter_response_ttl_seconds: 5,
        }),
        runtime,
        buyerWallet.address,
        testDir,
        { signer: buyerWallet, kernelAddress: KERNEL, chainId: 84532, channel },
      );
      const negPromise = orch.negotiate({ pollIntervalMs: 50 });
      let txId: string | undefined;
      for (let i = 0; i < 40; i++) {
        const all = await runtime.getAllTransactions();
        if (all.length > 0) { txId = all[0].id; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      const quote = await preparePushedQuote(txId!, '7000000');
      orch.setReceivedQuote(txId!, quote, {
        providerEndpoint: 'https://provider.test',
        providerAddress: providerWallet.address,
        actualEscrow: '5000000',
      });
      // Wait for buyer to POST the counter.
      for (let i = 0; i < 100 && !postedCounter; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Stash a reference to the negotiation promise so each test can
      // resolve it cleanly (otherwise jest reports an unhandled exit).
      // We attach a rescue: if any test ends without resolving, the
      // counter timeout will eventually fire and resolve to CANCELLED.
      void negPromise.catch(() => undefined);
      const counterHash = new CounterOfferBuilder().computeHash(postedCounter!);
      return { orch, txId: txId!, postedCounter: postedCounter!, counterHash };
    }

    it('rejects acceptance with mismatched acceptedAmount', async () => {
      const { orch, txId, counterHash } = await setupRoundWithSentCounter();
      const accept = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
        txId,
        provider: providerDID,
        consumer: consumerDID,
        acceptedAmount: '5500000', // counter was at $6 (6_000_000) — mismatch
        inReplyTo: counterHash,
        chainId: 84532,
        kernelAddress: KERNEL,
      });
      await expect(orch.setCounterAccepted(txId, accept)).rejects.toThrow(/acceptedAmount/i);
    }, 15_000);

    it('rejects acceptance with mismatched inReplyTo (different counter hash)', async () => {
      const { orch, txId, postedCounter } = await setupRoundWithSentCounter();
      const wrongHash = '0x' + 'a'.repeat(64);
      const accept = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
        txId,
        provider: providerDID,
        consumer: consumerDID,
        acceptedAmount: postedCounter.counterAmount,
        inReplyTo: wrongHash,
        chainId: 84532,
        kernelAddress: KERNEL,
      });
      await expect(orch.setCounterAccepted(txId, accept)).rejects.toThrow(/inReplyTo/i);
    }, 15_000);

    it('rejects acceptance with mismatched txId', async () => {
      const { orch, txId, postedCounter, counterHash } = await setupRoundWithSentCounter();
      const otherTxId = '0x' + 'b'.repeat(64);
      const accept = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
        txId: otherTxId,
        provider: providerDID,
        consumer: consumerDID,
        acceptedAmount: postedCounter.counterAmount,
        inReplyTo: counterHash,
        chainId: 84532,
        kernelAddress: KERNEL,
      });
      // Caller passes correct txId but message claims otherTxId.
      await expect(orch.setCounterAccepted(txId, accept)).rejects.toThrow(/txId mismatch/);
    }, 15_000);

    it('rejects acceptance signed by an attacker, not the provider', async () => {
      const { orch, txId, postedCounter, counterHash } = await setupRoundWithSentCounter();
      const attackerWallet = Wallet.createRandom();
      const accept = await new CounterAcceptBuilder(attackerWallet, new InMemoryNonceManager()).build({
        txId,
        provider: providerDID, // claims to be provider
        consumer: consumerDID,
        acceptedAmount: postedCounter.counterAmount,
        inReplyTo: counterHash,
        chainId: 84532,
        kernelAddress: KERNEL,
      });
      // Signature recovers to attacker, not providerDID's address.
      await expect(orch.setCounterAccepted(txId, accept)).rejects.toThrow();
    }, 15_000);

    it('rejects acceptance for a txId with no sent counter', async () => {
      const orch = new BuyerOrchestrator(
        makePolicy(),
        runtime,
        buyerWallet.address,
        testDir,
        { signer: buyerWallet, kernelAddress: KERNEL, chainId: 84532 },
      );
      const orphanTxId = '0x' + 'c'.repeat(64);
      const accept = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
        txId: orphanTxId,
        provider: providerDID,
        consumer: consumerDID,
        acceptedAmount: '6000000',
        inReplyTo: '0x' + 'd'.repeat(64),
        chainId: 84532,
        kernelAddress: KERNEL,
      });
      await expect(orch.setCounterAccepted(orphanTxId, accept)).rejects.toThrow(/No counter-offer sent/);
    });
  });

  // ==========================================================================
  // Atomic accept+linkEscrow rollback on partial failure (P1 #4)
  // ==========================================================================

  describe('accept+linkEscrow rollback', () => {
    it('rolls back to CANCELLED when linkEscrow fails after acceptQuote succeeded (accept path)', async () => {
      await runtime.mintTokens(buyerWallet.address, '100000000');
      const orch = new BuyerOrchestrator(
        makePolicy({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } }),
        runtime,
        buyerWallet.address,
        testDir,
      );

      const negPromise = orch.negotiate({ pollIntervalMs: 50 });
      let txId: string | undefined;
      for (let i = 0; i < 40; i++) {
        const all = await runtime.getAllTransactions();
        if (all.length > 0) { txId = all[0].id; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(txId).toBeDefined();

      // Stub linkEscrow to fail AFTER acceptQuote already succeeded.
      const origLink = runtime.linkEscrow.bind(runtime);
      jest.spyOn(runtime, 'linkEscrow').mockImplementationOnce(async () => {
        throw new Error('simulated escrow failure');
      });

      const quote = await preparePushedQuote(txId!, '7000000');
      orch.setReceivedQuote(txId!, quote, {
        providerAddress: providerWallet.address,
        actualEscrow: '5000000',
      });

      const result = await negPromise;
      expect(result.success).toBe(false);
      const tx = await runtime.getTransaction(txId!);
      expect(tx!.state).toBe('CANCELLED');
      // Sanity: the original linkEscrow is still in place for any future call.
      expect(typeof origLink).toBe('function');
    }, 10_000);

    it('frees per-tx state on the COMMITTED fast-path return (outer-loop cleanup)', async () => {
      // Scenario: external caller pushed a quote BEFORE the provider
      // jumped straight to COMMITTED (skipping QUOTED). Pre-fix bug:
      // the outer-loop COMMITTED branch returned without ever calling
      // _runNegotiationRound, so receivedQuotes accumulated forever.
      await runtime.mintTokens(buyerWallet.address, '100000000');
      const orch = new BuyerOrchestrator(
        makePolicy({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } }),
        runtime,
        buyerWallet.address,
        testDir,
      );

      const negPromise = orch.negotiate({ pollIntervalMs: 50 });
      let txId: string | undefined;
      for (let i = 0; i < 40; i++) {
        const all = await runtime.getAllTransactions();
        if (all.length > 0) { txId = all[0].id; break; }
        await new Promise((r) => setTimeout(r, 50));
      }

      // Push an unrelated/orphan quote so receivedQuotes has an entry,
      // then directly transition the tx to COMMITTED via the runtime
      // (simulating provider's INITIATED → COMMITTED fast path).
      const quote = await preparePushedQuote(txId!, '7000000');
      orch.setReceivedQuote(txId!, quote, {
        providerAddress: providerWallet.address,
        actualEscrow: '5000000',
      });
      // Confirm the entry is live before transition.
      const internalBefore = orch as unknown as { receivedQuotes: Map<string, unknown> };
      expect(internalBefore.receivedQuotes.has(txId!)).toBe(true);

      // Drive INITIATED → COMMITTED bypassing QUOTED — uses linkEscrow
      // directly, mirroring the on-chain fast path.
      await runtime.linkEscrow(txId!, '5000000');

      const result = await negPromise;
      expect(result.success).toBe(true);
      const internal = orch as unknown as {
        receivedQuotes: Map<string, unknown>;
        sentCounters: Map<string, unknown>;
      };
      expect(internal.receivedQuotes.has(txId!)).toBe(false);
      expect(internal.sentCounters.has(txId!)).toBe(false);
    }, 10_000);

    it('rolls back to CANCELLED when linkEscrow fails after acceptQuote succeeded (counter-accept path)', async () => {
      await runtime.mintTokens(buyerWallet.address, '100000000');
      let postedCounter: import('../builders/CounterOfferBuilder').CounterOfferMessage | undefined;
      const channel = new QuoteChannelClient({
        fetchImpl: (async (_url: string, init: { body?: string } = {}) => {
          if (init.body) {
            try {
              const parsed = JSON.parse(init.body);
              if (parsed?.type === 'agirails.counteroffer.v1' && parsed.message) postedCounter = parsed.message;
            } catch { /* */ }
          }
          return new Response('{}', { status: 201 });
        }) as unknown as typeof fetch,
        allowInsecureTargets: true,
      });
      const orch = new BuyerOrchestrator(
        makePolicy({
          rounds_per_provider: 3,
          counter_strategy: 'midpoint',
          target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
          counter_response_ttl_seconds: 5,
        }),
        runtime,
        buyerWallet.address,
        testDir,
        { signer: buyerWallet, kernelAddress: KERNEL, chainId: 84532, channel },
      );

      const negPromise = orch.negotiate({ pollIntervalMs: 50 });
      let txId: string | undefined;
      for (let i = 0; i < 40; i++) {
        const all = await runtime.getAllTransactions();
        if (all.length > 0) { txId = all[0].id; break; }
        await new Promise((r) => setTimeout(r, 50));
      }

      const quote = await preparePushedQuote(txId!, '7000000');
      orch.setReceivedQuote(txId!, quote, {
        providerEndpoint: 'https://provider.test',
        providerAddress: providerWallet.address,
        actualEscrow: '5000000',
      });
      for (let i = 0; i < 100 && !postedCounter; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(postedCounter).toBeDefined();

      // Stub linkEscrow to fail BEFORE provider sends acceptance.
      jest.spyOn(runtime, 'linkEscrow').mockImplementationOnce(async () => {
        throw new Error('simulated escrow failure');
      });

      const counterHash = new CounterOfferBuilder().computeHash(postedCounter!);
      const accept = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
        txId: txId!,
        provider: providerDID,
        consumer: consumerDID,
        acceptedAmount: postedCounter!.counterAmount,
        inReplyTo: counterHash,
        chainId: 84532,
        kernelAddress: KERNEL,
      });
      await orch.setCounterAccepted(txId!, accept);

      const result = await negPromise;
      expect(result.success).toBe(false);
      const tx = await runtime.getTransaction(txId!);
      expect(tx!.state).toBe('CANCELLED');
    }, 15_000);
  });
});
