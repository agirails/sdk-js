"use strict";
/**
 * Watch Command - Stream transaction state changes
 *
 * Agent-first feature: Real-time monitoring of transaction state.
 * Outputs state changes as they happen, perfect for scripts
 * that need to react to transaction lifecycle events.
 *
 * @module cli/commands/watch
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWatchCommand = createWatchCommand;
exports.runWatch = runWatch;
const commander_1 = require("commander");
const output_1 = require("../utils/output");
const client_1 = require("../utils/client");
// ============================================================================
// Command Definition
// ============================================================================
function createWatchCommand() {
    const cmd = new commander_1.Command('watch')
        .description('Watch a transaction for state changes (agent-first feature)')
        .argument('<txId>', 'Transaction ID to watch')
        .option('-t, --timeout <seconds>', 'Exit after timeout (default: indefinite)', '0')
        .option('-i, --interval <ms>', 'Polling interval in milliseconds', '1000')
        .option('--until <state>', 'Exit when transaction reaches this state')
        .option('--json', 'Output state changes as JSON lines (NDJSON)')
        .option('-q, --quiet', 'Output only state names on change')
        .action(async (txId, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            await runWatch(txId, options, output);
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
    return cmd;
}
async function runWatch(txId, options, output) {
    if (!(0, client_1.isValidTxId)(txId)) {
        throw new Error(`Invalid transaction ID format: "${txId}"`);
    }
    const client = await (0, client_1.createClient)();
    const pollIntervalMs = parseInt(options.interval, 10);
    const timeoutSeconds = parseInt(options.timeout, 10);
    const untilState = options.until?.toUpperCase();
    // Validate until state if provided
    const validStates = [
        'INITIATED', 'QUOTED', 'COMMITTED', 'IN_PROGRESS',
        'DELIVERED', 'SETTLED', 'DISPUTED', 'CANCELLED',
    ];
    if (untilState && !validStates.includes(untilState)) {
        throw new Error(`Invalid state: "${options.until}"\n` +
            `Valid states: ${validStates.join(', ')}`);
    }
    // Get initial state
    const tx = await client.intermediate.getTransaction(txId);
    if (!tx) {
        throw new Error(`Transaction not found: ${txId}`);
    }
    let currentState = tx.state;
    const startTime = Date.now();
    // Output initial state
    emitStateChange(output, txId, null, currentState, tx.updatedAt);
    // Check if already at target state
    if (untilState && currentState === untilState) {
        output.info('Transaction already at target state.');
        process.exit(output_1.ExitCode.SUCCESS);
    }
    // Terminal states
    const terminalStates = ['SETTLED', 'CANCELLED'];
    if (terminalStates.includes(currentState)) {
        output.info('Transaction is in terminal state.');
        process.exit(output_1.ExitCode.SUCCESS);
    }
    output.info('Watching for state changes... (Ctrl+C to stop)');
    // Polling loop
    const poll = async () => {
        // Check timeout
        if (timeoutSeconds > 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            if (elapsed >= timeoutSeconds) {
                output.warning(`Timeout reached (${timeoutSeconds}s)`);
                process.exit(output_1.ExitCode.TIMEOUT);
            }
        }
        try {
            const updatedTx = await client.intermediate.getTransaction(txId);
            if (!updatedTx) {
                output.warning('Transaction no longer exists');
                process.exit(output_1.ExitCode.ERROR);
            }
            if (updatedTx.state !== currentState) {
                const previousState = currentState;
                currentState = updatedTx.state;
                emitStateChange(output, txId, previousState, currentState, updatedTx.updatedAt);
                // Check if reached target state
                if (untilState && currentState === untilState) {
                    output.success(`Reached target state: ${untilState}`);
                    process.exit(output_1.ExitCode.SUCCESS);
                }
                // Check if terminal
                if (terminalStates.includes(currentState)) {
                    output.info(`Transaction reached terminal state: ${currentState}`);
                    process.exit(output_1.ExitCode.SUCCESS);
                }
            }
        }
        catch (error) {
            // Non-fatal: log warning and continue
            output.warning(`Poll error: ${error.message}`);
        }
        // Schedule next poll
        setTimeout(poll, pollIntervalMs);
    };
    // Start polling
    setTimeout(poll, pollIntervalMs);
    // Keep process alive
    await new Promise(() => { });
}
/**
 * Emit a state change event in the appropriate format
 */
function emitStateChange(output, txId, fromState, toState, timestamp) {
    const time = new Date(timestamp * 1000).toISOString();
    switch (output['mode']) {
        case 'json':
            // NDJSON format for easy parsing
            console.log(JSON.stringify({
                event: 'state_change',
                txId,
                fromState,
                toState,
                timestamp: time,
                unix: timestamp,
            }));
            break;
        case 'quiet':
            console.log(toState);
            break;
        case 'human':
        default:
            if (fromState) {
                console.log(`${output_1.fmt.dim(time)} ${(0, output_1.formatState)(fromState)} ${output_1.fmt.dim('->')} ${(0, output_1.formatState)(toState)}`);
            }
            else {
                console.log(`${output_1.fmt.dim(time)} ${output_1.fmt.dim('Current:')} ${(0, output_1.formatState)(toState)}`);
            }
            break;
    }
}
//# sourceMappingURL=watch.js.map