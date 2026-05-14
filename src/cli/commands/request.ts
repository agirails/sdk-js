/**
 * Request Command — Level 1 negotiated job request (PRD §5.6).
 *
 * Creates an on-chain INITIATED transaction whose routing key is
 * `keccak256(toUtf8Bytes(serviceName))`. A registered provider listening for
 * that hash (via `Agent.provide(name, handler)`) will quote, accept, run the
 * handler, and deliver. The CLI waits for delivery and prints each state
 * transition.
 *
 * Distinct from `actp pay`: pay is a Level 0 primitive that commits funds
 * directly without a handler; request is a Level 1 negotiated flow that
 * routes to a provider's handler. See PRD §A.2 for the decision log.
 *
 * @module cli/commands/request
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { discoverAgents } from '../../api/agirailsApp';
import {
  runRequest,
  QuoteTimeoutError,
  DeliveryTimeoutError,
  type RequestNetwork,
} from '../lib/runRequest';

// ============================================================================
// Command Definition
// ============================================================================

export function createRequestCommand(): Command {
  return new Command('request')
    .description('Request a Level 1 negotiated service (quote → accept → deliver)')
    .argument('<provider>', 'Provider address or agirails.app slug URL')
    .argument('<amount>', 'Amount to escrow (e.g., "0.05" USDC)')
    .requiredOption('--service <name>', 'Service name; on-chain key is keccak256(toUtf8Bytes(name))')
    .option('--deadline <iso-or-unix>', 'Job deadline as ISO 8601 or unix seconds', '')
    .option('--network <network>', 'Target network: mock | testnet | mainnet', 'testnet')
    .option('--quote-timeout <ms>', 'Max wait for INITIATED → QUOTED (or beyond), in ms', '30000')
    .option('--delivery-timeout <ms>', 'Max wait for DELIVERED, in ms', '300000')
    .option('--auto-accept', 'Auto-accept the first quote without prompting', true)
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the transaction ID')
    .action(async (provider: string, amount: string, options: RequestOptionsRaw) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runRequestCommand(provider, amount, options, output);
      } catch (error) {
        if (error instanceof QuoteTimeoutError) {
          output.errorResult({
            code: 'QUOTE_TIMEOUT',
            message: error.message,
            details: { txId: error.txId, timeoutMs: error.timeoutMs },
          });
          // PRD §5.6: exit code 2 is the canonical no-quote signal so scripts
          // can distinguish "provider offline" from other failure modes.
          process.exit(2);
        }
        if (error instanceof DeliveryTimeoutError) {
          output.errorResult({
            code: 'DELIVERY_TIMEOUT',
            message: error.message,
            details: { txId: error.txId, timeoutMs: error.timeoutMs, lastState: error.lastState },
          });
          process.exit(ExitCode.ERROR);
        }
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

// ============================================================================
// Implementation
// ============================================================================

interface RequestOptionsRaw {
  service: string;
  deadline?: string;
  network?: string;
  quoteTimeout?: string;
  deliveryTimeout?: string;
  autoAccept?: boolean;
  json?: boolean;
  quiet?: boolean;
}

async function runRequestCommand(
  providerArg: string,
  amount: string,
  options: RequestOptionsRaw,
  output: Output
): Promise<void> {
  // Resolve agirails.app slug to an address, mirroring `actp pay` UX.
  const provider = await resolveProvider(providerArg, output);

  const network = parseNetwork(options.network);
  const quoteTimeoutMs = parsePositiveInt(options.quoteTimeout, 30_000, '--quote-timeout');
  const deliveryTimeoutMs = parsePositiveInt(options.deliveryTimeout, 300_000, '--delivery-timeout');

  output.print(`→ Requesting ${options.service} from ${provider}`);
  output.print(`  amount: ${amount}, network: ${network}, quote-timeout: ${quoteTimeoutMs}ms`);
  output.blank();

  const result = await runRequest({
    provider,
    amount,
    service: options.service,
    deadline: options.deadline || undefined,
    network,
    quoteTimeoutMs,
    deliveryTimeoutMs,
    autoAccept: options.autoAccept ?? true,
    onTransition: (state, txId, ts) => {
      // Human mode shows the live log line; quiet/json modes suppress it
      // (they only emit the final structured result).
      output.print(`  [${ts.toISOString()}] ${state.padEnd(12)} ${txId}`);
    },
  });

  output.blank();
  output.result(
    {
      txId: result.txId,
      finalState: result.finalState,
      elapsedMs: result.elapsedMs,
      settled: result.settled,
      payload: result.payload,
    },
    { quietKey: 'txId' }
  );

  if (result.payload && typeof result.payload === 'object' && 'reflection' in (result.payload as Record<string, unknown>)) {
    output.blank();
    output.success(`Reflection: ${(result.payload as { reflection: string }).reflection}`);
  } else {
    output.blank();
    output.success(`Settled in ${result.elapsedMs} ms`);
  }
}

async function resolveProvider(input: string, output: Output): Promise<string> {
  const slugMatch = input.match(/^(?:https?:\/\/)?(?:www\.)?agirails\.app\/a\/([a-z0-9_-]+)$/i);
  if (!slugMatch) return input;

  const slug = slugMatch[1].toLowerCase();
  const spinner = output.spinner(`Resolving ${slug}...`);
  try {
    const result = await discoverAgents({ search: slug, limit: 10 });
    const agent = result.agents.find((a) => a.slug.toLowerCase() === slug);
    if (!agent?.wallet_address) {
      spinner.stop(false);
      throw new Error(`Agent "${slug}" not found or has no wallet address.`);
    }
    spinner.stop(true);
    output.print(`Resolved ${slug} → ${agent.wallet_address}`);
    return agent.wallet_address;
  } catch (err) {
    spinner.stop(false);
    throw err;
  }
}

function parseNetwork(raw?: string): RequestNetwork {
  const value = (raw ?? 'testnet').toLowerCase();
  if (value === 'mock' || value === 'testnet' || value === 'mainnet') return value;
  throw new Error(`Invalid --network: "${raw}". Expected mock, testnet, or mainnet.`);
}

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${flag}: "${raw}". Expected a positive integer (milliseconds).`);
  }
  return n;
}
