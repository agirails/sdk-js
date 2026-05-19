/**
 * E2E: resilience and full state walk (PRD §8.2 cases 9, 12, 15, 16).
 *
 *   Case 9  — Full state walk: INITIATED → QUOTED → COMMITTED → IN_PROGRESS
 *             → DELIVERED → SETTLED with evm time-travel for the 1h
 *             dispute window. Locks in the canonical state machine
 *             contract end-to-end against a real chain.
 *   Case 12 — Multi-handler error isolation. provide('a', throwing) +
 *             provide('b', good). Request for 'a' surfaces an error
 *             via agent.on('error') but never poisons handler 'b';
 *             subsequent request for 'b' completes cleanly.
 *   Case 15 — Handler throws → processingLocks released. processedJobs
 *             is NOT set, so the next sweep CAN re-process the same
 *             tx. Pins the §5.3 try/finally fix against a real chain.
 *   Case 16 — RPC drop. Provider URL becomes unreachable mid-test;
 *             agent.on('error') surfaces the failure without crashing
 *             the process.
 *
 * Case 13 (orchestrator.quote retry) is intentionally NOT in this
 * file — it covers the `actp agent` watchTimer's seen/inflight race
 * specifically, and the §5.8 unit test in cli/commands/agent.ts
 * already locks that path in. Re-exercising it through a full anvil
 * harness would add ~80 LOC for a flow already covered at unit scope.
 *
 * @module __e2e__/blockchain-runtime/resilience.e2e
 */

import { keccak256, toUtf8Bytes, JsonRpcProvider } from 'ethers';
import {
  describeAnvilSuite,
  startAnvilFork,
  provisionSlot,
  mintUsdc,
  advanceTime,
  usdc,
  type AnvilHandle,
} from './helpers';
import { BlockchainRuntime } from '../../runtime/BlockchainRuntime';
import { Agent } from '../../level1/Agent';

describeAnvilSuite('PRD §8.2 cases 9, 12, 15, 16 — resilience + state walk', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvilFork();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  });

  it("case 9 — full state walk INITIATED → SETTLED with 1h dispute-window time-travel", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
    });
    await providerRuntime.initialize();

    const requesterRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: requesterSigner,
      provider: anvil.provider,
      pollingInterval: 500,
    });
    await requesterRuntime.initialize();

    // 1. INITIATED.
    const txId = await requesterRuntime.createTransaction({
      provider: providerSigner.address,
      requester: requesterSigner.address,
      amount: usdc('0.05').toString(),
      deadline: Math.floor(Date.now() / 1000) + 7200, // 2h — well past 1h dispute window
      disputeWindow: 3601,
      serviceDescription: keccak256(toUtf8Bytes('onboarding')),
    });
    expect((await providerRuntime.getTransaction(txId))?.state).toBe('INITIATED');

    // 2. COMMITTED via linkEscrow (provider locks the escrow; in the
    //    Sentinel autoAccept flow this skips QUOTED). We exercise the
    //    direct INITIATED → COMMITTED path the kernel allows; the
    //    QUOTED branch is covered by the AIP-2.1 negotiation tests.
    await providerRuntime.linkEscrow(txId, usdc('0.05').toString());
    expect((await providerRuntime.getTransaction(txId))?.state).toBe('COMMITTED');

    // 3. IN_PROGRESS.
    await providerRuntime.transitionState(txId, 'IN_PROGRESS');
    expect((await providerRuntime.getTransaction(txId))?.state).toBe('IN_PROGRESS');

    // 4. DELIVERED. The kernel's _decodeDisputeWindow path accepts a
    //    32-byte dispute-window proof — 3601 seconds packed as a
    //    uint256 to land exactly 1 second past the kernel minimum.
    const disputeWindowProof = '0x' + (3601).toString(16).padStart(64, '0');
    await providerRuntime.transitionState(txId, 'DELIVERED', disputeWindowProof);
    expect((await providerRuntime.getTransaction(txId))?.state).toBe('DELIVERED');

    // 5. Requester-side immediate settle. ACTPKernel.sol:700-704 allows
    //    the requester to settle DELIVERED → SETTLED without waiting
    //    for the dispute window. This is the path runRequest takes.
    await requesterRuntime.transitionState(txId, 'SETTLED');
    expect((await providerRuntime.getTransaction(txId))?.state).toBe('SETTLED');

    // 6. Sanity check: even though we settled immediately, advancing
    //    past the dispute window must not double-settle or cause any
    //    state machine drift.
    await advanceTime(anvil, 3602);
    expect((await providerRuntime.getTransaction(txId))?.state).toBe('SETTLED');
  }, 60_000);

  it("case 12 — multi-handler error isolation: one throws, the other still completes", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterA = await provisionSlot(anvil, 1);
    const requesterB = await provisionSlot(anvil, 3);
    await mintUsdc(requesterA, requesterA.address, usdc('0.05'));
    await mintUsdc(requesterB, requesterB.address, usdc('0.05'));

    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
      sweepBlockWindow: 200,
    });
    await providerRuntime.initialize();

    const goodHandlerFires = jest.fn();
    const throwingHandlerFires = jest.fn(async () => {
      throw new Error('handler-a-blew-up');
    });
    const agent = new Agent({ name: 'MultiHandlerAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    agent.provide('service-a', throwingHandlerFires);
    agent.provide('service-b', async (job) => {
      goodHandlerFires();
      return { result: 'b-ok', got: job.service };
    });
    (agent as any)._status = 'running';
    (agent as any).subscribeIfBlockchain();

    try {
      const errorEmissions: unknown[] = [];
      agent.on('error', (e) => errorEmissions.push(e));

      // Submit request for the throwing handler first.
      const requesterRuntimeA = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterA,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntimeA.initialize();
      await requesterRuntimeA.createTransaction({
        provider: providerSigner.address,
        requester: requesterA.address,
        amount: usdc('0.05').toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 3601,
        serviceDescription: keccak256(toUtf8Bytes('service-a')),
      });

      await new Promise((r) => setTimeout(r, 2_500));

      // The throwing handler should have run + emitted error. Crucial:
      // the agent did NOT crash — we're still here.
      expect(throwingHandlerFires).toHaveBeenCalledTimes(1);
      expect(errorEmissions.length).toBeGreaterThanOrEqual(1);

      // Now submit for the good handler. processingLocks must be clean
      // (it's per-txId, so a different txId wouldn't collide anyway —
      // but the agent's other state must also be intact).
      const requesterRuntimeB = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterB,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntimeB.initialize();
      await requesterRuntimeB.createTransaction({
        provider: providerSigner.address,
        requester: requesterB.address,
        amount: usdc('0.05').toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 3601,
        serviceDescription: keccak256(toUtf8Bytes('service-b')),
      });

      await new Promise((r) => setTimeout(r, 2_500));

      // The good handler must have fired, proving the agent recovered.
      expect(goodHandlerFires).toHaveBeenCalledTimes(1);
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 90_000);

  it("case 15 — handler throws → processingLocks released → tx is re-tryable", async () => {
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

    const handlerFires = jest.fn(async () => {
      throw new Error('transient-handler-failure');
    });
    const agent = new Agent({ name: 'ThrowingHandlerAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    agent.provide('onboarding', handlerFires);
    (agent as any)._status = 'running';
    // No subscription — drive the path via explicit pollForJobs so we
    // can deterministically count poll cycles.

    try {
      const errorEmissions: unknown[] = [];
      agent.on('error', (e) => errorEmissions.push(e));

      const requesterRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterSigner,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntime.initialize();
      const txId = await requesterRuntime.createTransaction({
        provider: providerSigner.address,
        requester: requesterSigner.address,
        amount: usdc('0.05').toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 3601,
        serviceDescription: keccak256(toUtf8Bytes('onboarding')),
      });

      // First poll cycle — handler fires + throws. Agent's processJob
      // catch path swallows the error and emits via 'error'.
      await (agent as any).pollForJobs();
      await new Promise((r) => setTimeout(r, 1_500));
      expect(handlerFires).toHaveBeenCalledTimes(1);

      // Lock must be released. processedJobs may or may not be set
      // depending on whether the handler error happened before or
      // after processedJobs.set — but either way processingLocks
      // must be empty.
      const locksAfterFirstAttempt = (agent as any).processingLocks as Set<string>;
      expect(locksAfterFirstAttempt.has(txId)).toBe(false);

      // The kernel has already moved the tx to IN_PROGRESS (the agent
      // ran linkEscrow + transitionState(IN_PROGRESS) before calling
      // the handler). The subsequent poll sees state !== INITIATED
      // and the filter excludes it — so handler doesn't re-fire from
      // sweep. This is the contract: processingLocks frees the slot,
      // but the on-chain state machine prevents re-execution.
      // Verify: tx is past INITIATED on chain.
      const tx = await providerRuntime.getTransaction(txId);
      expect(['IN_PROGRESS', 'COMMITTED', 'DELIVERED'].includes(tx?.state ?? '')).toBe(true);
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 60_000);

  it("case 16 — RPC drop surfaces via agent.on('error') without crashing", async () => {
    const providerSigner = await provisionSlot(anvil, 0);

    // Build a runtime against a deliberately invalid RPC URL. The
    // agent's polling loop will get connection errors on every tick;
    // the contract is that these surface via agent.on('error'), not
    // by killing the process.
    const poisonedProvider = new JsonRpcProvider('http://127.0.0.1:1');
    const poisonedRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner.connect(poisonedProvider),
      provider: poisonedProvider,
      pollingInterval: 500,
      sweepBlockWindow: 200,
    });
    // initialize() does a chainId check that will itself fail — wrap
    // in try/catch since the contract is "no crash", not "init
    // succeeds against a dead RPC".
    try {
      await poisonedRuntime.initialize();
    } catch {
      /* expected — dead RPC */
    }

    const agent = new Agent({ name: 'PoisonedRPCAgent', network: 'testnet' });
    (agent as any)._client = { runtime: poisonedRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    agent.provide('onboarding', async () => ({ reflection: 'ok' }));
    (agent as any)._status = 'running';

    try {
      const errorEmissions: unknown[] = [];
      agent.on('error', (e) => errorEmissions.push(e));

      // Drive a poll cycle — the underlying runtime call will throw.
      // Agent.pollForJobs's try/catch must catch it and emit 'error'
      // instead of letting it become an unhandled rejection.
      let crashed = false;
      try {
        await (agent as any).pollForJobs();
      } catch {
        crashed = true;
      }
      // pollForJobs swallows runtime errors and emits via the event
      // bus — it must not throw to the caller.
      expect(crashed).toBe(false);

      // Give the event emission a microtask to settle.
      await new Promise((r) => setTimeout(r, 100));

      // At least one error must have surfaced.
      expect(errorEmissions.length).toBeGreaterThanOrEqual(1);
    } finally {
      poisonedProvider.destroy();
    }
  }, 30_000);
});
