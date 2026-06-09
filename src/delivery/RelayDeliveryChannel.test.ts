/**
 * Unit tests for RelayDeliveryChannel (AIP-16 Phase 2b).
 *
 * Covers: POST shape, GET shape, cursor pagination, polling, close(),
 * SSRF guards, request timeout, dedup-after-verify on the read side,
 * subscriber error isolation.
 *
 * Uses an injectable `fetchImpl` to mock all HTTP traffic.
 */

import { HDNodeWallet, Wallet } from 'ethers';

import { DeliveryEnvelopeBuilder } from './envelopeBuilder';
import { generateEphemeralKeyPair } from './keys';
import {
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  RelayDeliveryChannel,
} from './RelayDeliveryChannel';
import { DeliverySetupBuilder } from './setupBuilder';
import type {
  DeliveryEnvelopeWireV1,
  DeliverySetupWireV1,
} from './types';

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const KERNEL = '0x469CBADbACFFE096270594F0a31f0EEC53753411';
const CHAIN_ID = 84532;
const BASE_NOW = 1_750_000_000;
const TX_ID = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const BASE_URL = 'https://relay.example.com';

async function buildSetup(wallet: HDNodeWallet, createdAt = BASE_NOW): Promise<DeliverySetupWireV1> {
  const kp = generateEphemeralKeyPair();
  const builder = new DeliverySetupBuilder(wallet);
  const { wire } = await builder.build({
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL as `0x${string}`,
    requesterAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    buyerEphemeralPubkey: kp.publicKeyHex,
    expectedPrivacy: 'encrypted',
    createdAt,
    expiresInSec: 3600,
  });
  return wire;
}

async function buildEnvelope(wallet: HDNodeWallet, createdAt = BASE_NOW): Promise<DeliveryEnvelopeWireV1> {
  const builder = new DeliveryEnvelopeBuilder(wallet);
  const { wire } = await builder.buildPublic({
    txId: TX_ID,
    chainId: CHAIN_ID,
    kernelAddress: KERNEL as `0x${string}`,
    providerAddress: wallet.address as `0x${string}`,
    signerAddress: wallet.address as `0x${string}`,
    payload: { ok: true },
    createdAt,
  });
  return wire;
}

interface RecordedReq {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function mockOk(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value),
  } as unknown as Response;
}

function mockCreated(): Response {
  return {
    ok: true,
    status: 201,
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response;
}

function mockErr(status: number, body = 'error'): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

// ----------------------------------------------------------------------------
// publish
// ----------------------------------------------------------------------------

describe('RelayDeliveryChannel.publishSetup()', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('POSTs to /api/v1/delivery/setup with JSON body', async () => {
    const recorded: RecordedReq[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      recorded.push({
        url: u,
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: init?.headers as Record<string, string>,
      });
      return mockCreated();
    };
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    const wire = await buildSetup(wallet);
    await channel.publishSetup(wire);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe(`${BASE_URL}/api/v1/delivery/setup`);
    expect(recorded[0]?.method).toBe('POST');
    expect(JSON.parse(recorded[0]?.body ?? '{}')).toEqual(JSON.parse(JSON.stringify(wire)));
    expect((recorded[0]?.headers ?? {})['Content-Type']).toBe('application/json');
  });

  test('resolves on 201', async () => {
    const fetchImpl: typeof fetch = async () => mockCreated();
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await expect(channel.publishSetup(await buildSetup(wallet))).resolves.toBeUndefined();
  });

  test('resolves on 200', async () => {
    const fetchImpl: typeof fetch = async () => mockOk({});
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await expect(channel.publishSetup(await buildSetup(wallet))).resolves.toBeUndefined();
  });

  test('rejects on 400 with body in error message', async () => {
    const fetchImpl: typeof fetch = async () => mockErr(400, 'bad-request');
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await expect(channel.publishSetup(await buildSetup(wallet))).rejects.toThrow(/400/);
  });

  test('rejects on 500', async () => {
    const fetchImpl: typeof fetch = async () => mockErr(500, 'oops');
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await expect(channel.publishSetup(await buildSetup(wallet))).rejects.toThrow(/500/);
  });

  test('warn log on non-2xx', async () => {
    const events: Array<{ level: string; msg: string }> = [];
    const fetchImpl: typeof fetch = async () => mockErr(400, 'bad');
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      log: (level, msg) => {
        events.push({ level, msg });
      },
    });
    await expect(channel.publishSetup(await buildSetup(wallet))).rejects.toBeDefined();
    expect(events.some((e) => e.level === 'warn' && /non-2xx/.test(e.msg))).toBe(true);
  });

  test('strips trailing slash on baseUrl', async () => {
    const recorded: RecordedReq[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      recorded.push({ url: typeof url === 'string' ? url : url.toString(), method: init?.method });
      return mockCreated();
    };
    const channel = new RelayDeliveryChannel({ baseUrl: `${BASE_URL}//`, fetchImpl });
    await channel.publishSetup(await buildSetup(wallet));
    expect(recorded[0]?.url).toBe(`${BASE_URL}/api/v1/delivery/setup`);
  });
});

describe('RelayDeliveryChannel.publishEnvelope()', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('POSTs to /api/v1/delivery', async () => {
    const recorded: RecordedReq[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      recorded.push({ url: typeof url === 'string' ? url : url.toString(), method: init?.method });
      return mockCreated();
    };
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await channel.publishEnvelope(await buildEnvelope(wallet));
    expect(recorded[0]?.url).toBe(`${BASE_URL}/api/v1/delivery`);
    expect(recorded[0]?.method).toBe('POST');
  });

  test('rejects on 4xx', async () => {
    const fetchImpl: typeof fetch = async () => mockErr(404, 'not-found');
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await expect(channel.publishEnvelope(await buildEnvelope(wallet))).rejects.toThrow(/404/);
  });
});

// ----------------------------------------------------------------------------
// get
// ----------------------------------------------------------------------------

describe('RelayDeliveryChannel.getSetups() / getEnvelopes()', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('GET /api/v1/delivery/setup/{txId} returns wires', async () => {
    const wire = await buildSetup(wallet);
    const recorded: RecordedReq[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      recorded.push({ url: typeof url === 'string' ? url : url.toString(), method: init?.method });
      return mockOk({ items: [{ cursor: 'c1', wire }] });
    };
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    const setups = await channel.getSetups(TX_ID);
    expect(recorded[0]?.url).toContain('/api/v1/delivery/setup/');
    expect(recorded[0]?.method).toBe('GET');
    expect(setups).toHaveLength(1);
    expect(setups[0]?.signed.txId).toBe(TX_ID);
  });

  test('GET /api/v1/delivery/{txId} returns wires', async () => {
    const wire = await buildEnvelope(wallet);
    const recorded: RecordedReq[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      recorded.push({ url: typeof url === 'string' ? url : url.toString() });
      return mockOk({ items: [{ cursor: 'c1', wire }] });
    };
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    const envs = await channel.getEnvelopes(TX_ID);
    expect(recorded[0]?.url).toContain(`/api/v1/delivery/${TX_ID}`);
    expect(envs).toHaveLength(1);
  });

  test('getSetups with after cursor includes ?after=', async () => {
    const recorded: RecordedReq[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      recorded.push({ url: typeof url === 'string' ? url : url.toString() });
      return mockOk({ items: [] });
    };
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await channel.getSetups(TX_ID, 'cursor-123');
    expect(recorded[0]?.url).toMatch(/[?&]after=cursor-123/);
  });

  test('getEnvelopes with after cursor includes ?after=', async () => {
    const recorded: RecordedReq[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      recorded.push({ url: typeof url === 'string' ? url : url.toString() });
      return mockOk({ items: [] });
    };
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await channel.getEnvelopes(TX_ID, 'env-cursor');
    expect(recorded[0]?.url).toMatch(/[?&]after=env-cursor/);
  });

  test('GET 5xx rejects', async () => {
    const fetchImpl: typeof fetch = async () => mockErr(503, 'busy');
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await expect(channel.getSetups(TX_ID)).rejects.toThrow(/503/);
  });

  test('empty items array → empty result', async () => {
    const fetchImpl: typeof fetch = async () => mockOk({ items: [] });
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    expect(await channel.getSetups(TX_ID)).toEqual([]);
    expect(await channel.getEnvelopes(TX_ID)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// subscribe
// ----------------------------------------------------------------------------

describe('RelayDeliveryChannel.subscribeSetups()', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('polls relay and delivers verified setups', async () => {
    const wire = await buildSetup(wallet);
    let serverCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      serverCalls++;
      if (serverCalls === 1) {
        return mockOk({ items: [{ cursor: 'c1', wire }] });
      }
      return mockOk({ items: [] });
    };
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 10,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const received: DeliverySetupWireV1[] = [];
    const sub = await channel.subscribeSetups(TX_ID, (w) => {
      received.push(w);
    });
    await new Promise((r) => setTimeout(r, 80));
    await sub.close();
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.signed.txId).toBe(TX_ID);
  });

  test('dedup-after-verify: bad-sig setup dropped + logged, not added to dedup', async () => {
    const wire = await buildSetup(wallet);
    const tampered: DeliverySetupWireV1 = {
      ...wire,
      signed: { ...wire.signed, txId: ('0x' + 'cd'.repeat(32)) as `0x${string}` },
    };
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return mockOk({ items: [{ cursor: 'c1', wire: tampered }] });
      }
      return mockOk({ items: [] });
    };
    const events: Array<{ level: string; msg: string }> = [];
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 10,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
      log: (level, msg) => {
        events.push({ level, msg });
      },
    });
    const received: DeliverySetupWireV1[] = [];
    const sub = await channel.subscribeSetups(TX_ID, (w) => {
      received.push(w);
    });
    await new Promise((r) => setTimeout(r, 50));
    await sub.close();
    expect(received).toHaveLength(0);
    expect(events.some((e) => /dropping unverified/.test(e.msg))).toBe(true);
  });

  test('close() stops polling (no new fetches after close)', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return mockOk({ items: [] });
    };
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 5,
    });
    const sub = await channel.subscribeSetups(TX_ID, () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    const callsAtClose = calls;
    await sub.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBeLessThanOrEqual(callsAtClose + 1);
  });

  test('subscriber throw isolated (does NOT halt polling)', async () => {
    const wire = await buildSetup(wallet);
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) return mockOk({ items: [{ cursor: 'c1', wire }] });
      return mockOk({ items: [] });
    };
    const events: Array<{ level: string; msg: string }> = [];
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 10,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
      log: (level, msg) => {
        events.push({ level, msg });
      },
    });
    const sub = await channel.subscribeSetups(TX_ID, () => {
      throw new Error('boom');
    });
    await new Promise((r) => setTimeout(r, 60));
    await sub.close();
    expect(events.some((e) => /subscriber threw/.test(e.msg))).toBe(true);
    expect(calls).toBeGreaterThan(2);
  });

  test('polling appends cursor on subsequent calls', async () => {
    const wire = await buildSetup(wallet);
    const urls: string[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      urls.push(u);
      call++;
      if (call === 1) return mockOk({ items: [{ cursor: 'c-first', wire }] });
      return mockOk({ items: [] });
    };
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 10,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const sub = await channel.subscribeSetups(TX_ID, () => undefined);
    await new Promise((r) => setTimeout(r, 60));
    await sub.close();
    expect(urls.some((u) => /after=c-first/.test(u))).toBe(true);
  });
});

describe('RelayDeliveryChannel.subscribeEnvelopes()', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('polls + delivers verified envelopes', async () => {
    const wire = await buildEnvelope(wallet);
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) return mockOk({ items: [{ cursor: 'c1', wire }] });
      return mockOk({ items: [] });
    };
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 10,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const received: DeliveryEnvelopeWireV1[] = [];
    const sub = await channel.subscribeEnvelopes(TX_ID, (w) => {
      received.push(w);
    });
    await new Promise((r) => setTimeout(r, 60));
    await sub.close();
    expect(received).toHaveLength(1);
  });

  test('dedup: same envelope re-served twice fires only once', async () => {
    const wire = await buildEnvelope(wallet);
    const fetchImpl: typeof fetch = async () =>
      mockOk({ items: [{ cursor: 'c1', wire }] });
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 10,
      expectedKernelAddress: KERNEL,
      expectedChainId: CHAIN_ID,
      now: () => BASE_NOW,
    });
    const received: DeliveryEnvelopeWireV1[] = [];
    const sub = await channel.subscribeEnvelopes(TX_ID, (w) => {
      received.push(w);
    });
    await new Promise((r) => setTimeout(r, 60));
    await sub.close();
    expect(received).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// SSRF guard
// ----------------------------------------------------------------------------

describe('RelayDeliveryChannel SSRF guard', () => {
  test('refuses http://127.0.0.1 by default', () => {
    expect(
      () => new RelayDeliveryChannel({ baseUrl: 'http://127.0.0.1' }),
    ).toThrow(/SSRF|loopback|https/);
  });

  test('refuses http://10.0.0.1', () => {
    expect(
      () => new RelayDeliveryChannel({ baseUrl: 'http://10.0.0.1' }),
    ).toThrow(/SSRF|RFC1918|https/);
  });

  test('refuses http://192.168.0.1', () => {
    expect(
      () => new RelayDeliveryChannel({ baseUrl: 'http://192.168.0.1' }),
    ).toThrow(/SSRF|RFC1918|https/);
  });

  test('refuses http://169.254.169.254 (cloud metadata)', () => {
    expect(
      () => new RelayDeliveryChannel({ baseUrl: 'http://169.254.169.254' }),
    ).toThrow(/SSRF|link-local|metadata|https/);
  });

  test('refuses http://localhost', () => {
    expect(
      () => new RelayDeliveryChannel({ baseUrl: 'http://localhost' }),
    ).toThrow(/SSRF|localhost|https/);
  });

  test('allowPrivateHosts=true bypass for localhost (dev only)', () => {
    expect(
      () =>
        new RelayDeliveryChannel({
          baseUrl: 'http://localhost:8080',
          allowPrivateHosts: true,
        }),
    ).not.toThrow();
  });

  test('allowPrivateHosts=true bypass for 127.0.0.1', () => {
    expect(
      () =>
        new RelayDeliveryChannel({
          baseUrl: 'http://127.0.0.1:3000',
          allowPrivateHosts: true,
        }),
    ).not.toThrow();
  });

  test('https://relay.example.com accepted by default', () => {
    expect(
      () => new RelayDeliveryChannel({ baseUrl: 'https://relay.example.com' }),
    ).not.toThrow();
  });

  test('invalid URL throws', () => {
    expect(() => new RelayDeliveryChannel({ baseUrl: 'not-a-url' })).toThrow();
  });
});

// ----------------------------------------------------------------------------
// Timeouts
// ----------------------------------------------------------------------------

describe('RelayDeliveryChannel request timeout', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('aborts slow POST via AbortController', async () => {
    const fetchImpl: typeof fetch = (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) reject(new Error('aborted'));
          sig.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    };
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      requestTimeoutMs: 20,
    });
    await expect(channel.publishSetup(await buildSetup(wallet))).rejects.toThrow(/abort/i);
  });

  test('default timeout is REQUEST_TIMEOUT_MS', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(8000);
  });

  test('default poll interval is POLL_INTERVAL_MS', () => {
    expect(POLL_INTERVAL_MS).toBe(1000);
  });
});

// ----------------------------------------------------------------------------
// close()
// ----------------------------------------------------------------------------

describe('RelayDeliveryChannel.close()', () => {
  let wallet: HDNodeWallet;
  beforeEach(() => {
    wallet = Wallet.createRandom();
  });

  test('close() rejects subsequent publish', async () => {
    const fetchImpl: typeof fetch = async () => mockCreated();
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await channel.close();
    await expect(channel.publishSetup(await buildSetup(wallet))).rejects.toThrow(/closed/i);
  });

  test('close() rejects subsequent subscribe', async () => {
    const fetchImpl: typeof fetch = async () => mockOk({ items: [] });
    const channel = new RelayDeliveryChannel({ baseUrl: BASE_URL, fetchImpl });
    await channel.close();
    await expect(channel.subscribeSetups(TX_ID, () => undefined)).rejects.toThrow(/closed/i);
  });

  test('close() cancels active subscriptions', async () => {
    let polls = 0;
    const fetchImpl: typeof fetch = async () => {
      polls++;
      return mockOk({ items: [] });
    };
    const channel = new RelayDeliveryChannel({
      baseUrl: BASE_URL,
      fetchImpl,
      pollIntervalMs: 5,
    });
    await channel.subscribeSetups(TX_ID, () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    const baseline = polls;
    await channel.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(polls).toBeLessThanOrEqual(baseline + 1);
  });
});
