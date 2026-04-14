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
}

async function runPay(
  to: string,
  amount: string,
  options: PayOptions,
  output: Output
): Promise<void> {
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
    // Create client
    const client = await createClient();

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
