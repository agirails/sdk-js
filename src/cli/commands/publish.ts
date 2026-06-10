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
import { resolve, join, basename } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import * as readline from 'readline';
import { computeConfigHash, serializeAgirailsMd, parseAgirailsMd } from '../../config/agirailsmd';
import { preparePublish, extractRegistrationParams, PENDING_ENDPOINT, defaultDiscoveryEndpoint } from '../../config/publishPipeline';
import { savePendingPublish, getActpDir } from '../../config/pendingPublish';
import { saveBuyerLink } from '../../config/buyerLink';
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
 *
 * **Intentionally embedded** — same threat model as a Firebase public
 * client key or a Stripe publishable key. Rate-limited per identifier
 * and revocable server-side; carries **no privileged scope** on the
 * publish proxy. It exists so the proxy can attribute traffic per SDK
 * version without forcing every CLI user to register an account.
 *
 * The `ag_pub_v1_` prefix is deliberate convention — it signals "public
 * identifier, safe to commit" to anyone running `git grep` on the SDK.
 *
 * Confirmed safe-to-embed per the 2026-05-17 Apex source-level audit
 * (FIND-012 soft observation). Override via `AGIRAILS_PUBLISH_KEY` env
 * var when a deployment needs to opt in to a different rate-limit
 * bucket on the proxy.
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

/**
 * Run the publish flow programmatically.
 *
 * Exported so `actp init --intent pay --test` can chain `publish → test`
 * in a single command (AIP-18 buyer onboarding wow flow). External
 * consumers should still prefer `actp publish` for normal use.
 *
 * @param filePath - Path to {slug}.md, or '' to auto-resolve via
 *                   resolveIdentityPath / fallback to ./AGIRAILS.md.
 * @param options  - Same options the CLI command accepts.
 * @param output   - Output sink (controls json/quiet/human modes).
 */
export async function runPublish(
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
        'No file to publish.\n' +
        'Run `actp init` to create an identity file, then `actp publish`.\n' +
        'Or provide a path directly: actp publish <path>'
      );
      process.exit(ExitCode.INVALID_INPUT);
    }
  }

  let resolvedPath = resolve(effectivePath);

  if (!existsSync(resolvedPath)) {
    output.error(`File not found: ${effectivePath}\nRun \`actp init\` to create a new identity file.`);
    process.exit(ExitCode.INVALID_INPUT);
  }

  const spinner = output.spinner('Reading AGIRAILS.md...');

  try {
    // Read and compute hash
    let content = readFileSync(resolvedPath, 'utf-8');

    // Guard: never publish the AGIRAILS protocol guide (the ~48 KB owner doc the
    // owner curls). It is documentation, not an identity file — publishing it
    // 413s at the proxy and is meaningless on-chain. Real identity files are tiny.
    const guideBytes = Buffer.byteLength(content, 'utf-8');
    const looksLikeProtocolGuide =
      /^#{1,4}\s+Step\s+\d/m.test(content) && content.includes('actp init');
    if (looksLikeProtocolGuide || (basename(resolvedPath) === 'AGIRAILS.md' && guideBytes > 20480)) {
      spinner.stop(false);
      output.error(
        `"${basename(resolvedPath)}" looks like the AGIRAILS protocol guide ` +
        `(${Math.round(guideBytes / 1024)} KB), not your agent's identity file.\n` +
        `Publish your {slug}.md instead:\n` +
        `  actp init      # scaffolds the identity file\n` +
        `  actp publish   # auto-detects {slug}.md`,
      );
      process.exit(ExitCode.INVALID_INPUT);
    }

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
    // Set when this publish should ADOPT the user's own pending web draft
    // (created via the onboarding wizard) using the claim_code embedded in
    // AGIRAILS.md. Threaded into the upsert call so the server binds this
    // wallet + agent_id to that exact record instead of duplicating it.
    let draftClaimCode: string | undefined;

    let v4Config: ReturnType<typeof parseAgirailsMdV4> | undefined;
    try {
      v4Config = parseAgirailsMdV4(content);
    } catch {
      // Not a v4 file — skip slug check (backward compatible with v3 AGIRAILS.md)
    }

    // Intent / shape validation. Catches the common authoring drift where a
    // pay-only agent ships a `services` block that would silently register
    // it as a phantom provider on AgentRegistry. We strip the misshape
    // here (so the rewritten frontmatter persists to disk after publish)
    // and hard-fail when required fields are missing.
    if (v4Config) {
      if (v4Config.intent === 'pay' && v4Config.services.length > 0) {
        output.warning(
          `intent: pay agents do not provide services — stripping services block ` +
            `before publish (was: ${v4Config.services.map(s => s.type).join(', ')}).`
        );
        v4Config.services = [];
        const parsed = parseAgirailsMd(content);
        const updatedFm = { ...(parsed.frontmatter as Record<string, unknown>) };
        delete updatedFm.services;
        const newContent = serializeAgirailsMd(updatedFm, parsed.body);
        writeFileSync(resolvedPath + '.tmp', newContent, 'utf-8');
        renameSync(resolvedPath + '.tmp', resolvedPath);
        content = newContent;
        const reHash = computeConfigHash(newContent);
        configHash = reHash.configHash;
      }
      if (v4Config.intent === 'pay' && v4Config.servicesNeeded.length === 0) {
        throw new Error(
          'intent: pay requires servicesNeeded — list at least one capability your agent will buy.'
        );
      }
      if (v4Config.intent === 'earn' && v4Config.services.length === 0) {
        throw new Error(
          'intent: earn requires services — list at least one capability your agent will provide.'
        );
      }
      if (v4Config.intent === 'both' && v4Config.services.length === 0) {
        throw new Error('intent: both requires at least one entry in services (provider side).');
      }
      if (v4Config.intent === 'both' && v4Config.servicesNeeded.length === 0) {
        throw new Error('intent: both requires at least one entry in servicesNeeded (buyer side).');
      }
    }

    if (v4Config && !v4Config.agent_id) {
      // First publish — check slug availability
      const slugSpinner = output.spinner(`Checking slug availability: ${v4Config.slug}...`);
      try {
        const slugResult = await checkSlug(v4Config.slug);
        if (!slugResult.available) {
          // Try ownership recovery before falling back to auto-rename.
          // Scenario: user lost agent_id from AGIRAILS.md (manual edit,
          // file replaced, scaffold redo) but still owns the slug on
          // agirails.app. Treat this publish as an UPDATE, not NEW.
          let recovered = false;
          let adoptedDraft = false;
          if (slugResult.owner) {
            // projectRoot isn't bound until later in the function; derive
            // a local equivalent inline (parent dir of the .md file).
            const slugCheckProjectRoot = resolve(resolvedPath, '..');
            const localSigner = await derivePotentialSigner(slugCheckProjectRoot);
            const ownerWallet = slugResult.owner.wallet.toLowerCase();
            if (localSigner && localSigner.toLowerCase() === ownerWallet) {
              slugSpinner.stop(true);
              recovered = await maybeRecoverAgentId({
                output,
                slug: v4Config.slug,
                ownerAgentId: slugResult.owner.agentId,
                resolvedPath,
                onRestored: ({ newContent, newConfigHash }) => {
                  // Mutate in-memory state so the rest of publish treats
                  // this as a known-agent_id update path.
                  v4Config!.agent_id = slugResult.owner!.agentId;
                  configHash = newConfigHash;
                  content = newContent;
                },
              });
            } else if (localSigner) {
              output.warning(
                `Slug "${v4Config.slug}" is owned by ${ownerWallet} ` +
                  `(your wallet ${localSigner.toLowerCase()} differs).`
              );
            }
          }

          // Adopt the user's own pending web draft (onboarding wizard) using
          // the claim_code embedded in AGIRAILS.md. Publishing the original
          // slug lets the server bind this wallet + agent_id to that exact
          // record instead of creating a duplicate "<slug>-2".
          if (!recovered && slugResult.draft) {
            const code = readDraftClaimCode(content, resolvedPath);
            if (code) {
              slugSpinner.stop(true);
              output.info(`Slug "${v4Config.slug}" matches your web draft — adopting it (no duplicate).`);
              draftClaimCode = code;
              adoptedDraft = true;
            } else {
              output.warning(
                `Slug "${v4Config.slug}" is held by an unpublished web draft, but no ` +
                  `claim_code was found in AGIRAILS.md. Re-download the owner doc ` +
                  `(curl ".../a/${v4Config.slug}/AGIRAILS.md?token=...") to adopt it ` +
                  `instead of creating a duplicate.`
              );
            }
          }

          if (!recovered && !adoptedDraft) {
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
              const tmpSlugPath = newPath + '.tmp';
              writeFileSync(tmpSlugPath, newContent, 'utf-8');
              renameSync(tmpSlugPath, newPath);

              // Update in-memory references for the rest of publish
              resolvedPath = newPath;
              v4Config.slug = newSlug;

              // Recompute configHash with new slug
              const reHash = computeConfigHash(newContent);
              configHash = reHash.configHash;
              content = newContent;

              // Update config.json identity pointer
              try {
                const config = loadConfig(dirname(newPath));
                config.identity = `${newSlug}.md`;
                saveConfig(config, dirname(newPath));
              } catch {
                // Best-effort
              }
            } else {
              slugSpinner.stop(false);
              throw new Error(`Slug "${v4Config.slug}" is already taken on agirails.app. Choose a different name.`);
            }
          }
        } else {
          slugSpinner.stop(true);
          output.success(`Slug "${v4Config.slug}" is available.`);
        }
      } catch (slugErr) {
        if ((slugErr as Error).message.includes('already taken')) {
          slugSpinner.stop(false);
          throw slugErr;
        }
        if ((slugErr as Error).message.includes('was taken')) {
          // Auto-rename succeeded — not an error
        } else if ((slugErr as Error).message.includes('OWNERSHIP_RECOVERY_REQUIRES_TTY')) {
          // Re-throw — the user needs to add agent_id to AGIRAILS.md manually
          slugSpinner.stop(false);
          throw slugErr;
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

    // AIP-18 DEC-3/DEC-4: a pure buyer (intent: pay) LINKS — it does not
    // publish a service file. Skip the IPFS upload entirely so the buyer's
    // local file (which may carry a private `budget`) never reaches IPFS or
    // the publish proxy. No CID is produced; the buyer is identified by
    // wallet + the agirails.app DB link. (budget is additionally stripped
    // from the configHash via PUBLISH_METADATA_KEYS, so it is absent from
    // every hashed artifact too.) This also moves the pay-only short-circuit
    // ahead of any network upload, closing the leak where the file was sent
    // before the later on-chain skip.
    const isPayOnly = v4Config?.intent === 'pay';

    let cid: string | undefined;
    let arweaveTxId: string | undefined;

    if (isPayOnly) {
      spinner.stop(true);
      output.info(
        'Pay-only agent: no service file to publish — linking to agirails.app only (budget stays local).'
      );
    } else {
      // Upload to IPFS: direct (Filebase) or via publish proxy
      const filebaseAccessKey = process.env.FILEBASE_ACCESS_KEY;
      const filebaseSecretKey = process.env.FILEBASE_SECRET_KEY;
      const useProxy = !filebaseAccessKey || !filebaseSecretKey;

      spinner.stop(true);

      if (useProxy) {
        output.info('No Filebase credentials — using AGIRAILS publish proxy.');
      }

      const publishSpinner = output.spinner('Publishing to IPFS...');

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
    }

    // Parse frontmatter for registration params
    const { frontmatter, body } = parseAgirailsMd(content);
    const regParams = extractRegistrationParams(frontmatter as Record<string, unknown>);

    // Only consumed in the non-pay activation-failure path (cid is a real
    // string there); the '' fallback for pay-only is never persisted.
    const pendingData = {
      version: 1 as const,
      configHash,
      cid: cid ?? '',
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
    //
    // Pay-only short-circuit: AgentRegistry requires serviceDescriptors > 0
    // and pay-only agents have none, so we skip on-chain registration
    // entirely. Their identity is wallet + agirails.app DB record; no
    // gas spent, no test USDC minted, no pending-publish files left.
    // ================================================================
    let testnetTxHash: string | undefined;
    let smartWalletAddress: string | undefined;

    if (isPayOnly) {
      output.info(
        'Pay-only agent: skipping on-chain registration. ' +
          'Identity is your wallet + agirails.app profile.'
      );

      // Resolve the Smart Wallet address for a wallet:auto buyer so the DB
      // link (and the buyer-link marker) record the address the agent actually
      // transacts from — not the bare EOA signer. Providers get this from
      // on-chain activation; a buyer skips activation, so read the address
      // `actp init` derived into .actp/config.json. (Falls back to the EOA if
      // unknown.) This makes buyer attribution match on-chain payments.
      try {
        const cfg = loadConfig(projectRoot);
        if (cfg.wallet === 'auto' && cfg.smartWallet) {
          smartWalletAddress = cfg.smartWallet;
        }
      } catch {
        // Best-effort — the EOA fallback below still produces a valid link.
      }

      // Write the buyer-link marker so the SDK's auto-wallet gate grants
      // gas-sponsored transactions to this linked buyer (AIP-18 DEC-8) — a
      // buyer has no on-chain configHash and no pending-publish, so without
      // this marker the gate would fall back to the EOA wallet and require
      // ETH. The marker triggers NO lazy on-chain activation.
      //
      // Write it into the published agent's project root (.actp beside the
      // {slug}.md), not the cwd — otherwise `actp publish path/to/buyer.md`
      // run from elsewhere would drop the marker where the runtime client
      // can't find it. ACTP_DIR (if set) still wins, matching the client.
      try {
        const buyerLinkActpDir = process.env.ACTP_DIR || join(projectRoot, '.actp');
        saveBuyerLink(
          {
            version: 1,
            slug: v4Config!.slug,
            wallet: (smartWalletAddress || walletAddress || '').toLowerCase(),
            linkedAt: new Date().toISOString(),
          },
          buyerLinkActpDir,
        );
      } catch {
        // Best-effort — publish/link still succeeds without the gas marker.
      }

      // A buyer skips on-chain activation — which is where providers receive
      // their 1,000 test USDC. Mint it here so the buyer can actually pay
      // (gasless, no registration). Without this the agent links but has a
      // zero balance and can buy nothing.
      await mintTestnetUsdcForBuyer(projectRoot, output);
    } else {
      const activationSpinner = output.spinner('Activating on testnet...');
      try {
        const activationResult = await activateOnTestnet(
          // Non-pay branch: the upload above always assigns cid.
          projectRoot, configHash, cid!,
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

      // Save mainnet pending (lazy — activates on first mainnet payment).
      // This is intentional even when config mode is testnet: the agent may later
      // switch to mainnet, and the pending file ensures activation happens automatically.
      savePendingPublish({ ...pendingData, network: 'base-mainnet' });
    }

    // ================================================================
    // Write-back: wallet, agent_id, did into AGIRAILS.md frontmatter
    // These are in PUBLISH_METADATA_KEYS — stripped before hash computation.
    // ================================================================
    const publishMetadata: Record<string, string> = {};
    // Wallet write-back: Smart Wallet is the on-chain identity (NFT owner,
    // escrow party). EOA is only a fallback for non-Smart-Wallet flows.
    const existingWallet = (frontmatter as Record<string, unknown>).wallet as string | undefined;
    const canonicalWallet = smartWalletAddress || existingWallet || walletAddress;
    if (canonicalWallet) {
      publishMetadata.wallet = canonicalWallet;
      publishMetadata.did = `did:ethr:84532:${canonicalWallet}`;
    }
    // agent_id: query ERC-8004 Identity Registry for minted tokenId
    // Use Smart Wallet address (NFT owner) when available, fall back to EOA
    const ownerAddress = smartWalletAddress || existingWallet || walletAddress;
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
    //
    // Two flows:
    //  - earn/both: agent_id is required and verified on-chain via
    //    ownerOf(tokenId) == wallet. agent_id comes from YAML or from
    //    freshly minted publishMetadata (testnet activation).
    //  - pay-only:  no agent_id (no on-chain registration). Sync still
    //    happens — the wallet signature proves the wallet owns the
    //    slug, which is the only auth we need for buyer-only agents.
    // ================================================================
    const effectiveAgentId = v4Config?.agent_id || publishMetadata.agent_id;
    const isPayOnlyForSync = v4Config?.intent === 'pay';
    const canSync = v4Config && walletAddress && (effectiveAgentId || isPayOnlyForSync);
    if (canSync && v4Config && walletAddress) {
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
            // Omit agentId for pay-only (no on-chain NFT to verify against).
            // Web side skips ownerOf check when agentId is absent and trusts
            // the wallet signature as sole proof of ownership.
            ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
            wallet: smartWalletAddress || existingWallet || walletAddress,
            signer: walletAddress, // EOA that signed the message
            configCid: cid,
            configHash,
            signature: sig,
            message: upsertMessage,
            timestamp: publishTimestamp,
            network: publishNetwork,
            // Present only when adopting a pending web draft (see slug phase).
            ...(draftClaimCode ? { claimCode: draftClaimCode } : {}),
            config: {
              name: v4Config.name,
              description: (v4Config.description || "").replace(/^#\s+[^\n]+\n*/, "").trim(),
              // P1: include intent so web isPubliclyVisible() can hide
              // pay-only agents from public discovery on first sync. Without
              // this, a freshly synced pay-only agent leaks publicly until
              // the next re-publish.
              intent: v4Config.intent,
              capabilities: v4Config.services.map(s => s.type),
              // Buyer-side discovery metadata (AIP-18 §7.1, opt-in semi-public)
              // so the dashboard/profile reflects what the buyer requests.
              // budget is deliberately NOT synced — it is a private operational
              // cap (DEC-2) and never leaves the owner's machine.
              ...(v4Config.servicesNeeded?.length
                ? { services_needed: v4Config.servicesNeeded }
                : {}),
              pricing: {
                model: "fixed",
                amount: String(v4Config.pricing.base),
                unit: v4Config.pricing.unit || "job",
                currency: v4Config.pricing.currency || "USDC",
                minimum: String(v4Config.pricing.min_price ?? v4Config.pricing.base),
              },
              sla: {
                availability: "24/7",
                responseTime: { p50: 30, p95: 300 },
                ...(v4Config.sla.concurrency ? { throughput: v4Config.sla.concurrency + " concurrent" } : {}),
              },
              ...(v4Config.sla.concurrency ? { concurrency: v4Config.sla.concurrency } : {}),
              payment_mode: v4Config.payment.modes.includes("x402") ? "x402" : "actp",
              network: v4Config.network,
              // Covenant: map V4 accepts/returns to web input/output format
              ...(v4Config.covenant.accepts && Object.keys(v4Config.covenant.accepts).length > 0 ? {
                covenant: {
                  input: Object.entries(v4Config.covenant.accepts).map(([k, v]) => k + ": " + v).join("\n"),
                  output: Object.entries(v4Config.covenant.returns).map(([k, v]) => k + ": " + v).join("\n"),
                  guarantees: [] as string[],
                  dispute: { window_hours: 24, resolution: "auto-refund" },
                },
              } : {}),
              // Endpoint: for x402 agents
              ...(v4Config.endpoint ? {
                endpoints: { execute: v4Config.endpoint },
              } : {}),
            },
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
    } else if (v4Config && !v4Config.agent_id && !isPayOnlyForSync) {
      output.info('First publish — agirails.app sync will happen on re-publish (after agent_id is assigned).');
    }

    // Update AGIRAILS.md frontmatter
    const updatedFrontmatter = {
      ...(frontmatter as Record<string, unknown>),
      config_hash: configHash,
      // Pay-only buyers upload nothing — omit config_cid rather than write undefined.
      ...(cid ? { config_cid: cid } : {}),
      published_at: new Date().toISOString(),
      ...(arweaveTxId ? { arweave_tx: arweaveTxId } : {}),
      ...publishMetadata,
    };
    const updatedContent = serializeAgirailsMd(updatedFrontmatter, body);
    const tmpWritePath = resolvedPath + '.tmp';
    writeFileSync(tmpWritePath, updatedContent, 'utf-8');
    renameSync(tmpWritePath, resolvedPath);

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

    // ────────────────────────────────────────────────────────────────
    // Output results — branch by intent so a buyer's mental model stays
    // clean: a pure buyer LINKS (DEC-3/DEC-4). It does NOT publish to IPFS
    // and has NO mainnet lazy activation. Reporting otherwise re-muddies
    // exactly what AIP-18 set out to clarify.
    // ────────────────────────────────────────────────────────────────
    if (isPayOnly) {
      output.result(
        {
          configHash,
          linked: true,
          intent: 'pay',
          // No cid, no on-chain activation — a buyer publishes nothing.
          pendingPublish: false,
          testnetActivated: false,
        },
        { quietKey: 'configHash' }
      );

      output.blank();
      output.success('Buyer profile linked to agirails.app. Budget stays local and private.');
      output.print('');
      output.print('No on-chain registration and no IPFS upload — a pure buyer needs neither.');
      output.print('Gas is sponsored via your auto wallet; on testnet you start with 1,000 test USDC.');

      output.print('');
      output.print('Next steps:');
      output.print('  1. Check your balance:   actp balance');
      output.print('  2. Discover providers:   actp find <capability>');
      output.print('  3. Pay a provider:       actp pay <provider> <amount>');
    } else {
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

      // Context-aware next steps. Endpoint is optional; when absent we
      // send the agent's agirails.app profile URL on-chain as a default.
      const customEndpoint = frontmatter.endpoint
        && frontmatter.endpoint !== PENDING_ENDPOINT
        && frontmatter.endpoint !== defaultDiscoveryEndpoint(v4Config?.slug);
      output.print('');
      output.print('Next steps:');
      output.print('  1. Check your balance:   actp balance');
      output.print('  2. Verify config match:  actp diff');
      if (customEndpoint) {
        output.print('  3. Probe endpoint:       actp health');
      }

      // Suggest test payment on testnet
      if (testnetTxHash && v4Config?.slug) {
        output.print('');
        output.print(`  Try a test payment: actp pay agirails.app/a/${v4Config.slug} 5`);
      }

      // Inform about endpoint default — it is OPTIONAL. When unset, the
      // on-chain endpoint defaults to the agent's profile URL on
      // agirails.app, which is a real navigable page (vs the legacy
      // pending.agirails.io 404). Set a custom endpoint only if you want
      // x402 atomic HTTP payments or off-protocol job intake.
      if (!customEndpoint && v4Config?.slug) {
        output.print('');
        output.info(
          `No custom endpoint set — using your profile URL as the discovery anchor: ` +
            `${defaultDiscoveryEndpoint(v4Config.slug)}`
        );
        output.print(
          '  Set a custom endpoint only if you want x402 instant HTTP payments or ' +
            'off-protocol job intake (HTTPS webhook). Otherwise leave it as is.'
        );
      }
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

  // Mint test USDC on testnet — but only on FIRST activation. Re-activation
  // (re-publish / sync after a frontmatter edit) must not keep topping up
  // the wallet: every sync would add another 1,000 USDC and Damir's
  // Sentinel Auditor saw the balance climb 1k → 2k → 3k → 4k just from
  // renaming the agent on the web UI. Mirrors the idempotency check in
  // `mintTestnetUsdcForBuyer` below.
  //
  // The check is best-effort — a `balanceOf` failure (RPC blip, contract
  // not deployed on a fork) falls through to "mint anyway" so first-run
  // onboarding still gets its USDC. Net cost of a false-positive top-up
  // is 1,000 test USDC on testnet only.
  let shouldMint = true;
  try {
    const usdc = new ethers.Contract(
      networkConfig.contracts.usdc,
      ['function balanceOf(address) view returns (uint256)'],
      provider,
    );
    const bal: bigint = await usdc.balanceOf(smartWalletAddress);
    if (bal > 0n) {
      shouldMint = false;
      output.info(
        `Skipping test-USDC mint — wallet already holds ${ethers.formatUnits(bal, 6)} USDC.`
      );
    }
  } catch {
    // Fall through — mint by default.
  }

  const mintCalls = shouldMint
    ? buildTestnetMintBatch(
        networkConfig.contracts.usdc,
        smartWalletAddress,
        '1000000000', // 1000 USDC
      )
    : [];

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

  if (shouldMint) {
    output.success('Minted 1,000 test USDC to Smart Wallet');
  }
  return { txHash: receipt.hash, smartWalletAddress };
}

/**
 * Auto-mint test USDC to a pay-only buyer's Smart Wallet on testnet.
 *
 * Providers receive their 1,000 test USDC as part of on-chain activation. A
 * pure buyer (intent: pay) skips activation (DEC-3) but STILL needs USDC to
 * pay — otherwise the agent links successfully yet can't buy anything. So mint
 * it here via the same gasless, paymaster-sponsored UserOp, without any
 * registration.
 *
 * Idempotent: only mints when the wallet has no USDC, so re-publishing doesn't
 * keep topping up. Best-effort — a failure (no AA infra, paymaster down) warns
 * but never blocks the link.
 */
async function mintTestnetUsdcForBuyer(projectRoot: string, output: Output): Promise<void> {
  try {
    const { resolvePrivateKey } = await import('../../wallet/keystore');
    const privateKey = await resolvePrivateKey(projectRoot, { network: 'testnet' });
    if (!privateKey) return;

    const { getNetwork } = await import('../../config/networks');
    const networkConfig = getNetwork('base-sepolia');
    if (!networkConfig.aa || !networkConfig.contracts.agentRegistry) return;

    const bundlerPrimary = networkConfig.aa.bundlerUrls.coinbase ?? networkConfig.aa.bundlerUrls.pimlico;
    const paymasterPrimary = networkConfig.aa.paymasterUrls.coinbase ?? networkConfig.aa.paymasterUrls.pimlico;
    if (!bundlerPrimary || !paymasterPrimary) {
      output.info('Skipped test-USDC mint (no testnet bundler/paymaster configured).');
      return;
    }
    const bundlerBackup =
      networkConfig.aa.bundlerUrls.coinbase && networkConfig.aa.bundlerUrls.pimlico
        ? networkConfig.aa.bundlerUrls.pimlico
        : undefined;
    const paymasterBackup =
      networkConfig.aa.paymasterUrls.coinbase && networkConfig.aa.paymasterUrls.pimlico
        ? networkConfig.aa.paymasterUrls.pimlico
        : undefined;

    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    const { AutoWalletProvider } = await import('../../wallet/AutoWalletProvider');
    const autoWallet = await AutoWalletProvider.create({
      signer,
      provider,
      chainId: networkConfig.chainId,
      actpKernelAddress: networkConfig.contracts.actpKernel,
      bundler: { primaryUrl: bundlerPrimary, backupUrl: bundlerBackup },
      paymaster: { primaryUrl: paymasterPrimary, backupUrl: paymasterBackup },
    });
    const smartWalletAddress = autoWallet.getAddress();

    // Only mint when empty (first link) so re-publishing doesn't keep topping up.
    const usdc = new ethers.Contract(
      networkConfig.contracts.usdc,
      ['function balanceOf(address) view returns (uint256)'],
      provider,
    );
    const bal: bigint = await usdc.balanceOf(smartWalletAddress);
    if (bal > 0n) {
      output.info(`Test USDC already present (${(Number(bal) / 1e6).toFixed(2)} USDC) — skipping mint.`);
      return;
    }

    const { buildTestnetMintBatch } = await import('../../wallet/aa/TransactionBatcher');
    const mintCalls = buildTestnetMintBatch(
      networkConfig.contracts.usdc,
      smartWalletAddress,
      '1000000000', // 1000 USDC
    );
    const txRequests = mintCalls.map((c) => ({ to: c.target, data: c.data, value: c.value.toString() }));

    output.info('Minting 1,000 test USDC to your Smart Wallet (gasless)...');
    const receipt = await autoWallet.sendBatchTransaction(txRequests);
    if (receipt.success) {
      output.success('Minted 1,000 test USDC to your Smart Wallet.');
    } else {
      output.warning(`Test-USDC mint did not confirm (${receipt.hash}). You can fund the wallet later.`);
    }
  } catch (e) {
    output.warning(
      `Could not auto-mint test USDC: ${(e as Error).message}. The link succeeded — fund the wallet manually if needed.`,
    );
  }
}

// ============================================================================
// Slug Ownership Recovery
// ============================================================================

/**
 * Find the draft adoption code so `actp publish` can adopt the user's own
 * pending web draft instead of auto-renaming to "<slug>-2".
 *
 * Looks first in the published file's frontmatter, then in a sibling owner
 * AGIRAILS.md (the curled onboarding doc), where the code lives under the
 * `agent:` block. Best-effort: any read/parse error returns undefined.
 *
 * @internal Exported for unit tests; not part of the SDK public API.
 */
export function readDraftClaimCode(
  identityContent: string,
  identityPath: string,
): string | undefined {
  const fromFrontmatter = (fm: Record<string, unknown> | undefined): string | undefined => {
    if (!fm) return undefined;
    if (typeof fm.claim_code === 'string' && fm.claim_code) return fm.claim_code;
    const agent = fm.agent as Record<string, unknown> | undefined;
    if (agent && typeof agent.claim_code === 'string' && agent.claim_code) return agent.claim_code;
    return undefined;
  };

  // 1. The file being published (if the onboarding step copied it in).
  try {
    const code = fromFrontmatter(parseAgirailsMd(identityContent).frontmatter as Record<string, unknown>);
    if (code) return code;
  } catch {
    // ignore — fall through to sibling lookup
  }

  // 2. A sibling owner AGIRAILS.md in the same directory (the curled doc).
  try {
    for (const name of ['AGIRAILS.md', 'agirails.md']) {
      const p = resolve(identityPath, '..', name);
      if (existsSync(p)) {
        const code = fromFrontmatter(parseAgirailsMd(readFileSync(p, 'utf-8')).frontmatter as Record<string, unknown>);
        if (code) return code;
      }
    }
  } catch {
    // ignore — best-effort
  }

  return undefined;
}

/**
 * Best-effort lookup of the local EOA signer that would publish this agent.
 * Reads the keystore (testnet network — same one used downstream) without
 * surfacing errors: missing keystore returns undefined so the recovery flow
 * silently falls through to existing auto-rename behavior.
 *
 * @internal Exported for unit tests; not part of the SDK public API.
 */
export async function derivePotentialSigner(projectRoot: string): Promise<string | undefined> {
  try {
    const { resolvePrivateKey } = await import('../../wallet/keystore');
    const pk = await resolvePrivateKey(projectRoot, { network: 'testnet' });
    if (!pk) return undefined;
    return new ethers.Wallet(pk).address;
  } catch {
    return undefined;
  }
}

/**
 * Confirm with the user that we should restore the lost `agent_id` for a
 * slug they already own, then write it back to AGIRAILS.md so subsequent
 * publish steps follow the update path.
 *
 * - TTY: interactive y/N prompt (default Y on Enter)
 * - Non-TTY: throw OWNERSHIP_RECOVERY_REQUIRES_TTY with an actionable
 *   message (CI/agent flows must opt in by adding `agent_id:` to the file)
 *
 * Returns true when recovery succeeded; false when the user declined and
 * the caller should fall back to auto-rename.
 *
 * @internal Exported for unit tests; not part of the SDK public API.
 */
export async function maybeRecoverAgentId(opts: {
  output: Output;
  slug: string;
  ownerAgentId: string;
  resolvedPath: string;
  onRestored: (args: { newContent: string; newConfigHash: string }) => void;
}): Promise<boolean> {
  const { output, slug, ownerAgentId, resolvedPath, onRestored } = opts;

  if (!process.stdin.isTTY) {
    throw new Error(
      `OWNERSHIP_RECOVERY_REQUIRES_TTY: slug "${slug}" is owned by your wallet ` +
        `(agent_id ${ownerAgentId}), but AGIRAILS.md is missing the agent_id field. ` +
        `Add this line to your frontmatter and re-run actp publish:\n` +
        `  agent_id: "${ownerAgentId}"`
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question(
      `Slug "${slug}" is owned by your wallet (agent_id ${ownerAgentId}).\n` +
        `Restore agent_id and update existing agent? [Y/n] `,
      (a) => {
        rl.close();
        resolve(a.trim().toLowerCase());
      }
    );
  });

  if (answer === 'n' || answer === 'no') {
    output.info('Skipped recovery — proceeding with auto-rename.');
    return false;
  }

  // Recover: persist agent_id to disk + recompute hash.
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = parseAgirailsMd(raw);
  const updatedFm = { ...(parsed.frontmatter as Record<string, unknown>), agent_id: ownerAgentId };
  const newContent = serializeAgirailsMd(updatedFm, parsed.body);
  const tmp = resolvedPath + '.tmp';
  writeFileSync(tmp, newContent, 'utf-8');
  renameSync(tmp, resolvedPath);

  const { configHash: newConfigHash } = computeConfigHash(newContent);
  onRestored({ newContent, newConfigHash });
  output.success(`Restored agent_id ${ownerAgentId}. Treating as update.`);
  return true;
}
