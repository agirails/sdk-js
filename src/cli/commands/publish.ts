/**
 * Publish Command - Publish AGIRAILS.md config on-chain
 *
 * Reads AGIRAILS.md, computes canonical hash, uploads to IPFS,
 * optionally to Arweave, and records on AgentRegistry.
 *
 * @module cli/commands/publish
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { ethers } from 'ethers';
import { computeConfigHash, parseAgirailsMd } from '../../config/agirailsmd';
import { FilebaseClient } from '../../storage/FilebaseClient';
import { ArweaveClient } from '../../storage/ArweaveClient';
import { getNetwork } from '../../config/networks';
import { publishAgirailsMd, PENDING_ENDPOINT } from '../../config/publishPipeline';

// ============================================================================
// Command Definition
// ============================================================================

export function createPublishCommand(): Command {
  const cmd = new Command('publish')
    .description('Publish AGIRAILS.md config on-chain')
    .argument('[path]', 'Path to AGIRAILS.md', './AGIRAILS.md')
    .option('-n, --network <network>', 'Network (base-sepolia | base-mainnet)', 'base-sepolia')
    .option('--skip-arweave', 'Skip permanent Arweave storage (dev mode)')
    .option('--dry-run', 'Show what would happen without executing')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the config hash')
    .action(async (path, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runPublish(path, options, output);
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

interface PublishCommandOptions {
  network: string;
  skipArweave?: boolean;
  dryRun?: boolean;
}

async function runPublish(
  filePath: string,
  options: PublishCommandOptions,
  output: Output
): Promise<void> {
  const resolvedPath = resolve(filePath);

  if (!existsSync(resolvedPath)) {
    output.error(`File not found: ${filePath}`);
    process.exit(ExitCode.INVALID_INPUT);
  }

  const spinner = output.spinner('Reading AGIRAILS.md...');

  try {
    // Read and compute hash
    const content = readFileSync(resolvedPath, 'utf-8');
    const { configHash, structuredHash, bodyHash } = computeConfigHash(content);

    if (options.dryRun) {
      spinner.stop(true);

      output.result(
        {
          configHash,
          structuredHash,
          bodyHash,
          path: resolvedPath,
          network: options.network,
          dryRun: true,
        },
        { quietKey: 'configHash' }
      );

      output.blank();
      output.success('Dry run complete. No changes made.');
      return;
    }

    // Validate environment
    const privateKey = process.env.ACTP_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!privateKey) {
      spinner.stop(false);
      output.error('Private key required. Set ACTP_PRIVATE_KEY or PRIVATE_KEY env var.');
      process.exit(ExitCode.INVALID_INPUT);
    }

    const networkConfig = getNetwork(options.network);
    if (!networkConfig.contracts.agentRegistry) {
      spinner.stop(false);
      output.error(`AgentRegistry not deployed on ${options.network}`);
      process.exit(ExitCode.ERROR);
    }

    // Create provider and signer
    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);

    // Create Filebase client
    const filebaseAccessKey = process.env.FILEBASE_ACCESS_KEY;
    const filebaseSecretKey = process.env.FILEBASE_SECRET_KEY;
    if (!filebaseAccessKey || !filebaseSecretKey) {
      spinner.stop(false);
      output.error('Filebase credentials required. Set FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY.');
      process.exit(ExitCode.INVALID_INPUT);
    }

    const filebaseClient = new FilebaseClient({
      accessKey: filebaseAccessKey,
      secretKey: filebaseSecretKey,
    });

    // Create Arweave client (optional)
    let arweaveClient: ArweaveClient | undefined;
    if (!options.skipArweave) {
      const arweaveKey = process.env.ARCHIVE_UPLOADER_KEY;
      if (arweaveKey) {
        arweaveClient = await ArweaveClient.create({
          privateKey: arweaveKey,
          rpcUrl: networkConfig.rpcUrl,
        });
      }
    }

    spinner.stop(true);
    const publishSpinner = output.spinner('Publishing to IPFS + on-chain...');

    const result = await publishAgirailsMd({
      path: resolvedPath,
      network: options.network,
      registryAddress: networkConfig.contracts.agentRegistry,
      signer,
      filebaseClient,
      arweaveClient,
      skipArweave: options.skipArweave || !arweaveClient,
      gasSettings: {
        maxFeePerGas: networkConfig.gasSettings.maxFeePerGas,
        maxPriorityFeePerGas: networkConfig.gasSettings.maxPriorityFeePerGas,
      },
    });

    publishSpinner.stop(true);

    output.result(
      {
        configHash: result.configHash,
        cid: result.cid,
        txHash: result.txHash,
        arweaveTxId: result.arweaveTxId || null,
        registered: result.registered || false,
        network: options.network,
      },
      { quietKey: 'configHash' }
    );

    output.blank();
    if (result.registered) {
      output.success('Agent registered and config published!');
    } else {
      output.success('Config published successfully!');
    }
    output.print('');
    output.print('Next steps:');
    output.print('  - Verify sync:  actp diff');
    output.print('  - View on-chain: ' + networkConfig.blockExplorer + '/tx/' + result.txHash);

    // Warn if placeholder endpoint was used during auto-register
    if (result.registered) {
      const content = readFileSync(resolvedPath, 'utf-8');
      const { frontmatter } = parseAgirailsMd(content);
      if (!frontmatter.endpoint || frontmatter.endpoint === PENDING_ENDPOINT) {
        output.print('');
        output.warning('No endpoint in AGIRAILS.md — registered with placeholder URL.');
        output.print('  Update when your agent is deployed:');
        output.print('    1. Add "endpoint: https://your-agent.com/webhook" to AGIRAILS.md');
        output.print('    2. Run: actp publish');
      }
    }
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}
