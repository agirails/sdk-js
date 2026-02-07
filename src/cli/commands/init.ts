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
import * as readline from 'readline';
import { Command } from 'commander';
import {
  saveConfig,
  addToGitignore,
  isInitialized,
  getActpDir,
  CLIConfig,
  CLIMode,
} from '../utils/config';
import { Output, ExitCode } from '../utils/output';
import { MockStateManager } from '../../runtime/MockStateManager';

// ============================================================================
// Command Definition
// ============================================================================

export function createInitCommand(): Command {
  const cmd = new Command('init')
    .description('Initialize ACTP in the current directory')
    .option('-m, --mode <mode>', 'Operating mode: mock, testnet, mainnet', 'mock')
    .option('-a, --address <address>', 'Your Ethereum address')
    .option('-f, --force', 'Overwrite existing configuration')
    .option('--scaffold', 'Generate a starter agent.ts file')
    .option('--intent <intent>', 'Agent intent: earn, pay, or both (default: earn)')
    .option('--service <name>', 'Service name (default: my-service)')
    .option('--price <usdc>', 'Base price in USDC (default: 1)')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runInit(options, output);
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
  force?: boolean;
  scaffold?: boolean;
  intent?: string;
  service?: string;
  price?: string;
}

async function runInit(options: InitOptions, output: Output): Promise<void> {
  const projectRoot = process.cwd();

  // Check if already initialized
  if (isInitialized(projectRoot) && !options.force) {
    throw new Error(
      'ACTP already initialized in this directory.\n' +
        'Use --force to reinitialize.'
    );
  }

  // Validate mode
  const validModes: CLIMode[] = ['mock', 'testnet', 'mainnet'];
  if (!validModes.includes(options.mode as CLIMode)) {
    throw new Error(
      `Invalid mode: "${options.mode}". Valid modes: ${validModes.join(', ')}`
    );
  }

  const mode = options.mode as CLIMode;

  // Get or generate address
  let address = options.address;
  if (!address) {
    if (mode === 'mock') {
      // Generate a random address for mock mode
      address = '0x' + crypto.randomBytes(20).toString('hex');
      output.info(`Generated mock address: ${address}`);
    } else {
      // Generate a real wallet with encrypted keystore
      const actpDir = getActpDir(projectRoot);
      fs.mkdirSync(actpDir, { recursive: true });
      address = await generateWallet(actpDir, output);
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

  // Add to gitignore
  try {
    addToGitignore(projectRoot);
    output.success('Added .actp/ to .gitignore');
  } catch {
    output.warning('Could not update .gitignore (may not exist)');
  }

  // Output result
  output.blank();
  output.result(
    {
      initialized: true,
      directory: getActpDir(projectRoot),
      mode,
      address,
    },
    { quietKey: 'address' }
  );

  // Generate scaffold if requested
  if (options.scaffold) {
    await runScaffold(options, mode, output);
  } else {
    output.blank();
    output.print('Next steps:');
    output.print('  1. Create a payment: actp pay <provider> <amount>');
    output.print('  2. Check your balance: actp balance');
    output.print('  3. List transactions: actp tx list');
    output.print('');
    output.print('Tip: Use --scaffold to generate a starter agent.ts');
  }
}

// ============================================================================
// Wallet Generation
// ============================================================================

async function generateWallet(actpDir: string, output: Output): Promise<string> {
  const { Wallet } = await import('ethers');

  const wallet = Wallet.createRandom();

  // Get password from env var or interactive prompt
  let password = process.env.ACTP_KEY_PASSWORD;
  if (!password) {
    password = await promptPassword();
  }

  if (!password || password.length < 8) {
    throw new Error(
      'Wallet password required (minimum 8 characters).\n' +
        'Set ACTP_KEY_PASSWORD env var or enter when prompted.'
    );
  }

  // Encrypt with Keystore V3 (scrypt + AES-128-CTR)
  output.info('Encrypting wallet (this takes a few seconds)...');
  const keystore = await wallet.encrypt(password);

  // Save with restrictive permissions
  const keystorePath = path.join(actpDir, 'keystore.json');
  fs.writeFileSync(keystorePath, keystore, { mode: 0o600 });

  output.success('Key securely saved and encrypted');
  output.info(`Address: ${wallet.address}`);
  output.warning('Back up your password — it cannot be recovered.');
  output.info('');
  output.info('To start your agent:');
  output.info('  export ACTP_KEY_PASSWORD="your-password"');
  output.info('  npx ts-node agent.ts');

  return wallet.address;
}

async function promptPassword(): Promise<string> {
  // If not a TTY (e.g. piped or run by agent), skip prompt
  if (!process.stdin.isTTY) {
    return '';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Enter password for wallet encryption (min 8 chars): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// Scaffold
// ============================================================================

async function runScaffold(
  options: InitOptions,
  mode: CLIMode,
  output: Output,
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

  // Derive agent name from directory
  const agentName = path.basename(process.cwd());

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
        module: 'ES2022',
        moduleResolution: 'bundler',
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

  // Check package.json for type: module
  const pkgFile = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
      if (pkg.type !== 'module') {
        output.warning(
          'package.json has type: "' + (pkg.type || 'commonjs') + '". ' +
          'Set "type": "module" for ESM support, or run with: npx ts-node --esm agent.ts'
        );
      }
    } catch { /* ignore parse errors */ }
  }

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
