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
/**
 * Output mode for CLI commands
 */
export type OutputMode = 'human' | 'json' | 'quiet';
/**
 * Structured error for JSON output
 */
export interface CLIError {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}
/**
 * Transaction display format
 */
export interface TransactionDisplay {
    txId: string;
    state: string;
    requester: string;
    provider: string;
    amount: string;
    deadline: string;
    escrowId?: string | null;
    createdAt?: string;
}
export declare const fmt: {
    bold: (s: string) => string;
    dim: (s: string) => string;
    underline: (s: string) => string;
    red: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    blue: (s: string) => string;
    magenta: (s: string) => string;
    cyan: (s: string) => string;
    white: (s: string) => string;
    gray: (s: string) => string;
    success: (s: string) => string;
    error: (s: string) => string;
    warning: (s: string) => string;
    info: (s: string) => string;
    label: (s: string) => string;
    value: (s: string) => string;
};
/**
 * Format transaction state with appropriate color
 */
export declare function formatState(state: string): string;
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
export declare class Output {
    readonly mode: OutputMode;
    constructor(mode?: OutputMode);
    /**
     * Print a line (human mode only)
     */
    print(message: string): void;
    /**
     * Print success message
     */
    success(message: string): void;
    /**
     * Print error message
     */
    error(message: string): void;
    /**
     * Print warning message
     */
    warning(message: string): void;
    /**
     * Print info message
     */
    info(message: string): void;
    /**
     * Print a blank line (human mode only)
     */
    blank(): void;
    /**
     * Print a key-value pair
     */
    keyValue(key: string, value: string | number | boolean): void;
    /**
     * Print a section header
     */
    section(title: string): void;
    /**
     * Print a transaction in human-readable format
     */
    transaction(tx: TransactionDisplay): void;
    /**
     * Print a table of transactions
     */
    transactionTable(transactions: TransactionDisplay[]): void;
    /**
     * Output a result object
     *
     * - human mode: Pretty prints with colors
     * - json mode: Outputs JSON
     * - quiet mode: Outputs just the primary value (first key or specified)
     */
    result(data: Record<string, unknown>, options?: {
        quietKey?: string;
    }): void;
    /**
     * Output raw value (for quiet mode piping)
     */
    raw(value: string): void;
    /**
     * Output a structured error
     */
    errorResult(error: CLIError): void;
    /**
     * Start a spinner (human mode only)
     *
     * Returns a stop function to call when done.
     * No-op in json/quiet modes.
     */
    spinner(message: string): {
        stop: (success?: boolean) => void;
    };
}
/**
 * Set the global output mode
 */
export declare function setOutputMode(mode: OutputMode): void;
/**
 * Get the global output instance
 */
export declare function getOutput(): Output;
/**
 * Standard exit codes for CLI commands
 *
 * Following Unix conventions and extending for ACTP-specific states.
 */
export declare const ExitCode: {
    readonly SUCCESS: 0;
    readonly ERROR: 1;
    readonly PENDING: 2;
    readonly INVALID_INPUT: 3;
    readonly NOT_INITIALIZED: 4;
    readonly NETWORK_ERROR: 5;
    readonly TIMEOUT: 6;
};
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
//# sourceMappingURL=output.d.ts.map