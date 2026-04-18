/**
 * ProviderOrchestrator — channel-driven 3.5.0 tests.
 *
 * Covers the new auto-respond listener (start()) plus the existing
 * one-shot quote() and evaluateCounter() surfaces. The legacy
 * QuoteChannelClient-based tests were removed in 3.5.0.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Wallet, HDNodeWallet } from 'ethers';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import { ProviderOrchestrator } from './ProviderOrchestrator';
import { ProviderPolicy, IncomingRequest } from './ProviderPolicy';
import { CounterOfferBuilder, CounterOfferMessage } from '../builders/CounterOfferBuilder';
import { CounterAcceptMessage } from '../builders/CounterAcceptBuilder';
import { QuoteMessage } from '../builders/QuoteBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import { MockChannel } from './MockChannel';

const KERNEL = '0x1234567890123456789012345678901234567890';
const CHAIN_ID = 84_532;

function basePolicy(over: Partial<ProviderPolicy> = {}): ProviderPolicy {
  return {
    services: ['code-review'],
    pricing: {
      min_acceptable: { amount: 5, currency: 'USDC', unit: 'job' },
      ideal_price: { amount: 7, currency: 'USDC', unit: 'job' },
    },
    quote_ttl: '15m',
    ...over,
  };
}

describe('ProviderOrchestrator — channel-driven (3.5.0)', () => {
  let testDir: string;
  let runtime: MockRuntime;
  let providerWallet: HDNodeWallet;
  let buyerWallet: HDNodeWallet;
  let providerDID: string;
  let consumerDID: string;
  let channel: MockChannel;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-orch-'));
    runtime = new MockRuntime(new MockStateManager(testDir));
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
    providerDID = `did:ethr:${CHAIN_ID}:${providerWallet.address}`;
    consumerDID = `did:ethr:${CHAIN_ID}:${buyerWallet.address}`;
    channel = new MockChannel({ kernelAddressByChainId: { [CHAIN_ID]: KERNEL } });
  });

  afterEach(async () => {
    await channel.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function makeOrch(over: Partial<ProviderPolicy> = {}): ProviderOrchestrator {
    return new ProviderOrchestrator({
      policy: basePolicy(over),
      runtime,
      signer: providerWallet,
      kernelAddress: KERNEL,
      chainId: CHAIN_ID,
      providerDID,
      negotiationChannel: channel,
    });
  }

  async function makeIncomingTx(amount: string): Promise<{ req: IncomingRequest; txId: string }> {
    const txId = await runtime.createTransaction({
      provider: providerWallet.address,
      requester: buyerWallet.address,
      amount,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      serviceDescription: JSON.stringify({ service: 'code-review' }),
    });
    return {
      txId,
      req: {
        txId, consumer: consumerDID,
        offeredAmount: amount, maxPrice: '10000000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        serviceType: 'code-review', currency: 'USDC', unit: 'job',
      },
    };
  }

  // ==========================================================================
  // evaluateRequest
  // ==========================================================================

  describe('evaluateRequest', () => {
    it('quotes when policy passes', () => {
      const orch = makeOrch();
      const decision = orch.evaluateRequest({
        txId: '0x' + 'a'.repeat(64), consumer: consumerDID,
        offeredAmount: '5000000', maxPrice: '10000000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        serviceType: 'code-review', currency: 'USDC', unit: 'job',
      });
      expect(decision.action).toBe('quote');
      if (decision.action === 'quote') {
        expect(decision.amountBaseUnits).toBe('7000000'); // ideal $7
      }
    });

    it('skips on policy violation (service not offered)', () => {
      const orch = makeOrch();
      const decision = orch.evaluateRequest({
        txId: '0x' + 'a'.repeat(64), consumer: consumerDID,
        offeredAmount: '5000000', maxPrice: '10000000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        serviceType: 'translation', currency: 'USDC', unit: 'job',
      });
      expect(decision.action).toBe('skip');
    });
  });

  // ==========================================================================
  // quote() full flow
  // ==========================================================================

  describe('quote()', () => {
    it('anchors on-chain + posts on channel', async () => {
      const orch = makeOrch();
      const { req, txId } = await makeIncomingTx('5000000');
      const result = await orch.quote(req, providerDID);
      expect(result.decision.action).toBe('quote');
      expect(result.quote).toBeDefined();
      expect(result.channelError).toBeUndefined();
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('QUOTED');
      const posted = channel.getMessagesForTxId(txId);
      expect(posted).toHaveLength(1);
      expect(posted[0].envelope.type).toBe('agirails.quote.v1');
    });

    it('returns channelError when post fails but on-chain succeeded', async () => {
      const failingChannel = {
        post: async () => { throw new Error('relay 500'); },
        subscribeTxId: () => ({ unsubscribe: () => undefined }),
        subscribeAgent: () => ({ unsubscribe: () => undefined }),
      };
      const orch = new ProviderOrchestrator({
        policy: basePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        providerDID,
        negotiationChannel: failingChannel as any,
      });
      const { req, txId } = await makeIncomingTx('5000000');
      const result = await orch.quote(req, providerDID);
      expect(result.channelError).toMatch(/relay 500/);
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('QUOTED'); // on-chain still happened
    });
  });

  // ==========================================================================
  // start() — multi-round auto-respond
  // ==========================================================================

  describe('start() — auto-respond to incoming counters', () => {
    async function buildBuyerCounter(
      txId: string, quoteAmount: string, counterAmount: string,
    ): Promise<CounterOfferMessage> {
      const builder = new CounterOfferBuilder(buyerWallet, new InMemoryNonceManager());
      return builder.build({
        txId, consumer: consumerDID, provider: providerDID,
        quoteAmount, counterAmount, maxPrice: '10000000',
        inReplyTo: '0x' + 'b'.repeat(64),
        chainId: CHAIN_ID, kernelAddress: KERNEL,
      });
    }

    it('auto-accepts a counter at-or-above floor', async () => {
      const orch = makeOrch();
      const { req, txId } = await makeIncomingTx('5000000');
      await orch.quote(req, providerDID);
      await orch.start();

      // Buyer counters at $6 (above floor $5).
      const counter = await buildBuyerCounter(txId, '7000000', '6000000');
      await channel.post(txId, { type: 'agirails.counteroffer.v1', message: counter });

      // Wait for provider's response (acceptance posted).
      const accept = await waitForChannelMessage(channel, txId, 'agirails.counteraccept.v1', 1500);
      expect(accept).toBeDefined();
      const acceptMsg = accept!.envelope.message as CounterAcceptMessage;
      expect(acceptMsg.acceptedAmount).toBe('6000000');
      expect(acceptMsg.txId).toBe(txId);

      orch.stop();
    });

    it('auto-rejects a counter below floor with default walk strategy', async () => {
      const orch = makeOrch();
      const { req, txId } = await makeIncomingTx('5000000');
      await orch.quote(req, providerDID);
      await orch.start();

      // Buyer counters at $3 (below floor $5).
      const counter = await buildBuyerCounter(txId, '7000000', '3000000');
      await channel.post(txId, { type: 'agirails.counteroffer.v1', message: counter });

      // No response should be posted within window.
      await new Promise((r) => setTimeout(r, 300));
      const accept = channel.getMessagesForTxId(txId).find(
        (m) => m.envelope.type === 'agirails.counteraccept.v1',
      );
      const requote = channel.getMessagesForTxId(txId).filter(
        (m) => m.envelope.type === 'agirails.quote.v1',
      );
      expect(accept).toBeUndefined();
      // Only the original quote, no re-quote.
      expect(requote).toHaveLength(1);
      orch.stop();
    });

    it('auto-requotes (concedes) when counter below floor with concede strategy', async () => {
      const orch = makeOrch({
        counter_strategy: 'concede',
        concede_pct: 50, // halve the gap each round
        max_requotes: 2,
      });
      const { req, txId } = await makeIncomingTx('5000000');
      await orch.quote(req, providerDID); // initial quote at $7 (ideal)
      await orch.start();

      // Buyer counters at $3 (below floor $5). Provider should re-quote.
      // last quote $7, floor $5, gap $2, concede 50% → re-quote $6.
      const counter = await buildBuyerCounter(txId, '7000000', '3000000');
      await channel.post(txId, { type: 'agirails.counteroffer.v1', message: counter });

      const requoted = await waitForNthQuote(channel, txId, 2, 1500);
      expect(requoted).toBeDefined();
      const requoteMsg = requoted!.envelope.message as QuoteMessage;
      expect(requoteMsg.quotedAmount).toBe('6000000');
      orch.stop();
    });

    it('walks after exhausting requote budget', async () => {
      const orch = makeOrch({
        counter_strategy: 'concede',
        concede_pct: 50,
        max_requotes: 1, // only one re-quote allowed
      });
      const { req, txId } = await makeIncomingTx('5000000');
      await orch.quote(req, providerDID);
      await orch.start();

      // First counter → triggers re-quote.
      const c1 = await buildBuyerCounter(txId, '7000000', '3000000');
      await channel.post(txId, { type: 'agirails.counteroffer.v1', message: c1 });
      await waitForNthQuote(channel, txId, 2, 1500);

      // Second counter at same low amount → should walk (no second re-quote).
      const c2 = await buildBuyerCounter(txId, '6000000', '3500000'); // counter again below floor
      await channel.post(txId, { type: 'agirails.counteroffer.v1', message: c2 });
      await new Promise((r) => setTimeout(r, 300));

      const allQuotes = channel.getMessagesForTxId(txId).filter(
        (m) => m.envelope.type === 'agirails.quote.v1',
      );
      expect(allQuotes).toHaveLength(2); // initial + 1 re-quote, no third
      orch.stop();
    });

    it('start() without providerDID throws', async () => {
      const orch = new ProviderOrchestrator({
        policy: basePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        // providerDID intentionally omitted
        negotiationChannel: channel,
      });
      await expect(orch.start()).rejects.toThrow(/providerDID/);
    });

    it('start() without negotiationChannel throws', async () => {
      const orch = new ProviderOrchestrator({
        policy: basePolicy(),
        runtime,
        signer: providerWallet,
        kernelAddress: KERNEL,
        chainId: CHAIN_ID,
        providerDID,
        // negotiationChannel intentionally omitted
      });
      await expect(orch.start()).rejects.toThrow(/negotiationChannel/);
    });

    it('stop() is idempotent', async () => {
      const orch = makeOrch();
      await orch.start();
      orch.stop();
      expect(() => orch.stop()).not.toThrow();
    });
  });
});

async function waitForChannelMessage(
  channel: MockChannel, txId: string, type: string, timeoutMs: number,
): Promise<{ envelope: { message: unknown } } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = channel.getMessagesForTxId(txId).find((m) => m.envelope.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 30));
  }
  return undefined;
}

/** Wait until at least N quote messages exist for txId; return the Nth. */
async function waitForNthQuote(
  channel: MockChannel, txId: string, n: number, timeoutMs: number,
): Promise<{ envelope: { message: unknown } } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const quotes = channel.getMessagesForTxId(txId).filter(
      (m) => m.envelope.type === 'agirails.quote.v1',
    );
    if (quotes.length >= n) return quotes[n - 1];
    await new Promise((r) => setTimeout(r, 30));
  }
  return undefined;
}
