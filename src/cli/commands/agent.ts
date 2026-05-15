/**
 * `actp agent` — long-running provider daemon (3.5.0).
 *
 * Replaces `actp serve` from 3.4.x. Differences:
 *   * No HTTP listener — channel-driven via NegotiationChannel
 *     (RelayChannel by default → polls agirails.app/api/v1/negotiations).
 *   * Auto-respond multi-round: provider's ProviderPolicy.counter_strategy
 *     governs accept / requote / walk on every incoming counter, with
 *     CounterAcceptMessage / new QuoteMessage signed and POSTed back
 *     automatically. No operator-mediated delivery.
 *   * Watches on-chain for new INITIATED txs addressed to the provider
 *     and quotes them per ProviderPolicy.
 *
 * Operationally: `actp agent --policy policy.json` runs forever until
 * SIGINT/SIGTERM, prints negotiation events to the terminal, and never
 * needs an open inbound port.
 *
 * @module cli/commands/agent
 */

import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { Wallet, JsonRpcProvider, type Signer } from 'ethers';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { getNetwork } from '../../config/networks';
import { BlockchainRuntime } from '../../runtime/BlockchainRuntime';
import { MockRuntime } from '../../runtime/MockRuntime';
import { MockStateManager } from '../../runtime/MockStateManager';
import { ProviderOrchestrator } from '../../negotiation/ProviderOrchestrator';
import type { ProviderPolicy, IncomingRequest } from '../../negotiation/ProviderPolicy';
import { RelayChannel } from '../../negotiation/RelayChannel';
import { serviceNameForHash } from '../lib/serviceNameForHash';

export function createAgentCommand(): Command {
  return new Command('agent')
    .description('Run a long-running provider daemon (channel-driven, no HTTP)')
    .requiredOption('--policy <path>', 'Path to ProviderPolicy JSON file')
    .option('--network <name>', 'Network — base-sepolia | base-mainnet | mock', 'base-sepolia')
    .option('--rpc <url>', 'Custom RPC URL override (testnet/mainnet only)')
    .option('--mock', 'Run with MockRuntime instead of BlockchainRuntime')
    .option('--relay <url>', 'Negotiation relay base URL', 'https://agirails.app')
    .option('--poll-ms <num>', 'Channel poll interval in ms', '1500')
    .option('--watch-poll-ms <num>', 'On-chain INITIATED-tx watch interval', '5000')
    .action(async (options) => {
      const output = new Output('human');
      try {
        await runAgent(options, output);
      } catch (error) {
        const structured = mapError(error);
        output.errorResult({
          code: structured.code,
          message: structured.message,
          details: structured.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });
}

interface AgentOptions {
  policy: string;
  network: string;
  rpc?: string;
  mock?: boolean;
  relay: string;
  pollMs: string;
  watchPollMs: string;
}

async function runAgent(options: AgentOptions, output: Output): Promise<void> {
  if (!existsSync(options.policy)) throw new Error(`Policy file not found: ${options.policy}`);
  const policy = JSON.parse(readFileSync(options.policy, 'utf-8')) as ProviderPolicy;

  let runtime: BlockchainRuntime | MockRuntime;
  let kernelAddress: string;
  let chainId: number;
  let signerAddress: string;
  let signer: Signer;

  if (options.mock) {
    const stateMgr = new MockStateManager(process.cwd() + '/.actp-agent');
    runtime = new MockRuntime(stateMgr);
    kernelAddress = '0x' + '0'.repeat(40);
    chainId = 84532;
    const w = Wallet.createRandom();
    signer = w; signerAddress = w.address;
    output.info('Running in MOCK mode — no real on-chain interaction.');
  } else {
    const networkCfg = getNetwork(options.network);
    if (options.rpc) networkCfg.rpcUrl = options.rpc;
    const { resolvePrivateKey } = await import('../../wallet/keystore');
    const tier = options.network.includes('mainnet') ? 'mainnet'
      : options.network.includes('sepolia') ? 'testnet' : 'mock';
    const privateKey = await resolvePrivateKey(process.cwd(), {
      network: tier as 'mainnet' | 'testnet' | 'mock',
    });
    if (!privateKey) throw new Error('No wallet found. Run `actp init` or set ACTP_KEYSTORE_BASE64.');
    const provider = new JsonRpcProvider(networkCfg.rpcUrl);
    const w = new Wallet(privateKey, provider);
    signer = w;
    runtime = new BlockchainRuntime({
      network: options.network as 'base-sepolia' | 'base-mainnet',
      signer: w, provider,
    });
    await runtime.initialize();
    kernelAddress = networkCfg.contracts.actpKernel;
    chainId = networkCfg.chainId;
    signerAddress = await w.getAddress();
  }

  const providerDID = `did:ethr:${chainId}:${signerAddress.toLowerCase()}`;
  const pollMs = Number(options.pollMs);
  const watchPollMs = Number(options.watchPollMs);

  const channel = new RelayChannel({
    baseUrl: options.relay,
    kernelAddressByChainId: { [chainId]: kernelAddress },
    pollIntervalMs: pollMs,
    log: (level, msg) => {
      if (level === 'error') output.error(msg);
      else if (level === 'warn') output.warning(msg);
      // 'info' suppressed — relay polling is chatty
    },
  });

  const orchestrator = new ProviderOrchestrator({
    policy, runtime, signer, kernelAddress, chainId, providerDID,
    negotiationChannel: channel,
    log: (_level, msg) => output.info(msg),
  });

  const sub = await orchestrator.start();

  output.success(`actp agent listening on relay ${options.relay} for ${providerDID}`);
  output.print(`  Network:        ${options.network}${options.mock ? ' (mock)' : ''}`);
  output.print(`  Provider:       ${signerAddress}`);
  output.print(`  Policy floor:   $${policy.pricing.min_acceptable.amount} ${policy.pricing.min_acceptable.currency}/${policy.pricing.min_acceptable.unit}`);
  output.print(`  Policy ideal:   $${policy.pricing.ideal_price.amount} ${policy.pricing.ideal_price.currency}/${policy.pricing.ideal_price.unit}`);
  output.print(`  counter_strat:  ${policy.counter_strategy ?? 'walk'} (concede_pct=${policy.counter_strategy === 'concede' ? policy.concede_pct ?? 30 : 'n/a'})`);
  output.print(`  Relay poll:     ${pollMs}ms`);
  output.print(`  Watch poll:     ${watchPollMs}ms`);
  output.print('');
  output.print('Watching on-chain for INITIATED txs + auto-quoting per policy.');
  output.print('Counter-offers from buyers auto-handled per counter_strategy.');
  output.print('');

  // Watch on-chain for new INITIATED txs addressed to us, auto-quote.
  //
  // PRD §5.8: pre-4.0.0 this loop called `getAllTransactions()`, which is a
  // no-op on BlockchainRuntime — `actp agent` saw zero on-chain TXs on every
  // real chain since BlockchainRuntime was introduced. The migration:
  //   - Use `getTransactionsByProvider(addr, 'INITIATED', 100)` (the
  //     bounded EventMonitor-backed sweep from PRD §5.2). It filters
  //     server-side, so the per-tx `provider` check the old loop did
  //     after the fact is no longer load-bearing.
  //   - Add an `inflight` set so a long-running `orchestrator.quote()`
  //     can't be re-entered by the next sweep tick for the same txId.
  //   - Only mark a TX `seen` *after* `orchestrator.quote()` resolves
  //     successfully. The old loop did `seen.add()` before the await,
  //     which meant a transient quote failure (relay 5xx, signer
  //     disconnect) permanently dropped the TX with no retry.
  //   - Replace the `policy.services[0] ?? 'default'` fallback with a
  //     hash-based `serviceNameForHash` lookup. The old fallback could
  //     quote the wrong service when the policy has more than one entry.
  const seen = new Set<string>();
  const inflight = new Set<string>();
  const watchTimer = setInterval(async () => {
    try {
      const pending = await runtime.getTransactionsByProvider(
        signerAddress,
        'INITIATED',
        100
      );
      for (const t of pending) {
        if (seen.has(t.id) || inflight.has(t.id)) continue;
        inflight.add(t.id);
        try {
          const serviceType = serviceNameForHash(t.serviceHash, policy.services);
          if (!serviceType) {
            // Unknown hash is a deterministic skip (not a transient
            // failure) — mark seen so we don't re-evaluate it forever.
            output.warning(
              `[init] tx=${t.id.slice(0, 12)}… unknown service hash ${t.serviceHash?.slice(0, 10) ?? '(missing)'}…, skipping`
            );
            seen.add(t.id);
            continue;
          }
          const req: IncomingRequest = {
            txId: t.id,
            consumer: `did:ethr:${chainId}:${t.requester.toLowerCase()}`,
            offeredAmount: String(t.amount),
            maxPrice: String(t.amount), // best estimate without separate field
            deadline: Number(t.deadline) || Math.floor(Date.now() / 1000) + 3600,
            serviceType,
            currency: policy.pricing.min_acceptable.currency,
            unit: policy.pricing.min_acceptable.unit,
          };
          const result = await orchestrator.quote(req, providerDID);
          output.info(`[init] tx=${t.id.slice(0, 12)}… ${result.decision.action}: ${result.decision.reason}`);
          // Only mark seen after success; transient failures retry next sweep.
          seen.add(t.id);
        } catch (err) {
          output.warning(
            `[init] tx=${t.id.slice(0, 12)}… quote failed (will retry next sweep): ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          inflight.delete(t.id);
        }
      }
    } catch (err) {
      output.warning(`On-chain watch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, watchPollMs);

  const shutdown = async (signal: string): Promise<void> => {
    output.info(`\n${signal} received — shutting down…`);
    clearInterval(watchTimer);
    sub.unsubscribe();
    await channel.close().catch(() => undefined);
    output.success('Stopped.');
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
