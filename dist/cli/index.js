#!/usr/bin/env node
"use strict";
/**
 * ACTP CLI - Agent Commerce Transaction Protocol Command Line Interface
 *
 * The ACTP CLI is designed for AI agents - not humans clicking buttons.
 * Key differentiators:
 *
 * 1. **Machine-readable output**: JSON by default for scripting
 * 2. **Pipe-friendly**: Commands output just what you need
 * 3. **Structured exit codes**: 0=success, 1=error, 2=pending
 * 4. **Agent-first features**: watch, simulate, batch
 *
 * @module cli
 * @see https://docs.agirails.io/cli
 */
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
// Import commands
const init_1 = require("./commands/init");
const pay_1 = require("./commands/pay");
const tx_1 = require("./commands/tx");
const balance_1 = require("./commands/balance");
const mint_1 = require("./commands/mint");
const config_1 = require("./commands/config");
const watch_1 = require("./commands/watch");
const simulate_1 = require("./commands/simulate");
const batch_1 = require("./commands/batch");
const time_1 = require("./commands/time");
// ============================================================================
// Program Setup
// ============================================================================
const program = new commander_1.Command();
program
    .name('actp')
    .description('ACTP CLI - Agent Commerce Transaction Protocol\n\n' +
    'The payment layer for AI agents. Create escrow-backed transactions,\n' +
    'track state changes, and settle payments programmatically.\n\n' +
    'Quick Start:\n' +
    '  $ actp init                     Initialize in current directory\n' +
    '  $ actp pay 0xProvider 100       Create a payment\n' +
    '  $ actp tx status <txId>         Check transaction status\n\n' +
    'Output Modes:\n' +
    '  --json     Machine-readable JSON output\n' +
    '  --quiet    Minimal output (just the essential value)')
    .version('0.1.0', '-v, --version', 'Output the version number')
    .helpOption('-h, --help', 'Display help for command');
// ============================================================================
// Register Commands
// ============================================================================
// Core commands (most used)
program.addCommand((0, init_1.createInitCommand)());
program.addCommand((0, pay_1.createPayCommand)());
program.addCommand((0, tx_1.createTxCommand)());
program.addCommand((0, balance_1.createBalanceCommand)());
program.addCommand((0, mint_1.createMintCommand)());
program.addCommand((0, config_1.createConfigCommand)());
// Agent-first features
program.addCommand((0, watch_1.createWatchCommand)());
program.addCommand((0, simulate_1.createSimulateCommand)());
program.addCommand((0, batch_1.createBatchCommand)());
// Mock mode utilities
program.addCommand((0, time_1.createTimeCommand)());
// ============================================================================
// Error Handling
// ============================================================================
// Handle unknown commands
program.on('command:*', (operands) => {
    console.error(`Error: Unknown command '${operands[0]}'`);
    console.error('');
    console.error('Run "actp --help" for available commands.');
    process.exit(1);
});
// ============================================================================
// Parse & Execute
// ============================================================================
program.parse(process.argv);
// If no arguments, show help
if (process.argv.length === 2) {
    program.outputHelp();
}
//# sourceMappingURL=index.js.map