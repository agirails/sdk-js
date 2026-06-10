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
  // If using Commander default './AGIRAILS.md', check identity pointer first
  let effectivePath = filePath;
  if (filePath === './AGIRAILS.md') {
    const { resolveIdentityPath } = await import('../utils/config');
    const identityPath = resolveIdentityPath();
    if (identityPath) {
      effectivePath = identityPath;
    }
  }
  const resolvedPath = resolve(effectivePath);

  // AIP-18 DEC-3: a pure buyer (intent: pay) is never anchored on-chain — its
  // config is local-authored and its budget is private (never synced). An
  // on-chain diff doesn't apply, so report that honestly instead of the
  // misleading "no-remote / run publish".
  try {
    const { existsSync, readFileSync } = await import('fs');
    if (existsSync(resolvedPath)) {
      const { parseAgirailsMdV4 } = await import('../../config/agirailsmdV4');
      const v4 = parseAgirailsMdV4(readFileSync(resolvedPath, 'utf-8'));
      if (v4.intent === 'pay') {
        output.result(
          {
            status: 'buyer-local',
            intent: 'pay',
            inSync: true,
            hasLocalFile: true,
            hasOnChainConfig: false,
            note: 'Buyer config is local-authored; not anchored on-chain (budget stays private).',
          },
          { quietKey: 'status' }
        );
        output.blank();
        output.info(
          'Buyer (intent: pay): config is local-authored and budget is private — ' +
            'nothing to diff on-chain.'
        );
        output.print('Edit your {slug}.md locally, then run: actp publish (re-links to agirails.app).');
        return;
      }
    }
  } catch {
    // Not a parseable v4 buyer file — fall through to the normal on-chain diff.
  }

  // Determine agent address.
  //
  // Resolution order (matches `actp pull`):
  //   1. --address flag (explicit override)
  //   2. config.address from .actp/config.json — for `wallet: 'auto'`
  //      this is the Smart Wallet address, which is the identity
  //      AgentRegistry has indexed (publish runs through Paymaster as
  //      msg.sender = Smart Wallet). Reading on-chain hash for the EOA
  //      signer in that flow returns 0x0 and surfaces a false
  //      "Pending chain sync" alarm.
  //   3. EOA derived from the resolved private key (legacy single-wallet
  //      flows where signer == on-chain identity).
  let agentAddress = options.address;
  if (!agentAddress) {
    try {
      const { loadConfig } = await import('../utils/config');
      const cfg = loadConfig();
      if (cfg.address) agentAddress = cfg.address;
    } catch {
      // Config missing — fall through to keystore EOA.
    }
  }
  if (!agentAddress) {
    const { resolvePrivateKey } = await import('../../wallet/keystore');
    const networkTier = options.network === 'base-mainnet' ? 'mainnet' : 'testnet';
    const privateKey = await resolvePrivateKey(undefined, { network: networkTier });
    if (!privateKey) {
      output.error('Agent address required. Use --address or set up a keystore via `actp init`.');
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
