/**
 * QuoteChannel unit tests — covers the four AIP-2.1 §8.4 test scenarios:
 *   - replay: same signed POST 100× → 1 effect, 99 cached idempotent responses
 *   - cross-tx: quote with txId=A POSTed to URL for txId=B → 400
 *   - expired: expiresAt = now - 60 → 410
 *   - cross-network: chainId=8453 POSTed to chainId=84532 path → 400
 *
 * Plus client-side timeout + URL composition tests.
 */

import { Wallet, HDNodeWallet } from 'ethers';
import {
  QuoteChannelClient,
  QuoteChannelHandler,
  InMemoryDedupStore,
  buildChannelPath,
} from './QuoteChannel';
import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import { CounterOfferBuilder, CounterOfferMessage } from '../builders/CounterOfferBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';

const KERNEL_TESTNET = '0x1234567890123456789012345678901234567890';
const KERNEL_MAINNET = '0x9999999999999999999999999999999999999999';
const TX_ID_A = '0xaaaa1234567890aaaa1234567890aaaa1234567890aaaa1234567890aaaa1234';
const TX_ID_B = '0xbbbb1234567890bbbb1234567890bbbb1234567890bbbb1234567890bbbb1234';
const QUOTE_HASH = '0xfeed1234567890feed1234567890feed1234567890feed1234567890feed1234';

async function buildQuote(
  signer: HDNodeWallet,
  overrides: { txId?: string; chainId?: number; expiresAt?: number; quotedAmount?: string } = {},
): Promise<QuoteMessage> {
  const builder = new QuoteBuilder(signer, new InMemoryNonceManager());
  return builder.build({
    txId: overrides.txId ?? TX_ID_A,
    provider: `did:ethr:84532:${signer.address}`,
    consumer: 'did:ethr:84532:0x2222222222222222222222222222222222222222',
    quotedAmount: overrides.quotedAmount ?? '7000000',
    originalAmount: '5000000',
    maxPrice: '10000000',
    chainId: overrides.chainId ?? 84532,
    kernelAddress: KERNEL_TESTNET,
    expiresAt: overrides.expiresAt,
  });
}

async function buildCounter(
  signer: HDNodeWallet,
  overrides: { txId?: string; chainId?: number } = {},
): Promise<CounterOfferMessage> {
  const builder = new CounterOfferBuilder(signer, new InMemoryNonceManager());
  return builder.build({
    txId: overrides.txId ?? TX_ID_A,
    consumer: `did:ethr:84532:${signer.address}`,
    provider: 'did:ethr:84532:0x1111111111111111111111111111111111111111',
    quoteAmount: '7000000',
    counterAmount: '6000000',
    maxPrice: '10000000',
    inReplyTo: QUOTE_HASH,
    chainId: overrides.chainId ?? 84532,
    kernelAddress: KERNEL_TESTNET,
  });
}

// ============================================================================
// buildChannelPath
// ============================================================================

describe('buildChannelPath', () => {
  it('encodes chainId and txId in the canonical shape', () => {
    expect(buildChannelPath(84532, TX_ID_A)).toBe(`/quote-channel/84532/${TX_ID_A}`);
  });
});

// ============================================================================
// InMemoryDedupStore
// ============================================================================

describe('InMemoryDedupStore', () => {
  it('returns fresh on first check, duplicate on second', async () => {
    const store = new InMemoryDedupStore();
    expect(await store.check('k1')).toBe('fresh');
    await store.record('k1', 60_000);
    expect(await store.check('k1')).toBe('duplicate');
  });

  it('expires after TTL', async () => {
    const store = new InMemoryDedupStore();
    await store.record('k1', 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.check('k1')).toBe('fresh');
  });

  it('bounds map size — oldest entries evicted past maxSize', async () => {
    const store = new InMemoryDedupStore(3);
    await store.record('a', 60_000);
    await store.record('b', 60_000);
    await store.record('c', 60_000);
    await store.record('d', 60_000); // pushes 'a' out
    expect(await store.check('a')).toBe('fresh');
    expect(await store.check('b')).toBe('duplicate');
  });
});

// ============================================================================
// QuoteChannelHandler
// ============================================================================

describe('QuoteChannelHandler', () => {
  let providerWallet: HDNodeWallet;
  let buyerWallet: HDNodeWallet;
  let handler: QuoteChannelHandler;

  beforeEach(() => {
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
    handler = new QuoteChannelHandler({
      kernelAddressByChainId: {
        84532: KERNEL_TESTNET,
        8453: KERNEL_MAINNET,
      },
    });
  });

  it('accepts a fresh valid quote → 201', async () => {
    const quote = await buildQuote(providerWallet);
    const res = await handler.handle(
      { type: 'agirails.quote.v1', message: quote },
      { pathChainId: 84532, pathTxId: TX_ID_A },
    );
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accepted: true, duplicate: false });
  });

  it('AIP-2.1 §8.4 replay: 100× same POST → 1 effect, 99 cached idempotent', async () => {
    const quote = await buildQuote(providerWallet);
    const ctx = { pathChainId: 84532, pathTxId: TX_ID_A };
    const payload = { type: 'agirails.quote.v1' as const, message: quote };

    const first = await handler.handle(payload, ctx);
    expect(first.status).toBe(201);

    let dupes = 0;
    for (let i = 0; i < 99; i++) {
      const r = await handler.handle(payload, ctx);
      if (r.status === 200 && 'duplicate' in r.body && r.body.duplicate === true) dupes++;
    }
    expect(dupes).toBe(99);
  });

  it('AIP-2.1 §8.4 cross-tx: quote(txA) POSTed to URL for txB → 400', async () => {
    const quote = await buildQuote(providerWallet, { txId: TX_ID_A });
    const res = await handler.handle(
      { type: 'agirails.quote.v1', message: quote },
      { pathChainId: 84532, pathTxId: TX_ID_B },
    );
    expect(res.status).toBe(400);
    if (!res.body.accepted) {
      expect(res.body.reason).toContain('txId mismatch');
    }
  });

  it('AIP-2.1 §8.4 expired: expiresAt = now - 60 → 410', async () => {
    // Build with a normal expiresAt then mutate post-build to bypass the
    // builder's own future-check. Re-sign so the signature stays valid;
    // otherwise we'd hit 401 (signature failure) before the expiry check.
    const builder = new QuoteBuilder(providerWallet, new InMemoryNonceManager());
    const valid = await builder.build({
      txId: TX_ID_A,
      provider: `did:ethr:84532:${providerWallet.address}`,
      consumer: 'did:ethr:84532:0x2222222222222222222222222222222222222222',
      quotedAmount: '7000000',
      originalAmount: '5000000',
      maxPrice: '10000000',
      chainId: 84532,
      kernelAddress: KERNEL_TESTNET,
    });
    const expired: QuoteMessage = { ...valid, expiresAt: Math.floor(Date.now() / 1000) - 600 };
    // Note: signature still binds to original expiresAt — handler rejects on
    // expiry first (cheaper), so we don't need to re-sign for this test.
    const res = await handler.handle(
      { type: 'agirails.quote.v1', message: expired },
      { pathChainId: 84532, pathTxId: TX_ID_A },
    );
    expect(res.status).toBe(410);
  });

  it('AIP-2.1 §8.4 cross-network: chainId=8453 POSTed to chainId=84532 path → 400', async () => {
    // Build a quote signed for mainnet then POST it to a testnet URL.
    const quote = await buildQuote(providerWallet, { chainId: 8453 });
    const res = await handler.handle(
      { type: 'agirails.quote.v1', message: quote },
      { pathChainId: 84532, pathTxId: TX_ID_A },
    );
    expect(res.status).toBe(400);
    if (!res.body.accepted) {
      expect(res.body.reason).toContain('chainId mismatch');
    }
  });

  it('rejects invalid payload shape → 400', async () => {
    const res = await handler.handle(
      { wrong: 'shape' },
      { pathChainId: 84532, pathTxId: TX_ID_A },
    );
    expect(res.status).toBe(400);
  });

  it('rejects when kernel address is not configured for the chain → 400', async () => {
    const isolatedHandler = new QuoteChannelHandler({
      kernelAddressByChainId: { 84532: KERNEL_TESTNET }, // no mainnet
    });
    const quote = await buildQuote(providerWallet, { chainId: 8453 });
    // path matches message chain so we reach the kernel-lookup step
    const res = await isolatedHandler.handle(
      { type: 'agirails.quote.v1', message: quote },
      { pathChainId: 8453, pathTxId: TX_ID_A },
    );
    expect(res.status).toBe(400);
    if (!res.body.accepted) {
      expect(res.body.reason).toContain('Unsupported chainId');
    }
  });

  it('returns 401 when signature was tampered', async () => {
    const quote = await buildQuote(providerWallet);
    const tampered: QuoteMessage = {
      ...quote,
      signature: '0x' + '00'.repeat(65),
    };
    const res = await handler.handle(
      { type: 'agirails.quote.v1', message: tampered },
      { pathChainId: 84532, pathTxId: TX_ID_A },
    );
    expect(res.status).toBe(401);
  });

  it('handles counter-offer payload symmetrically', async () => {
    const counter = await buildCounter(buyerWallet);
    const res = await handler.handle(
      { type: 'agirails.counteroffer.v1', message: counter },
      { pathChainId: 84532, pathTxId: TX_ID_A },
    );
    expect(res.status).toBe(201);
  });
});

// ============================================================================
// QuoteChannelClient
// ============================================================================

describe('QuoteChannelClient', () => {
  let providerWallet: HDNodeWallet;
  let buyerWallet: HDNodeWallet;

  beforeEach(() => {
    providerWallet = Wallet.createRandom();
    buyerWallet = Wallet.createRandom();
  });

  it('POSTs quote to /quote-channel/{chainId}/{txId}', async () => {
    const quote = await buildQuote(providerWallet);
    const calls: { url: string; body: string }[] = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('{"accepted":true}', { status: 201 });
    };
    const client = new QuoteChannelClient({ fetchImpl: fakeFetch as typeof fetch });

    await client.sendQuote('https://provider.example.com/agent', quote);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://provider.example.com/agent/quote-channel/84532/${TX_ID_A}`,
    );
    const body = JSON.parse(calls[0].body);
    expect(body.type).toBe('agirails.quote.v1');
    expect(body.message.txId).toBe(TX_ID_A);
  });

  it('strips trailing slash from peer endpoint', async () => {
    const quote = await buildQuote(providerWallet);
    let receivedUrl = '';
    const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
      receivedUrl = String(url);
      return new Response('{}', { status: 201 });
    };
    const client = new QuoteChannelClient({ fetchImpl: fakeFetch as typeof fetch });

    await client.sendQuote('https://provider.example.com/agent/', quote);

    expect(receivedUrl).toBe(`https://provider.example.com/agent/quote-channel/84532/${TX_ID_A}`);
  });

  it('throws on non-2xx response with status + body in error', async () => {
    const quote = await buildQuote(providerWallet);
    const fakeFetch = async (): Promise<Response> => new Response('Forbidden — bad signature', {
      status: 401, statusText: 'Unauthorized',
    });
    const client = new QuoteChannelClient({ fetchImpl: fakeFetch as typeof fetch });

    await expect(client.sendQuote('https://provider.example.com', quote)).rejects.toThrow(
      /401.*bad signature/,
    );
  });

  it('aborts request after timeout', async () => {
    const quote = await buildQuote(providerWallet);
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      // Hang until the abort fires.
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response('{}', { status: 200 });
    };
    const client = new QuoteChannelClient({ fetchImpl: fakeFetch as typeof fetch, timeoutMs: 50 });

    await expect(client.sendQuote('https://provider.example.com', quote)).rejects.toThrow();
  });

  it('sendCounter posts to the same path shape using counter.chainId/txId', async () => {
    const counter = await buildCounter(buyerWallet);
    let receivedUrl = '';
    let receivedType = '';
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      receivedUrl = String(url);
      receivedType = JSON.parse(String(init?.body ?? '{}')).type;
      return new Response('{}', { status: 201 });
    };
    const client = new QuoteChannelClient({ fetchImpl: fakeFetch as typeof fetch });

    await client.sendCounter('https://buyer.example.com', counter);

    expect(receivedUrl).toBe(
      `https://buyer.example.com/quote-channel/84532/${TX_ID_A}`,
    );
    expect(receivedType).toBe('agirails.counteroffer.v1');
  });
});
