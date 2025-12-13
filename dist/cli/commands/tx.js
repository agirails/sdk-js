"use strict";
/**
 * Transaction Commands - tx subcommand group
 *
 * Commands for managing ACTP transactions:
 * - tx create: Create a new transaction (intermediate API)
 * - tx status: Check transaction status
 * - tx list: List all transactions
 * - tx deliver: Mark transaction as delivered
 * - tx settle: Release escrow funds
 * - tx cancel: Cancel a transaction
 *
 * @module cli/commands/tx
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTxCommand = createTxCommand;
const commander_1 = require("commander");
const output_1 = require("../utils/output");
const client_1 = require("../utils/client");
// ============================================================================
// Main tx Command
// ============================================================================
function createTxCommand() {
    const cmd = new commander_1.Command('tx')
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
function createTxCreateCommand() {
    return new commander_1.Command('create')
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
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            const client = await (0, client_1.createClient)();
            let deadline = options.deadline;
            if (/^\d+$/.test(options.deadline)) {
                deadline = parseInt(options.deadline, 10);
            }
            const disputeWindow = parseInt(options.disputeWindow, 10);
            // Create transaction
            const txId = await client.intermediate.createTransaction({
                provider,
                amount,
                deadline,
                disputeWindow,
                serviceDescription: options.description,
            });
            // Optionally fund
            let escrowId;
            if (options.fund) {
                escrowId = await client.intermediate.linkEscrow(txId);
            }
            const tx = await client.intermediate.getTransaction(txId);
            if (!tx)
                throw new Error('Transaction not found after creation');
            output.result({
                txId,
                state: tx.state,
                provider: tx.provider,
                requester: tx.requester,
                amount: `${formatUsdc(tx.amount)} USDC`,
                deadline: new Date(tx.deadline * 1000).toISOString(),
                escrowId: escrowId || null,
            }, { quietKey: 'txId' });
            if (!options.fund) {
                output.blank();
                output.info('Transaction created but not funded.');
                output.print('  Fund it: actp tx fund ' + txId.slice(0, 10) + '...');
            }
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
                details: structuredError.details,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// tx status
// ============================================================================
function createTxStatusCommand() {
    return new commander_1.Command('status')
        .description('Check transaction status')
        .argument('<txId>', 'Transaction ID')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Output only the state')
        .action(async (txId, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            if (!(0, client_1.isValidTxId)(txId)) {
                throw new Error(`Invalid transaction ID format: "${txId}"`);
            }
            const client = await (0, client_1.createClient)();
            const tx = await client.intermediate.getTransaction(txId);
            if (!tx) {
                throw new Error(`Transaction not found: ${txId}`);
            }
            const status = await client.beginner.checkStatus(txId);
            if (options.quiet) {
                output.raw(tx.state);
                return;
            }
            const display = {
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
            }
            else {
                output.transaction(display);
                output.blank();
                output.print('Available Actions:');
                output.keyValue('  Can Accept', status.canAccept);
                output.keyValue('  Can Complete', status.canComplete);
                output.keyValue('  Can Dispute', status.canDispute);
            }
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
                details: structuredError.details,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// tx list
// ============================================================================
function createTxListCommand() {
    return new commander_1.Command('list')
        .description('List all transactions')
        .option('-s, --state <state>', 'Filter by state')
        .option('-l, --limit <n>', 'Limit number of results', '50')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Output only transaction IDs (one per line)')
        .action(async (options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            const client = await (0, client_1.createClient)();
            let transactions = await client.advanced.getAllTransactions();
            // Filter by state if specified
            if (options.state) {
                const stateFilter = options.state.toUpperCase();
                transactions = transactions.filter((tx) => tx.state === stateFilter);
            }
            // Sort by createdAt descending (newest first)
            transactions.sort((a, b) => b.createdAt - a.createdAt);
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
                    transactions: transactions.map((tx) => ({
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
            output.transactionTable(transactions.map((tx) => ({
                txId: tx.id,
                state: tx.state,
                requester: tx.requester,
                provider: tx.provider,
                amount: `${formatUsdc(tx.amount)} USDC`,
                deadline: new Date(tx.deadline * 1000).toISOString(),
            })));
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
                details: structuredError.details,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// tx deliver
// ============================================================================
function createTxDeliverCommand() {
    return new commander_1.Command('deliver')
        .description('Mark transaction as delivered (provider action)')
        .argument('<txId>', 'Transaction ID')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Minimal output')
        .action(async (txId, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            if (!(0, client_1.isValidTxId)(txId)) {
                throw new Error(`Invalid transaction ID format: "${txId}"`);
            }
            const client = await (0, client_1.createClient)();
            // Transition to DELIVERED
            await client.intermediate.transitionState(txId, 'DELIVERED');
            const tx = await client.intermediate.getTransaction(txId);
            if (!tx)
                throw new Error('Transaction not found');
            output.result({
                txId,
                state: tx.state,
                completedAt: tx.completedAt
                    ? new Date(tx.completedAt * 1000).toISOString()
                    : null,
            }, { quietKey: 'state' });
            output.success('Transaction marked as delivered!');
            output.info(`Dispute window: ${tx.disputeWindow} seconds`);
            output.print('');
            output.print('After dispute window expires, settle with:');
            output.print('  actp tx settle ' + txId.slice(0, 10) + '...');
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
                details: structuredError.details,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// tx settle
// ============================================================================
function createTxSettleCommand() {
    return new commander_1.Command('settle')
        .description('Release escrow funds to provider')
        .argument('<txId>', 'Transaction ID')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Minimal output')
        .action(async (txId, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            if (!(0, client_1.isValidTxId)(txId)) {
                throw new Error(`Invalid transaction ID format: "${txId}"`);
            }
            const client = await (0, client_1.createClient)();
            // Get transaction to find escrow
            const tx = await client.intermediate.getTransaction(txId);
            if (!tx)
                throw new Error(`Transaction not found: ${txId}`);
            if (!tx.escrowId)
                throw new Error('Transaction has no linked escrow');
            // Release escrow
            await client.intermediate.releaseEscrow(tx.escrowId);
            // Get updated transaction
            const updatedTx = await client.intermediate.getTransaction(txId);
            if (!updatedTx)
                throw new Error('Transaction not found');
            output.result({
                txId,
                state: updatedTx.state,
                provider: updatedTx.provider,
                amount: `${formatUsdc(updatedTx.amount)} USDC`,
            }, { quietKey: 'state' });
            output.success('Escrow released! Funds sent to provider.');
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
                details: structuredError.details,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// tx cancel
// ============================================================================
function createTxCancelCommand() {
    return new commander_1.Command('cancel')
        .description('Cancel a transaction (before delivery)')
        .argument('<txId>', 'Transaction ID')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Minimal output')
        .action(async (txId, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            if (!(0, client_1.isValidTxId)(txId)) {
                throw new Error(`Invalid transaction ID format: "${txId}"`);
            }
            const client = await (0, client_1.createClient)();
            // Transition to CANCELLED
            await client.intermediate.transitionState(txId, 'CANCELLED');
            const tx = await client.intermediate.getTransaction(txId);
            if (!tx)
                throw new Error('Transaction not found');
            output.result({
                txId,
                state: tx.state,
                refunded: tx.escrowId !== null,
            }, { quietKey: 'state' });
            output.success('Transaction cancelled!');
            if (tx.escrowId) {
                output.info('Funds have been refunded to requester.');
            }
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
                details: structuredError.details,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// Helpers
// ============================================================================
/**
 * Format USDC amount from wei to decimal
 */
function formatUsdc(weiAmount) {
    const amount = BigInt(weiAmount);
    const whole = amount / 1000000n;
    const decimal = amount % 1000000n;
    const decimalStr = decimal.toString().padStart(6, '0').slice(0, 2);
    return `${whole}.${decimalStr}`;
}
//# sourceMappingURL=tx.js.map