/**
 * runRequest tests (PRD §5.6).
 *
 * Covers:
 *  - On-chain serviceDescription is the bytes32 routing key, never JSON.
 *  - Quote-phase timeout surfaces QuoteTimeoutError with the actionable
 *    cancel hint, leaving the TX on-chain INITIATED.
 *  - Happy path on MockRuntime: handler runs, requester settles immediately.
 *
 * BuyerOrchestrator + level0/request fixes are validated separately via
 * existing suites and are also covered indirectly by the runRequest happy
 * path (which exercises the shared createTransaction routing-key
 * invariant).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { keccak256, toUtf8Bytes } from 'ethers';
import { runRequest, QuoteTimeoutError } from './runRequest';
import { Agent } from '../../level1/Agent';
import { ACTPClient } from '../../ACTPClient';

describe('runRequest (PRD §5.6)', () => {
  let testDir: string;
  // Reuse the deterministic mock-mode requester slot from runRequest so the
  // mint-and-spend cycle works without a real keypair.
  const PROVIDER = '0x' + 'b'.repeat(40);

  beforeEach(() => {
    const base = path.join(os.homedir(), '.agirails');
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    testDir = fs.mkdtempSync(path.join(base, 'runRequest-test-'));
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('puts the bytes32 routing key on-chain, not JSON metadata (Layer B invariant)', async () => {
    // No provider registered on the receiver side — we don't care that no
    // quote arrives. We only care what `createTransaction` recorded. We use
    // a very short quote-timeout and assert the TX exists with the correct
    // serviceHash before the QuoteTimeoutError fires.
    let observedTxId: string | undefined;

    const attempt = runRequest({
      provider: PROVIDER,
      amount: '0.05',
      service: 'onboarding',
      network: 'mock',
      quoteTimeoutMs: 200, // fail fast
      stateDirectory: testDir,
      onTransition: (state, txId) => {
        if (state === 'INITIATED') observedTxId = txId;
      },
    });

    await expect(attempt).rejects.toBeInstanceOf(QuoteTimeoutError);
    expect(observedTxId).toBeDefined();

    // The TX is still on-chain — open a fresh client against the same state
    // dir and read the serviceHash field directly.
    const { ACTPClient } = await import('../../ACTPClient');
    const client = await ACTPClient.create({
      mode: 'mock',
      requesterAddress: '0x' + Buffer.from('requester').toString('hex').padEnd(40, '0'),
      stateDirectory: testDir,
    });
    const tx = await client.runtime.getTransaction(observedTxId!);
    expect(tx).toBeDefined();
    expect(tx!.serviceHash).toBe(keccak256(toUtf8Bytes('onboarding')));
    // The legacy JSON-envelope hash MUST NOT appear here.
    expect(tx!.serviceHash).not.toBe(
      keccak256(toUtf8Bytes(JSON.stringify({ service: 'onboarding' })))
    );
  });

  it('surfaces QuoteTimeoutError with an actionable cancel hint when no provider quotes', async () => {
    try {
      await runRequest({
        provider: PROVIDER,
        amount: '0.05',
        service: 'onboarding',
        network: 'mock',
        quoteTimeoutMs: 200,
        stateDirectory: testDir,
      });
      throw new Error('expected QuoteTimeoutError');
    } catch (err) {
      expect(err).toBeInstanceOf(QuoteTimeoutError);
      const qte = err as QuoteTimeoutError;
      expect(qte.timeoutMs).toBe(200);
      expect(qte.message).toMatch(/cancel.*actp tx cancel/);
    }
  });

  // ============================================================================
  // §5.6.1 hardening — bugs surfaced during audit
  // ============================================================================

  describe('§5.6.1 — service name normalization', () => {
    it('trims incidental whitespace before hashing so routing matches `Agent.provide(name)`', async () => {
      // Spy on a real Agent provider that registered 'onboarding'. Without
      // the .trim() in runRequest, this caller would hash ' onboarding\n'
      // and the provider's handlersByHash lookup would miss.
      const provider = new Agent({ name: 'TrimProvider', network: 'mock', stateDirectory: testDir });
      provider.provide('onboarding', async () => ({ ok: true }));
      await provider.start();
      try {
        const r = await runRequest({
          provider: provider.address,
          amount: '0.05',
          service: '  onboarding\n',
          network: 'mock',
          quoteTimeoutMs: 20_000,
          deliveryTimeoutMs: 20_000,
          stateDirectory: testDir,
        });
        expect(r.finalState === 'DELIVERED' || r.finalState === 'SETTLED').toBe(true);
      } finally {
        await provider.stop();
      }
    }, 30_000);

    it('rejects an empty / whitespace-only service name', async () => {
      await expect(
        runRequest({
          provider: PROVIDER,
          amount: '0.05',
          service: '   ',
          network: 'mock',
          stateDirectory: testDir,
        })
      ).rejects.toThrow(/non-empty/);
    });
  });

  describe('§5.6.1 — deadline ms-vs-s sanity check', () => {
    it('rejects an obvious millisecond timestamp (Date.now()) as a unix-seconds deadline', async () => {
      await expect(
        runRequest({
          provider: PROVIDER,
          amount: '0.05',
          service: 'onboarding',
          deadline: Date.now(), // wrong unit — should be Math.floor(Date.now()/1000)
          network: 'mock',
          quoteTimeoutMs: 200,
          stateDirectory: testDir,
        })
      ).rejects.toThrow(/millisecond timestamp/);
    });

    it('accepts a plausible unix-seconds deadline', async () => {
      // Use 200ms quote timeout so the test fails fast with QuoteTimeoutError —
      // we only care that the deadline validation passed.
      await expect(
        runRequest({
          provider: PROVIDER,
          amount: '0.05',
          service: 'onboarding',
          deadline: Math.floor(Date.now() / 1000) + 3600,
          network: 'mock',
          quoteTimeoutMs: 200,
          stateDirectory: testDir,
        })
      ).rejects.toBeInstanceOf(QuoteTimeoutError);
    });
  });

  it('runs end-to-end against a MockRuntime-backed Agent (happy path)', async () => {
    // Spin up a provider Agent on the same state directory. It will pick up
    // the INITIATED tx via its 5 s polling sweep, accept, deliver, and
    // settle. We pre-bind the provider address so the requester's
    // createTransaction targets it.
    const provider = new Agent({
      name: 'HappyProvider',
      network: 'mock',
      stateDirectory: testDir,
    });
    provider.provide('onboarding', async () => ({ reflection: 'be here now' }));
    await provider.start();

    try {
      const result = await runRequest({
        provider: provider.address,
        amount: '0.05',
        service: 'onboarding',
        network: 'mock',
        quoteTimeoutMs: 20_000,
        deliveryTimeoutMs: 20_000,
        stateDirectory: testDir,
      });

      expect(result.finalState === 'DELIVERED' || result.finalState === 'SETTLED').toBe(true);
      expect(result.payload).toBeDefined();
      // The handler returned { reflection: 'be here now' }. The level1 Agent
      // wraps that into a delivery-proof envelope, so the parsed payload
      // contains either the raw object or the envelope.
      const reflection =
        (result.payload as { reflection?: string; result?: { reflection?: string } } | undefined)
          ?.reflection ??
        (result.payload as { result?: { reflection?: string } } | undefined)?.result?.reflection;
      expect(reflection).toBe('be here now');
    } finally {
      await provider.stop();
    }
  }, 30_000);
});
