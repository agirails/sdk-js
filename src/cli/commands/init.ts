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
  isInitialized,
  getActpDir,
  CLIConfig,
  CLIMode,
} from '../utils/config';
import { Output, ExitCode } from '../utils/output';
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
}

async function runInit(options: InitOptions, output: Output, cmd?: Command): Promise<void> {
  const projectRoot = process.cwd();

  // Check if already initialized
  if (isInitialized(projectRoot) && !options.force) {
    throw new Error(
      'ACTP already initialized in this directory.\n' +
        'Use --force to reinitialize.'
    );
  }

  // ── AGIRAILS.md pre-fill ──────────────────────────────────────────────
  const agirailsMdPath = path.join(projectRoot, 'AGIRAILS.md');
  let mdConfig: Record<string, unknown> | null = null;

  if (fs.existsSync(agirailsMdPath)) {
    try {
      const { parseAgirailsMd } = await import('../../config/agirailsmd');
      const parsed = parseAgirailsMd(fs.readFileSync(agirailsMdPath, 'utf-8'));
      mdConfig = parsed.frontmatter;
    } catch {
      output.warning('Found AGIRAILS.md but could not parse it — ignoring');
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

    // capabilities → service (first capability)
    if (!isExplicit('service') && Array.isArray(mdConfig.capabilities) && mdConfig.capabilities.length > 0) {
      options.service = String(mdConfig.capabilities[0]);
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
    if (Array.isArray(mdConfig.capabilities)) lines.push(`  Capabilities: ${mdConfig.capabilities.join(', ')}`);
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
    ...(mdConfig && Array.isArray(mdConfig.capabilities) ? { capabilities: mdConfig.capabilities.map(String) } : {}),
    ...(mdConfig && mdConfig.price != null ? { price: Number(mdConfig.price) } : {}),
    ...(mdConfig && mdConfig.concurrency != null ? { concurrency: Number(mdConfig.concurrency) } : {}),
    ...(mdConfig && mdConfig.payment_mode ? { paymentMode: String(mdConfig.payment_mode) as 'actp' | 'x402' | 'both' } : {}),
    ...(mdConfig && mdConfig.budget != null ? { budget: Number(mdConfig.budget) } : {}),
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
    output.success('Added .actp/ to .gitignore');
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
    output.print('');
    output.print('Tip: Use --scaffold to generate a starter agent.ts');
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

  // TODO: Replace with your actual work
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

    // TODO: Replace with your actual work
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
