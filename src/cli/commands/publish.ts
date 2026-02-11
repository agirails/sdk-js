/**
 * Publish Command — Lazy Publish flow.
 *
 * New flow (no on-chain calls):
 * 1. Parse AGIRAILS.md → compute configHash
 * 2. Generate wallet if .actp/keystore.json missing
 * 3. Upload to IPFS via Filebase
 * 4. Optionally upload to Arweave
 * 5. Save pending-publish.json (activation deferred to first payment)
 * 6. Update AGIRAILS.md frontmatter
 *
 * On-chain activation happens automatically during the first payment
 * via ACTPClient's lazy publish mechanism.
 *
 * @module cli/commands/publish
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { computeConfigHash, serializeAgirailsMd } from '../../config/agirailsmd';
import { preparePublish, extractRegistrationParams, PENDING_ENDPOINT } from '../../config/publishPipeline';
import { savePendingPublish, getActpDir } from '../../config/pendingPublish';
import { FilebaseClient } from '../../storage/FilebaseClient';
import { ArweaveClient } from '../../storage/ArweaveClient';
import { generateWallet } from '../utils/wallet';

// ============================================================================
// Command Definition
// ============================================================================

export function createPublishCommand(): Command {
  const cmd = new Command('publish')
    .description('Publish AGIRAILS.md config (offline — activates on first payment)')
    .argument('[path]', 'Path to AGIRAILS.md', './AGIRAILS.md')
    .option('-n, --network <network>', 'DEPRECATED: network is auto-detected (accepted but ignored)')
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
  network?: string;
  skipArweave?: boolean;
  dryRun?: boolean;
}

async function runPublish(
  filePath: string,
  options: PublishCommandOptions,
  output: Output
): Promise<void> {
  // Deprecation warning for --network
  if (options.network) {
    output.warning('--network flag is deprecated and ignored. Network is auto-detected at payment time.');
  }

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
          dryRun: true,
        },
        { quietKey: 'configHash' }
      );

      output.blank();
      output.success('Dry run complete. No changes made.');
      return;
    }

    // Ensure .actp directory exists
    const actpDir = getActpDir();
    if (!existsSync(actpDir)) {
      mkdirSync(actpDir, { recursive: true });
    }

    // Generate wallet if keystore.json doesn't exist
    const keystorePath = join(actpDir, 'keystore.json');
    if (!existsSync(keystorePath)) {
      spinner.stop(true);
      output.info('No wallet found — generating one...');
      await generateWallet(actpDir, output);
      output.blank();
    }

    // Validate Filebase credentials
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
          rpcUrl: 'https://mainnet.base.org', // Only used for Arweave upload
        });
      }
    }

    spinner.stop(true);
    const publishSpinner = output.spinner('Publishing to IPFS...');

    // Prepare publish (IPFS + hash, no on-chain)
    const result = await preparePublish({
      path: resolvedPath,
      filebaseClient,
      arweaveClient,
      skipArweave: options.skipArweave || !arweaveClient,
    });

    publishSpinner.stop(true);

    // Extract registration params for pending publish
    const { frontmatter, body } = result;
    const regParams = extractRegistrationParams(frontmatter as Record<string, unknown>);

    // Save pending-publish.json
    savePendingPublish({
      version: 1,
      configHash: result.configHash,
      cid: result.cid,
      endpoint: regParams.endpoint,
      serviceDescriptors: regParams.serviceDescriptors,
      createdAt: new Date().toISOString(),
    });

    // Update AGIRAILS.md frontmatter
    const updatedFrontmatter = {
      ...(frontmatter as Record<string, unknown>),
      config_hash: result.configHash,
      config_cid: result.cid,
      published_at: new Date().toISOString(),
      ...(result.arweaveTxId ? { arweave_tx: result.arweaveTxId } : {}),
    };
    const updatedContent = serializeAgirailsMd(updatedFrontmatter, body);
    writeFileSync(resolvedPath, updatedContent, 'utf-8');

    // Output results
    output.result(
      {
        configHash: result.configHash,
        cid: result.cid,
        arweaveTxId: result.arweaveTxId || null,
        pendingPublish: true,
      },
      { quietKey: 'configHash' }
    );

    output.blank();
    output.success('Config published to IPFS and saved locally.');
    output.print('');
    output.print('On-chain activation will happen automatically on your first payment.');
    output.print('');
    output.print('Next steps:');
    output.print('  - Verify config:  actp diff');
    output.print('  - Make a payment: your first payment activates the agent on-chain');

    // Warn if placeholder endpoint
    if (!frontmatter.endpoint || frontmatter.endpoint === PENDING_ENDPOINT) {
      output.print('');
      output.warning('No endpoint in AGIRAILS.md — using placeholder URL.');
      output.print('  Update when your agent is deployed:');
      output.print('    1. Add "endpoint: https://your-agent.com/webhook" to AGIRAILS.md');
      output.print('    2. Run: actp publish');
    }
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}
