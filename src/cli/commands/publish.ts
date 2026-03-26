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
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { computeConfigHash, serializeAgirailsMd, parseAgirailsMd } from '../../config/agirailsmd';
import { preparePublish, extractRegistrationParams, PENDING_ENDPOINT } from '../../config/publishPipeline';
import { savePendingPublish, getActpDir } from '../../config/pendingPublish';
import { addToGitignore, loadConfig, saveConfig, isInitialized, CLIConfig, CONFIG_DEFAULTS } from '../utils/config';
import { ethers } from 'ethers';
import { FilebaseClient } from '../../storage/FilebaseClient';
import { ArweaveClient } from '../../storage/ArweaveClient';
import { generateWallet } from '../utils/wallet';
import { parseAgirailsMdV4 } from '../../config/agirailsmdV4';
import { checkSlug, upsertAgent } from '../../api/agirailsApp';

// ============================================================================
// Publish Proxy (fallback when no Filebase credentials)
// ============================================================================

const PUBLISH_PROXY_URL = process.env.AGIRAILS_PUBLISH_URL || 'https://api.agirails.io/v1/publish';

/**
 * Public client key for the AGIRAILS publish proxy.
 * This is NOT a secret — it's a rate-limited, revocable identifier
 * (same model as Firebase API keys). Override via AGIRAILS_PUBLISH_KEY.
 */
const PUBLISH_CLIENT_KEY = process.env.AGIRAILS_PUBLISH_KEY || 'ag_pub_v1_2026';

/**
 * Upload AGIRAILS.md content via the AGIRAILS publish proxy API.
 * Used when FILEBASE_ACCESS_KEY / FILEBASE_SECRET_KEY are not set.
 *
 * @param content - Raw AGIRAILS.md file content
 * @param localConfigHash - Locally computed configHash (for validation)
 */
async function publishViaProxy(content: string, localConfigHash: string): Promise<{ cid: string; configHash: string }> {
  const response = await fetch(PUBLISH_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': PUBLISH_CLIENT_KEY,
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(`Publish proxy error (${response.status}): ${body.error || response.statusText}`);
  }

  const result = await response.json() as { cid: string; configHash: string };
  if (!result.cid || !result.configHash) {
    throw new Error('Publish proxy returned invalid response (missing cid or configHash)');
  }

  // Validate: proxy's configHash must match locally computed hash
  // (guards against hash-drift between SDK and API canonicalization logic)
  if (result.configHash !== localConfigHash) {
    throw new Error(
      `Config hash mismatch: proxy returned ${result.configHash.slice(0, 10)}... ` +
      `but local hash is ${localConfigHash.slice(0, 10)}... — ` +
      'This may indicate an SDK/API version mismatch. Update your SDK.'
    );
  }

  return result;
}

// ============================================================================
// Command Definition
// ============================================================================

export function createPublishCommand(): Command {
  const cmd = new Command('publish')
    .description('Publish AGIRAILS.md config (offline — activates on first payment)')
    .argument('[path]', 'Path to AGIRAILS.md or {slug}.md')
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

  // Resolve file path: explicit arg > identity pointer > ./AGIRAILS.md fallback
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
        'No file to publish. Provide a path, or create a {slug}.md identity file.\n' +
        'Usage: actp publish [path]'
      );
      process.exit(ExitCode.INVALID_INPUT);
    }
  }

  let resolvedPath = resolve(effectivePath);

  if (!existsSync(resolvedPath)) {
    output.error(`File not found: ${effectivePath}`);
    process.exit(ExitCode.INVALID_INPUT);
  }

  const spinner = output.spinner('Reading AGIRAILS.md...');

  try {
    // Read and compute hash
    let content = readFileSync(resolvedPath, 'utf-8');
    let { configHash, structuredHash, bodyHash } = computeConfigHash(content);

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

    // ================================================================
    // Phase 1: Slug check (pre-chain, no auth, only on first publish)
    // ================================================================
    let v4Config: ReturnType<typeof parseAgirailsMdV4> | undefined;
    try {
      v4Config = parseAgirailsMdV4(content);
    } catch {
      // Not a v4 file — skip slug check (backward compatible with v3 AGIRAILS.md)
    }

    if (v4Config && !v4Config.agent_id) {
      // First publish — check slug availability
      const slugSpinner = output.spinner(`Checking slug availability: ${v4Config.slug}...`);
      try {
        const slugResult = await checkSlug(v4Config.slug);
        if (!slugResult.available) {
          if (slugResult.suggestion) {
            slugSpinner.stop(true);
            const oldSlug = v4Config.slug;
            const newSlug = slugResult.suggestion;

            // Auto-rename: update frontmatter slug, rename file, update config pointer
            output.info(`Slug "${oldSlug}" was taken. Renamed to "${newSlug}".`);

            // Rename file on disk
            const { dirname, join: pathJoin } = await import('path');
            const dir = dirname(resolvedPath);
            const newPath = pathJoin(dir, `${newSlug}.md`);
            renameSync(resolvedPath, newPath);

            // Re-read, update slug in frontmatter, rewrite, re-parse, recompute hash
            const rawContent = readFileSync(newPath, 'utf-8');
            const parsed = parseAgirailsMd(rawContent);
            const updatedFm = { ...(parsed.frontmatter as Record<string, unknown>), slug: newSlug };
            const newContent = serializeAgirailsMd(updatedFm, parsed.body);
            writeFileSync(newPath, newContent, 'utf-8');

            // Update in-memory references for the rest of publish
            resolvedPath = newPath;
            v4Config.slug = newSlug;

            // Recompute configHash with new slug
            const reHash = computeConfigHash(newContent);
            configHash = reHash.configHash;
            content = newContent;

            // Update config.json identity pointer
            try {
              const config = loadConfig(resolve(newPath, '..'));
              config.identity = `${newSlug}.md`;
              saveConfig(config, resolve(newPath, '..'));
            } catch {
              // Best-effort
            }
          } else {
            slugSpinner.stop(false);
            throw new Error(`Slug "${v4Config.slug}" is already taken on agirails.app. Choose a different name.`);
          }
        } else {
          slugSpinner.stop(true);
          output.success(`Slug "${v4Config.slug}" is available.`);
        }
      } catch (slugErr) {
        if ((slugErr as Error).message.includes('already taken')) throw slugErr;
        if ((slugErr as Error).message.includes('was taken')) {
          // Auto-rename succeeded — not an error
        } else {
          slugSpinner.stop(false);
          // Non-fatal: slug check API failure doesn't block publish
          output.warning(`Slug check failed: ${(slugErr as Error).message}. Proceeding.`);
        }
      }
    }

    // Ensure .actp directory exists
    const actpDir = getActpDir();
    if (!existsSync(actpDir)) {
      mkdirSync(actpDir, { recursive: true });
    }

    // Generate wallet if keystore.json doesn't exist
    const keystorePath = join(actpDir, 'keystore.json');
    let walletAddress = '';
    if (!existsSync(keystorePath)) {
      spinner.stop(true);
      output.info('No wallet found — generating one...');
      walletAddress = await generateWallet(actpDir, output);
      output.blank();
    } else {
      // Read address from existing keystore (plaintext field, no decryption)
      try {
        const ks = JSON.parse(readFileSync(keystorePath, 'utf-8'));
        walletAddress = ks.address ? `0x${ks.address.replace(/^0x/, '')}` : '';
      } catch {
        // Best-effort address extraction
      }
    }

    // Upload to IPFS: direct (Filebase) or via publish proxy
    const filebaseAccessKey = process.env.FILEBASE_ACCESS_KEY;
    const filebaseSecretKey = process.env.FILEBASE_SECRET_KEY;
    const useProxy = !filebaseAccessKey || !filebaseSecretKey;

    spinner.stop(true);

    if (useProxy) {
      output.info('No Filebase credentials — using AGIRAILS publish proxy.');
    }

    const publishSpinner = output.spinner('Publishing to IPFS...');

    let cid: string;
    let arweaveTxId: string | undefined;

    if (useProxy) {
      // Fallback: upload via AGIRAILS publish proxy API
      const proxyResult = await publishViaProxy(content, configHash);
      cid = proxyResult.cid;
      // Proxy doesn't do Arweave — skip
    } else {
      // Direct upload via Filebase S3 + optional Arweave
      const filebaseClient = new FilebaseClient({
        accessKey: filebaseAccessKey,
        secretKey: filebaseSecretKey,
      });

      let arweaveClient: ArweaveClient | undefined;
      if (!options.skipArweave) {
        const arweaveKey = process.env.ARCHIVE_UPLOADER_KEY;
        if (arweaveKey) {
          arweaveClient = await ArweaveClient.create({
            privateKey: arweaveKey,
            rpcUrl: 'https://mainnet.base.org',
          });
        }
      }

      const prepResult = await preparePublish({
        path: resolvedPath,
        filebaseClient,
        arweaveClient,
        skipArweave: options.skipArweave || !arweaveClient,
      });

      cid = prepResult.cid;
      arweaveTxId = prepResult.arweaveTxId;
    }

    publishSpinner.stop(true);

    // Parse frontmatter for registration params
    const { frontmatter, body } = parseAgirailsMd(content);
    const regParams = extractRegistrationParams(frontmatter as Record<string, unknown>);

    const pendingData = {
      version: 1 as const,
      configHash,
      cid,
      endpoint: regParams.endpoint,
      serviceDescriptors: regParams.serviceDescriptors,
      createdAt: new Date().toISOString(),
    };

    const projectRoot = resolve(resolvedPath, '..');

    // ================================================================
    // Local setup: bootstrap or migrate config, ensure .gitignore
    // "publish covers setup" — no separate `actp init` required.
    // ================================================================
    try {
      if (isInitialized(projectRoot)) {
        // Existing project: migrate config (strip deprecated `registered`)
        const config = loadConfig(projectRoot);
        saveConfig(config, projectRoot);
      } else if (walletAddress) {
        // Fresh project: bootstrap minimal config using address from keystore
        const bootstrapConfig: CLIConfig = {
          ...CONFIG_DEFAULTS,
          mode: 'testnet', // safe default for new projects
          address: walletAddress.toLowerCase(),
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
    let smartWalletAddress: string | undefined;
    const activationSpinner = output.spinner('Activating on testnet...');
    try {
      const activationResult = await activateOnTestnet(
        projectRoot, configHash, cid,
        regParams.endpoint, regParams.serviceDescriptors, output,
      );
      activationSpinner.stop(true);
      if (activationResult) {
        testnetTxHash = activationResult.txHash;
        smartWalletAddress = activationResult.smartWalletAddress;
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

    // ================================================================
    // Write-back: wallet, agent_id, did into AGIRAILS.md frontmatter
    // These are in PUBLISH_METADATA_KEYS — stripped before hash computation.
    // ================================================================
    const publishMetadata: Record<string, string> = {};
    // Wallet write-back: Smart Wallet is the on-chain identity (NFT owner,
    // escrow party). EOA is only a fallback for non-Smart-Wallet flows.
    const canonicalWallet = smartWalletAddress || walletAddress;
    if (canonicalWallet) {
      publishMetadata.wallet = canonicalWallet;
      publishMetadata.did = `did:ethr:84532:${canonicalWallet}`;
    }
    // agent_id: query ERC-8004 Identity Registry for minted tokenId
    // Use Smart Wallet address (NFT owner) when available, fall back to EOA
    const ownerAddress = smartWalletAddress || walletAddress;
    if (testnetTxHash && ownerAddress) {
      try {
        const { getNetwork: getNet } = await import('../../config/networks');
        const { ethers: eth } = await import('ethers');
        const net = getNet('base-sepolia');
        const prov = new eth.JsonRpcProvider(net.rpcUrl);

        // Query ERC-8004 Identity Registry for the agent's NFT tokenId
        const erc8004Addr = net.contracts.erc8004IdentityRegistry;
        if (erc8004Addr) {
          const { ERC8004_IDENTITY_ABI } = await import('../../types/erc8004');
          const erc8004 = new eth.Contract(erc8004Addr, ERC8004_IDENTITY_ABI, prov);
          // Parse Registered event from tx receipt for exact agentId
          let agentId: string | undefined;
          try {
            const receipt = await prov.getTransactionReceipt(testnetTxHash);
            if (receipt) {
              const registeredTopic = eth.id('Registered(uint256,string,address)');
              for (const log of receipt.logs) {
                if (log.address.toLowerCase() === erc8004Addr.toLowerCase()
                    && log.topics[0] === registeredTopic) {
                  // agentId is the first indexed parameter
                  agentId = BigInt(log.topics[1]).toString();
                  break;
                }
              }
            }
          } catch {
            // Event parsing failed — fall back to balanceOf query
          }

          // Fallback: query by balance if event parsing didn't work
          if (!agentId) {
            const balance = await erc8004.balanceOf(ownerAddress);
            if (Number(balance) > 0) {
              const lastIndex = Number(balance) - 1;
              agentId = (await erc8004.tokenOfOwnerByIndex(ownerAddress, lastIndex)).toString();
            }
          }

          if (agentId) {
            publishMetadata.agent_id = agentId;
            publishMetadata.did = `did:ethr:84532:${ownerAddress}`;
          }
        }

        // Fallback: check AgentRegistry if ERC-8004 didn't yield an agent_id
        if (!publishMetadata.agent_id) {
          const registryAddr = net.contracts.agentRegistry;
          if (registryAddr) {
            const { AgentRegistryClient: ARC } = await import('../../registry/AgentRegistryClient');
            const regClient = ARC.readOnly(registryAddr, prov);
            const onChainConfig = await regClient.getConfig(ownerAddress);
            if (onChainConfig.isActive) {
              const agentId = BigInt(ownerAddress).toString();
              publishMetadata.agent_id = agentId;
              publishMetadata.did = `did:ethr:84532:${ownerAddress}`;
            }
          }
        }
      } catch {
        // Best-effort — agent_id will be written on re-publish
      }
    }


    // ================================================================
    // Phase 1: API upsert to agirails.app (post-chain, non-blocking)
    // Requires agent_id — skipped on first publish (agent_id assigned
    // on-chain, written back to YAML, available on re-publish).
    // API routes: POST /api/v1/agents (dual auth: session + wallet-sig)
    // ================================================================
    if (v4Config && v4Config.agent_id && walletAddress) {
      const apiSpinner = output.spinner('Syncing with agirails.app...');
      try {
        const publishTimestamp = Math.floor(Date.now() / 1000);
        // C-2 fix: include network in signed message to prevent cross-network replay
        // Upsert only fires after testnet activation, so network is always base-sepolia
        const publishNetwork = 'base-sepolia';
        const upsertMessage = `agirails-publish:${v4Config.slug}:${configHash}:${publishNetwork}:${publishTimestamp}`;
        const { resolvePrivateKey: resolveKey } = await import('../../wallet/keystore');
        const privKey = await resolveKey(projectRoot, { network: 'testnet' });
        if (privKey) {
          const signer = new ethers.Wallet(privKey);
          const sig = await signer.signMessage(upsertMessage);
          const apiResult = await upsertAgent({
            slug: v4Config.slug,
            agentId: v4Config.agent_id,
            wallet: smartWalletAddress || walletAddress,
            signer: walletAddress, // EOA that signed the message
            configCid: cid,
            configHash,
            signature: sig,
            message: upsertMessage,
            timestamp: publishTimestamp,
            network: publishNetwork,
          });
          apiSpinner.stop(true);
          output.success(`Profile live at: agirails.app/a/${v4Config.slug}`);
          // Display claim code if returned (for linking to dashboard)
          if (apiResult.claimCode) {
            output.print(`  Claim code: ${apiResult.claimCode}`);
            output.print(`  Claim link: https://agirails.app/claim?code=${apiResult.claimCode}`);
            output.print('  (use this to link the agent to your dashboard account)');
          }
        } else {
          apiSpinner.stop(false);
          output.info('Skipped agirails.app sync (no wallet key for signing).');
        }
      } catch (apiErr) {
        apiSpinner.stop(false);
        // Non-blocking — agent is already on-chain
        output.warning(`agirails.app sync failed: ${(apiErr as Error).message}`);
        output.print('  Agent is on-chain. Retry with: actp publish');
      }
    } else if (v4Config && !v4Config.agent_id) {
      output.info('First publish — agirails.app sync will happen on re-publish (after agent_id is assigned).');
    }

    // Update AGIRAILS.md frontmatter
    const updatedFrontmatter = {
      ...(frontmatter as Record<string, unknown>),
      config_hash: configHash,
      config_cid: cid,
      published_at: new Date().toISOString(),
      ...(arweaveTxId ? { arweave_tx: arweaveTxId } : {}),
      ...publishMetadata,
    };
    const updatedContent = serializeAgirailsMd(updatedFrontmatter, body);
    writeFileSync(resolvedPath, updatedContent, 'utf-8');

    // Update identity pointer in config.json if this is a {slug}.md file
    if (v4Config) {
      try {
        const { basename } = await import('path');
        const config = loadConfig(projectRoot);
        const filename = basename(resolvedPath);
        if (config.identity !== filename) {
          config.identity = filename;
          saveConfig(config, projectRoot);
        }
      } catch {
        // Best-effort — config might not exist yet
      }
    }

    // Output results
    output.result(
      {
        configHash,
        cid,
        arweaveTxId: arweaveTxId || null,
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

    // Context-aware next steps
    const hasEndpoint = frontmatter.endpoint && frontmatter.endpoint !== PENDING_ENDPOINT;
    output.print('');
    output.print('Next steps:');
    if (!hasEndpoint) {
      output.print('  1. Set your endpoint:    Add "endpoint: https://..." to AGIRAILS.md');
      output.print('  2. Check endpoint:       actp health');
      output.print('  3. Check your balance:   actp balance');
      output.print('  4. Verify config match:  actp diff');
    } else {
      output.print('  1. Check endpoint:       actp health');
      output.print('  2. Check your balance:   actp balance');
      output.print('  3. Verify config match:  actp diff');
    }

    // Suggest test payment on testnet
    if (testnetTxHash && v4Config?.slug) {
      output.print('');
      output.print(`  Try a test payment: actp pay agirails.app/a/${v4Config.slug} 5`);
    }

    // Warn if placeholder endpoint
    if (!hasEndpoint) {
      output.print('');
      output.warning('No endpoint set — your agent can\'t receive jobs yet.');
      output.print('  Add "endpoint: https://your-agent.com/webhook" to AGIRAILS.md, then: actp publish');
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
): Promise<{ txHash: string; smartWalletAddress: string } | undefined> {
  const { resolvePrivateKey } = await import('../../wallet/keystore');
  const { ethers } = await import('ethers');
  const { getNetwork } = await import('../../config/networks');
  const { AutoWalletProvider } = await import('../../wallet/AutoWalletProvider');
  const { buildActivationBatch, buildTestnetMintBatch } = await import('../../wallet/aa/TransactionBatcher');
  const { getOnChainAgentState, detectLazyPublishScenario } = await import('../../ACTPClient');

  const privateKey = await resolvePrivateKey(projectRoot, { network: 'testnet' });
  if (!privateKey) {
    throw new Error('No wallet found. Cannot activate on testnet.');
  }

  const networkConfig = getNetwork('base-sepolia');
  if (!networkConfig.aa || !networkConfig.contracts.agentRegistry) {
    throw new Error('Testnet AA or AgentRegistry not configured.');
  }

  const coinbaseBundlerUrl = networkConfig.aa.bundlerUrls.coinbase;
  const pimlicoBundlerUrl = networkConfig.aa.bundlerUrls.pimlico;
  const coinbasePaymasterUrl = networkConfig.aa.paymasterUrls.coinbase;
  const pimlicoPaymasterUrl = networkConfig.aa.paymasterUrls.pimlico;
  const bundlerPrimary = coinbaseBundlerUrl ?? pimlicoBundlerUrl;
  const bundlerBackup = coinbaseBundlerUrl && pimlicoBundlerUrl ? pimlicoBundlerUrl : undefined;
  const paymasterPrimary = coinbasePaymasterUrl ?? pimlicoPaymasterUrl;
  const paymasterBackup = coinbasePaymasterUrl && pimlicoPaymasterUrl ? pimlicoPaymasterUrl : undefined;

  if (!bundlerPrimary || !paymasterPrimary) {
    throw new Error(
      'Testnet AA bundler/paymaster endpoints are not configured.\n' +
      'Set CDP_API_KEY or PIMLICO_API_KEY (or explicit *_BUNDLER_URL/*_PAYMASTER_URL).'
    );
  }

  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  const autoWallet = await AutoWalletProvider.create({
    signer,
    provider,
    chainId: networkConfig.chainId,
    actpKernelAddress: networkConfig.contracts.actpKernel,
    bundler: {
      primaryUrl: bundlerPrimary,
      backupUrl: bundlerBackup,
    },
    paymaster: {
      primaryUrl: paymasterPrimary,
      backupUrl: paymasterBackup,
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

  // Build activation calls (includes ERC-8004 identity mint for scenario A)
  const activationCalls = buildActivationBatch({
    scenario,
    agentRegistryAddress: networkConfig.contracts.agentRegistry,
    cid,
    configHash,
    listed: true,
    ...(scenario === 'A' ? { endpoint, serviceDescriptors } : {}),
    erc8004IdentityRegistry: networkConfig.contracts.erc8004IdentityRegistry,
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
  return { txHash: receipt.hash, smartWalletAddress };
}
