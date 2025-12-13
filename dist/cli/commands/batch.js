"use strict";
/**
 * Batch Command - Execute multiple commands from a file
 *
 * Agent-first feature: Process commands in bulk.
 * Perfect for:
 * - Scripted workflows
 * - Replaying transaction sequences
 * - Automated testing
 *
 * Security: Commands are validated against an allowlist and arguments
 * are passed as an array to avoid shell injection attacks.
 *
 * @module cli/commands/batch
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBatchCommand = createBatchCommand;
exports.runBatch = runBatch;
const fs = __importStar(require("fs"));
const readline = __importStar(require("readline"));
const commander_1 = require("commander");
const output_1 = require("../utils/output");
const client_1 = require("../utils/client");
// ============================================================================
// Security: Command Allowlist and Argument Parsing
// ============================================================================
/**
 * Allowlist of valid ACTP subcommands.
 * Only these commands can be executed through batch mode.
 * This prevents command injection attacks.
 */
const VALID_SUBCOMMANDS = new Set([
    'init', 'pay', 'tx', 'balance', 'mint', 'config',
    'watch', 'simulate', 'time',
]);
/**
 * Allowlist of valid 'tx' subcommands.
 */
const VALID_TX_SUBCOMMANDS = new Set([
    'create', 'status', 'list', 'deliver', 'settle', 'cancel',
]);
/**
 * Characters that are not allowed in command arguments.
 * These could be used for shell injection attacks.
 */
const DANGEROUS_CHARS_PATTERN = /[;&|`$(){}[\]<>!\\'"]/;
/**
 * Parse a command string into an array of arguments safely.
 * Does NOT use shell for parsing - handles quotes manually.
 *
 * @param command - Raw command string
 * @returns Array of parsed arguments
 * @throws Error if command contains dangerous characters
 */
function parseCommandArgs(command) {
    const args = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    // Check for dangerous characters outside quotes
    const cleanCommand = command.replace(/"[^"]*"|'[^']*'/g, ''); // Remove quoted strings
    if (DANGEROUS_CHARS_PATTERN.test(cleanCommand)) {
        throw new Error('Command contains potentially dangerous characters. ' +
            'Shell metacharacters are not allowed for security reasons.');
    }
    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (inQuotes) {
            if (char === quoteChar) {
                inQuotes = false;
                quoteChar = '';
            }
            else {
                current += char;
            }
        }
        else if (char === '"' || char === "'") {
            inQuotes = true;
            quoteChar = char;
        }
        else if (char === ' ' || char === '\t') {
            if (current) {
                args.push(current);
                current = '';
            }
        }
        else {
            current += char;
        }
    }
    if (current) {
        args.push(current);
    }
    if (inQuotes) {
        throw new Error('Unclosed quote in command');
    }
    return args;
}
/**
 * Validate that a command only uses allowed subcommands.
 *
 * @param args - Parsed command arguments
 * @returns true if command is valid
 * @throws Error if command is not in allowlist
 */
function validateCommand(args) {
    if (args.length === 0) {
        throw new Error('Empty command');
    }
    const subcommand = args[0];
    if (subcommand === 'tx') {
        if (args.length < 2) {
            throw new Error('tx command requires a subcommand');
        }
        if (!VALID_TX_SUBCOMMANDS.has(args[1])) {
            throw new Error(`Unknown tx subcommand: ${args[1]}. Allowed: ${Array.from(VALID_TX_SUBCOMMANDS).join(', ')}`);
        }
        return true;
    }
    if (!VALID_SUBCOMMANDS.has(subcommand)) {
        throw new Error(`Unknown command: ${subcommand}. Allowed: ${Array.from(VALID_SUBCOMMANDS).join(', ')}`);
    }
    return true;
}
// ============================================================================
// Command Definition
// ============================================================================
function createBatchCommand() {
    const cmd = new commander_1.Command('batch')
        .description('Execute multiple commands from a file (agent-first feature)')
        .argument('[file]', 'File containing commands (one per line), or - for stdin')
        .option('--dry-run', 'Parse and validate commands without executing')
        .option('--stop-on-error', 'Stop execution on first error', false)
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Minimal output')
        .action(async (file, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            await runBatch(file, options, output);
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
    return cmd;
}
async function runBatch(file, options, output) {
    // Read commands
    let commands;
    if (!file || file === '-') {
        // Read from stdin
        commands = await readStdin();
    }
    else {
        // Read from file
        if (!fs.existsSync(file)) {
            throw new Error(`File not found: ${file}`);
        }
        commands = fs.readFileSync(file, 'utf-8').split('\n');
    }
    // Filter empty lines and comments
    const commandsWithLine = commands
        .map((line, index) => ({ line: index + 1, command: line.trim() }))
        .filter(({ command }) => command && !command.startsWith('#'));
    if (commandsWithLine.length === 0) {
        output.warning('No commands to execute.');
        return;
    }
    output.info(`Processing ${commandsWithLine.length} command(s)...`);
    output.blank();
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    for (const { line, command } of commandsWithLine) {
        const startTime = Date.now();
        if (options.dryRun) {
            // Dry run: just parse and validate
            const parseResult = parseCommand(command);
            if (parseResult.valid) {
                results.push({
                    line,
                    command,
                    status: 'success',
                    output: `Would execute: ${parseResult.parsed}`,
                });
                successCount++;
                outputDryRunResult(output, line, command, true, parseResult.parsed);
            }
            else {
                results.push({
                    line,
                    command,
                    status: 'error',
                    error: parseResult.error,
                });
                errorCount++;
                outputDryRunResult(output, line, command, false, parseResult.error);
                if (options.stopOnError) {
                    output.error('Stopping on error (--stop-on-error)');
                    break;
                }
            }
        }
        else {
            // Execute command
            try {
                const result = await executeCommand(command);
                const duration = Date.now() - startTime;
                results.push({
                    line,
                    command,
                    status: 'success',
                    output: result,
                    duration,
                });
                successCount++;
                outputExecutionResult(output, line, command, true, result, duration);
            }
            catch (error) {
                const duration = Date.now() - startTime;
                const errorMessage = error.message;
                results.push({
                    line,
                    command,
                    status: 'error',
                    error: errorMessage,
                    duration,
                });
                errorCount++;
                outputExecutionResult(output, line, command, false, errorMessage, duration);
                if (options.stopOnError) {
                    output.error('Stopping on error (--stop-on-error)');
                    skippedCount = commandsWithLine.length - successCount - errorCount;
                    break;
                }
            }
        }
    }
    // Summary
    output.blank();
    output.section('Batch Summary');
    output.keyValue('Total Commands', commandsWithLine.length);
    output.keyValue('Succeeded', successCount);
    output.keyValue('Failed', errorCount);
    if (skippedCount > 0) {
        output.keyValue('Skipped', skippedCount);
    }
    // Exit with appropriate code
    if (errorCount > 0) {
        process.exit(output_1.ExitCode.ERROR);
    }
}
/**
 * Read commands from stdin
 */
async function readStdin() {
    return new Promise((resolve) => {
        const lines = [];
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false,
        });
        rl.on('line', (line) => {
            lines.push(line);
        });
        rl.on('close', () => {
            resolve(lines);
        });
    });
}
/**
 * Parse and validate a command (for dry-run)
 *
 * Security: Uses parseCommandArgs for safe argument parsing
 * and validates against allowlist.
 */
function parseCommand(command) {
    try {
        // Parse command safely (no shell interpretation)
        const args = parseCommandArgs(command);
        if (args.length === 0) {
            return { valid: false, error: 'Empty command' };
        }
        // Validate against allowlist
        validateCommand(args);
        return {
            valid: true,
            parsed: `actp ${args.join(' ')}`,
            args,
        };
    }
    catch (error) {
        return {
            valid: false,
            error: error.message,
        };
    }
}
/**
 * Execute a command (by spawning a child process)
 *
 * SECURITY FIX: No longer uses shell interpolation.
 * Arguments are passed as an array directly to the actp binary.
 * This prevents command injection attacks.
 */
async function executeCommand(command) {
    const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
    return new Promise((resolve, reject) => {
        // Parse command safely - no shell interpretation
        let args;
        try {
            args = parseCommandArgs(command);
            validateCommand(args);
        }
        catch (error) {
            reject(error);
            return;
        }
        // Add --json flag for structured output
        args.push('--json');
        // SECURITY: Use shell: false and pass arguments as array
        // This prevents any shell interpretation of the arguments
        const child = spawn('actp', args, {
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env },
            shell: false, // CRITICAL: Do not use shell
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim() || 'OK');
            }
            else {
                // Try to parse error from JSON output
                try {
                    const errorObj = JSON.parse(stderr || stdout);
                    reject(new Error(errorObj.error?.message || 'Command failed'));
                }
                catch {
                    reject(new Error(stderr.trim() || stdout.trim() || `Exit code: ${code}`));
                }
            }
        });
        child.on('error', (error) => {
            reject(error);
        });
    });
}
/**
 * Output dry-run result
 */
function outputDryRunResult(output, line, command, success, message) {
    if (output['mode'] === 'json') {
        return; // JSON output is aggregated at the end
    }
    if (output['mode'] === 'quiet') {
        console.log(success ? 'OK' : 'ERROR');
        return;
    }
    const lineStr = `[${line}]`.padEnd(5);
    const status = success ? output_1.fmt.green('VALID') : output_1.fmt.red('INVALID');
    console.log(`${output_1.fmt.dim(lineStr)} ${status} ${output_1.fmt.dim(command)}`);
    if (message && !success) {
        console.log(`      ${output_1.fmt.red(message)}`);
    }
}
/**
 * Output execution result
 */
function outputExecutionResult(output, line, command, success, message, durationMs) {
    if (output['mode'] === 'json') {
        return; // JSON output is aggregated at the end
    }
    if (output['mode'] === 'quiet') {
        console.log(success ? 'OK' : 'ERROR');
        return;
    }
    const lineStr = `[${line}]`.padEnd(5);
    const status = success ? output_1.fmt.green('OK') : output_1.fmt.red('FAIL');
    const duration = output_1.fmt.dim(`(${durationMs}ms)`);
    console.log(`${output_1.fmt.dim(lineStr)} ${status} ${command} ${duration}`);
    if (!success) {
        console.log(`      ${output_1.fmt.red(message)}`);
    }
}
//# sourceMappingURL=batch.js.map