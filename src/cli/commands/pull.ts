/**
 * Pull Command - Pull on-chain config to local {slug}.md or AGIRAILS.md
 *
 * Fetches the published config from IPFS (via on-chain CID),
 * verifies integrity against on-chain hash, and writes locally.
 *
 * Phase 1 additions:
 * - --agent-id and --wallet args for new-machine setup
 * - Slug-based filename derivation from YAML frontmatter
 * - Identity pointer creation in config.json
 *
 * @module cli/commands/pull
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve, basename, dirname, join } from 'path';
import { ethers } from 'ethers';
import { pull } from '../../config/syncOperations';
import { getNetwork } from '../../config/networks';
import { isInitialized, loadConfig, saveConfig, resolveIdentityPath } from '../utils/config';

// ============================================================================
// Command Definition
// ============================================================================

export function createPullCommand(): Command {
  const cmd = new Command('pull')
    .description('Pull on-chain config to local file')
    .argument('[path]', 'Path to write config (auto-derived from slug if omitted)')
    .option('-n, --network <network>', 'Network (base-sepolia | base-mainnet)', 'base-sepolia')
    .option('-a, --address <address>', 'Agent wallet address')
    .option('--agent-id <id>', 'Agent ID (ERC-8004 token ID)')
    .option('--wallet <address>', 'Alias for --address')
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
  agentId?: string;
  wallet?: string;
  force?: boolean;
}

async function runPull(
  filePath: string | undefined,
  options: PullCommandOptions,
  output: Output
): Promise<void> {
  // Resolve agent address: --agent-id > --address/--wallet > identity pointer > env
  let agentAddress = options.address || options.wallet;

  if (options.agentId) {
    // TODO: Resolve agent-id to wallet address via ERC-8004 ownerOf
    // For now, require --address alongside --agent-id
    if (!agentAddress) {
      output.error(
        'When using --agent-id, also provide --address (agent wallet).\n' +
        'ERC-8004 address resolution will be supported in a future release.'
      );
      process.exit(ExitCode.INVALID_INPUT);
    }
  }

  if (!agentAddress) {
    // Try identity pointer → env vars
    try {
      const config = loadConfig();
      agentAddress = config.address;
    } catch {
      // Config doesn't exist — try env vars
    }
  }

  if (!agentAddress) {
    const privateKey = process.env.ACTP_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!privateKey) {
      output.error(
        'Agent address required.\n' +
        'Usage: actp pull --address 0x... [--agent-id ID]\n' +
        'Or: actp pull (if config.json exists with address)'
      );
      process.exit(ExitCode.INVALID_INPUT);
    }
    agentAddress = new ethers.Wallet(privateKey).address;
  }

  const networkConfig = getNetwork(options.network);
  if (!networkConfig.contracts.agentRegistry) {
    output.error(`AgentRegistry not deployed on ${options.network}`);
    process.exit(ExitCode.ERROR);
  }

  // If no explicit path, use identity pointer or temp path (will rename after parsing slug)
  const useAutoPath = !filePath;
  const tempPath = filePath ? resolve(filePath) : resolve('./AGIRAILS.md');

  const spinner = output.spinner('Pulling config from on-chain...');

  try {
    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);

    const result = await pull({
      path: tempPath,
      agentAddress,
      registryAddress: networkConfig.contracts.agentRegistry,
      provider,
      force: options.force,
    });

    spinner.stop(result.written);

    // If we auto-derived the path, try to rename based on slug from YAML
    let finalPath = tempPath;
    if (result.written && useAutoPath) {
      try {
        const { readFileSync, renameSync } = await import('fs');
        const { parseAgirailsMdV4 } = await import('../../config/agirailsmdV4');
        const content = readFileSync(tempPath, 'utf-8');
        const v4 = parseAgirailsMdV4(content);
        if (v4.slug) {
          const slugPath = resolve(dirname(tempPath), `${v4.slug}.md`);
          if (slugPath !== tempPath) {
            renameSync(tempPath, slugPath);
            finalPath = slugPath;
            output.info(`Saved as ${v4.slug}.md (derived from slug in YAML)`);
          }
        }
      } catch {
        // Not a v4 file or parse failed — keep original path
      }
    }

    // Update identity pointer in config.json
    if (result.written) {
      try {
        const projectRoot = dirname(finalPath);
        if (isInitialized(projectRoot)) {
          const config = loadConfig(projectRoot);
          const filename = basename(finalPath);
          if (config.identity !== filename) {
            config.identity = filename;
            saveConfig(config, projectRoot);
            output.info(`Updated identity pointer → ${filename}`);
          }
        }
      } catch {
        // Best-effort
      }
    }

    output.result(
      {
        written: result.written,
        cid: result.cid || null,
        status: result.status,
        path: finalPath,
        network: options.network,
      },
      { quietKey: 'status' }
    );

    if (result.written) {
      output.blank();
      output.success(`Config pulled and written to ${basename(finalPath)}`);
    } else {
      output.blank();
      output.info(result.status);
    }
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}
