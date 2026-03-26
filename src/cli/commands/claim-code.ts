/**
 * Claim-Code Command — Regenerate a claim code for dashboard linking.
 *
 * Signs a message with the agent's keystore wallet, sends to server,
 * gets a fresh claim code. Use when the original code expired or was lost.
 *
 * @module cli/commands/claim-code
 */

import { Command } from 'commander';
import { ethers } from 'ethers';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolvePrivateKey } from '../../wallet/keystore';
import { requestClaimCode } from '../../api/agirailsApp';
import { parseAgirailsMd } from '../../config/agirailsmd';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

// ============================================================================
// Command Definition
// ============================================================================

export function createClaimCodeCommand(): Command {
  const cmd = new Command('claim-code')
    .description('Get a claim code to link your agent to your dashboard account')
    .argument('[path]', 'Path to AGIRAILS.md or {slug}.md')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the claim code')
    .action(async (path, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runClaimCode(path, output);
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

async function runClaimCode(
  filePath: string | undefined,
  output: Output,
): Promise<void> {
  // Resolve AGIRAILS.md path
  let effectivePath = filePath;
  if (!effectivePath) {
    const { resolveIdentityPath } = await import('../utils/config');
    const identityPath = resolveIdentityPath();
    if (identityPath) {
      effectivePath = identityPath;
    } else if (existsSync(resolve('./AGIRAILS.md'))) {
      effectivePath = './AGIRAILS.md';
    } else {
      output.error(
        'No AGIRAILS.md found. Provide a path or run from your agent directory.\n' +
        'Usage: actp claim-code [path]'
      );
      process.exit(ExitCode.INVALID_INPUT);
    }
  }

  const resolvedPath = resolve(effectivePath);
  if (!existsSync(resolvedPath)) {
    output.error(`File not found: ${effectivePath}`);
    process.exit(ExitCode.INVALID_INPUT);
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  const { frontmatter } = parseAgirailsMd(content);
  const fm = frontmatter as Record<string, unknown>;

  const agentId = fm.agent_id as string | undefined;
  if (!agentId) {
    output.error(
      'No agent_id found in AGIRAILS.md frontmatter.\n' +
      'Run `actp publish` first to register your agent on-chain.'
    );
    process.exit(ExitCode.INVALID_INPUT);
  }

  const spinner = output.spinner('Generating claim code...');

  try {
    const projectRoot = resolve(resolvedPath, '..');
    const privateKey = await resolvePrivateKey(projectRoot, { network: 'testnet' });
    if (!privateKey) {
      throw new Error(
        'No wallet credentials found.\n' +
        'Set ACTP_KEY_PASSWORD or ACTP_PRIVATE_KEY environment variable.'
      );
    }

    const wallet = new ethers.Wallet(privateKey);
    const walletAddress = wallet.address;

    // Read Smart Wallet address from AGIRAILS.md frontmatter if available
    const fmWallet = fm.wallet as string | undefined;
    const effectiveWallet = fmWallet || walletAddress;

    // Sign message
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `agirails-claim-code:${agentId}:${timestamp}`;
    const signature = await wallet.signMessage(message);

    const result = await requestClaimCode({
      agentId,
      wallet: effectiveWallet,
      signer: effectiveWallet.toLowerCase() !== walletAddress.toLowerCase() ? walletAddress : undefined,
      signature,
      message,
    });

    spinner.stop(true);

    output.result(
      {
        claimCode: result.claimCode,
        claimUrl: `https://agirails.app/claim?code=${result.claimCode}`,
        agentId,
      },
      { quietKey: 'claimCode' }
    );

    output.blank();
    output.success(`Claim code: ${result.claimCode}`);
    output.print(`  Claim link: https://agirails.app/claim?code=${result.claimCode}`);
    output.print('  (enter this code in your dashboard to link the agent)');
    output.print('');
    output.print('  Code expires in 24 hours. Run `actp claim-code` to get a new one.');
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}
