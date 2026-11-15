/**
 * Negotiate Command — Autonomous buyer-side negotiation
 *
 * Discovers agents, scores them, validates against buyer policy,
 * and optionally executes the full negotiation flow.
 *
 * @module cli/commands/negotiate
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { Output, ExitCode, fmt } from '../utils/output';
import { ethers } from 'ethers';
import { createClient, mapError } from '../utils/client';
import { BuyerOrchestrator, ProgressEvent } from '../../negotiation/BuyerOrchestrator';
import { BuyerPolicy } from '../../negotiation/PolicyEngine';
import { getNetwork } from '../../config/networks';
import { AgentRegistry } from '../../protocol/AgentRegistry';

// ============================================================================
// Command Definition
// ============================================================================

export function createNegotiateCommand(): Command {
  const cmd = new Command('negotiate')
    .description('Run autonomous buyer-side negotiation')
    .requiredOption('--policy <path>', 'Path to buyer policy JSON file')
    .option('--dry-run', 'Score candidates without creating transactions')
    .option('--poll-interval <ms>', 'Poll interval for quote state (ms)', '3000')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runNegotiate(options, output);
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
          details: structuredError.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

async function runNegotiate(
  options: { policy: string; dryRun?: boolean; pollInterval?: string; json?: boolean; quiet?: boolean },
  output: Output
): Promise<void> {
  // Load policy
  let policy: BuyerPolicy;
  try {
    const raw = readFileSync(options.policy, 'utf8');
    policy = JSON.parse(raw) as BuyerPolicy;
  } catch (err) {
    output.errorResult({
      code: 'INVALID_POLICY',
      message: `Failed to load policy: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(ExitCode.ERROR);
  }

  // Validate required policy fields (structure + types + ranges)
  const errors: string[] = [];

  if (!policy.task || typeof policy.task !== 'string') {
    errors.push('task must be a non-empty string');
  }
  if (typeof policy.constraints?.max_unit_price?.amount !== 'number' || !Number.isFinite(policy.constraints.max_unit_price.amount) || policy.constraints.max_unit_price.amount <= 0) {
    errors.push('constraints.max_unit_price.amount must be a finite positive number');
  }
  if (typeof policy.constraints?.max_daily_spend?.amount !== 'number' || !Number.isFinite(policy.constraints.max_daily_spend.amount) || policy.constraints.max_daily_spend.amount <= 0) {
    errors.push('constraints.max_daily_spend.amount must be a finite positive number');
  }
  if (typeof policy.negotiation?.rounds_max !== 'number' || !Number.isInteger(policy.negotiation.rounds_max) || policy.negotiation.rounds_max < 1) {
    errors.push('negotiation.rounds_max must be a positive integer');
  }
  if (!policy.negotiation?.quote_ttl || typeof policy.negotiation.quote_ttl !== 'string') {
    errors.push('negotiation.quote_ttl must be a string (e.g. "15m", "2h")');
  } else {
    // Validate TTL format early (before orchestrator)
    try {
      const { PolicyEngine } = await import('../../negotiation/PolicyEngine');
      PolicyEngine.parseTtl(policy.negotiation.quote_ttl);
    } catch {
      errors.push(`negotiation.quote_ttl has invalid format: "${policy.negotiation.quote_ttl}" (expected e.g. "15m", "2h", "30s")`);
    }
  }
  if (!Array.isArray(policy.selection?.prioritize) || policy.selection.prioritize.length === 0) {
    errors.push('selection.prioritize must be a non-empty array');
  }

  if (errors.length > 0) {
    output.errorResult({
      code: 'INVALID_POLICY',
      message: `Invalid policy: ${errors.join('; ')}`,
    });
    process.exit(ExitCode.ERROR);
  }

  const rawPollInterval = options.pollInterval ?? '3000';
  const pollInterval = /^\d+$/.test(rawPollInterval) ? Number(rawPollInterval) : NaN;
  if (isNaN(pollInterval) || pollInterval < 100) {
    output.errorResult({
      code: 'INVALID_OPTION',
      message: `--poll-interval must be a whole number >= 100ms, got: "${rawPollInterval}"`,
    });
    process.exit(ExitCode.ERROR);
  }

  const spinner = output.spinner(options.dryRun ? 'Scoring candidates...' : 'Negotiating...');
  const client = await createClient();

  // F-5: best-effort read-only AgentRegistry so the orchestrator can run the
  // pre-escrow price-band check before locking escrow. Fail-open — any failure
  // (no key, no registry configured, dry-run/mock) leaves it undefined and the
  // guard is skipped, exactly as before.
  let agentRegistry: AgentRegistry | undefined;
  try {
    const { resolveNetwork } = await import('../utils/network');
    const { network } = resolveNetwork();
    const networkConfig = getNetwork(network);
    if (networkConfig.contracts.agentRegistry) {
      const { resolvePrivateKey } = await import('../../wallet/keystore');
      const tier = network.includes('mainnet')
        ? 'mainnet'
        : network.includes('sepolia')
          ? 'testnet'
          : 'mock';
      const privateKey = await resolvePrivateKey(process.cwd(), {
        network: tier as 'mainnet' | 'testnet' | 'mock',
      });
      if (privateKey) {
        const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
        const signer = new ethers.Wallet(privateKey, provider);
        agentRegistry = new AgentRegistry(
          networkConfig.contracts.agentRegistry,
          signer,
          networkConfig.gasSettings,
        );
      }
    }
  } catch {
    // fail-open: leave agentRegistry undefined
  }

  const orchestrator = new BuyerOrchestrator(
    policy,
    client.runtime,
    client.getAddress(),
    undefined,
    {},
    // Pass the ACTPClient so on-chain writes route via StandardAdapter
    // (Paymaster-sponsored UserOps when AutoWallet is active).
    client,
    agentRegistry,
  );

  // Progress callback for human mode
  const onProgress = (event: ProgressEvent) => {
    if (options.json || options.quiet) return;

    switch (event.type) {
      case 'discovery':
        spinner.stop(true);
        output.print(`Found ${event.candidates} candidates`);
        break;
      case 'scoring':
        output.print(`Ranked ${event.ranked} candidates`);
        break;
      case 'round_start':
        output.print(`Round ${event.round}: trying ${fmt.cyan(event.provider)}...`);
        break;
      case 'waiting_quote':
        output.print(`  Waiting for quote (${event.ttlSeconds}s TTL)...`);
        break;
      case 'quote_received':
        output.print('  Quote received, validating...');
        break;
      case 'round_end':
        if (event.action === 'accepted') {
          output.success(`Round ${event.round}: ${fmt.green('accepted')} — ${event.reason}`);
        } else {
          output.print(`  Round ${event.round}: ${fmt.dim(event.action)} — ${event.reason}`);
        }
        break;
      case 'complete':
        break;
    }
  };

  try {
    const result = await orchestrator.negotiate({
      dryRun: options.dryRun,
      pollIntervalMs: pollInterval,
      onProgress,
    });

    spinner.stop(result.success);

    // Output result
    output.result(
      {
        success: result.success,
        commerce_session_id: result.commerce_session_id,
        actp_tx_id: result.actp_tx_id,
        selected_provider: result.selected_provider,
        rounds_used: result.rounds_used,
        reason: result.reason,
        rounds: result.rounds,
      },
      { quietKey: result.success ? 'actp_tx_id' : 'reason' }
    );

    process.exit(result.success ? ExitCode.SUCCESS : ExitCode.ERROR);
  } catch (err) {
    spinner.stop(false);
    throw err;
  }
}
