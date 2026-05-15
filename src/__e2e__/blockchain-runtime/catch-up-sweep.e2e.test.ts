/**
 * E2E: catch-up sweep (PRD §8.2 cases 2 + 3).
 *
 * Case 2 (happy path): a provider that boots AFTER an INITIATED tx was
 *   already on-chain recovers the tx via the bounded
 *   `BlockchainRuntime.getTransactionsByProvider` sweep within 10s. The
 *   subscription path can't catch this tx — the listener wasn't wired
 *   yet when `TransactionCreated` fired — so the recovery is purely
 *   `Agent.pollForJobs` doing its job.
 *
 * Case 3 (boundary): a tx that landed > `sweepBlockWindow` blocks ago
 *   is intentionally NOT recovered. This documents the operational
 *   contract operators rely on when tuning the window. PRD §7 bullet 5
 *   tells operators they must raise `sweepBlockWindow` if their restart
 *   cadence exceeds the default ~4h window; this test pins that cliff
 *   so a future change can't silently widen or narrow it.
 *
 * Both cases share fixture setup (provider + requester + USDC) so they
 * live in the same describe block. Each `it` spins its own anvil-side
 * state via `mineBlocks`.
 *
 * @module __e2e__/blockchain-runtime/catch-up-sweep.e2e
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import {
  describeAnvilSuite,
  startAnvilFork,
  provisionSlot,
  mintUsdc,
  mineBlocks,
  usdc,
  type AnvilHandle,
} from './helpers';
import { BlockchainRuntime } from '../../runtime/BlockchainRuntime';
import { Agent } from '../../level1/Agent';

describeAnvilSuite('PRD §8.2 cases 2 + 3 — catch-up sweep', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvilFork();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  });

  it("case 2 — recovers a pre-existing INITIATED tx within 10s of provider boot", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    // 1. Requester submits the INITIATED tx BEFORE the provider exists.
    //    No subscription is listening; only the catch-up sweep can find it.
    const requesterRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: requesterSigner,
      provider: anvil.provider,
      pollingInterval: 500,
    });
    await requesterRuntime.initialize();

    const serviceHash = keccak256(toUtf8Bytes('onboarding'));
    await requesterRuntime.createTransaction({
      provider: providerSigner.address,
      requester: requesterSigner.address,
      amount: usdc('0.05').toString(),
      deadline: Math.floor(Date.now() / 1000) + 3600,
      disputeWindow: 3601,
      serviceDescription: serviceHash,
    });

    // 2. Provider boots fresh. The Agent's start() wiring is bypassed in
    //    favor of explicit polling control so the test isolates the
    //    pollForJobs → handleIncomingTransaction path.
    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
      sweepBlockWindow: 200,
    });
    await providerRuntime.initialize();

    const agent = new Agent({ name: 'CatchUpAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    agent.provide('onboarding', async () => ({ reflection: 'ok' }));
    (agent as any)._status = 'running';
    // Intentionally do NOT call subscribeIfBlockchain — we want to prove
    // the polling path alone recovers the tx. The subscription wouldn't
    // have seen the pre-boot event anyway, but skipping it makes the
    // assertion unambiguous.

    try {
      const jobReceived = new Promise<{ service: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timeout waiting for catch-up sweep recovery')),
          10_000
        );
        agent.once('job:received', (job: unknown) => {
          clearTimeout(timer);
          resolve(job as { service: string });
        });
      });

      // Trigger one poll cycle. In production this fires on the 5s
      // interval set by Agent.startPolling(); here we drive it explicitly
      // so the test doesn't sit idle.
      await (agent as any).pollForJobs();

      const job = await jobReceived;
      expect(job.service).toBe('onboarding');
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 45_000);

  it("case 3 — does NOT recover a tx older than sweepBlockWindow (boundary documents the cliff)", async () => {
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    // 1. Requester submits an INITIATED tx, then we mine far past the
    //    provider's sweep window. The sweep_block_window is tuned small
    //    (50 blocks) so the boundary test stays fast; production
    //    operators tune to ~7200 (~4h on Base L2) per MIGRATION-4.0 §5.
    const SWEEP_BLOCK_WINDOW = 50;
    const requesterRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: requesterSigner,
      provider: anvil.provider,
      pollingInterval: 500,
    });
    await requesterRuntime.initialize();

    const serviceHash = keccak256(toUtf8Bytes('onboarding'));
    await requesterRuntime.createTransaction({
      provider: providerSigner.address,
      requester: requesterSigner.address,
      amount: usdc('0.05').toString(),
      deadline: Math.floor(Date.now() / 1000) + 7200, // 2h, comfortably > 1h kernel min
      disputeWindow: 3601,
      serviceDescription: serviceHash,
    });

    // Mine well past the window. Anvil's anvil_mine produces empty
    // blocks instantly.
    await mineBlocks(anvil, SWEEP_BLOCK_WINDOW + 5);

    // 2. Provider boots with the tight sweep window. The pre-mined
    //    tx is now `currentBlock - 51`-ish — beyond the recover band.
    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      pollingInterval: 500,
      sweepBlockWindow: SWEEP_BLOCK_WINDOW,
    });
    await providerRuntime.initialize();

    const handlerFires = jest.fn();
    const agent = new Agent({ name: 'BoundaryAgent', network: 'testnet' });
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

    const jobReceived = jest.fn();
    agent.on('job:received', jobReceived);

    try {
      // Run a poll cycle. The sweep's bounded queryFilter should not see
      // the pre-mined tx because it falls outside `currentBlock - 50`.
      await (agent as any).pollForJobs();

      // Give the dispatch path a tick to (not) fire.
      await new Promise((r) => setTimeout(r, 1_000));

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
});
