/**
 * Pay Command - One-liner payment command (basic API)
 *
 * The simplest way to create a payment transaction.
 * Creates transaction, links escrow, and returns immediately.
 *
 * @module cli/commands/pay
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { createClient, mapError } from '../utils/client';
import { resolveNetwork, describeNetwork } from '../utils/network';
import { discoverAgents } from '../../api/agirailsApp';

// ============================================================================
// Command Definition
// ============================================================================

export function createPayCommand(): Command {
  const cmd = new Command('pay')
    .description('Create a payment transaction (simplest API)')
    .argument('<to>', 'Provider address (recipient)')
    .argument('<amount>', 'Amount to pay (e.g., "100", "100.50", "100 USDC")')
    .option('-d, --deadline <deadline>', 'Deadline (+24h, +7d, or Unix timestamp)', '+24h')
    .option('-w, --dispute-window <seconds>', 'Dispute window in seconds', '172800')
    // PRD §5.9: --service is parsed *only* to reject it with a canonical
    // directive. `actp pay` is a Level 0 primitive — no handler routing,
    // no quote/accept negotiation. Callers who want hashed service routing
    // belong on `actp request --service <name>`.
    .option('--service <name>', '(rejected — see actp request for Level 1 flow)')
    .option('--network <network>', 'Network: mock | testnet | mainnet (default: ACTP_NETWORK or config mode)')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the transaction ID')
    .action(async (to, amount, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runPay(to, amount, options, output);
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

interface PayOptions {
  deadline: string;
  disputeWindow: string;
  service?: string;
  network?: string;
}

/**
 * Canonical directive emitted when a caller passes `--service` to `actp pay`.
 * Exported so tests + future doc tooling can assert/inspect the exact wording.
 * PRD §5.9.
 */
export const PAY_SERVICE_REJECTION_MESSAGE =
  `Error: 'actp pay' is a Level 0 primitive and does not accept --service.\n` +
  `For negotiated Level 1 job flow (where a provider's handler runs after quote/accept),\n` +
  `use 'actp request <provider> <amount> --service <name>' instead.\n` +
  `See https://agirails.io/docs/sdk/level-0-vs-level-1`;

/**
 * Exit code for `actp pay --service` rejection. 64 = `EX_USAGE` from
 * sysexits.h — the standard signal for "command-line usage error" so
 * scripts can distinguish a misuse from a generic ACTP failure.
 */
const EX_USAGE = 64;

async function runPay(
  to: string,
  amount: string,
  options: PayOptions,
  output: Output
): Promise<void> {
  // PRD §5.9: --service belongs on `actp request`, not `actp pay`. The
  // flag is parsed only so we can intercept and route the user.
  // `errorResult` is used (not `output.error`) so the directive is visible
  // in --json and --quiet modes too; a silent exit-64 would leave scripts
  // guessing at the cause.
  if (options.service !== undefined) {
    output.errorResult({
      code: 'PAY_SERVICE_REJECTED',
      message: PAY_SERVICE_REJECTION_MESSAGE,
      details: { use: 'actp request <provider> <amount> --service <name>' },
    });
    process.exit(EX_USAGE);
  }

  // F-2: resolve the network up front (flag > ACTP_NETWORK > config mode) and
  // surface its source. Throws loudly here — before any slug lookup or
  // payment — if mainnet is requested via flag/env over a non-mainnet config.
  const resolved = resolveNetwork(options.network);
  output.print(`  network: ${describeNetwork(resolved)}`);

  // Resolve slug URLs (e.g. agirails.app/a/arha) to wallet addresses
  const slugMatch = to.match(/^(?:https?:\/\/)?(?:www\.)?agirails\.app\/a\/([a-z0-9_-]+)$/i);
  if (slugMatch) {
    const slug = slugMatch[1].toLowerCase();
    const resolveSpinner = output.spinner(`Resolving ${slug}...`);
    try {
      const result = await discoverAgents({ search: slug, limit: 10 });
      const agent = result.agents.find(a => a.slug.toLowerCase() === slug);
      if (!agent?.wallet_address) {
        resolveSpinner.stop(false);
        output.error(`Agent "${slug}" not found or has no wallet address.`);
        process.exit(ExitCode.ERROR);
      }
      to = agent.wallet_address;
      resolveSpinner.stop(true);
      output.print(`Resolved ${slug} → ${to}`);
    } catch (error) {
      resolveSpinner.stop(false);
      throw error;
    }
  }

  // Create spinner for human mode
  const spinner = output.spinner('Creating payment...');

  try {
    // Create client (network resolved above; pass the flag through so the
    // client's own resolution + mainnet guard agree with what we printed).
    const client = await createClient(process.cwd(), { network: options.network });

    // Parse options
    let deadline: string | number = options.deadline;
    if (/^\d+$/.test(options.deadline)) {
      deadline = parseInt(options.deadline, 10);
    }

    const disputeWindow = parseInt(options.disputeWindow, 10);

    // Create payment
    const result = await client.basic.pay({
      to,
      amount,
      deadline,
      disputeWindow,
    });

    spinner.stop(true);

    // Output result
    output.result(
      {
        txId: result.txId,
        state: result.state,
        provider: result.provider,
        requester: result.requester,
        amount: result.amount,
        deadline: result.deadline,
      },
      { quietKey: 'txId' }
    );

    output.blank();
    output.success('Payment created and funded!');
    output.print('');
    output.print('Next steps:');
    output.print('  - Provider delivers: actp tx deliver ' + result.txId.slice(0, 10) + '...');
    output.print('  - Check status:      actp tx status ' + result.txId.slice(0, 10) + '...');
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}

export { runPay };
