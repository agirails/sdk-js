/**
 * Pull Command - Pull on-chain config to local AGIRAILS.md
 *
 * Fetches the published AGIRAILS.md from IPFS (via on-chain CID),
 * verifies integrity against on-chain hash, and writes locally.
 * Use --force to overwrite existing file without confirmation.
 *
 * @module cli/commands/pull
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve } from 'path';
import { ethers } from 'ethers';
import { pull } from '../../config/syncOperations';
import { getNetwork } from '../../config/networks';

// ============================================================================
// Command Definition
// ============================================================================

export function createPullCommand(): Command {
  const cmd = new Command('pull')
    .description('Pull on-chain AGIRAILS.md config to local file')
    .argument('[path]', 'Path to write AGIRAILS.md', './AGIRAILS.md')
    .option('-n, --network <network>', 'Network (base-sepolia | base-mainnet)', 'base-sepolia')
    .option('-a, --address <address>', 'Agent address to pull config for')
    .option('--force', 'Overwrite without confirmation (CI mode)')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (path, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runPull(path, options, output);
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

interface PullCommandOptions {
  network: string;
  address?: string;
  force?: boolean;
}

async function runPull(
  filePath: string,
  options: PullCommandOptions,
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

  const spinner = output.spinner('Pulling config from on-chain...');

  try {
    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);

    const result = await pull({
      path: resolvedPath,
      agentAddress,
      registryAddress: networkConfig.contracts.agentRegistry,
      provider,
      force: options.force,
    });

    spinner.stop(result.written);

    output.result(
      {
        written: result.written,
        cid: result.cid || null,
        status: result.status,
        path: resolvedPath,
        network: options.network,
      },
      { quietKey: 'status' }
    );

    if (result.written) {
      output.blank();
      output.success(`Config pulled and written to ${filePath}`);
    } else {
      output.blank();
      output.info(result.status);
    }
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}
