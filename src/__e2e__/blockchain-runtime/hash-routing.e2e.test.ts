/**
 * E2E: hash routing happy path (PRD §8.2 case 4).
 *
 * Asserts the Layer B promise: a provider that registers two services
 * (e.g. `agent.provide('onboarding', h1)` + `agent.provide('translate', h2)`)
 * receives an INITIATED tx whose on-chain serviceHash matches the second
 * service, and ONLY the second handler fires.
 *
 * This is the test that would have caught the pre-§5.4 routing miss
 * (`findServiceHandler` returned undefined for hash-only TXs) and the
 * pre-§5.4.1 'job.service === unknown' bug (matched handler's
 * config.name didn't flow into Job construction).
 *
 * @module __e2e__/blockchain-runtime/hash-routing.e2e
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

describeAnvilSuite('PRD §8.2 case 4 — hash routing happy path', () => {
  let anvil: AnvilHandle;

  beforeAll(async () => {
    anvil = await startAnvilFork();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  });

  it("routes to the handler whose name matches the on-chain serviceHash", async () => {
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

    const onboardingFires = jest.fn();
    const translateFires = jest.fn();

    const agent = new Agent({ name: 'HashRoutingAgent', network: 'testnet' });
    (agent as any)._client = { runtime: providerRuntime };
    Object.defineProperty(agent, 'address', {
      get: () => providerSigner.address,
      configurable: true,
    });
    // Two handlers registered under distinct names — only the one whose
    // keccak256(toUtf8Bytes(name)) matches the on-chain serviceHash must fire.
    agent.provide('onboarding', async () => {
      onboardingFires();
      return { reflection: 'onboarding-result' };
    });
    agent.provide('translate', async () => {
      translateFires();
      return { translation: 'translate-result' };
    });
    (agent as any)._status = 'running';
    (agent as any).subscribeIfBlockchain();

    try {
      const jobReceivedFor = new Promise<{ service: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5_000);
        agent.once('job:received', (job: unknown) => {
          clearTimeout(timer);
          resolve(job as { service: string });
        });
      });

      // Requester submits a 'translate' request — Agent has both
      // handlers, but only translate must fire.
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
        serviceDescription: keccak256(toUtf8Bytes('translate')),
      });

      const job = await jobReceivedFor;
      expect(job.service).toBe('translate');

      // Handler dispatch is async (`agent.processJob(...).catch`). Give
      // the event loop a tick to actually invoke the matched handler,
      // then assert the other one never ran.
      await new Promise((r) => setTimeout(r, 1500));
      expect(translateFires).toHaveBeenCalledTimes(1);
      expect(onboardingFires).not.toHaveBeenCalled();
    } finally {
      try {
        await agent.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }, 45_000);
});
