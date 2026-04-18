/**
 * E2E: spawn `actp serve` as a real subprocess + exercise the HTTP
 * surface end-to-end.
 *
 * This is the closest thing to "what an integrator runs" — bin/actp,
 * --mock runtime, real HTTP socket, real JSON serialization. Verifies
 * the CLI bootstrap + slow-loris hardening + path-binding behavior we
 * just shipped.
 *
 * Skipped if the dist/ build is missing (build is required because
 * bin/actp loads dist/cli/agirails.js).
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Wallet } from 'ethers';
import { CounterOfferBuilder } from '../builders/CounterOfferBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';

const DIST_PATH = path.join(__dirname, '..', '..', 'dist');
const SDK_ROOT = path.join(__dirname, '..', '..');
const CHAIN_ID = 84_532;

function distExists(): boolean {
  return fs.existsSync(path.join(DIST_PATH, 'cli', 'agirails.js'));
}

const describeIfDist = distExists() ? describe : describe.skip;

describeIfDist('E2E: actp serve subprocess', () => {
  let policyPath: string;
  let testCwd: string;
  let serverProc: ChildProcess | null = null;
  let port: number;

  beforeAll(async () => {
    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'actp-serve-e2e-'));
    policyPath = path.join(testCwd, 'policy.json');
    const policy = {
      services: ['code-review', 'translation'],
      pricing: {
        min_acceptable: { amount: 3, currency: 'USDC', unit: 'job' },
        ideal_price: { amount: 7, currency: 'USDC', unit: 'job' },
      },
      quote_ttl: '15m',
    };
    fs.writeFileSync(policyPath, JSON.stringify(policy));
    // Pick a random high port to avoid conflicts.
    port = 19000 + Math.floor(Math.random() * 5000);

    serverProc = spawn(
      'node',
      [path.join(SDK_ROOT, 'bin', 'actp'), 'serve', '--mock', '--policy', policyPath, '--port', String(port)],
      { cwd: testCwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // Capture output for debugging if the test fails.
    let allOutput = '';
    serverProc.stdout?.on('data', (chunk: Buffer) => { allOutput += chunk.toString(); });
    serverProc.stderr?.on('data', (chunk: Buffer) => { allOutput += chunk.toString(); });

    // Wait for the server to be ready (poll GET /).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) {
          const body = await res.json() as { status: string };
          if (body.status === 'ok') return;
        }
      } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`actp serve did not become ready in 15s. Output:\n${allOutput}`);
  }, 30_000);

  afterAll(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
    if (testCwd && fs.existsSync(testCwd)) {
      fs.rmSync(testCwd, { recursive: true, force: true });
    }
  });

  it('responds to GET / health check', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('actp-serve');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/no-such-path`);
    expect(res.status).toBe(404);
  });

  it('rejects a counter with chainId mismatch (path vs message) — 400', async () => {
    // Build a real signed counter with chainId=8453 (mainnet)
    // and POST it to /quote-channel/84532/<txId> (sepolia).
    // Path-binding must fire BEFORE signature verify.
    const w = Wallet.createRandom();
    const counter = await new CounterOfferBuilder(w, new InMemoryNonceManager()).build({
      txId: '0x' + 'a'.repeat(64),
      consumer: `did:ethr:8453:${w.address}`,
      provider: `did:ethr:8453:${'0x' + '1'.repeat(40)}`,
      quoteAmount: '7000000',
      counterAmount: '6000000',
      maxPrice: '10000000',
      inReplyTo: '0x' + 'b'.repeat(64),
      chainId: 8453,
      kernelAddress: '0x' + '3'.repeat(40),
    });

    const url = `http://127.0.0.1:${port}/quote-channel/${CHAIN_ID}/${counter.txId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'agirails.counteroffer.v1', message: counter }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { reason: string };
    expect(body.reason).toMatch(/chainId/i);
  });

  it('rejects a malformed JSON body — 400', async () => {
    const url = `http://127.0.0.1:${port}/quote-channel/${CHAIN_ID}/0x${'c'.repeat(64)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an oversize body — server caps reads at 64 KiB', async () => {
    const huge = JSON.stringify({ junk: 'x'.repeat(80 * 1024) });
    const url = `http://127.0.0.1:${port}/quote-channel/${CHAIN_ID}/0x${'d'.repeat(64)}`;
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
    expect(outcome === 'rejected' || (status !== null && status >= 400)).toBe(true);
  });
});
