"use strict";
/**
 * CLI Output Formatting Utilities
 *
 * Handles multi-mode output for human and machine consumption.
 * Supports three output modes:
 * - human: Colorful, formatted output for terminal users
 * - json: Machine-readable JSON for scripting
 * - quiet: Minimal output (just the essential value)
 *
 * @module cli/utils/output
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExitCode = exports.Output = exports.fmt = void 0;
exports.formatState = formatState;
exports.setOutputMode = setOutputMode;
exports.getOutput = getOutput;
// ============================================================================
// Color Support Detection
// ============================================================================
/**
 * Check if terminal supports colors
 */
function supportsColor() {
    // Force no color in tests or CI when FORCE_COLOR not set
    if (process.env.NO_COLOR !== undefined)
        return false;
    if (process.env.FORCE_COLOR !== undefined)
        return true;
    // Check if stdout is TTY
    if (!process.stdout.isTTY)
        return false;
    // Check TERM
    const term = process.env.TERM || '';
    if (term === 'dumb')
        return false;
    return true;
}
// ============================================================================
// ANSI Color Codes (inline, no dependencies)
// ============================================================================
const COLORS_ENABLED = supportsColor();
const colors = {
    reset: COLORS_ENABLED ? '\x1b[0m' : '',
    bold: COLORS_ENABLED ? '\x1b[1m' : '',
    dim: COLORS_ENABLED ? '\x1b[2m' : '',
    underline: COLORS_ENABLED ? '\x1b[4m' : '',
    // Foreground
    red: COLORS_ENABLED ? '\x1b[31m' : '',
    green: COLORS_ENABLED ? '\x1b[32m' : '',
    yellow: COLORS_ENABLED ? '\x1b[33m' : '',
    blue: COLORS_ENABLED ? '\x1b[34m' : '',
    magenta: COLORS_ENABLED ? '\x1b[35m' : '',
    cyan: COLORS_ENABLED ? '\x1b[36m' : '',
    white: COLORS_ENABLED ? '\x1b[37m' : '',
    gray: COLORS_ENABLED ? '\x1b[90m' : '',
};
// ============================================================================
// Text Formatting Helpers
// ============================================================================
exports.fmt = {
    bold: (s) => `${colors.bold}${s}${colors.reset}`,
    dim: (s) => `${colors.dim}${s}${colors.reset}`,
    underline: (s) => `${colors.underline}${s}${colors.reset}`,
    red: (s) => `${colors.red}${s}${colors.reset}`,
    green: (s) => `${colors.green}${s}${colors.reset}`,
    yellow: (s) => `${colors.yellow}${s}${colors.reset}`,
    blue: (s) => `${colors.blue}${s}${colors.reset}`,
    magenta: (s) => `${colors.magenta}${s}${colors.reset}`,
    cyan: (s) => `${colors.cyan}${s}${colors.reset}`,
    white: (s) => `${colors.white}${s}${colors.reset}`,
    gray: (s) => `${colors.gray}${s}${colors.reset}`,
    // Semantic formatting
    success: (s) => `${colors.green}${s}${colors.reset}`,
    error: (s) => `${colors.red}${s}${colors.reset}`,
    warning: (s) => `${colors.yellow}${s}${colors.reset}`,
    info: (s) => `${colors.cyan}${s}${colors.reset}`,
    label: (s) => `${colors.gray}${s}${colors.reset}`,
    value: (s) => `${colors.white}${colors.bold}${s}${colors.reset}`,
};
// ============================================================================
// State Formatting
// ============================================================================
/**
 * Format transaction state with appropriate color
 */
function formatState(state) {
    switch (state) {
        case 'INITIATED':
            return exports.fmt.yellow(state);
        case 'QUOTED':
            return exports.fmt.cyan(state);
        case 'COMMITTED':
            return exports.fmt.blue(state);
        case 'IN_PROGRESS':
            return exports.fmt.magenta(state);
        case 'DELIVERED':
            return exports.fmt.green(state);
        case 'SETTLED':
            return exports.fmt.green(exports.fmt.bold(state));
        case 'DISPUTED':
            return exports.fmt.red(state);
        case 'CANCELLED':
            return exports.fmt.dim(state);
        default:
            return state;
    }
}
// ============================================================================
// Output Class
// ============================================================================
/**
 * Output formatter for CLI commands
 *
 * Provides consistent output across all commands with support for
 * human-readable, JSON, and quiet modes.
 *
 * @example
 * ```typescript
 * const output = new Output('human');
 *
 * // Success message
 * output.success('Transaction created!');
 *
 * // Key-value output
 * output.keyValue('Transaction ID', txId);
 *
 * // JSON output (in json mode, prints JSON)
 * output.result({ txId, state: 'INITIATED' });
 * ```
 */
class Output {
    constructor(mode = 'human') {
        this.mode = mode;
    }
    // ==========================================================================
    // Basic Output Methods
    // ==========================================================================
    /**
     * Print a line (human mode only)
     */
    print(message) {
        if (this.mode === 'human') {
            console.log(message);
        }
    }
    /**
     * Print success message
     */
    success(message) {
        if (this.mode === 'human') {
            console.log(exports.fmt.success('[+] ' + message));
        }
    }
    /**
     * Print error message
     */
    error(message) {
        if (this.mode === 'human') {
            console.error(exports.fmt.error('[!] ' + message));
        }
    }
    /**
     * Print warning message
     */
    warning(message) {
        if (this.mode === 'human') {
            console.warn(exports.fmt.warning('[*] ' + message));
        }
    }
    /**
     * Print info message
     */
    info(message) {
        if (this.mode === 'human') {
            console.log(exports.fmt.info('[i] ' + message));
        }
    }
    /**
     * Print a blank line (human mode only)
     */
    blank() {
        if (this.mode === 'human') {
            console.log('');
        }
    }
    // ==========================================================================
    // Structured Output
    // ==========================================================================
    /**
     * Print a key-value pair
     */
    keyValue(key, value) {
        if (this.mode === 'human') {
            console.log(`  ${exports.fmt.label(key + ':')} ${exports.fmt.value(String(value))}`);
        }
    }
    /**
     * Print a section header
     */
    section(title) {
        if (this.mode === 'human') {
            console.log('');
            console.log(exports.fmt.bold(title));
            console.log(exports.fmt.dim('-'.repeat(40)));
        }
    }
    /**
     * Print a transaction in human-readable format
     */
    transaction(tx) {
        if (this.mode === 'human') {
            console.log('');
            console.log(exports.fmt.bold('Transaction Details'));
            console.log(exports.fmt.dim('-'.repeat(40)));
            console.log(`  ${exports.fmt.label('ID:')} ${exports.fmt.value(tx.txId)}`);
            console.log(`  ${exports.fmt.label('State:')} ${formatState(tx.state)}`);
            console.log(`  ${exports.fmt.label('Requester:')} ${tx.requester}`);
            console.log(`  ${exports.fmt.label('Provider:')} ${tx.provider}`);
            console.log(`  ${exports.fmt.label('Amount:')} ${exports.fmt.value(tx.amount)}`);
            console.log(`  ${exports.fmt.label('Deadline:')} ${tx.deadline}`);
            if (tx.escrowId) {
                console.log(`  ${exports.fmt.label('Escrow ID:')} ${tx.escrowId}`);
            }
            if (tx.createdAt) {
                console.log(`  ${exports.fmt.label('Created:')} ${tx.createdAt}`);
            }
        }
    }
    /**
     * Print a table of transactions
     */
    transactionTable(transactions) {
        if (this.mode === 'human') {
            if (transactions.length === 0) {
                console.log(exports.fmt.dim('  No transactions found.'));
                return;
            }
            // Header
            console.log('');
            console.log(exports.fmt.bold('  ID (short)        State           Amount            Provider'));
            console.log(exports.fmt.dim('  ' + '-'.repeat(70)));
            // Rows
            for (const tx of transactions) {
                const shortId = tx.txId.slice(0, 10) + '...';
                const stateFormatted = formatState(tx.state).padEnd(20);
                const amountPadded = tx.amount.padEnd(16);
                const providerShort = tx.provider.slice(0, 10) + '...';
                console.log(`  ${shortId}  ${stateFormatted}  ${amountPadded}  ${providerShort}`);
            }
            console.log(exports.fmt.dim('  ' + '-'.repeat(70)));
            console.log(exports.fmt.dim(`  ${transactions.length} transaction(s)`));
        }
    }
    // ==========================================================================
    // Result Output (Mode-Aware)
    // ==========================================================================
    /**
     * Output a result object
     *
     * - human mode: Pretty prints with colors
     * - json mode: Outputs JSON
     * - quiet mode: Outputs just the primary value (first key or specified)
     */
    result(data, options = {}) {
        switch (this.mode) {
            case 'json':
                console.log(JSON.stringify(data, null, 2));
                break;
            case 'quiet': {
                const key = options.quietKey || Object.keys(data)[0];
                const value = data[key];
                if (value !== undefined && value !== null) {
                    console.log(String(value));
                }
                break;
            }
            case 'human':
            default:
                for (const [key, value] of Object.entries(data)) {
                    this.keyValue(key, value);
                }
                break;
        }
    }
    /**
     * Output raw value (for quiet mode piping)
     */
    raw(value) {
        console.log(value);
    }
    // ==========================================================================
    // Error Output
    // ==========================================================================
    /**
     * Output a structured error
     */
    errorResult(error) {
        switch (this.mode) {
            case 'json':
                console.error(JSON.stringify({ error }, null, 2));
                break;
            case 'quiet':
                console.error(error.message);
                break;
            case 'human':
            default:
                console.error('');
                console.error(exports.fmt.error(`Error: ${error.message}`));
                if (error.details) {
                    console.error(exports.fmt.dim(JSON.stringify(error.details, null, 2)));
                }
                console.error(exports.fmt.dim(`(code: ${error.code})`));
                break;
        }
    }
    // ==========================================================================
    // Progress Indicators
    // ==========================================================================
    /**
     * Start a spinner (human mode only)
     *
     * Returns a stop function to call when done.
     * No-op in json/quiet modes.
     */
    spinner(message) {
        if (this.mode !== 'human') {
            return { stop: () => { } };
        }
        const frames = ['|', '/', '-', '\\'];
        let i = 0;
        process.stdout.write(exports.fmt.cyan(`[${frames[0]}] ${message}`));
        const interval = setInterval(() => {
            i = (i + 1) % frames.length;
            process.stdout.write(`\r${exports.fmt.cyan(`[${frames[i]}] ${message}`)}`);
        }, 100);
        return {
            stop: (success = true) => {
                clearInterval(interval);
                const symbol = success ? exports.fmt.green('[+]') : exports.fmt.red('[!]');
                process.stdout.write(`\r${symbol} ${message}\n`);
            },
        };
    }
}
exports.Output = Output;
// ============================================================================
// Global Output Instance
// ============================================================================
let globalOutput = new Output('human');
/**
 * Set the global output mode
 */
function setOutputMode(mode) {
    globalOutput = new Output(mode);
}
/**
 * Get the global output instance
 */
function getOutput() {
    return globalOutput;
}
// ============================================================================
// Exit Codes
// ============================================================================
/**
 * Standard exit codes for CLI commands
 *
 * Following Unix conventions and extending for ACTP-specific states.
 */
exports.ExitCode = {
    SUCCESS: 0,
    ERROR: 1,
    PENDING: 2, // Transaction in pending state
    INVALID_INPUT: 3,
    NOT_INITIALIZED: 4,
    NETWORK_ERROR: 5,
    TIMEOUT: 6,
};
//# sourceMappingURL=output.js.map