/**
 * RelayChannel — exercises the polling client against a fake fetch.
 * Mirrors the MockChannel contract so both impls are interchangeable.
 */

import { Wallet, HDNodeWallet } from 'ethers';
import { RelayChannel } from './RelayChannel';
import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import type { NegotiationMessage, DeliveredMessage } from './NegotiationChannel';

const KERNEL = '0x1234567890123456789012345678901234567890';
const CHAIN_ID = 84_532;
const TX_ID = '0x' + 'a'.repeat(64);
const BASE = 'https://relay.test';

interface RelayState {
  messages: Array<{ cursor: string; envelope: NegotiationMessage; receivedAt: number; txId: string }>;
  agentInbox: Array<{ cursor: string; txId: string; envelope: NegotiationMessage; receivedAt: number }>;
  postedCount: number;
}

function makeFetchFake(state: RelayState): typeof fetch {
  return (async (input: string | URL, init?: { method?: string; body?: string }) => {
    const url = typeof input === 'string' ? new URL(input) : input;
    const path = url.pathname;
    const method = init?.method ?? 'GET';

    if (method === 'POST' && /^\/api\/v1\/negotiations\/0x[a-fA-F0-9]{64}\/messages$/.test(path)) {
      const txId = path.split('/')[4];
      const envelope = JSON.parse(init!.body!) as NegotiationMessage;
      state.postedCount++;
      const cursor = String(state.messages.length + 1);
      state.messages.push({ cursor, envelope, receivedAt: Math.floor(Date.now() / 1000), txId });
      return new Response('{"ok":true}', { status: 201 });
    }

    if (method === 'GET' && /^\/api\/v1\/negotiations\/0x[a-fA-F0-9]{64}\/messages$/.test(path)) {
      const txId = path.split('/')[4];
      const after = url.searchParams.get('after');
      const filtered = state.messages
        .filter((m) => m.txId === txId)
        .filter((m) => !after || Number(m.cursor) > Number(after));
      return new Response(JSON.stringify({ messages: filtered.map((m) => ({ cursor: m.cursor, envelope: m.envelope, receivedAt: m.receivedAt })) }), { status: 200 });
    }

    if (method === 'GET' && /^\/api\/v1\/negotiations\/inbox\/[^/]+$/.test(path)) {
      const after = url.searchParams.get('after');
      const filtered = state.agentInbox.filter((m) => !after || Number(m.cursor) > Number(after));
      return new Response(JSON.stringify({ messages: filtered }), { status: 200 });
    }

    return new Response('{"error":"not found"}', { status: 404 });
  }) as unknown as typeof fetch;
}

async function buildQuote(provider: HDNodeWallet, consumer: HDNodeWallet, nm = new InMemoryNonceManager()): Promise<NegotiationMessage> {
  const builder = new QuoteBuilder(provider, nm);
  const quote = await builder.build({
    txId: TX_ID,
    provider: `did:ethr:${CHAIN_ID}:${provider.address}`,
    consumer: `did:ethr:${CHAIN_ID}:${consumer.address}`,
    quotedAmount: '7000000',
    originalAmount: '5000000',
    maxPrice: '10000000',
    chainId: CHAIN_ID,
    kernelAddress: KERNEL,
  });
  return { type: 'agirails.quote.v1', message: quote };
}

describe('RelayChannel', () => {
  let provider: HDNodeWallet;
  let consumer: HDNodeWallet;
  let state: RelayState;
  let channel: RelayChannel;

  beforeEach(() => {
    provider = Wallet.createRandom();
    consumer = Wallet.createRandom();
    state = { messages: [], agentInbox: [], postedCount: 0 };
    channel = new RelayChannel({
      baseUrl: BASE,
      kernelAddressByChainId: { [CHAIN_ID]: KERNEL },
      pollIntervalMs: 30,
      fetchImpl: makeFetchFake(state),
    });
  });

  afterEach(async () => {
    await channel.close();
  });

  it('POSTs a message to the relay', async () => {
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    expect(state.postedCount).toBe(1);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].envelope.type).toBe('agirails.quote.v1');
  });

  it('throws on relay POST failure (non-2xx)', async () => {
    const failChannel = new RelayChannel({
      baseUrl: BASE,
      kernelAddressByChainId: { [CHAIN_ID]: KERNEL },
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    const quote = await buildQuote(provider, consumer);
    await expect(failChannel.post(TX_ID, quote)).rejects.toThrow(/Relay POST 500/);
  });

  it('subscribeTxId polls and delivers a posted message', async () => {
    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    // Wait a few poll intervals to ensure pickup.
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    expect(received[0].envelope.type).toBe('agirails.quote.v1');
  });

  it('dedups across poll cycles (cursor advances)', async () => {
    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    // No new posts; subsequent polls should NOT redeliver.
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
  });

  it('drops messages that fail EIP-712 verify (tampered signature)', async () => {
    const received: DeliveredMessage[] = [];
    channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    const quote = await buildQuote(provider, consumer);
    state.messages.push({
      cursor: '99',
      txId: TX_ID,
      envelope: { type: 'agirails.quote.v1', message: { ...quote.message as QuoteMessage, signature: '0x' + '0'.repeat(130) } },
      receivedAt: Math.floor(Date.now() / 1000),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
  });

  it('unsubscribe stops further deliveries', async () => {
    const received: DeliveredMessage[] = [];
    const sub = channel.subscribeTxId(TX_ID, (d) => { received.push(d); });
    sub.unsubscribe();
    const quote = await buildQuote(provider, consumer);
    await channel.post(TX_ID, quote);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
  });

  // ==========================================================================
  // Apex audit FIND-011 — assertSafePeerUrl guard on consumer-supplied baseUrl
  // ==========================================================================

  describe('baseUrl SSRF guard (FIND-011)', () => {
    const kernelMap = { [CHAIN_ID]: KERNEL };
    it('rejects http:// baseUrl by default', () => {
      expect(() => new RelayChannel({
        baseUrl: 'http://relay.test',
        kernelAddressByChainId: kernelMap,
      })).toThrow(/https/);
    });

    it('rejects loopback baseUrl', () => {
      expect(() => new RelayChannel({
        baseUrl: 'https://127.0.0.1:8080',
        kernelAddressByChainId: kernelMap,
      })).toThrow(/loopback|SSRF/);
    });

    it('rejects AWS metadata endpoint', () => {
      expect(() => new RelayChannel({
        baseUrl: 'https://169.254.169.254',
        kernelAddressByChainId: kernelMap,
      })).toThrow(/link-local|metadata|SSRF/);
    });

    it('rejects RFC1918 (192.168.x.x)', () => {
      expect(() => new RelayChannel({
        baseUrl: 'https://192.168.1.1',
        kernelAddressByChainId: kernelMap,
      })).toThrow(/RFC1918|SSRF/);
    });

    it('rejects IPv4-mapped IPv6 loopback bypass', () => {
      expect(() => new RelayChannel({
        baseUrl: 'https://[::ffff:127.0.0.1]',
        kernelAddressByChainId: kernelMap,
      })).toThrow(/loopback|SSRF/);
    });

    it('rejects localhost by name', () => {
      expect(() => new RelayChannel({
        baseUrl: 'https://localhost:3000',
        kernelAddressByChainId: kernelMap,
      })).toThrow(/localhost|SSRF/);
    });

    it('allows insecure targets when explicitly opted in (dev escape hatch)', () => {
      expect(() => new RelayChannel({
        baseUrl: 'http://127.0.0.1:3000',
        kernelAddressByChainId: kernelMap,
        allowInsecureTargets: true,
      })).not.toThrow();
    });

    it('default https public host (e.g. agirails.app) is accepted', () => {
      expect(() => new RelayChannel({
        baseUrl: 'https://agirails.app',
        kernelAddressByChainId: kernelMap,
      })).not.toThrow();
    });
  });

  it('subscribeAgent polls /api/v1/negotiations/inbox/:did and delivers', async () => {
    const providerDID = `did:ethr:${CHAIN_ID}:${provider.address}`;
    const collected: Array<{ txId: string; type: string }> = [];
    channel.subscribeAgent(providerDID, (txId, d) => { collected.push({ txId, type: d.envelope.type }); });

    const quote = await buildQuote(provider, consumer);
    state.agentInbox.push({
      cursor: '1', txId: TX_ID,
      envelope: quote, receivedAt: Math.floor(Date.now() / 1000),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(collected).toHaveLength(1);
    expect(collected[0].txId).toBe(TX_ID);
    expect(collected[0].type).toBe('agirails.quote.v1');
  });
});
