/**
 * Init Command - Initialize ACTP in the current directory
 *
 * Creates .actp/ directory with configuration and initial state.
 * Supports interactive and non-interactive modes.
 *
 * @module cli/commands/init
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
  saveConfig,
  addToGitignore,
  addToDockerignore,
  addToRailwayignore,
  writeEnvExample,
  isInitialized,
  getActpDir,
  CLIConfig,
  CLIMode,
} from '../utils/config';
import { Output, ExitCode, fmt } from '../utils/output';
import { generateWallet, computeSmartWalletInit } from '../utils/wallet';
import { MockStateManager } from '../../runtime/MockStateManager';
import { generateSlug } from '../../config/slugUtils';

// ============================================================================
// FIX-3: ACTP_KEY_PASSWORD auto-generation
// ============================================================================

/**
 * Source of the resolved ACTP_KEY_PASSWORD.
 *  - `env`: already in `process.env.ACTP_KEY_PASSWORD` before this ran.
 *  - `dotenv`: read from `<dir>/.env`.
 *  - `generated`: newly minted by `generateStrongPassword()`.
 */
export type KeyPasswordSource = 'env' | 'dotenv' | 'generated';

/**
 * Result of `ensureKeyPassword`.
 *
 * `envFilePath` is present whenever the helper looked at or wrote to a `.env`
 * file on disk; it is `undefined` when the password was taken from
 * `process.env` (no disk touch).
 */
export interface EnsureKeyPasswordResult {
  source: KeyPasswordSource;
  wroteToDisk: boolean;
  fingerprint: string;
  envFilePath?: string;
}

/**
 * Generate a 32-character password from the base64 alphabet (`A-Za-z0-9+/`).
 *
 * 24 random bytes encode to exactly 32 base64 chars with no `=` padding
 * (since 24 % 3 === 0), which keeps the alphabet test happy.
 */
export function generateStrongPassword(): string {
  return crypto.randomBytes(24).toString('base64');
}

/**
 * Deterministic short fingerprint of a password: first 12 hex chars of SHA-256.
 * Safe to log — it does NOT reveal the password.
 */
export function fingerprintPassword(password: string): string {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Read the value of `ACTP_KEY_PASSWORD` from a `.env` file.
 *
 * Returns `undefined` if the file does not exist, the key is missing, or
 * the value is empty. Strips surrounding single or double quotes.
 * Comment lines (starting with `#`) are skipped.
 */
export function readKeyPasswordFromDotenv(envPath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      return undefined;
    }
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^ACTP_KEY_PASSWORD\s*=\s*(.*)$/.exec(trimmed);
    if (match) {
      let value = match[1].trim();
      // Strip surrounding matched quotes (double or single).
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Append `.env` to the project's `.gitignore`, creating the file if missing
 * and avoiding duplicate lines.
 *
 * Best-effort: failures are swallowed (returns `false`).
 */
function appendDotenvToGitignore(gitignorePath: string): boolean {
  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return false;
    content = '';
  }
  // Already present? bail.
  if (/^\.env$/m.test(content)) return true;
  if (content.length > 0 && !content.endsWith('\n')) content += '\n';
  content += '.env\n';
  try {
    fs.writeFileSync(gitignorePath, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `ACTP_KEY_PASSWORD=<password>` to the .env file (appending if the
 * file already exists, creating it otherwise) and chmod it to 0o600.
 *
 * Returns `true` on success, `false` if any filesystem op fails — callers
 * should still set `process.env.ACTP_KEY_PASSWORD` in memory so the rest of
 * the init flow can proceed.
 */
function writeKeyPasswordToDotenv(envPath: string, password: string): boolean {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return false;
    content = '';
  }
  // If the key already exists, do not overwrite — caller decides what to do.
  if (/^ACTP_KEY_PASSWORD\s*=/m.test(content)) return true;
  if (content.length > 0 && !content.endsWith('\n')) content += '\n';
  content += `ACTP_KEY_PASSWORD=${password}\n`;
  try {
    fs.writeFileSync(envPath, content, { mode: 0o600 });
  } catch {
    return false;
  }
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    /* best-effort on platforms that don't honour POSIX modes */
  }
  return true;
}

/**
 * Ensure that `process.env.ACTP_KEY_PASSWORD` is set before keystore
 * generation runs.
 *
 * Resolution order:
 *  1. If `process.env.ACTP_KEY_PASSWORD` is already a non-empty string, use it.
 *  2. Otherwise, read from `<dir>/.env`.
 *  3. Otherwise, generate a fresh 32-char password, persist it to
 *     `<dir>/.env` (chmod 0o600), and add `.env` to `<dir>/.gitignore`.
 *
 * Only the *fingerprint* is ever written to `output`; the raw password is
 * never logged.
 */
export function ensureKeyPassword(dir: string, output: Output): EnsureKeyPasswordResult {
  // 1. process.env already populated → take it.
  const fromEnv = process.env.ACTP_KEY_PASSWORD;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return {
      source: 'env',
      wroteToDisk: false,
      fingerprint: fingerprintPassword(fromEnv),
    };
  }

  const envPath = path.join(dir, '.env');
  const gitignorePath = path.join(dir, '.gitignore');

  // 2. Try .env.
  const fromDotenv = readKeyPasswordFromDotenv(envPath);
  if (fromDotenv) {
    process.env.ACTP_KEY_PASSWORD = fromDotenv;
    const fingerprint = fingerprintPassword(fromDotenv);
    output.print('');
    output.print(`Loaded ACTP_KEY_PASSWORD from .env (fingerprint: ${fingerprint})`);
    return {
      source: 'dotenv',
      wroteToDisk: false,
      fingerprint,
      envFilePath: envPath,
    };
  }

  // 3. Generate.
  const password = generateStrongPassword();
  const wroteToDisk = writeKeyPasswordToDotenv(envPath, password);
  appendDotenvToGitignore(gitignorePath);
  process.env.ACTP_KEY_PASSWORD = password;
  const fingerprint = fingerprintPassword(password);

  output.print('');
  if (wroteToDisk) {
    output.print('Auto-generated ACTP_KEY_PASSWORD (32 random chars) and wrote it to .env.');
  } else {
    output.warning(
      `Could not write .env at ${envPath} — auto-generated ACTP_KEY_PASSWORD kept in process.env only.`,
    );
  }
  output.print(`Fingerprint (SHA-256 first 12 hex): ${fingerprint}`);
  output.print('Back this up — you need it to decrypt your keystore.');

  return {
    source: 'generated',
    wroteToDisk,
    fingerprint,
    envFilePath: envPath,
  };
}

// ============================================================================
// Command Definition
// ============================================================================

export function createInitCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize ACTP in the current directory')
    .option('-m, --mode <mode>', 'Operating mode: mock, testnet, mainnet', 'mock')
    .option('-a, --address <address>', 'Your Ethereum address')
    .option('-w, --wallet <type>', 'Wallet type: auto (gas-free Smart Wallet) or eoa (traditional)', 'auto')
    .option('-f, --force', 'Overwrite existing configuration')
    .option('--scaffold', 'Generate a starter agent.ts file')
    .option('--intent <intent>', 'Agent intent: earn, pay, or both (default: earn)')
    .option('--service <name>', 'Service name (default: my-service)')
    .option('--price <usdc>', 'Base price in USDC (default: 1)')
    .option('--test', 'After init, automatically run a test transaction (no prompt)')
    .option('--no-test', 'Skip the post-init "Run test?" prompt')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options, command) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runInit(options, output, command);
      } catch (error) {
        output.errorResult({
          code: 'INIT_FAILED',
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

type ScaffoldIntent = 'earn' | 'pay' | 'both';

interface InitOptions {
  mode: string;
  address?: string;
  wallet?: string;
  force?: boolean;
  scaffold?: boolean;
  intent?: string;
  service?: string;
  price?: string;
  /** true = auto-run test after init; false = skip prompt; undefined = interactive */
  test?: boolean;
}

async function runInit(options: InitOptions, output: Output, cmd?: Command): Promise<void> {
  const projectRoot = process.cwd();

  // Render banner (human mode only — hidden in --json / --quiet)
  if (output.mode === 'human') {
    const { renderBanner } = await import('../utils/banner');
    output.print('');
    output.print(renderBanner());
    output.print('');
  }

  // Check if already initialized
  if (isInitialized(projectRoot) && !options.force) {
    throw new Error(
      'ACTP already initialized in this directory.\n' +
        'Use --force to reinitialize.'
    );
  }

  // ── {slug}.md pre-fill (Phase 1: identity file takes priority) ──────
  let identityFilename: string | undefined;
  let mdConfig: Record<string, unknown> | null = null;

  // 1. Check for existing {slug}.md files in project root (*.md, skip AGIRAILS.md/README.md/CHANGELOG.md)
  const mdFiles = fs.readdirSync(projectRoot).filter(
    f => f.endsWith('.md') && !['AGIRAILS.md', 'README.md', 'CHANGELOG.md', 'SCRATCHPAD.md'].includes(f)
  );

  for (const mdFile of mdFiles) {
    try {
      const { parseAgirailsMdV4 } = await import('../../config/agirailsmdV4');
      const content = fs.readFileSync(path.join(projectRoot, mdFile), 'utf-8');
      const v4 = parseAgirailsMdV4(content);
      // A provider file has services; a pure buyer (AIP-18 intent: pay) has
      // none — it is identified by servicesNeeded instead. Accept both so a
      // pay-only {slug}.md isn't silently ignored at init.
      const isBuyerFile = v4.intent === 'pay' && v4.servicesNeeded.length > 0;
      if (v4.name && (v4.services.length > 0 || isBuyerFile)) {
        // Valid identity file found
        identityFilename = mdFile;
        mdConfig = isBuyerFile
          ? { name: v4.name, network: v4.network, intent: 'pay', servicesNeeded: v4.servicesNeeded }
          : { name: v4.name, network: v4.network, services: v4.services, price: v4.pricing.base };
        output.info(`Found identity file: ${mdFile}`);
        break;
      }
    } catch {
      // Not a valid v4 identity file — skip
    }
  }

  // 2. Fallback: check AGIRAILS.md (v3 onboarding manual)
  if (!mdConfig) {
    const agirailsMdPath = path.join(projectRoot, 'AGIRAILS.md');
    if (fs.existsSync(agirailsMdPath)) {
      try {
        const { parseAgirailsMd } = await import('../../config/agirailsmd');
        const parsed = parseAgirailsMd(fs.readFileSync(agirailsMdPath, 'utf-8'));
        mdConfig = parsed.frontmatter;
      } catch {
        output.warning('Found AGIRAILS.md but could not parse it — ignoring');
      }
    }
  }

  // Helper: true when the user explicitly passed a flag on the CLI
  const isExplicit = (flag: string): boolean =>
    cmd?.getOptionValueSource(flag) === 'cli';

  // Apply AGIRAILS.md values where the user didn't set an explicit flag
  if (mdConfig) {
    // network → mode mapping
    if (!isExplicit('mode') && mdConfig.network) {
      const net = String(mdConfig.network);
      if (net === 'base-sepolia' || net === 'testnet') options.mode = 'testnet';
      else if (net === 'base-mainnet' || net === 'mainnet') options.mode = 'mainnet';
      else if (net === 'mock') options.mode = 'mock';
    }

    // intent
    if (!isExplicit('intent') && mdConfig.intent) {
      options.intent = String(mdConfig.intent);
    }

    // capabilities/services → service (first entry).
    // Services can be either plain strings (legacy) or {type, ...} objects
    // (canonical, V4) — coerce both to plain string capability names.
    const toCapName = (entry: unknown): string => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        return String(obj.type ?? obj.service_type ?? '');
      }
      return '';
    };
    const caps = mdConfig.capabilities || mdConfig.services;
    if (!isExplicit('service') && Array.isArray(caps) && caps.length > 0) {
      const first = toCapName(caps[0]);
      if (first) options.service = first;
    }

    // price
    if (!isExplicit('price') && mdConfig.price != null) {
      options.price = String(mdConfig.price);
    }

    // Log what we pre-filled
    const lines: string[] = [];
    if (mdConfig.network) lines.push(`  Mode: ${options.mode}`);
    if (mdConfig.name) lines.push(`  Agent: ${String(mdConfig.name)}`);
    if (mdConfig.intent) lines.push(`  Intent: ${options.intent || mdConfig.intent}`);
    const logCaps = mdConfig.capabilities || mdConfig.services;
    if (Array.isArray(logCaps)) {
      lines.push(`  Capabilities: ${logCaps.map(toCapName).filter(Boolean).join(', ')}`);
    }
    if (mdConfig.price != null) lines.push(`  Price: $${mdConfig.price} USDC`);

    output.info('Found AGIRAILS.md \u2014 using config from file');
    for (const line of lines) {
      output.print(line);
    }
    output.blank();
  }
  // ── End AGIRAILS.md pre-fill ──────────────────────────────────────────

  // Validate mode
  const validModes: CLIMode[] = ['mock', 'testnet', 'mainnet'];
  if (!validModes.includes(options.mode as CLIMode)) {
    throw new Error(
      `Invalid mode: "${options.mode}". Valid modes: ${validModes.join(', ')}`
    );
  }

  const mode = options.mode as CLIMode;

  // Determine wallet type
  const walletType = (mode === 'mock') ? 'mock' : (options.wallet || 'auto');
  if (walletType !== 'mock' && walletType !== 'auto' && walletType !== 'eoa') {
    throw new Error(
      `Invalid wallet type: "${walletType}". Valid types: auto, eoa`
    );
  }

  // Get or generate address
  let address = options.address;
  let smartWalletAddress: string | undefined;
  if (!address) {
    if (mode === 'mock') {
      // Generate a random address for mock mode
      address = '0x' + crypto.randomBytes(20).toString('hex');
      output.info(`Generated mock address: ${address}`);
    } else {
      // FIX-3: ensure ACTP_KEY_PASSWORD is set BEFORE we mint the keystore.
      // Resolution order is env → .env → generate-and-persist.
      ensureKeyPassword(projectRoot, output);

      // Generate a real wallet with encrypted keystore
      const actpDir = getActpDir(projectRoot);
      fs.mkdirSync(actpDir, { recursive: true });
      const eoaAddress = await generateWallet(actpDir, output);

      if (walletType === 'auto') {
        // Compute Smart Wallet address from signer
        smartWalletAddress = await computeSmartWalletInit(eoaAddress, mode, output);
        address = smartWalletAddress;

        output.info('');
        output.info('Gas-free transactions enabled (activates on first payment)');
        output.info('Next: run "actp publish" to publish your agent config');
      } else {
        address = eoaAddress;
      }
    }
  }

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(
      `Invalid address format: "${address}"\n` +
        'Expected 0x-prefixed 40-character hex string.'
    );
  }

  // AIP-18 DEC-4: scaffold a minimal pay-only {slug}.md when the user
  // initialized with `--intent pay` and no identity file already exists.
  // Without it `actp publish` bails ("No file to publish") and the buyer
  // never gets the gas-sponsorship buyer-link marker (DEC-8) → falls back
  // to EOA → needs ETH → defeats the entire point of pay-only onboarding.
  // Skipped for mock mode (no real wallet, no buyer-link semantics) and
  // when an identity file was already discovered in scanning above.
  const resolvedIntentForId =
    (options.intent || (mdConfig?.intent as string | undefined) || 'earn');
  if (
    resolvedIntentForId === 'pay' &&
    !identityFilename &&
    mode !== 'mock'
  ) {
    try {
      const agentName =
        (mdConfig?.name ? String(mdConfig.name) : null) ||
        path.basename(projectRoot);
      identityFilename = generateBuyerIdentityFile({
        projectRoot,
        name: agentName,
        walletAddress: address,
        mode,
        output,
      });
    } catch (e) {
      // Best-effort. The user can still run `actp publish <path>` manually
      // with a hand-written file; we don't want init to fail because of a
      // scaffold write error (e.g. read-only fs).
      output.warning(
        `Could not generate buyer identity file: ${(e as Error).message}`
      );
    }
  }

  // Create configuration
  const config: CLIConfig = {
    mode,
    address: address.toLowerCase(),
    version: '1.0',
    ...(walletType !== 'mock' && { wallet: walletType as 'auto' | 'eoa' }),
    ...(smartWalletAddress && { smartWallet: smartWalletAddress.toLowerCase() }),
    // AGIRAILS.md-derived values (stored for downstream use)
    ...(mdConfig && mdConfig.name ? { agentName: String(mdConfig.name) } : {}),
    ...(mdConfig && mdConfig.intent ? { intent: String(mdConfig.intent) as 'earn' | 'pay' | 'both' } : {}),
    ...(mdConfig && Array.isArray(mdConfig.capabilities ?? mdConfig.services)
      ? {
          capabilities: ((mdConfig.capabilities ?? mdConfig.services) as unknown[])
            .map((e) =>
              typeof e === 'string'
                ? e
                : String((e as Record<string, unknown>)?.type ?? (e as Record<string, unknown>)?.service_type ?? '')
            )
            .filter(Boolean),
        }
      : {}),
    ...(mdConfig && mdConfig.price != null ? { price: Number(mdConfig.price) } : {}),
    ...(mdConfig && mdConfig.concurrency != null ? { concurrency: Number(mdConfig.concurrency) } : {}),
    ...(mdConfig && mdConfig.payment_mode ? { paymentMode: String(mdConfig.payment_mode) as 'actp' | 'x402' | 'both' } : {}),
    ...(mdConfig && mdConfig.budget != null ? { budget: Number(mdConfig.budget) } : {}),
    // Phase 1: identity pointer to {slug}.md
    ...(identityFilename ? { identity: identityFilename } : {}),
  };

  // Save configuration
  saveConfig(config, projectRoot);
  output.success('Configuration saved');

  // Initialize mock state if in mock mode
  if (mode === 'mock') {
    const stateManager = new MockStateManager(projectRoot);
    if (!stateManager.exists() || options.force) {
      stateManager.reset();
      output.success('Mock state initialized');
    }

    // Mint initial tokens for the address
    const { MockRuntime } = await import('../../runtime/MockRuntime');
    const runtime = new MockRuntime(stateManager);
    await runtime.mintTokens(address.toLowerCase(), '10000000000'); // 10,000 USDC
    output.info('Minted 10,000 USDC to your address');
  }

  // Add to ignore files (AIP-13: gitignore + dockerignore + railwayignore)
  try {
    addToGitignore(projectRoot);
    output.success('Added .actp/ + .env patterns to .gitignore');
  } catch {
    output.warning('Could not update .gitignore (may not exist)');
  }
  try {
    addToDockerignore(projectRoot);
    output.success('Added .actp/ to .dockerignore');
  } catch {
    output.warning('Could not update .dockerignore');
  }
  try {
    addToRailwayignore(projectRoot);
    output.success('Added .actp/ to .railwayignore');
  } catch {
    output.warning('Could not update .railwayignore');
  }
  // Apex audit FIND-012(b): document the secrets schema in a committed
  // `.env.example` so downstream consumers have a starting point that
  // never contains live keys.
  try {
    writeEnvExample(projectRoot);
    output.success('Wrote .env.example (secrets schema)');
  } catch {
    output.warning('Could not write .env.example (may already exist as symlink)');
  }

  // Output result
  output.blank();
  output.result(
    {
      initialized: true,
      directory: getActpDir(projectRoot),
      mode,
      address,
      ...(walletType !== 'mock' && { wallet: walletType }),
    },
    { quietKey: 'address' }
  );

  // Generate scaffold if requested
  if (options.scaffold) {
    await runScaffold(options, mode, output, mdConfig);
  } else {
    const resolvedIntent = (options.intent || 'earn') as ScaffoldIntent;
    output.blank();
    output.print('Next steps:');
    if (walletType === 'auto') {
      if (resolvedIntent === 'pay') {
        // AIP-18 DEC-3: a buyer LINKS (no on-chain publish). `actp publish`
        // is still the single command — it branches to a link for pay-only.
        // budget never leaves the local config.
        output.print('  1. Link your buyer profile: actp publish   (budget stays local & private)');
        output.print('  2. Discover providers: actp find <capability>');
        output.print('  3. Pay a provider: actp pay <provider> <amount>');
      } else {
        output.print('  1. Publish config: actp publish');
        output.print('  2. Create a payment: actp pay <provider> <amount>');
        output.print('  3. Check your balance: actp balance');
      }
    } else {
      output.print('  1. Create a payment: actp pay <provider> <amount>');
      output.print('  2. Check your balance: actp balance');
      output.print('  3. List transactions: actp tx list');
    }

    if (resolvedIntent === 'earn' || resolvedIntent === 'both') {
      output.print('');
      output.print('  Receive x402 payments (Express):');
      output.print("    import { buildX402Server } from '@agirails/sdk/server';");
      output.print("    import { paymentMiddleware } from '@x402/express';");
      output.print('    const { httpServer, routes } = await buildX402Server({');
      output.print(`      payTo: '${address}',`);
      output.print(`      network: '${mode === 'testnet' ? 'eip155:84532' : mode === 'mainnet' ? 'eip155:8453' : 'eip155:84532'}',`);
      output.print("      routes: [{ route: 'GET /api/hello', price: '$0.01' }],");
      output.print('    });');
      output.print('    app.use(paymentMiddleware(routes, httpServer));');
    }

    output.print('');
    output.print('Tip: Use --scaffold to generate a starter agent.ts');
  }

  // Post-init handoff — offer to run a test transaction
  await offerPostInitTest(options, output);
}

/**
 * After a successful init, offer to run a test transaction.
 *
 * Behavior:
 *   --test          → auto-run without prompting
 *   --no-test       → skip entirely
 *   (no flag, TTY)  → interactive prompt
 *   (no flag, non-TTY) → skip (CI / piped)
 *
 * Requires an identity file to exist (otherwise runTest would fail).
 */
async function offerPostInitTest(options: InitOptions, output: Output): Promise<void> {
  if (output.mode !== 'human') return; // never in json / quiet
  if (options.test === false) return; // --no-test flag

  // Check identity file exists — runTest needs it
  const { resolveIdentityPath } = await import('../utils/config');
  const identity = resolveIdentityPath();
  if (!identity) {
    // No identity file — test flow needs one. Show hint instead of silent skip.
    output.print('');
    output.print('Want to see your agent earn its first payment?');
    output.print(`  Create a ${fmt.bold('{slug}.md')} identity file, then run: ${fmt.cyan('actp test')}`);
    output.print(`  Or let an AI assistant generate one: ${fmt.cyan('curl -sLO https://www.agirails.app/protocol/AGIRAILS.md')}`);
    return;
  }

  let shouldRun = false;

  if (options.test === true) {
    // --test flag: auto-run
    shouldRun = true;
  } else if (process.stdout.isTTY) {
    // Interactive prompt
    const readline = await import('readline');
    output.print('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('Your agent is ready. Run a test transaction now? (Y/n): ', resolve);
    });
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    shouldRun = trimmed === '' || trimmed === 'y' || trimmed === 'yes';
  }

  if (shouldRun) {
    // AIP-18 DEC-3/DEC-4/DEC-8: a fresh pay-only init wrote a {slug}.md but
    // has NOT yet linked the buyer or minted test USDC. Running test
    // straight away would hit the EOA fallback (no buyer-link.json) and
    // fail with INSUFFICIENT_FUNDS. Auto-chain publish first so the
    // buyer-link gate fires and 1k test USDC is minted, then run the test.
    // This makes `actp init --mode testnet --intent pay --test` a single
    // end-to-end command that ends in a settled escrow.
    try {
      const { resolveIdentityPath: resolveIdentity } = await import('../utils/config');
      const identityPath = resolveIdentity();
      if (identityPath) {
        const { parseAgirailsMdV4 } = await import('../../config/agirailsmdV4');
        const v4 = parseAgirailsMdV4(fs.readFileSync(identityPath, 'utf-8'));
        if (v4.intent === 'pay') {
          const { runPublish } = await import('./publish');
          output.print('');
          output.print('→ Linking buyer profile (skips registry, mints 1k test USDC if needed)…');
          await runPublish('', {}, output);
        }
      }
    } catch (e) {
      // Publish errors here are non-fatal — the test may still succeed if
      // the buyer is already linked from a prior run, and printing a stack
      // trace would mask the real problem. Surface a brief warning and
      // proceed to runTest, which has its own error reporting.
      output.warning(
        `Pre-test publish step failed: ${(e as Error).message}. Continuing to test…`
      );
    }

    const { runTest } = await import('./test');
    await runTest(output);
  }
}

// ============================================================================
// AIP-18: Pay-only buyer identity file generation
// ============================================================================

/**
 * Input for generateBuyerIdentityFile().
 *
 * - `projectRoot`: cwd of the init invocation; the file is written here.
 * - `name`: human-readable agent name; defaults to project basename.
 * - `walletAddress`: Smart Wallet address (auto wallet) or EOA address;
 *   recorded as `wallet:` so the publish link goes to the right address.
 * - `mode`: testnet/mainnet — written to the `network:` field.
 * - `output`: for logging the write.
 */
interface BuyerIdentityFileInput {
  projectRoot: string;
  name: string;
  walletAddress: string;
  mode: Exclude<CLIMode, 'mock'>;
  output: Output;
}

/**
 * AIP-18 DEC-4: `actp init --intent pay` writes a private buyer identity
 * file so the downstream `actp publish` flow has an input to read.
 *
 * Without this file `resolveIdentityPath()` returns null → `actp publish`
 * bails with "No file to publish" → the buyer-link.json marker is never
 * written → ACTPClient's auto-wallet gate falls back to the EOA path →
 * the buyer needs ETH to send a transaction (defeats DEC-8 gasless).
 *
 * The generated file is the minimal valid V4 schema for a pay-only agent:
 * `name`, `intent: pay`, and a non-empty `servicesNeeded` (mandated by the
 * parser at agirailsmdV4.ts:180). Default `servicesNeeded = ['onboarding']`
 * matches the deployed Sentinel agent so `actp test` works out-of-box.
 *
 * `budget` lives in the file but is stripped from any hash that leaves
 * the machine via `PUBLISH_METADATA_KEYS` in the publish proxy; the
 * publish flow's pay-only branch also short-circuits before any upload.
 * So the file is local-and-private even though committable.
 *
 * Returns the basename of the generated file, suitable for storing in
 * `.actp/config.json` as the `identity:` pointer.
 */
export function generateBuyerIdentityFile(input: BuyerIdentityFileInput): string {
  const { projectRoot, name, walletAddress, mode, output } = input;

  const slug = generateSlug(name) || 'buyer';
  const filename = `${slug}.md`;
  const filePath = path.join(projectRoot, filename);

  // Don't clobber an existing identity file. The caller (runInit) already
  // gates this on `!identityFilename`, but a defensive check here avoids
  // a race window if a file was created between resolveIdentityPath and
  // this write.
  if (fs.existsSync(filePath)) {
    return filename;
  }

  const networkField = mode === 'testnet' ? 'testnet' : 'mainnet';
  const content = `---
name: ${name}
slug: ${slug}
intent: pay
servicesNeeded:
  - onboarding
network: ${networkField}
budget: 10
wallet: "${walletAddress.toLowerCase()}"
---

# ${name}

Pay-only buyer agent. Discovers and requests services from providers on the AGIRAILS network.

## Budget

Default budget per request: 10 USDC. Edit \`budget:\` above to change.

## What this buyer needs

Edit \`servicesNeeded:\` above to list the capabilities you want to purchase.
The default \`onboarding\` matches the deployed Sentinel agent — running
\`actp test\` from this directory will buy a sample reflection from Sentinel
on Base Sepolia.

## Privacy

\`budget\` stays on disk. The publish flow strips it from any artifact that
leaves the machine (publish proxy hashing skips it, on-chain registration
is skipped entirely for pay-only). You can safely commit this file; only
the wallet address and slug become public on agirails.app.
`;

  // Atomic write — rename keeps fs in a consistent state under interrupt.
  const tempFile = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempFile, content, 'utf-8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
    throw error;
  }

  output.success(`Generated buyer identity: ${filename}`);
  return filename;
}

// ============================================================================
// Scaffold
// ============================================================================

async function runScaffold(
  options: InitOptions,
  mode: CLIMode,
  output: Output,
  mdConfig?: Record<string, unknown> | null,
): Promise<void> {
  const validIntents: ScaffoldIntent[] = ['earn', 'pay', 'both'];
  const intent: ScaffoldIntent = (options.intent as ScaffoldIntent) || 'earn';

  if (!validIntents.includes(intent)) {
    throw new Error(
      `Invalid intent: "${options.intent}". Valid intents: ${validIntents.join(', ')}`
    );
  }

  const service = options.service || 'my-service';
  const price = options.price || '1';
  const agentFile = path.join(process.cwd(), 'agent.ts');

  // Check if file already exists
  if (fs.existsSync(agentFile) && !options.force) {
    output.warning('agent.ts already exists. Use --force to overwrite.');
    return;
  }

  // Derive agent name: prefer AGIRAILS.md name, fallback to directory name
  const agentName = (mdConfig?.name ? String(mdConfig.name) : null) || path.basename(process.cwd());

  // Get template and substitute variables
  const template = getTemplate(intent);
  const content = template
    .replace(/\{\{service\}\}/g, service)
    .replace(/\{\{mode\}\}/g, mode)
    .replace(/\{\{price\}\}/g, price)
    .replace(/\{\{name\}\}/g, agentName);

  // Atomic write
  const tempFile = `${agentFile}.tmp`;
  try {
    fs.writeFileSync(tempFile, content, 'utf-8');
    fs.renameSync(tempFile, agentFile);
  } catch (error) {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
    throw error;
  }

  output.success(`Generated agent.ts (intent: ${intent})`);

  // Generate tsconfig.json if it doesn't exist
  const tsconfigFile = path.join(process.cwd(), 'tsconfig.json');
  if (!fs.existsSync(tsconfigFile)) {
    const tsconfigContent = JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        strict: true,
        outDir: 'dist',
        skipLibCheck: true,
      },
      include: ['*.ts'],
    }, null, 2);

    const tsconfigTemp = `${tsconfigFile}.tmp`;
    try {
      fs.writeFileSync(tsconfigTemp, tsconfigContent, 'utf-8');
      fs.renameSync(tsconfigTemp, tsconfigFile);
      output.success('Generated tsconfig.json');
    } catch {
      output.warning('Could not generate tsconfig.json');
    }
  }

  // Note: @agirails/sdk is CJS — no type:module check needed

  output.blank();
  output.print('Next steps:');
  output.print('  1. Edit agent.ts with your logic');
  output.print('  2. Run: npx ts-node --esm agent.ts');
  output.print('  3. Check balance: actp balance');
}

function getTemplate(intent: ScaffoldIntent): string {
  switch (intent) {
    case 'earn':
      return TEMPLATE_EARN;
    case 'pay':
      return TEMPLATE_PAY;
    case 'both':
      return TEMPLATE_BOTH;
  }
}

// ============================================================================
// Templates
// ============================================================================

const TEMPLATE_EARN = `import { provide } from '@agirails/sdk';

const provider = provide('{{service}}', async (job) => {
  console.log(\`Job received: \${job.id} (\${job.budget} USDC)\`);

  // Replace with your actual work
  const result = await processJob(job.input);

  return result;
}, {
  network: '{{mode}}',
  filter: { minBudget: {{price}} },
});

async function processJob(input: any): Promise<any> {
  // Your logic here
  return { status: 'completed', output: input };
}

console.log(\`Provider listening for '{{service}}' jobs...\`);
`;

const TEMPLATE_PAY = `import { request } from '@agirails/sdk';

async function main() {
  const { result, transaction } = await request('{{service}}', {
    provider: '0xPROVIDER_ADDRESS', // replace with the provider's address
    input: { /* your data here */ },
    budget: {{price}},
    network: '{{mode}}',
  });

  console.log('Result:', result);
  console.log('Transaction:', transaction.id);
  console.log('Fee:', transaction.fee, 'USDC');
}

main().catch(console.error);
`;

const TEMPLATE_BOTH = `import { Agent } from '@agirails/sdk';

async function main() {
  const agent = new Agent({
    name: '{{name}}',
    network: '{{mode}}',
    behavior: {
      autoAccept: true,
      concurrency: 10,
    },
  });

  // Provide a service
  agent.provide('{{service}}', async (job, ctx) => {
    ctx.progress(50, 'Working...');

    // Replace with your actual work
    return { status: 'completed', output: job.input };
  });

  agent.on('payment:received', (data) => {
    console.log(\`Earned \${data.amount} USDC\`);
  });

  await agent.start();
  console.log(\`Agent '{{name}}' running on {{mode}}\`);
}

main().catch(console.error);
`;

export { runInit };
