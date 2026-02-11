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
import { addToGitignore, loadConfig, saveConfig, isInitialized, CLIConfig, CONFIG_DEFAULTS } from '../utils/config';
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

    const pendingData = {
      version: 1 as const,
      configHash: result.configHash,
      cid: result.cid,
      endpoint: regParams.endpoint,
      serviceDescriptors: regParams.serviceDescriptors,
      createdAt: new Date().toISOString(),
    };

    const projectRoot = resolve(filePath, '..');

    // ================================================================
    // Local setup: bootstrap or migrate config, ensure .gitignore
    // "publish covers setup" — no separate `actp init` required.
    // ================================================================
    try {
      if (isInitialized(projectRoot)) {
        // Existing project: migrate config (strip deprecated `registered`)
        const config = loadConfig(projectRoot);
        saveConfig(config, projectRoot);
      } else {
        // Fresh project: bootstrap minimal config
        const walletAddress = await resolveWalletAddress(projectRoot);
        const bootstrapConfig: CLIConfig = {
          ...CONFIG_DEFAULTS,
          mode: 'testnet', // safe default for new projects
          address: walletAddress,
          wallet: 'auto',
          version: '1.0',
        };
        saveConfig(bootstrapConfig, projectRoot);
        output.info('Created .actp/config.json (testnet, auto wallet).');
      }
    } catch {
      // Config setup is best-effort — publish works without it
    }
    addToGitignore(projectRoot);

    // ================================================================
    // ALWAYS activate on testnet (one command, both networks per SPEC)
    // ================================================================
    let testnetTxHash: string | undefined;
    const activationSpinner = output.spinner('Activating on testnet...');
    try {
      testnetTxHash = await activateOnTestnet(
        projectRoot, result.configHash, result.cid,
        regParams.endpoint, regParams.serviceDescriptors, output,
      );
      activationSpinner.stop(true);
      if (testnetTxHash) {
        output.success(`Testnet activation: ${testnetTxHash}`);
      } else {
        output.info('Testnet: already up-to-date.');
      }
    } catch (activationError) {
      activationSpinner.stop(false);
      // Save testnet pending as fallback — will activate on first testnet payment
      savePendingPublish({ ...pendingData, network: 'base-sepolia' });
      output.warning(
        `Testnet activation failed: ${(activationError as Error).message}\n` +
        '  Saved as pending — will activate on first testnet payment.'
      );
    }

    // Always save mainnet pending (lazy — activates on first mainnet payment)
    savePendingPublish({ ...pendingData, network: 'base-mainnet' });

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
        testnetActivated: !!testnetTxHash,
        ...(testnetTxHash ? { testnetTxHash } : {}),
      },
      { quietKey: 'configHash' }
    );

    output.blank();
    output.success('Config published to IPFS and saved locally.');

    if (testnetTxHash) {
      output.print('');
      output.success('Testnet: activated on-chain.');
    }

    output.print('');
    output.print('Mainnet: on-chain activation will happen on your first payment.');
    output.print('');
    output.print('Next steps:');
    output.print('  - Verify config:  actp diff');
    output.print('  - Make a payment: your first mainnet payment activates the agent on-chain');

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

// ============================================================================
// Testnet Activation
// ============================================================================

/**
 * Activate agent on testnet during `actp publish`.
 *
 * SPEC v4 Step 3: activation + mint test USDC in a single gasless UserOp.
 * Always mints test USDC regardless of scenario (SPEC: "always on testnet").
 *
 * @returns Transaction hash of the UserOp, or undefined if already up-to-date
 */
async function activateOnTestnet(
  projectRoot: string,
  configHash: string,
  cid: string,
  endpoint: string,
  serviceDescriptors: import('../../types/agent').ServiceDescriptor[],
  output: Output,
): Promise<string | undefined> {
  const { resolvePrivateKey } = await import('../../wallet/keystore');
  const { ethers } = await import('ethers');
  const { getNetwork } = await import('../../config/networks');
  const { AutoWalletProvider } = await import('../../wallet/AutoWalletProvider');
  const { buildActivationBatch, buildTestnetMintBatch } = await import('../../wallet/aa/TransactionBatcher');
  const { getOnChainAgentState, detectLazyPublishScenario } = await import('../../ACTPClient');

  const privateKey = await resolvePrivateKey(projectRoot);
  if (!privateKey) {
    throw new Error('No wallet found. Cannot activate on testnet.');
  }

  const networkConfig = getNetwork('base-sepolia');
  if (!networkConfig.aa || !networkConfig.contracts.agentRegistry) {
    throw new Error('Testnet AA or AgentRegistry not configured.');
  }

  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  const autoWallet = await AutoWalletProvider.create({
    signer,
    provider,
    chainId: networkConfig.chainId,
    actpKernelAddress: networkConfig.contracts.actpKernel,
    bundler: {
      primaryUrl: networkConfig.aa.bundlerUrls.coinbase,
      backupUrl: networkConfig.aa.bundlerUrls.pimlico,
    },
    paymaster: {
      primaryUrl: networkConfig.aa.paymasterUrls.coinbase,
      backupUrl: networkConfig.aa.paymasterUrls.pimlico,
    },
  });

  const smartWalletAddress = autoWallet.getAddress();
  output.info(`Smart Wallet: ${smartWalletAddress}`);

  // Check on-chain state to determine activation scenario
  const onChainState = await getOnChainAgentState(
    provider, networkConfig.contracts.agentRegistry, smartWalletAddress
  );
  const scenario = detectLazyPublishScenario(onChainState, {
    version: 1, configHash, cid, endpoint, serviceDescriptors, createdAt: new Date().toISOString(),
  });

  if (scenario === 'C' || scenario === 'none') {
    // Already up-to-date on-chain — no activation needed
    return undefined;
  }

  // Build activation calls
  const activationCalls = buildActivationBatch({
    scenario,
    agentRegistryAddress: networkConfig.contracts.agentRegistry,
    cid,
    configHash,
    listed: true,
    ...(scenario === 'A' ? { endpoint, serviceDescriptors } : {}),
  });

  // Always mint test USDC on testnet (SPEC: "always")
  const mintCalls = buildTestnetMintBatch(
    networkConfig.contracts.usdc,
    smartWalletAddress,
    '1000000000', // 1000 USDC
  );

  const allCalls = [...activationCalls, ...mintCalls];
  const txRequests = allCalls.map((c) => ({
    to: c.target,
    data: c.data,
    value: c.value.toString(),
  }));

  output.info(`Submitting ${allCalls.length}-call UserOp...`);
  const receipt = await autoWallet.sendBatchTransaction(txRequests);

  if (!receipt.success) {
    throw new Error(`Testnet activation UserOp failed: ${receipt.hash}`);
  }

  output.success('Minted 1,000 test USDC to Smart Wallet');
  return receipt.hash;
}

/**
 * Resolve wallet address from keystore without needing config.json.
 * Used during publish bootstrap for fresh projects.
 */
async function resolveWalletAddress(projectRoot: string): Promise<string> {
  const { resolvePrivateKey } = await import('../../wallet/keystore');
  const { Wallet } = await import('ethers');

  const privateKey = await resolvePrivateKey(projectRoot);
  if (!privateKey) {
    return ''; // Will be set later when wallet is created
  }
  return new Wallet(privateKey).address;
}
