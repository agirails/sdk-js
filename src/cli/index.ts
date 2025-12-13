#!/usr/bin/env node
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

import { Command } from 'commander';

// Import commands
import { createInitCommand } from './commands/init';
import { createPayCommand } from './commands/pay';
import { createTxCommand } from './commands/tx';
import { createBalanceCommand } from './commands/balance';
import { createMintCommand } from './commands/mint';
import { createConfigCommand } from './commands/config';
import { createWatchCommand } from './commands/watch';
import { createSimulateCommand } from './commands/simulate';
import { createBatchCommand } from './commands/batch';
import { createTimeCommand } from './commands/time';

// ============================================================================
// Program Setup
// ============================================================================

const program = new Command();

program
  .name('actp')
  .description(
    'ACTP CLI - Agent Commerce Transaction Protocol\n\n' +
      'The payment layer for AI agents. Create escrow-backed transactions,\n' +
      'track state changes, and settle payments programmatically.\n\n' +
      'Quick Start:\n' +
      '  $ actp init                     Initialize in current directory\n' +
      '  $ actp pay 0xProvider 100       Create a payment\n' +
      '  $ actp tx status <txId>         Check transaction status\n\n' +
      'Output Modes:\n' +
      '  --json     Machine-readable JSON output\n' +
      '  --quiet    Minimal output (just the essential value)'
  )
  .version('0.1.0', '-v, --version', 'Output the version number')
  .helpOption('-h, --help', 'Display help for command');

// ============================================================================
// Register Commands
// ============================================================================

// Core commands (most used)
program.addCommand(createInitCommand());
program.addCommand(createPayCommand());
program.addCommand(createTxCommand());
program.addCommand(createBalanceCommand());
program.addCommand(createMintCommand());
program.addCommand(createConfigCommand());

// Agent-first features
program.addCommand(createWatchCommand());
program.addCommand(createSimulateCommand());
program.addCommand(createBatchCommand());

// Mock mode utilities
program.addCommand(createTimeCommand());

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
