/**
 * BuyerOrchestrator — channel-driven AIP-2.1 negotiation tests.
 *
 * Covers the 3.5.0 architecture: NegotiationChannel as the single
 * transport for quote / counter / counteraccept messages. Multi-round
 * counter-counter exchange against the same provider tested here for
 * the first time.
 *
 * The legacy single-counter setReceivedQuote/setCounterAccepted tests
 * live (skipped) in BuyerOrchestrator.negotiation.test.ts as historical
 * reference for the 3.4.x API.
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
import { CounterOfferBuilder } from '../builders/CounterOfferBuilder';
import { CounterAcceptBuilder } from '../builders/CounterAcceptBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import { MockChannel } from './MockChannel';
import * as agirailsApp from '../api/agirailsApp';

const KERNEL = '0x1234567890123456789012345678901234567890';
const CHAIN_ID = 84_532;

describe('BuyerOrchestrator — channel-driven (3.5.0)', () => {
  let testDir: string;
  let runtime: MockRuntime;
  let providerWallet: HDNodeWallet;
  let buyerWallet: HDNodeWallet;
  let providerDID: string;
  let consumerDID: string;
  let channel: MockChannel;
  let providerNm: InMemoryNonceManager; // shared so multiple quotes from provider differ

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buyer-orch-channel-'));
    runtime = new MockRuntime(new MockStateManager(testDir));
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
    providerDID = `did:ethr:${CHAIN_ID}:${providerWallet.address}`;
    consumerDID = `did:ethr:${CHAIN_ID}:${buyerWallet.address}`;
    channel = new MockChannel({ kernelAddressByChainId: { [CHAIN_ID]: KERNEL } });
    providerNm = new InMemoryNonceManager();

    jest.spyOn(agirailsApp, 'discoverAgents').mockResolvedValue({
      agents: [{
        slug: 'test-provider',
        wallet_address: providerWallet.address,
        name: 'Test Provider',
        description: 'mock',
        published_config: { pricing: { amount: '5', currency: 'USDC', unit: 'job' } },
        stats: {
          reputation_score: 80, success_rate: 95,
          avg_completion_time_seconds: 60, completed_transactions: 100,
        },
      } as unknown as agirailsApp.DiscoverAgent],
      total: 1,
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await channel.close();
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
      negotiation: { rounds_max: 1, quote_ttl: '1m', ...neg },
      selection: { prioritize: ['price'] },
      ...(target_unit_price ? { target_unit_price } : {}),
    };
  }

  /**
   * Provider posts a quote. On the FIRST call for a txId, also anchors
   * on-chain via runtime.submitQuote (matches AIP-2 sequence). Subsequent
   * re-quotes are off-chain only — kernel forbids QUOTED → QUOTED on-chain.
   */
  const firstQuoteByTx = new Set<string>();
  async function postProviderQuote(txId: string, quotedAmount: string): Promise<QuoteMessage> {
    const builder = new QuoteBuilder(providerWallet, providerNm);
    const quote = await builder.build({
      txId, provider: providerDID, consumer: consumerDID,
      quotedAmount, originalAmount: '5000000', maxPrice: '10000000',
      chainId: CHAIN_ID, kernelAddress: KERNEL,
    });
    if (!firstQuoteByTx.has(txId)) {
      await runtime.submitQuote(txId, quote);
      firstQuoteByTx.add(txId);
    }
    await channel.post(txId, { type: 'agirails.quote.v1', message: quote });
    return quote;
  }

  /** Wait until orchestrator has issued createTransaction; return the txId. */
  async function awaitTxId(): Promise<string> {
    for (let i = 0; i < 80; i++) {
      const all = await runtime.getAllTransactions();
      if (all.length > 0) return all[0].id;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out waiting for createTransaction');
  }

  function makeBuyerOrch(policyOver: Parameters<typeof makePolicy>[0] = {}): BuyerOrchestrator {
    return new BuyerOrchestrator(
      makePolicy(policyOver),
      runtime,
      buyerWallet.address,
      testDir,
      {
        signer: buyerWallet, kernelAddress: KERNEL, chainId: CHAIN_ID,
        negotiationChannel: channel,
      },
    );
  }

  // ==========================================================================
  // accept-at-quote (no counter needed)
  // ==========================================================================

  it('accepts a quote at-or-below target (no counter needed)', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const orch = makeBuyerOrch({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();
    await postProviderQuote(txId, '7000000'); // $7 ≤ $8 target → accept
    const result = await negPromise;
    expect(result.success).toBe(true);
    const tx = await runtime.getTransaction(txId);
    expect(tx!.amount).toBe('7000000');
    expect(tx!.state).toBe('COMMITTED');
  }, 10_000);

  // ==========================================================================
  // walk reject (above target, walk strategy)
  // ==========================================================================

  it('rejects quote above target with counter_strategy=walk', async () => {
    const orch = makeBuyerOrch({
      rounds_per_provider: 3, counter_strategy: 'walk',
      target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
    });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();
    await postProviderQuote(txId, '7000000'); // $7 above $5 target, walk → reject
    const result = await negPromise;
    expect(result.success).toBe(false);
    const tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('CANCELLED');
  }, 10_000);

  // ==========================================================================
  // single counter → provider accepts
  // ==========================================================================

  it('counters and commits at counter amount when provider accepts in-window (single round)', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const orch = makeBuyerOrch({
      rounds_per_provider: 3, counter_strategy: 'midpoint',
      target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
      counter_response_ttl_seconds: 5,
    });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();

    // Provider posts quote → buyer counters (midpoint of $7+$5 = $6).
    await postProviderQuote(txId, '7000000');

    // Wait for buyer's counter to land on the channel.
    const buyerCounter = await waitForChannelMessage(channel, txId, 'agirails.counteroffer.v1', 3000);
    expect(buyerCounter).toBeDefined();
    expect((buyerCounter!.message as any).counterAmount).toBe('6000000');

    // Provider signs + posts acceptance.
    const accept = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
      txId, provider: providerDID, consumer: consumerDID,
      acceptedAmount: '6000000',
      inReplyTo: new CounterOfferBuilder().computeHash(buyerCounter!.message as any),
      chainId: CHAIN_ID, kernelAddress: KERNEL,
    });
    await channel.post(txId, { type: 'agirails.counteraccept.v1', message: accept });

    const result = await negPromise;
    expect(result.success).toBe(true);
    const tx = await runtime.getTransaction(txId);
    expect(tx!.amount).toBe('6000000');
    expect(tx!.state).toBe('COMMITTED');
  }, 15_000);

  // ==========================================================================
  // MULTI-ROUND: provider re-quotes after buyer's counter, buyer counters
  // again, provider finally accepts. Three counter-exchange rounds.
  // ==========================================================================

  it('completes a multi-round counter→re-quote→counter→accept exchange', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const orch = makeBuyerOrch({
      rounds_per_provider: 3, counter_strategy: 'midpoint',
      target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
      counter_response_ttl_seconds: 5,
    });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();

    // Round 1: provider quotes $9, buyer counters at midpoint = $7.
    await postProviderQuote(txId, '9000000');
    const counter1 = await waitForChannelMessage(channel, txId, 'agirails.counteroffer.v1', 3000);
    expect((counter1!.message as any).counterAmount).toBe('7000000'); // midpoint($9, $5)

    // Round 2: provider re-quotes $8 (lower than original, higher than counter).
    // Buyer counters at midpoint($8, $5) = $6.50 = 6500000.
    await postProviderQuote(txId, '8000000');
    const counter2 = await waitForChannelMessage(channel, txId, 'agirails.counteroffer.v1', 3000, [counter1!.message.signature]);
    expect((counter2!.message as any).counterAmount).toBe('6500000');

    // Round 3 (last): provider re-quotes $6.50 — exactly at buyer's counter.
    // DecisionEngine sees roundsUsedSoFar=2, rounds_per_provider=3 →
    // budget exhausted on next eval, accept-if-affordable triggers.
    await postProviderQuote(txId, '6500000');

    // Buyer should now accept at $6.50 directly (no more counter sent).
    const result = await negPromise;
    expect(result.success).toBe(true);
    const tx = await runtime.getTransaction(txId);
    expect(tx!.amount).toBe('6500000');
    expect(tx!.state).toBe('COMMITTED');
  }, 20_000);

  // ==========================================================================
  // counter timeout (provider doesn't respond)
  // ==========================================================================

  it('cancels when provider does not respond to counter within TTL', async () => {
    const orch = makeBuyerOrch({
      rounds_per_provider: 3, counter_strategy: 'midpoint',
      target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
      counter_response_ttl_seconds: 1,
    });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();
    await postProviderQuote(txId, '7000000');
    // Provider never posts acceptance or re-quote → timeout → CANCELLED.
    const result = await negPromise;
    expect(result.success).toBe(false);
    const tx = await runtime.getTransaction(txId);
    expect(tx!.state).toBe('CANCELLED');
  }, 15_000);

  // ==========================================================================
  // memory hygiene: subscription cleaned up
  // ==========================================================================

  it('closes the channel subscription at terminal outcome', async () => {
    await runtime.mintTokens(buyerWallet.address, '100000000');
    const orch = makeBuyerOrch({ target_unit_price: { amount: 8, currency: 'USDC', unit: 'job' } });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();
    await postProviderQuote(txId, '7000000');
    await negPromise;
    // Channel should have no active subscriptions left for this orch.
    expect(channel.activeSubscriptionCount()).toBe(0);
    // Internal queues should also be empty.
    const internal = orch as unknown as { inboundQueues: Map<string, unknown>; activeSubscriptions: Map<string, unknown> };
    expect(internal.inboundQueues.has(txId)).toBe(false);
    expect(internal.activeSubscriptions.has(txId)).toBe(false);
  }, 10_000);

  // ==========================================================================
  // CounterAccept binding mismatch security check
  // ==========================================================================

  it('rejects a CounterAccept whose acceptedAmount does not match buyer\'s counter', async () => {
    const orch = makeBuyerOrch({
      rounds_per_provider: 3, counter_strategy: 'midpoint',
      target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
      counter_response_ttl_seconds: 3,
    });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();
    await postProviderQuote(txId, '7000000');

    const buyerCounter = await waitForChannelMessage(channel, txId, 'agirails.counteroffer.v1', 3000);

    // Provider signs an acceptance for the WRONG amount (greedy provider
    // tries to commit at $7 instead of buyer's $6 counter).
    const malicious = await new CounterAcceptBuilder(providerWallet, new InMemoryNonceManager()).build({
      txId, provider: providerDID, consumer: consumerDID,
      acceptedAmount: '7000000', // mismatch — buyer's counter was $6m
      inReplyTo: new CounterOfferBuilder().computeHash(buyerCounter!.message as any),
      chainId: CHAIN_ID, kernelAddress: KERNEL,
    });
    await channel.post(txId, { type: 'agirails.counteraccept.v1', message: malicious });

    const result = await negPromise;
    expect(result.success).toBe(false);
    const lastRound = result.rounds[result.rounds.length - 1];
    expect(lastRound.action).toBe('error');
    expect(lastRound.reason).toMatch(/binding mismatch/);
  }, 15_000);

  // ==========================================================================
  // hash mismatch (channel quote does not match on-chain)
  // ==========================================================================

  it('rejects when channel quote does not match on-chain hash', async () => {
    const orch = makeBuyerOrch({
      rounds_per_provider: 3, counter_strategy: 'walk',
      target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
    });
    const negPromise = orch.negotiate({ pollIntervalMs: 50 });
    const txId = await awaitTxId();

    // Anchor on-chain with quote A, post DIFFERENT quote B on channel.
    const quoteA = await new QuoteBuilder(providerWallet, new InMemoryNonceManager()).build({
      txId, provider: providerDID, consumer: consumerDID,
      quotedAmount: '5000000', originalAmount: '5000000', maxPrice: '10000000',
      chainId: CHAIN_ID, kernelAddress: KERNEL,
    });
    await runtime.submitQuote(txId, quoteA);
    const quoteB = await new QuoteBuilder(providerWallet, new InMemoryNonceManager()).build({
      txId, provider: providerDID, consumer: consumerDID,
      quotedAmount: '7000000', originalAmount: '5000000', maxPrice: '10000000',
      chainId: CHAIN_ID, kernelAddress: KERNEL,
    });
    await channel.post(txId, { type: 'agirails.quote.v1', message: quoteB });

    const result = await negPromise;
    expect(result.success).toBe(false);
    const lastRound = result.rounds[result.rounds.length - 1];
    expect(lastRound.action).toBe('error');
    expect(lastRound.reason).toMatch(/hash mismatch/i);
  }, 10_000);
});

/**
 * Helper: wait for the next channel message of a given type for txId.
 * Skips messages whose signature is already in `excludeSignatures`
 * (used to wait for "next counter after the previous one").
 */
async function waitForChannelMessage(
  channel: MockChannel,
  txId: string,
  type: string,
  timeoutMs: number,
  excludeSignatures: string[] = [],
): Promise<{ message: { signature: string } } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = channel.getMessagesForTxId(txId);
    const match = all.find(
      (m) => m.envelope.type === type && !excludeSignatures.includes(m.envelope.message.signature),
    );
    if (match) return match.envelope as { message: { signature: string } };
    await new Promise((r) => setTimeout(r, 30));
  }
  return undefined;
}
