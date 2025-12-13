/**
 * Init Command - Initialize ACTP in the current directory
 *
 * Creates .actp/ directory with configuration and initial state.
 * Supports interactive and non-interactive modes.
 *
 * @module cli/commands/init
 */

import * as crypto from 'crypto';
import { Command } from 'commander';
import {
  saveConfig,
  addToGitignore,
  isInitialized,
  getActpDir,
  CLIConfig,
  CLIMode,
} from '../utils/config';
import { Output, ExitCode } from '../utils/output';
import { MockStateManager } from '../../runtime/MockStateManager';

// ============================================================================
// Command Definition
// ============================================================================

export function createInitCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize ACTP in the current directory')
    .option('-m, --mode <mode>', 'Operating mode: mock, testnet, mainnet', 'mock')
    .option('-a, --address <address>', 'Your Ethereum address')
    .option('-f, --force', 'Overwrite existing configuration')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runInit(options, output);
      } catch (error) {
        output.errorResult({
          code: 'INIT_FAILED',
          message: (error as Error).message,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

interface InitOptions {
  mode: string;
  address?: string;
  force?: boolean;
}

async function runInit(options: InitOptions, output: Output): Promise<void> {
  const projectRoot = process.cwd();

  // Check if already initialized
  if (isInitialized(projectRoot) && !options.force) {
    throw new Error(
      'ACTP already initialized in this directory.\n' +
        'Use --force to reinitialize.'
    );
  }

  // Validate mode
  const validModes: CLIMode[] = ['mock', 'testnet', 'mainnet'];
  if (!validModes.includes(options.mode as CLIMode)) {
    throw new Error(
      `Invalid mode: "${options.mode}". Valid modes: ${validModes.join(', ')}`
    );
  }

  const mode = options.mode as CLIMode;

  // Get or generate address
  let address = options.address;
  if (!address) {
    if (mode === 'mock') {
      // Generate a random address for mock mode
      address = '0x' + crypto.randomBytes(20).toString('hex');
      output.info(`Generated mock address: ${address}`);
    } else {
      throw new Error(
        `Address required for ${mode} mode.\n` +
          'Use --address <your-address> to specify.'
      );
    }
  }

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(
      `Invalid address format: "${address}"\n` +
        'Expected 0x-prefixed 40-character hex string.'
    );
  }

  // Create configuration
  const config: CLIConfig = {
    mode,
    address: address.toLowerCase(),
    version: '1.0',
  };

  // Save configuration
  saveConfig(config, projectRoot);
  output.success('Configuration saved');

  // Initialize mock state if in mock mode
  if (mode === 'mock') {
    const stateManager = new MockStateManager(projectRoot);
    if (!stateManager.exists() || options.force) {
      stateManager.reset();
      output.success('Mock state initialized');
    }

    // Mint initial tokens for the address
    const { MockRuntime } = await import('../../runtime/MockRuntime');
    const runtime = new MockRuntime(stateManager);
    await runtime.mintTokens(address.toLowerCase(), '10000000000'); // 10,000 USDC
    output.info('Minted 10,000 USDC to your address');
  }

  // Add to gitignore
  try {
    addToGitignore(projectRoot);
    output.success('Added .actp/ to .gitignore');
  } catch {
    output.warning('Could not update .gitignore (may not exist)');
  }

  // Output result
  output.blank();
  output.result(
    {
      initialized: true,
      directory: getActpDir(projectRoot),
      mode,
      address,
    },
    { quietKey: 'address' }
  );

  output.blank();
  output.print('Next steps:');
  output.print('  1. Create a payment: actp pay <provider> <amount>');
  output.print('  2. Check your balance: actp balance');
  output.print('  3. List transactions: actp tx list');
}

export { runInit };
