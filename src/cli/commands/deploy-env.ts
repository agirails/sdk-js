/**
 * Deploy:env Command - Generate deployment environment variables (AIP-13)
 *
 * Reads .actp/keystore.json, base64-encodes it, and outputs env vars
 * ready for any deployment platform (Railway, Vercel, Fly.io, Hetzner, etc.).
 *
 * @module cli/commands/deploy-env
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { getActpDir } from '../utils/config';

// ============================================================================
// Command Definition
// ============================================================================

export function createDeployEnvCommand(): Command {
  const cmd = new Command('deploy:env')
    .description('Generate deployment env vars from keystore (AIP-13)')
    .option('--format <format>', 'Output format: shell (default), docker, json', 'shell')
    .option('--json', 'Machine-readable JSON output')
    .option('-q, --quiet', 'Output only the base64 string (for piping)')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runDeployEnv(options, output);
      } catch (error) {
        output.errorResult({
          code: 'DEPLOY_ENV_FAILED',
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

interface DeployEnvOptions {
  format: string;
  json?: boolean;
  quiet?: boolean;
}

export function runDeployEnv(options: DeployEnvOptions, output: Output): void {
  const projectRoot = process.cwd();
  const actpDir = getActpDir(projectRoot);
  const keystorePath = path.join(actpDir, 'keystore.json');

  if (!fs.existsSync(keystorePath)) {
    throw new Error(
      'No keystore found at ' + keystorePath + '\n' +
      'Run "actp init" first to generate a wallet.'
    );
  }

  const keystoreContent = fs.readFileSync(keystorePath, 'utf-8');

  // Validate it's valid JSON
  try {
    JSON.parse(keystoreContent);
  } catch {
    throw new Error('Keystore file is corrupted (not valid JSON).');
  }

  const base64 = Buffer.from(keystoreContent).toString('base64');

  // Quiet mode: just the base64 string (for piping)
  if (options.quiet) {
    output.result({ keystoreBase64: base64 }, { quietKey: 'keystoreBase64' });
    return;
  }

  // JSON mode
  if (options.json || options.format === 'json') {
    output.result({
      keystoreBase64: base64,
      passwordVar: 'ACTP_KEY_PASSWORD',
    });
    return;
  }

  // Docker format
  if (options.format === 'docker') {
    output.print('# Add to your Dockerfile:');
    output.print(`ENV ACTP_KEYSTORE_BASE64="${base64}"`);
    output.print('ENV ACTP_KEY_PASSWORD="<your keystore password>"');
    output.print('');
    output.print('# WARNING: Prefer build args or secrets over ENV for sensitive values.');
    return;
  }

  // Shell format (default)
  output.print('# Set these environment variables on your deployment platform:');
  output.print(`ACTP_KEYSTORE_BASE64=${base64}`);
  output.print('ACTP_KEY_PASSWORD=<your keystore password>');
  output.print('');
  output.print('# SECURITY BEST PRACTICE:');
  output.print('# Store ACTP_KEYSTORE_BASE64 and ACTP_KEY_PASSWORD in SEPARATE secret scopes');
  output.print('# where your platform supports it (e.g., different secret groups, vaults, or teams).');
  output.print('# This preserves the two-factor security model.');
  output.print('#');
  output.print('# WARNING: Never echo these values in CI/CD logs or commit them to git.');
  output.print('');
  output.print('# Platform-specific examples:');
  output.print(`# Railway:  railway variables set ACTP_KEYSTORE_BASE64="${base64}"`);
  output.print('# Vercel:   vercel env add ACTP_KEYSTORE_BASE64');
  output.print(`# Fly.io:   fly secrets set ACTP_KEYSTORE_BASE64="${base64}"`);
  output.print('# Hetzner:  Add to your .env on the server (ensure .env is in .gitignore)');
}
