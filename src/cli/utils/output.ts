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

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Color Support Detection
// ============================================================================

/**
 * Check if terminal supports colors
 */
function supportsColor(): boolean {
  // Force no color in tests or CI when FORCE_COLOR not set
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;

  // Check if stdout is TTY
  if (!process.stdout.isTTY) return false;

  // Check TERM
  const term = process.env.TERM || '';
  if (term === 'dumb') return false;

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

export const fmt = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  underline: (s: string) => `${colors.underline}${s}${colors.reset}`,

  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  magenta: (s: string) => `${colors.magenta}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,

  // Semantic formatting
  success: (s: string) => `${colors.green}${s}${colors.reset}`,
  error: (s: string) => `${colors.red}${s}${colors.reset}`,
  warning: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  info: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  label: (s: string) => `${colors.gray}${s}${colors.reset}`,
  value: (s: string) => `${colors.white}${colors.bold}${s}${colors.reset}`,
};

// ============================================================================
// State Formatting
// ============================================================================

/**
 * Format transaction state with appropriate color
 */
export function formatState(state: string): string {
  switch (state) {
    case 'INITIATED':
      return fmt.yellow(state);
    case 'QUOTED':
      return fmt.cyan(state);
    case 'COMMITTED':
      return fmt.blue(state);
    case 'IN_PROGRESS':
      return fmt.magenta(state);
    case 'DELIVERED':
      return fmt.green(state);
    case 'SETTLED':
      return fmt.green(fmt.bold(state));
    case 'DISPUTED':
      return fmt.red(state);
    case 'CANCELLED':
      return fmt.dim(state);
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
export class Output {
  public readonly mode: OutputMode;

  constructor(mode: OutputMode = 'human') {
    this.mode = mode;
  }

  // ==========================================================================
  // Basic Output Methods
  // ==========================================================================

  /**
   * Print a line (human mode only)
   */
  print(message: string): void {
    if (this.mode === 'human') {
      console.log(message);
    }
  }

  /**
   * Print success message
   */
  success(message: string): void {
    if (this.mode === 'human') {
      console.log(fmt.success('[+] ' + message));
    }
  }

  /**
   * Print error message
   */
  error(message: string): void {
    if (this.mode === 'human') {
      console.error(fmt.error('[!] ' + message));
    }
  }

  /**
   * Print warning message
   */
  warning(message: string): void {
    if (this.mode === 'human') {
      console.warn(fmt.warning('[*] ' + message));
    }
  }

  /**
   * Print info message
   */
  info(message: string): void {
    if (this.mode === 'human') {
      console.log(fmt.info('[i] ' + message));
    }
  }

  /**
   * Print a blank line (human mode only)
   */
  blank(): void {
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
  keyValue(key: string, value: string | number | boolean): void {
    if (this.mode === 'human') {
      console.log(`  ${fmt.label(key + ':')} ${fmt.value(String(value))}`);
    }
  }

  /**
   * Print a section header
   */
  section(title: string): void {
    if (this.mode === 'human') {
      console.log('');
      console.log(fmt.bold(title));
      console.log(fmt.dim('-'.repeat(40)));
    }
  }

  /**
   * Print a transaction in human-readable format
   */
  transaction(tx: TransactionDisplay): void {
    if (this.mode === 'human') {
      console.log('');
      console.log(fmt.bold('Transaction Details'));
      console.log(fmt.dim('-'.repeat(40)));
      console.log(`  ${fmt.label('ID:')} ${fmt.value(tx.txId)}`);
      console.log(`  ${fmt.label('State:')} ${formatState(tx.state)}`);
      console.log(`  ${fmt.label('Requester:')} ${tx.requester}`);
      console.log(`  ${fmt.label('Provider:')} ${tx.provider}`);
      console.log(`  ${fmt.label('Amount:')} ${fmt.value(tx.amount)}`);
      console.log(`  ${fmt.label('Deadline:')} ${tx.deadline}`);
      if (tx.escrowId) {
        console.log(`  ${fmt.label('Escrow ID:')} ${tx.escrowId}`);
      }
      if (tx.createdAt) {
        console.log(`  ${fmt.label('Created:')} ${tx.createdAt}`);
      }
    }
  }

  /**
   * Print a table of transactions
   */
  transactionTable(transactions: TransactionDisplay[]): void {
    if (this.mode === 'human') {
      if (transactions.length === 0) {
        console.log(fmt.dim('  No transactions found.'));
        return;
      }

      // Header
      console.log('');
      console.log(
        fmt.bold(
          '  ID (short)        State           Amount            Provider'
        )
      );
      console.log(fmt.dim('  ' + '-'.repeat(70)));

      // Rows
      for (const tx of transactions) {
        const shortId = tx.txId.slice(0, 10) + '...';
        const stateFormatted = formatState(tx.state).padEnd(20);
        const amountPadded = tx.amount.padEnd(16);
        const providerShort = tx.provider.slice(0, 10) + '...';

        console.log(`  ${shortId}  ${stateFormatted}  ${amountPadded}  ${providerShort}`);
      }

      console.log(fmt.dim('  ' + '-'.repeat(70)));
      console.log(fmt.dim(`  ${transactions.length} transaction(s)`));
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
  result(
    data: Record<string, unknown>,
    options: { quietKey?: string } = {}
  ): void {
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
          this.keyValue(key, value as string | number | boolean);
        }
        break;
    }
  }

  /**
   * Output raw value (for quiet mode piping)
   */
  raw(value: string): void {
    console.log(value);
  }

  // ==========================================================================
  // Error Output
  // ==========================================================================

  /**
   * Output a structured error
   */
  errorResult(error: CLIError): void {
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
        console.error(fmt.error(`Error: ${error.message}`));
        if (error.details) {
          console.error(fmt.dim(JSON.stringify(error.details, null, 2)));
        }
        console.error(fmt.dim(`(code: ${error.code})`));
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
  spinner(message: string): { stop: (success?: boolean) => void } {
    if (this.mode !== 'human') {
      return { stop: () => {} };
    }

    const frames = ['|', '/', '-', '\\'];
    let i = 0;

    process.stdout.write(fmt.cyan(`[${frames[0]}] ${message}`));

    const interval = setInterval(() => {
      i = (i + 1) % frames.length;
      process.stdout.write(`\r${fmt.cyan(`[${frames[i]}] ${message}`)}`);
    }, 100);

    return {
      stop: (success = true) => {
        clearInterval(interval);
        const symbol = success ? fmt.green('[+]') : fmt.red('[!]');
        process.stdout.write(`\r${symbol} ${message}\n`);
      },
    };
  }
}

// ============================================================================
// Global Output Instance
// ============================================================================

let globalOutput: Output = new Output('human');

/**
 * Set the global output mode
 */
export function setOutputMode(mode: OutputMode): void {
  globalOutput = new Output(mode);
}

/**
 * Get the global output instance
 */
export function getOutput(): Output {
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
export const ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  PENDING: 2, // Transaction in pending state
  INVALID_INPUT: 3,
  NOT_INITIALIZED: 4,
  NETWORK_ERROR: 5,
  TIMEOUT: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
