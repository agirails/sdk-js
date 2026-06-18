/**
 * E2E: routing edge cases (PRD §8.2 cases 5, 6, 7).
 *
 * Three negative-routing scenarios that must each fail safely without
 * dispatching a handler:
 *
 *   Case 5 — Unknown serviceHash. The on-chain hash doesn't match any
 *     `agent.provide(name)` registration. The agent must log + skip,
 *     never dispatch a wrong handler.
 *   Case 6 — ZeroHash (Level 0 `actp pay` semantics). PRD §5.4 calls
 *     this `pay_zerohash_ignored` for observability; the runtime
 *     transport surfaces it, but no handler runs.
 *   Case 7 — INITIATED→CANCELLED race. Subscription fires for an
 *     INITIATED tx, but by the time `getTransaction()` hydrates, the
 *     requester has cancelled. The state guard in
 *     `subscribeProviderJobs` (PRD §5.2.1) must drop it instead of
 *     dispatching a stale state.
 *
 * These cases close the assertion that hash routing fails CLOSED:
 * unknown / zero / mid-flight-cancelled tx → no handler, no escrow
 * link, no `job:received` event.
 *
 * @module __e2e__/blockchain-runtime/routing-edges.e2e
 */

import { keccak256, toUtf8Bytes, ZeroHash } from 'ethers';
import {
  describeAnvilSuite,
  startAnvilFork,
  provisionSlot,
  mintUsdc,
  usdc,
  type AnvilHandle,
} from './helpers';
import { BlockchainRuntime } from '../../runtime/BlockchainRuntime';
import { Agent } from '../../level1/Agent';

describeAnvilSuite('PRD §8.2 cases 5–7 — routing edges', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvilFork();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  });

  it("case 5 — unknown serviceHash: agent skips, no handler dispatched", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
      sweepBlockWindow: 200,
    });
    await providerRuntime.initialize();

    const handlerFires = jest.fn();
    const agent = new Agent({ name: 'UnknownHashAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    // Register 'onboarding', then send a TX for an UNRELATED service.
    // Agent.findServiceHandler must return undefined for the unknown
    // hash; processJob must never invoke this handler.
    agent.provide('onboarding', async () => {
      handlerFires();
      return { reflection: 'should-not-fire' };
    });
    (agent as any)._status = 'running';
    (agent as any).subscribeIfBlockchain();

    try {
      const requesterRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterSigner,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntime.initialize();

      await requesterRuntime.createTransaction({
        provider: providerSigner.address,
        requester: requesterSigner.address,
        amount: usdc('0.05').toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 3601,
        // Hash for a service the agent does NOT offer:
        serviceDescription: keccak256(toUtf8Bytes('transcribe')),
      });

      const jobReceived = jest.fn();
      agent.on('job:received', jobReceived);

      // Give both subscription + poll a chance to react.
      await new Promise((r) => setTimeout(r, 1_500));
      await (agent as any).pollForJobs();
      await new Promise((r) => setTimeout(r, 500));

      expect(jobReceived).not.toHaveBeenCalled();
      expect(handlerFires).not.toHaveBeenCalled();
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 45_000);

  it("case 6 — ZeroHash (raw-pay) with a SOLE handler: routes to it", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
      sweepBlockWindow: 200,
    });
    await providerRuntime.initialize();

    const handlerFires = jest.fn();
    const agent = new Agent({ name: 'ZeroHashAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    // Exactly ONE registered handler — the unambiguous raw-pay case.
    agent.provide('onboarding', async () => {
      handlerFires();
      return { reflection: 'sole-handler-fired' };
    });
    (agent as any)._status = 'running';
    (agent as any).subscribeIfBlockchain();

    try {
      const requesterRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterSigner,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntime.initialize();

      // ZeroHash serviceHash = the Level 0 `actp pay` (raw-pay) shape. With
      // exactly one registered handler the SDK now routes it to that sole
      // handler instead of silently dropping it.
      await requesterRuntime.createTransaction({
        provider: providerSigner.address,
        requester: requesterSigner.address,
        amount: usdc('0.05').toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 3601,
        serviceDescription: ZeroHash,
      });

      const jobReceived = jest.fn();
      agent.on('job:received', jobReceived);

      await new Promise((r) => setTimeout(r, 1_500));
      await (agent as any).pollForJobs();
      await new Promise((r) => setTimeout(r, 500));

      expect(handlerFires).toHaveBeenCalled();
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 45_000);

  it("case 6b — ZeroHash with 2+ handlers: ambiguous, NOT dispatched", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
      sweepBlockWindow: 200,
    });
    await providerRuntime.initialize();

    const handlerFires = jest.fn();
    const agent = new Agent({ name: 'ZeroHashMultiAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    // TWO registered handlers — ZeroHash routing is ambiguous, so the
    // sole-handler fallback must NOT fire; the job is dropped (unchanged
    // pre-fix behavior for the multi-handler case).
    agent.provide('onboarding', async () => {
      handlerFires();
      return { reflection: 'should-not-fire' };
    });
    agent.provide('research', async () => {
      handlerFires();
      return { reflection: 'should-not-fire' };
    });
    (agent as any)._status = 'running';
    (agent as any).subscribeIfBlockchain();

    try {
      const requesterRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterSigner,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntime.initialize();

      await requesterRuntime.createTransaction({
        provider: providerSigner.address,
        requester: requesterSigner.address,
        amount: usdc('0.05').toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 3601,
        serviceDescription: ZeroHash,
      });

      const jobReceived = jest.fn();
      agent.on('job:received', jobReceived);

      await new Promise((r) => setTimeout(r, 1_500));
      await (agent as any).pollForJobs();
      await new Promise((r) => setTimeout(r, 500));

      expect(jobReceived).not.toHaveBeenCalled();
      expect(handlerFires).not.toHaveBeenCalled();
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 45_000);

  it("case 7 — INITIATED→CANCELLED race: state guard drops the stale event", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
      sweepBlockWindow: 200,
    });
    await providerRuntime.initialize();

    const handlerFires = jest.fn();
    const agent = new Agent({ name: 'StateGuardAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    agent.provide('onboarding', async () => {
      handlerFires();
      return { reflection: 'should-not-fire' };
    });
    (agent as any)._status = 'running';
    // Subscription off — we'll drive the racy path manually so the
    // sequencing is deterministic. Agent.subscribeProviderJobs'
    // hydration step re-reads tx.state; we stage that re-read to find
    // CANCELLED. The unit-level §5.2.1 test covers the same guard at
    // pollForJobs scope; this case covers it end-to-end against a real
    // on-chain state transition.

    try {
      const requesterRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterSigner,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntime.initialize();

      // 1. Create INITIATED tx.
      const txId = await requesterRuntime.createTransaction({
        provider: providerSigner.address,
        requester: requesterSigner.address,
        amount: usdc('0.05').toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 3601,
        serviceDescription: keccak256(toUtf8Bytes('onboarding')),
      });

      // 2. Requester immediately cancels (INITIATED → CANCELLED is
      //    legal per the kernel state machine). The transition is on
      //    chain before the provider gets a chance to react.
      await requesterRuntime.transitionState(txId, 'CANCELLED');

      // 3. NOW the provider polls. The sweep returns the (still-event-
      //    indexed) txId, but the hydrated state is CANCELLED. The
      //    post-hydration state guard from §5.2.1 must skip.
      const jobReceived = jest.fn();
      agent.on('job:received', jobReceived);
      await (agent as any).pollForJobs();
      await new Promise((r) => setTimeout(r, 500));

      expect(jobReceived).not.toHaveBeenCalled();
      expect(handlerFires).not.toHaveBeenCalled();

      // Sanity: the tx really did make it on-chain in CANCELLED state.
      const tx = await providerRuntime.getTransaction(txId);
      expect(tx?.state).toBe('CANCELLED');
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 45_000);
});
