/**
 * Diff Command - Compare local AGIRAILS.md with on-chain config
 *
 * Shows sync status between local file and AgentRegistry state.
 * Terraform-style: never auto-overwrites, just shows differences.
 *
 * @module cli/commands/diff
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve } from 'path';
import { ethers } from 'ethers';
import { diff } from '../../config/syncOperations';
import { getNetwork } from '../../config/networks';

// ============================================================================
// Command Definition
// ============================================================================

export function createDiffCommand(): Command {
  const cmd = new Command('diff')
    .description('Compare local AGIRAILS.md with on-chain config')
    .argument('[path]', 'Path to AGIRAILS.md', './AGIRAILS.md')
    .option('-n, --network <network>', 'Network (base-sepolia | base-mainnet)', 'base-sepolia')
    .option('-a, --address <address>', 'Agent address to compare with')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only sync status')
    .action(async (path, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runDiff(path, options, output);
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

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

interface DiffCommandOptions {
  network: string;
  address?: string;
}

async function runDiff(
  filePath: string,
  options: DiffCommandOptions,
  output: Output
): Promise<void> {
  const resolvedPath = resolve(filePath);

  // Determine agent address
  let agentAddress = options.address;
  if (!agentAddress) {
    const privateKey = process.env.ACTP_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!privateKey) {
      output.error('Agent address required. Use --address or set ACTP_PRIVATE_KEY env var.');
      process.exit(ExitCode.INVALID_INPUT);
    }
    agentAddress = new ethers.Wallet(privateKey).address;
  }

  const networkConfig = getNetwork(options.network);
  if (!networkConfig.contracts.agentRegistry) {
    output.error(`AgentRegistry not deployed on ${options.network}`);
    process.exit(ExitCode.ERROR);
  }

  const spinner = output.spinner('Comparing local and on-chain config...');

  try {
    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);

    const result = await diff({
      path: resolvedPath,
      agentAddress,
      registryAddress: networkConfig.contracts.agentRegistry,
      provider,
    });

    spinner.stop(true);

    output.result(
      {
        status: result.status,
        inSync: result.inSync,
        localHash: result.localHash,
        onChainHash: result.onChainHash,
        onChainCID: result.onChainCID || null,
        hasLocalFile: result.hasLocalFile,
        hasOnChainConfig: result.hasOnChainConfig,
        network: options.network,
        agent: agentAddress,
      },
      { quietKey: 'status' }
    );

    output.blank();

    // Human-friendly status messages
    switch (result.status) {
      case 'in-sync':
        output.success('Local and on-chain configs are in sync.');
        break;
      case 'local-ahead':
        output.warning('Local changes not yet published. Run: actp publish');
        break;
      case 'remote-ahead':
        output.warning('On-chain config is newer. Run: actp pull');
        break;
      case 'diverged':
        output.warning('Local and on-chain configs have diverged.');
        output.print('  Resolve by running: actp publish (to push local) or actp pull --force (to accept remote)');
        break;
      case 'no-local':
        output.info('No local AGIRAILS.md found. Run: actp pull');
        break;
      case 'no-remote':
        output.info('No config published on-chain. Run: actp publish');
        break;
    }
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}
