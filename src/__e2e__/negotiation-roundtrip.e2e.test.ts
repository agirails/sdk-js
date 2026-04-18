/**
 * E2E: Buyer ↔ Provider negotiation over a real HTTP socket.
 *
 * Wires a real `http.createServer` running `QuoteChannelHandler` against
 * a `BuyerOrchestrator` whose `QuoteChannelClient` points at that local
 * server. The counter-offer travels over loopback (IP literal so the
 * SSRF guard is satisfied) — exercises:
 *   1. Path-binding (URL chainId/txId vs message fields)
 *   2. EIP-712 signature recovery (real provider key)
 *   3. Body cap + read timeout
 *   4. The setCounterAccepted security/binding chain end-to-end
 *
 * Provider ack of the counter is signed and pushed to the buyer
 * orchestrator (out-of-band, mirroring how `actp serve` defers ack
 * delivery to the operator per AIP-2.1 §5.3).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { Wallet, HDNodeWallet } from 'ethers';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import { BuyerOrchestrator } from '../negotiation/BuyerOrchestrator';
import { BuyerPolicy } from '../negotiation/PolicyEngine';
import { QuoteBuilder } from '../builders/QuoteBuilder';
import { CounterOfferBuilder, CounterOfferMessage } from '../builders/CounterOfferBuilder';
import { CounterAcceptBuilder } from '../builders/CounterAcceptBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import {
  QuoteChannelClient,
  QuoteChannelHandler,
} from '../transport/QuoteChannel';
import * as agirailsApp from '../api/agirailsApp';

const KERNEL = '0x1234567890123456789012345678901234567890';
const CHAIN_ID = 84_532;

interface E2EFixture {
  testDir: string;
  runtime: MockRuntime;
  providerWallet: HDNodeWallet;
  buyerWallet: HDNodeWallet;
  providerDID: string;
  consumerDID: string;
  server: http.Server;
  serverUrl: string;
  receivedCounters: CounterOfferMessage[];
  buyer: BuyerOrchestrator;
}

async function startProviderServer(args: {
  receivedCounters: CounterOfferMessage[];
}): Promise<{ server: http.Server; url: string }> {
  const handler = new QuoteChannelHandler({
    kernelAddressByChainId: { [CHAIN_ID]: KERNEL },
  });

  const server = http.createServer(async (req, res) => {
    try {
      // Mirror the production-style read-and-cap (10s deadline + 64KiB).
      const chunks: Buffer[] = [];
      let total = 0;
      const MAX = 64 * 1024;
      const settled = await new Promise<{ ok: true; body: string } | { ok: false; reason: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 10_000);
        req.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX) {
            clearTimeout(timer);
            resolve({ ok: false, reason: 'too large' });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          clearTimeout(timer);
          resolve({ ok: true, body: Buffer.concat(chunks).toString('utf-8') });
        });
        req.on('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, reason: err.message });
        });
      });
      if (!settled.ok) {
        res.statusCode = 400;
        res.end(JSON.stringify({ accepted: false, reason: settled.reason }));
        return;
      }

      const url = req.url ?? '/';
      const channelMatch = url.match(/^\/quote-channel\/(\d+)\/(0x[a-fA-F0-9]{64})\/?$/);
      if (req.method !== 'POST' || !channelMatch) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const [, chainIdStr, txId] = channelMatch;
      let payload: unknown;
      try {
        payload = JSON.parse(settled.body);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ accepted: false, reason: 'invalid json' }));
        return;
      }
      const result = await handler.handle(payload, {
        pathChainId: Number(chainIdStr),
        pathTxId: txId,
      });
      // Tap counter-offers so the test can sign acceptances bound to them.
      if (result.status === 201 || result.status === 200) {
        const p = payload as { type?: string; message?: CounterOfferMessage };
        if (p?.type === 'agirails.counteroffer.v1' && p.message) {
          args.receivedCounters.push(p.message);
        }
      }
      res.statusCode = result.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result.body));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // Slow-loris hardening (mirrors what `actp serve` sets).
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  // Use an explicit IPv4 literal so the SSRF guard is satisfied
  // (127.0.0.0/8 is a loopback range — we set allowInsecureTargets on
  // the buyer's QuoteChannelClient anyway).
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

async function setupFixture(): Promise<E2EFixture> {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aip21-e2e-'));
  const runtime = new MockRuntime(new MockStateManager(testDir));
  const providerWallet = Wallet.createRandom();
  const buyerWallet = Wallet.createRandom();
  const providerDID = `did:ethr:${CHAIN_ID}:${providerWallet.address}`;
  const consumerDID = `did:ethr:${CHAIN_ID}:${buyerWallet.address}`;

  jest.spyOn(agirailsApp, 'discoverAgents').mockResolvedValue({
    agents: [
      {
        slug: 'e2e-provider',
        wallet_address: providerWallet.address,
        name: 'E2E Provider',
        description: 'mock',
        published_config: { pricing: { amount: '5', currency: 'USDC', unit: 'job' } },
        stats: {
          reputation_score: 80, success_rate: 95,
          avg_completion_time_seconds: 60, completed_transactions: 100,
        },
      } as unknown as agirailsApp.DiscoverAgent,
    ],
    total: 1,
  });

  const receivedCounters: CounterOfferMessage[] = [];
  const { server, url: serverUrl } = await startProviderServer({ receivedCounters });

  const channel = new QuoteChannelClient({
    // 127.0.0.1 is loopback — needs allowInsecureTargets for the SSRF guard
    // AND we're on http:// not https:// for E2E speed.
    allowInsecureTargets: true,
  });

  const policy: BuyerPolicy = {
    task: 'code-review',
    constraints: {
      max_unit_price: { amount: 10, currency: 'USDC', unit: 'job' },
      max_daily_spend: { amount: 100, currency: 'USDC' },
    },
    negotiation: {
      rounds_max: 1,
      quote_ttl: '1m',
      rounds_per_provider: 3,
      counter_strategy: 'midpoint',
      counter_response_ttl_seconds: 5,
    },
    selection: { prioritize: ['price'] },
    target_unit_price: { amount: 5, currency: 'USDC', unit: 'job' },
  };

  await runtime.mintTokens(buyerWallet.address, '100000000');
  const buyer = new BuyerOrchestrator(
    policy,
    runtime,
    buyerWallet.address,
    testDir,
    { signer: buyerWallet, kernelAddress: KERNEL, chainId: CHAIN_ID, channel },
  );

  return {
    testDir, runtime, providerWallet, buyerWallet,
    providerDID, consumerDID,
    server, serverUrl, receivedCounters, buyer,
  };
}

async function teardownFixture(fx: E2EFixture): Promise<void> {
  await new Promise<void>((resolve) => fx.server.close(() => resolve()));
  fs.rmSync(fx.testDir, { recursive: true, force: true });
  jest.restoreAllMocks();
}

describe('E2E: AIP-2.1 negotiation over real HTTP', () => {
  it('completes a full counter→accept cycle end-to-end', async () => {
    const fx = await setupFixture();
    try {
      const negPromise = fx.buyer.negotiate({ pollIntervalMs: 50 });

      // Wait for buyer to issue createTransaction.
      let txId: string | undefined;
      for (let i = 0; i < 80 && !txId; i++) {
        const all = await fx.runtime.getAllTransactions();
        if (all.length > 0) txId = all[0].id;
        else await new Promise((r) => setTimeout(r, 50));
      }
      expect(txId).toBeDefined();

      // Provider builds + submits a quote at $7 (above buyer's $5 target).
      const quote = await new QuoteBuilder(fx.providerWallet, new InMemoryNonceManager()).build({
        txId: txId!,
        provider: fx.providerDID,
        consumer: fx.consumerDID,
        quotedAmount: '7000000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });
      await fx.runtime.submitQuote(txId!, quote);

      // Push the quote into the buyer with the LIVE provider endpoint —
      // this is what triggers the counter to flow over real HTTP.
      // sendCounter appends `/quote-channel/{chainId}/{txId}` itself, so
      // we hand it the BASE URL only.
      fx.buyer.setReceivedQuote(txId!, quote, {
        providerEndpoint: fx.serverUrl,
        providerAddress: fx.providerWallet.address,
        actualEscrow: '5000000',
      });

      // Wait for the server to receive the buyer's counter via real HTTP.
      for (let i = 0; i < 100 && fx.receivedCounters.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fx.receivedCounters.length).toBe(1);
      const counter = fx.receivedCounters[0];
      // midpoint of $7 and $5 = $6
      expect(counter.counterAmount).toBe('6000000');
      expect(counter.txId).toBe(txId);
      expect(counter.consumer.toLowerCase()).toContain(fx.buyerWallet.address.toLowerCase());

      // Provider signs an acceptance bound to the counter's hash and
      // delivers it back to the buyer (out-of-band per AIP-2.1 §5.3).
      const counterHash = new CounterOfferBuilder().computeHash(counter);
      const accept = await new CounterAcceptBuilder(fx.providerWallet, new InMemoryNonceManager()).build({
        txId: txId!,
        provider: fx.providerDID,
        consumer: fx.consumerDID,
        acceptedAmount: counter.counterAmount,
        inReplyTo: counterHash,
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });
      await fx.buyer.setCounterAccepted(txId!, accept);

      const result = await negPromise;
      expect(result.success).toBe(true);
      const tx = await fx.runtime.getTransaction(txId!);
      expect(tx!.amount).toBe('6000000');
      expect(tx!.state).toBe('COMMITTED');
    } finally {
      await teardownFixture(fx);
    }
  }, 30_000);

  it('rejects a malformed counter (path/message chainId mismatch) via real HTTP', async () => {
    // Direct end-to-end check that the handler's path-binding fires
    // when a buggy or malicious sender posts to the wrong path.
    const fx = await setupFixture();
    try {
      const otherWallet = Wallet.createRandom();
      const counter = await new CounterOfferBuilder(otherWallet, new InMemoryNonceManager()).build({
        txId: '0x' + 'a'.repeat(64),
        consumer: `did:ethr:${CHAIN_ID}:${otherWallet.address}`,
        provider: fx.providerDID,
        quoteAmount: '7000000',
        counterAmount: '6000000',
        maxPrice: '10000000',
        inReplyTo: '0x' + 'b'.repeat(64),
        chainId: CHAIN_ID,
        kernelAddress: KERNEL,
      });

      // Post to an URL whose path chainId is DIFFERENT from message.chainId.
      const wrongPath = `${fx.serverUrl}/quote-channel/8453/${counter.txId}`;
      const res = await fetch(wrongPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'agirails.counteroffer.v1', message: counter }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.reason).toMatch(/chainId/i);
      expect(fx.receivedCounters.length).toBe(0);
    } finally {
      await teardownFixture(fx);
    }
  }, 15_000);

  it('rejects an oversize body (server-side cap)', async () => {
    const fx = await setupFixture();
    try {
      // 80 KiB payload — server caps at 64 KiB. The server `req.destroy()`s
      // the socket once the cap is hit, so fetch can either see a 4xx
      // response (race won by the response-write) OR a socket reset
      // (race won by destroy). Both shapes mean the cap fired.
      const huge = JSON.stringify({ junk: 'x'.repeat(80 * 1024) });
      const url = `${fx.serverUrl}/quote-channel/${CHAIN_ID}/0x${'c'.repeat(64)}`;
      let outcome: 'rejected' | 'response' = 'response';
      let status: number | null = null;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: huge,
        });
        status = res.status;
      } catch {
        outcome = 'rejected';
      }
      // Either we got a 4xx or the socket was reset — both are acceptable.
      expect(outcome === 'rejected' || (status !== null && status >= 400 && status < 500)).toBe(true);
      // The body never made it through the channel handler — no counters captured.
      expect(fx.receivedCounters.length).toBe(0);
    } finally {
      await teardownFixture(fx);
    }
  }, 15_000);
});
