/**
 * Sync Command - Bidirectional reconcile of local ⟷ web ⟷ chain
 *
 * Compares the local identity file, the agirails.app web copy, and the
 * on-chain configHash. Propagates a single-sided change automatically;
 * on a genuine double-edit conflict the newest wins and the loser is
 * snapshotted (never silently clobbered). Then publishes the winning
 * config on-chain (the keyholder side) unless --no-publish is set.
 *
 * @module cli/commands/sync
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { ethers } from 'ethers';
import { reconcile } from '../../config/syncOperations';
import { parseAgirailsMd } from '../../config/agirailsmd';
import { getNetwork } from '../../config/networks';

export function createSyncCommand(): Command {
  const cmd = new Command('sync')
    .description('Reconcile local ⟷ web ⟷ chain (newest wins, loser snapshotted)')
    .argument('[path]', 'Path to the identity file', './AGIRAILS.md')
    .option('-n, --network <network>', 'Network (base-sepolia | base-mainnet)', 'base-sepolia')
    .option('-a, --address <address>', 'Agent address')
    .option('-s, --slug <slug>', 'Agent slug (defaults to the file frontmatter)')
    .option('--no-publish', 'Reconcile files only; do not push on-chain')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the action')
    .action(async (path, options) => {
      const output = new Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
      try {
        await runSync(path, options, output);
      } catch (error) {
        const e = mapError(error);
        output.errorResult({ code: e.code, message: e.message, details: e.details });
        process.exit(ExitCode.ERROR);
      }
    });
  return cmd;
}

interface SyncCommandOptions {
  network: string;
  address?: string;
  slug?: string;
  publish: boolean; // commander sets `publish: false` when --no-publish is passed
}

async function runSync(filePath: string, options: SyncCommandOptions, output: Output): Promise<void> {
  // Resolve the identity file (honour the .actp identity pointer).
  let effectivePath = filePath;
  if (filePath === './AGIRAILS.md') {
    const { resolveIdentityPath } = await import('../utils/config');
    const identityPath = resolveIdentityPath();
    if (identityPath) effectivePath = identityPath;
  }
  const resolvedPath = resolve(effectivePath);

  // Slug: --slug, else the file frontmatter (top-level or under `agent:`).
  let slug = options.slug;
  if (!slug && existsSync(resolvedPath)) {
    try {
      const fm = parseAgirailsMd(readFileSync(resolvedPath, 'utf-8')).frontmatter as Record<string, unknown>;
      const agent = fm.agent as Record<string, unknown> | undefined;
      slug = (typeof fm.slug === 'string' ? fm.slug : undefined) ||
        (agent && typeof agent.slug === 'string' ? agent.slug : undefined);
    } catch {
      // fall through to the missing-slug error below
    }
  }
  if (!slug) {
    output.error('Agent slug required. Use --slug or ensure the identity file has a slug.');
    process.exit(ExitCode.INVALID_INPUT);
  }

  // Agent address.
  //
  // Resolution order (matches `actp diff` / `actp pull`):
  //   1. --address flag
  //   2. config.address from .actp/config.json — for `wallet: 'auto'`
  //      this is the Smart Wallet address that AgentRegistry has indexed.
  //      Using the EOA signer here returns 0x0 on-chain and surfaces a
  //      false "Pending chain sync" alarm on the public profile.
  //   3. EOA derived from the resolved private key.
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

  const spinner = output.spinner('Reconciling local ⟷ web ⟷ chain...');
  let result;
  try {
    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
    result = await reconcile({
      path: resolvedPath,
      agentAddress,
      registryAddress: networkConfig.contracts.agentRegistry,
      provider,
      slug,
    });
    spinner.stop(true);
  } catch (error) {
    spinner.stop(false);
    throw error;
  }

  output.result(
    {
      action: result.action,
      wroteLocal: result.wroteLocal,
      needsPublish: result.needsPublish,
      snapshot: result.snapshotPath ?? null,
      localHash: result.localHash,
      onChainHash: result.onChainHash,
      webHash: result.webHash,
    },
    { quietKey: 'action' },
  );
  output.blank();
  output.info(result.status);

  if (!result.needsPublish) {
    output.success('Everything is in sync.');
    return;
  }

  if (options.publish === false) {
    output.warning('Files reconciled. Skipped on-chain push (--no-publish). Run: actp publish');
    return;
  }

  // Push the winning config on-chain (+ web) by delegating to publish.
  output.blank();
  output.info('Pushing reconciled config on-chain...');
  const { createPublishCommand } = await import('./publish');
  const publishCmd = createPublishCommand();
  await publishCmd.parseAsync([resolvedPath, '--network', options.network], { from: 'user' });
}
