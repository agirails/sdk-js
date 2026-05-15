/**
 * E2E: subscription delivery (PRD §8.2 case 1).
 *
 * Asserts the headline 4.0.0 promise: a provider Agent on
 * BlockchainRuntime receives a `job:received` event within 5 seconds of
 * a requester submitting an INITIATED transaction on-chain. This is the
 * exact path that was a silent noop in SDK ≤ 3.5.3 across all three
 * layers (transport → routing → execution).
 *
 * Harness:
 *   - anvil forked from Base Sepolia at the pinned block.
 *   - HD slot 0 = provider, slot 1 = requester. Both pre-funded with ETH.
 *   - Requester gets enough MockUSDC for one 0.05 USDC request.
 *   - Provider runs a real `Agent` with `agent.provide('onboarding', ...)`.
 *   - Requester calls the SDK-internal createTransaction directly so the
 *     test stays focused on transport + routing, not the CLI wrapper
 *     (which has its own coverage in runRequest.test.ts).
 *
 * @module __e2e__/blockchain-runtime/subscription-delivery.e2e
 */

import { keccak256, toUtf8Bytes } from 'ethers';
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

describeAnvilSuite('PRD §8.2 case 1 — subscription delivery', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvilFork();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  });

  it("delivers job:received within 5s of an on-chain INITIATED transaction", async () => {
    // 1. Provision wallets.
    const providerSigner = await provisionSlot(anvil, 0);
    const requesterSigner = await provisionSlot(anvil, 1);

    // 2. Fund the requester with $0.05 USDC for the createTransaction call.
    await mintUsdc(requesterSigner, requesterSigner.address, usdc('0.05'));

    // 3. Build a real Agent on BlockchainRuntime. The wallet path mirrors
    //    Sentinel's deployment — Agent picks up the provider address from
    //    the signer.
    const providerRuntime = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: providerSigner,
      provider: anvil.provider,
      // Keep polling tight enough that the catch-up sweep can plausibly
      // race the subscription, but not so tight that we stress anvil:
      pollingInterval: 500,
      // 4h default would be fine, but 200 blocks (~6 min on Base L2 cadence)
      // keeps the queryFilter scan cheap for this test.
      sweepBlockWindow: 200,
    });
    await providerRuntime.initialize();

    // Wire the agent + provide an 'onboarding' handler with the same
    // hash the requester will put on-chain.
    const agent = new Agent({ name: 'SubscriptionDeliveryAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    agent.provide('onboarding', async () => ({ reflection: 'ok' }));
    // Manually run the subscription wiring — bypass agent.start() so the
    // test doesn't depend on ACTPClient.create's full lifecycle. The unit
    // suites already cover start()'s assembly; this test isolates the
    // EventMonitor → handleIncomingTransaction path.
    (agent as any)._status = 'running';
    (agent as any).subscribeIfBlockchain();

    try {
      // 4. Subscribe to the agent's event BEFORE submitting the on-chain TX
      //    so we can't miss the emission window.
      const jobReceived = waitForEvent(agent, 'job:received', 5_000);

      // 5. Submit INITIATED tx via a second runtime instance acting as the
      //    requester. This is the path runRequest takes on real chains.
      const requesterRuntime = new BlockchainRuntime({
        network: 'base-sepolia',
        signer: requesterSigner,
        provider: anvil.provider,
        pollingInterval: 500,
      });
      await requesterRuntime.initialize();

      const serviceHash = keccak256(toUtf8Bytes('onboarding'));
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      await requesterRuntime.createTransaction({
        provider: providerSigner.address,
        requester: requesterSigner.address,
        amount: usdc('0.05').toString(),
        deadline,
        disputeWindow: 3601, // kernel minimum is 1h
        serviceDescription: serviceHash,
      });

      // 6. The job:received emission is the headline assertion. The
      //    payload's `service` must come from the matched handler
      //    (PRD §5.4.1), not 'unknown'.
      const job = await jobReceived;
      expect(job).toBeDefined();
      expect((job as { service: string }).service).toBe('onboarding');
    } finally {
      // Clean up subscription + provider runtime.
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 45_000);
});

/**
 * Promise that resolves with the first event payload, or rejects on timeout.
 * Use `agent.once` semantics so the listener self-removes on first fire.
 */
function waitForEvent(agent: Agent, event: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.off(event, onEvent);
      reject(new Error(`Timeout waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (payload: unknown): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    agent.once(event, onEvent);
  });
}
