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
      if (v4.name && v4.services.length > 0) {
        // Valid identity file found
        identityFilename = mdFile;
        mdConfig = { name: v4.name, network: v4.network, services: v4.services, price: v4.pricing.base };
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
    output.blank();
    output.print('Next steps:');
    if (walletType === 'auto') {
      output.print('  1. Publish config: actp publish');
      output.print('  2. Create a payment: actp pay <provider> <amount>');
      output.print('  3. Check your balance: actp balance');
    } else {
      output.print('  1. Create a payment: actp pay <provider> <amount>');
      output.print('  2. Check your balance: actp balance');
      output.print('  3. List transactions: actp tx list');
    }

    const resolvedIntent = (options.intent || 'earn') as ScaffoldIntent;
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
    const { runTest } = await import('./test');
    await runTest(output);
  }
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
