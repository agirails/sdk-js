/**
 * Transaction Commands - tx subcommand group
 *
 * Commands for managing ACTP transactions:
 * - tx create: Create a new transaction (standard API)
 * - tx status: Check transaction status
 * - tx list: List all transactions
 * - tx deliver: Mark transaction as delivered
 * - tx settle: Release escrow funds
 * - tx cancel: Cancel a transaction
 *
 * @module cli/commands/tx
 */

import { Command } from 'commander';
import { Output, ExitCode, TransactionDisplay } from '../utils/output';
import { createClient, mapError, isValidTxId } from '../utils/client';
import { TransactionState, MockTransaction } from '../../runtime/types/MockState';

// ============================================================================
// Main tx Command
// ============================================================================

export function createTxCommand(): Command {
  const cmd = new Command('tx')
    .description('Transaction management commands');

  cmd.addCommand(createTxCreateCommand());
  cmd.addCommand(createTxStatusCommand());
  cmd.addCommand(createTxListCommand());
  cmd.addCommand(createTxDeliverCommand());
  cmd.addCommand(createTxSettleCommand());
  cmd.addCommand(createTxCancelCommand());

  return cmd;
}

// ============================================================================
// tx create
// ============================================================================

function createTxCreateCommand(): Command {
  return new Command('create')
    .description('Create a new transaction (without auto-funding)')
    .argument('<provider>', 'Provider address')
    .argument('<amount>', 'Amount to pay')
    .option('-d, --deadline <deadline>', 'Deadline (+24h, +7d, or Unix timestamp)', '+24h')
    .option('-w, --dispute-window <seconds>', 'Dispute window in seconds', '172800')
    .option('--description <text>', 'Service description')
    .option('--fund', 'Automatically fund the escrow after creation')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the transaction ID')
    .action(async (provider, amount, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        const client = await createClient();

        let deadline: string | number = options.deadline;
        if (/^\d+$/.test(options.deadline)) {
          deadline = parseInt(options.deadline, 10);
        }

        const disputeWindow = parseInt(options.disputeWindow, 10);

        // Create transaction
        const txId = await client.standard.createTransaction({
          provider,
          amount,
          deadline,
          disputeWindow,
          serviceDescription: options.description,
        });

        // Optionally fund
        let escrowId: string | undefined;
        if (options.fund) {
          escrowId = await client.standard.linkEscrow(txId);
        }

        const tx = await client.standard.getTransaction(txId);
        if (!tx) throw new Error('Transaction not found after creation');

        output.result(
          {
            txId,
            state: tx.state,
            provider: tx.provider,
            requester: tx.requester,
            amount: `${formatUsdc(tx.amount)} USDC`,
            deadline: new Date(tx.deadline * 1000).toISOString(),
            escrowId: escrowId || null,
          },
          { quietKey: 'txId' }
        );

        if (!options.fund) {
          output.blank();
          output.info('Transaction created but not funded.');
          output.print('  Fund it: actp tx fund ' + txId.slice(0, 10) + '...');
        }
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
}

// ============================================================================
// tx status
// ============================================================================

function createTxStatusCommand(): Command {
  return new Command('status')
    .description('Check transaction status')
    .argument('<txId>', 'Transaction ID')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the state')
    .action(async (txId, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        if (!isValidTxId(txId)) {
          throw new Error(`Invalid transaction ID format: "${txId}"`);
        }

        const client = await createClient();
        const tx = await client.standard.getTransaction(txId);

        if (!tx) {
          throw new Error(`Transaction not found: ${txId}`);
        }

        const status = await client.basic.checkStatus(txId);

        if (options.quiet) {
          output.raw(tx.state);
          return;
        }

        const display: TransactionDisplay = {
          txId: tx.id,
          state: tx.state,
          requester: tx.requester,
          provider: tx.provider,
          amount: `${formatUsdc(tx.amount)} USDC`,
          deadline: new Date(tx.deadline * 1000).toISOString(),
          escrowId: tx.escrowId,
          createdAt: new Date(tx.createdAt * 1000).toISOString(),
        };

        if (options.json) {
          output.result({
            ...display,
            actions: {
              canAccept: status.canAccept,
              canComplete: status.canComplete,
              canDispute: status.canDispute,
            },
          });
        } else {
          output.transaction(display);
          output.blank();
          output.print('Available Actions:');
          output.keyValue('  Can Accept', status.canAccept);
          output.keyValue('  Can Complete', status.canComplete);
          output.keyValue('  Can Dispute', status.canDispute);
        }
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
}

// ============================================================================
// tx list
// ============================================================================

function createTxListCommand(): Command {
  return new Command('list')
    .description('List all transactions')
    .option('-s, --state <state>', 'Filter by state')
    .option('-l, --limit <n>', 'Limit number of results', '50')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only transaction IDs (one per line)')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        const client = await createClient();
        let transactions: MockTransaction[] = await client.advanced.getAllTransactions();

        // Filter by state if specified
        if (options.state) {
          const stateFilter = options.state.toUpperCase();
          transactions = transactions.filter((tx: MockTransaction) => tx.state === stateFilter);
        }

        // Sort by createdAt descending (newest first)
        transactions.sort((a: MockTransaction, b: MockTransaction) => b.createdAt - a.createdAt);

        // Apply limit
        const limit = parseInt(options.limit, 10);
        transactions = transactions.slice(0, limit);

        if (options.quiet) {
          for (const tx of transactions) {
            console.log(tx.id);
          }
          return;
        }

        if (options.json) {
          output.result({
            count: transactions.length,
            transactions: transactions.map((tx: MockTransaction) => ({
              txId: tx.id,
              state: tx.state,
              requester: tx.requester,
              provider: tx.provider,
              amount: tx.amount,
              deadline: new Date(tx.deadline * 1000).toISOString(),
              createdAt: new Date(tx.createdAt * 1000).toISOString(),
            })),
          });
          return;
        }

        output.section(`Transactions (${transactions.length})`);
        output.transactionTable(
          transactions.map((tx: MockTransaction) => ({
            txId: tx.id,
            state: tx.state,
            requester: tx.requester,
            provider: tx.provider,
            amount: `${formatUsdc(tx.amount)} USDC`,
            deadline: new Date(tx.deadline * 1000).toISOString(),
          }))
        );
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
}

// ============================================================================
// tx deliver
// ============================================================================

function createTxDeliverCommand(): Command {
  return new Command('deliver')
    .description('Mark transaction as delivered (provider action)')
    .argument('<txId>', 'Transaction ID')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (txId, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        if (!isValidTxId(txId)) {
          throw new Error(`Invalid transaction ID format: "${txId}"`);
        }

        const client = await createClient();

        const beforeTx = await client.standard.getTransaction(txId);
        if (!beforeTx) throw new Error(`Transaction not found: ${txId}`);

        const transitionPath: TransactionState[] = [];

        // On-chain lifecycle requires COMMITTED -> IN_PROGRESS -> DELIVERED.
        // Keep CLI ergonomic by applying the missing intermediate state automatically.
        if (beforeTx.state === 'COMMITTED') {
          await client.standard.transitionState(txId, 'IN_PROGRESS' as TransactionState);
          transitionPath.push('IN_PROGRESS');
          await client.standard.transitionState(txId, 'DELIVERED' as TransactionState);
          transitionPath.push('DELIVERED');
        } else if (beforeTx.state === 'IN_PROGRESS') {
          await client.standard.transitionState(txId, 'DELIVERED' as TransactionState);
          transitionPath.push('DELIVERED');
        } else if (beforeTx.state === 'DELIVERED') {
          // Idempotent behavior for repeated deliver calls.
          transitionPath.push('DELIVERED');
        } else {
          throw new Error(
            `Cannot deliver transaction ${txId} from state ${beforeTx.state}. ` +
              'Expected COMMITTED, IN_PROGRESS, or DELIVERED.'
          );
        }

        const tx = await client.standard.getTransaction(txId);
        if (!tx) throw new Error('Transaction not found');

        output.result(
          {
            txId,
            state: tx.state,
            transitionPath,
            completedAt: tx.completedAt
              ? new Date(tx.completedAt * 1000).toISOString()
              : null,
          },
          { quietKey: 'state' }
        );

        if (beforeTx.state === 'DELIVERED') {
          output.info('Transaction is already DELIVERED.');
        } else {
          output.success('Transaction marked as delivered!');
        }
        output.info(`Dispute window: ${tx.disputeWindow} seconds`);
        output.print('');
        output.print('After dispute window expires, settle with:');
        output.print('  actp tx settle ' + txId.slice(0, 10) + '...');
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
}

// ============================================================================
// tx settle
// ============================================================================

function createTxSettleCommand(): Command {
  return new Command('settle')
    .description('Release escrow funds to provider')
    .argument('<txId>', 'Transaction ID')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (txId, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        if (!isValidTxId(txId)) {
          throw new Error(`Invalid transaction ID format: "${txId}"`);
        }

        const client = await createClient();

        // Get transaction to find escrow
        const tx = await client.standard.getTransaction(txId);
        if (!tx) throw new Error(`Transaction not found: ${txId}`);
        if (!tx.escrowId) throw new Error('Transaction has no linked escrow');

        // Release escrow
        await client.standard.releaseEscrow(tx.escrowId);

        // Get updated transaction
        const updatedTx = await client.standard.getTransaction(txId);
        if (!updatedTx) throw new Error('Transaction not found');

        output.result(
          {
            txId,
            state: updatedTx.state,
            provider: updatedTx.provider,
            amount: `${formatUsdc(updatedTx.amount)} USDC`,
          },
          { quietKey: 'state' }
        );

        output.success('Escrow released! Funds sent to provider.');
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
}

// ============================================================================
// tx cancel
// ============================================================================

function createTxCancelCommand(): Command {
  return new Command('cancel')
    .description('Cancel a transaction (before delivery)')
    .argument('<txId>', 'Transaction ID')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (txId, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        if (!isValidTxId(txId)) {
          throw new Error(`Invalid transaction ID format: "${txId}"`);
        }

        const client = await createClient();

        // Transition to CANCELLED
        await client.standard.transitionState(txId, 'CANCELLED' as TransactionState);

        const tx = await client.standard.getTransaction(txId);
        if (!tx) throw new Error('Transaction not found');

        output.result(
          {
            txId,
            state: tx.state,
            refunded: tx.escrowId !== null,
          },
          { quietKey: 'state' }
        );

        output.success('Transaction cancelled!');
        if (tx.escrowId) {
          output.info('Funds have been refunded to requester.');
        }
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
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format USDC amount from wei to decimal
 */
function formatUsdc(weiAmount: string): string {
  const amount = BigInt(weiAmount);
  const whole = amount / 1_000_000n;
  const decimal = amount % 1_000_000n;
  const decimalStr = decimal.toString().padStart(6, '0').slice(0, 2);
  return `${whole}.${decimalStr}`;
}
