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
    const channel = new QuoteChannelClient({
      // Stub fetch — counter POST is "delivered" immediately.
      fetchImpl: (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch,
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

    // Simulate provider accepting the counter shortly after we send it.
    setTimeout(() => orch.setCounterAccepted(txId!, '6000000'), 200);

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
});
