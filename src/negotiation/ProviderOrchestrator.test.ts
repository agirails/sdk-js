/**
 * ProviderOrchestrator tests — uses MockRuntime for on-chain side and
 * mocks the QuoteChannelClient for off-chain side so tests are
 * hermetic and fast.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Wallet, HDNodeWallet } from 'ethers';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import { QuoteChannelClient } from '../transport/QuoteChannel';
import { ProviderOrchestrator } from './ProviderOrchestrator';
import { IncomingRequest, ProviderPolicy } from './ProviderPolicy';
import { CounterOfferBuilder } from '../builders/CounterOfferBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';

const KERNEL = '0x1234567890123456789012345678901234567890';

describe('ProviderOrchestrator', () => {
  let testDir: string;
  let runtime: MockRuntime;
  let providerWallet: HDNodeWallet;
  let buyerWallet: HDNodeWallet;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-orch-'));
    runtime = new MockRuntime(new MockStateManager(testDir));
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function makePolicy(overrides: Partial<ProviderPolicy> = {}): ProviderPolicy {
    return {
      services: ['code-review'],
      pricing: {
        min_acceptable: { amount: 5, currency: 'USDC', unit: 'job' },
        ideal_price: { amount: 10, currency: 'USDC', unit: 'job' },
      },
      quote_ttl: '15m',
      ...overrides,
    };
  }

  async function makeInflightTxn(overrides: { amount?: string; deadline?: number } = {}): Promise<string> {
    return runtime.createTransaction({
      provider: providerWallet.address,
      requester: buyerWallet.address,
      amount: overrides.amount ?? '5000000',
      deadline: overrides.deadline ?? Math.floor(Date.now() / 1000) + 3600,
    });
  }

  function makeReq(txId: string, overrides: Partial<IncomingRequest> = {}): IncomingRequest {
    return {
      txId,
      consumer: `did:ethr:84532:${buyerWallet.address}`,
      offeredAmount: '5000000',
      maxPrice: '10000000',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      serviceType: 'code-review',
      currency: 'USDC',
      unit: 'job',
      ...overrides,
    };
  }

  function mockChannel(): QuoteChannelClient & { calls: Array<{ endpoint: string; quote: unknown }> } {
    const calls: Array<{ endpoint: string; quote: unknown }> = [];
    const channel = new QuoteChannelClient({
      fetchImpl: (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch,
      allowInsecureTargets: true, // tests use http://peer.test
    });
    // Wrap sendQuote to capture calls.
    const originalSendQuote = channel.sendQuote.bind(channel);
    (channel as unknown as { sendQuote: (ep: string, q: unknown) => Promise<void> }).sendQuote = async (ep, q) => {
      calls.push({ endpoint: ep, quote: q });
      return originalSendQuote(ep, q as Parameters<typeof originalSendQuote>[1]);
    };
    return Object.assign(channel, { calls });
  }

  // --------------------------------------------------------------------------
  // evaluateRequest (pure policy)
  // --------------------------------------------------------------------------

  describe('evaluateRequest', () => {
    it('returns quote + recommended amount when policy passes', async () => {
      const txId = await makeInflightTxn();
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
      });
      const decision = orch.evaluateRequest(makeReq(txId, { maxPrice: '15000000' }));
      expect(decision.action).toBe('quote');
      if (decision.action === 'quote') {
        expect(decision.amount).toBe(10); // ideal
      }
    });

    it('returns skip with violations when service not offered', async () => {
      const txId = await makeInflightTxn();
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
      });
      const decision = orch.evaluateRequest(makeReq(txId, { serviceType: 'translation' }));
      expect(decision.action).toBe('skip');
      if (decision.action === 'skip') {
        expect(decision.reason).toMatch(/service_not_offered/);
      }
    });
  });

  // --------------------------------------------------------------------------
  // quote() happy path
  // --------------------------------------------------------------------------

  describe('quote() — full flow', () => {
    it('submits on-chain (INITIATED → QUOTED) and posts to buyer channel', async () => {
      const txId = await makeInflightTxn();
      const channel = mockChannel();
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
        channel,
      });

      const result = await orch.quote(
        makeReq(txId, { maxPrice: '15000000' }),
        `did:ethr:84532:${providerWallet.address}`,
        'https://buyer.test',
      );

      expect(result.decision.action).toBe('quote');
      expect(result.quote).toBeDefined();
      expect(result.channelError).toBeUndefined();

      // On-chain: state must be QUOTED, hash must match QuoteBuilder hash.
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('QUOTED');
      expect(tx!.quoteHash).toBeDefined();

      // Off-chain: channel POST was made with the exact signed quote.
      expect(channel.calls).toHaveLength(1);
      expect(channel.calls[0].endpoint).toBe('https://buyer.test');
      expect((channel.calls[0].quote as { txId: string }).txId).toBe(txId);
    });

    it('skips both on-chain + off-chain when policy rejects', async () => {
      const txId = await makeInflightTxn();
      const channel = mockChannel();
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
        channel,
      });

      const result = await orch.quote(
        makeReq(txId, { maxPrice: '1000000' }), // $1 below floor
        `did:ethr:84532:${providerWallet.address}`,
        'https://buyer.test',
      );

      expect(result.decision.action).toBe('skip');
      expect(result.quote).toBeUndefined();
      expect(channel.calls).toHaveLength(0);

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('INITIATED'); // untouched
    });

    it('returns channelError when off-chain POST fails but on-chain succeeded', async () => {
      const txId = await makeInflightTxn();
      // Channel that always fails.
      const failingChannel = new QuoteChannelClient({
        fetchImpl: (async () => new Response('fail', { status: 500, statusText: 'boom' })) as unknown as typeof fetch,
        allowInsecureTargets: true,
      });
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
        channel: failingChannel,
      });

      const result = await orch.quote(
        makeReq(txId, { maxPrice: '15000000' }),
        `did:ethr:84532:${providerWallet.address}`,
        'https://buyer.test',
      );

      expect(result.decision.action).toBe('quote');
      expect(result.quote).toBeDefined();
      expect(result.channelError).toMatch(/500|boom|POST failed/);

      // Critical: on-chain succeeded even though off-chain failed.
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('QUOTED');
    });

    it('skips the off-chain POST when no endpoint is provided', async () => {
      // Callers using non-HTTP transports (Telegram adapter, pubsub,
      // whatever) omit the endpoint. On-chain step must still run.
      const txId = await makeInflightTxn();
      const channel = mockChannel();
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
        channel,
      });

      const result = await orch.quote(
        makeReq(txId, { maxPrice: '15000000' }),
        `did:ethr:84532:${providerWallet.address}`,
        undefined,
      );

      expect(result.decision.action).toBe('quote');
      expect(result.quote).toBeDefined();
      expect(channel.calls).toHaveLength(0);

      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('QUOTED');
    });
  });

  // --------------------------------------------------------------------------
  // evaluateCounter
  // --------------------------------------------------------------------------

  describe('evaluateCounter', () => {
    async function buildSignedCounter(args: {
      counterAmount: string;
      quoteAmount?: string;
      txId?: string;
    }) {
      const counterBuilder = new CounterOfferBuilder(buyerWallet, new InMemoryNonceManager());
      return counterBuilder.build({
        txId: args.txId ?? '0x' + 'a'.repeat(64),
        consumer: `did:ethr:84532:${buyerWallet.address}`,
        provider: `did:ethr:84532:${providerWallet.address}`,
        quoteAmount: args.quoteAmount ?? '10000000',
        counterAmount: args.counterAmount,
        maxPrice: '15000000',
        inReplyTo: '0x' + 'c'.repeat(64),
        chainId: 84532,
        kernelAddress: KERNEL,
      });
    }

    it('accepts a counter ≥ floor', async () => {
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
      });
      const counter = await buildSignedCounter({ counterAmount: '6000000' }); // $6, above $5 floor
      const verdict = await orch.evaluateCounter(counter);
      expect(verdict.action).toBe('accept');
    });

    it('rejects a counter below floor', async () => {
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
      });
      const counter = await buildSignedCounter({ counterAmount: '3000000' }); // $3 below floor
      const verdict = await orch.evaluateCounter(counter);
      expect(verdict.action).toBe('reject');
    });

    it('throws when counter signature does not verify', async () => {
      const orch = new ProviderOrchestrator({
        policy: makePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: 84532,
      });
      const counter = await buildSignedCounter({ counterAmount: '6000000' });
      const tampered = { ...counter, signature: '0x' + '00'.repeat(65) };
      await expect(orch.evaluateCounter(tampered)).rejects.toThrow();
    });
  });
});
