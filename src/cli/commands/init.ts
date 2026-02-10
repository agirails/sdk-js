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
  let didRegister = false;
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

        // Y/N: Register for gas-free transactions?
        const shouldRegister = await promptRegister(output);
        if (shouldRegister) {
          didRegister = await runInlineRegistration(projectRoot, mode, output);
        }

        // address = Smart Wallet if registered, EOA if not
        // This ensures CLI commands (balance, tx list) show the correct address
        address = didRegister ? smartWalletAddress : eoaAddress;
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
    ...(didRegister && { registered: true }),
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
    if (walletType === 'auto' && didRegister) {
      // Already registered — ready to go
      output.print('  1. Create a payment: actp pay <provider> <amount>');
      output.print('  2. Check your balance: actp balance');
      output.print('  3. List transactions: actp tx list');
    } else if (walletType === 'auto') {
      // Skipped registration — remind them
      output.print('  1. Register for gas-free: actp register');
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

/**
 * Compute the Smart Wallet address for an EOA signer.
 * Uses CREATE2 counterfactual derivation — no deployment needed.
 */
async function computeSmartWalletInit(
  eoaAddress: string,
  mode: string,
  output: Output
): Promise<string> {
  const { ethers } = await import('ethers');
  const { getNetwork } = await import('../../config/networks');
  const { computeSmartWalletAddress } = await import('../../wallet/aa/UserOpBuilder');

  const network = mode === 'testnet' ? 'base-sepolia' : 'base-mainnet';
  const networkConfig = getNetwork(network);
  const rpcUrl = networkConfig.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  output.info('Computing Smart Wallet address...');
  const smartWalletAddress = await computeSmartWalletAddress(eoaAddress, provider);

  output.success(`Smart Wallet: ${smartWalletAddress}`);
  output.info('Gas-free transactions enabled (requires registration)');
  output.info('Register with: actp register');

  return smartWalletAddress;
}

/**
 * Ask user if they want to register for gas-free transactions.
 * Non-TTY (piped/agent) defaults to yes.
 */
async function promptRegister(output: Output): Promise<boolean> {
  output.blank();
  output.print('Register for gas-free transactions? (recommended)');
  output.print('  Your agent gets a Smart Wallet with sponsored gas — no ETH needed.');
  output.print('  Requires on-chain registration on AgentRegistry.');
  output.blank();

  if (!process.stdin.isTTY) {
    output.info('Non-interactive mode: auto-registering');
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('  Register now? [Y/n] ', (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

/**
 * Run inline registration during init.
 * Reuses the same logic as `actp register` — parses AGIRAILS.md,
 * builds gasless UserOp (testnet: register + mint 1000 USDC).
 *
 * Returns true if registration succeeded, false on failure (non-fatal).
 */
async function runInlineRegistration(
  projectRoot: string,
  mode: string,
  output: Output
): Promise<boolean> {
  try {
    const { resolvePrivateKey } = await import('../../wallet/keystore');
    const privateKey = await resolvePrivateKey(projectRoot);
    if (!privateKey) {
      output.warning('Could not load wallet key. Run "actp register" later.');
      return false;
    }

    const { parseAgirailsMd } = await import('../../config/agirailsmd');
    const { extractRegistrationParams } = await import('../../config/publishPipeline');
    const { ethers } = await import('ethers');
    const { getNetwork } = await import('../../config/networks');
    const { AutoWalletProvider } = await import('../../wallet/AutoWalletProvider');
    const { buildRegisterAgentBatch, buildTestnetInitBatch, buildTestnetMintBatch } = await import('../../wallet/aa/TransactionBatcher');
    const { sdkLogger } = await import('../../utils/Logger');

    // Parse AGIRAILS.md if present
    const agirailsMdPath = path.join(projectRoot, 'AGIRAILS.md');
    let endpoint = '';
    let serviceDescriptors;

    if (fs.existsSync(agirailsMdPath)) {
      const content = fs.readFileSync(agirailsMdPath, 'utf-8');
      const parsed = parseAgirailsMd(content);
      const regParams = extractRegistrationParams(parsed.frontmatter);
      endpoint = regParams.endpoint;
      serviceDescriptors = regParams.serviceDescriptors;
      output.info(`Parsed ${serviceDescriptors.length} service(s) from AGIRAILS.md`);
    } else {
      const serviceType = 'general';
      serviceDescriptors = [{
        serviceTypeHash: ethers.keccak256(ethers.toUtf8Bytes(serviceType)),
        serviceType,
        schemaURI: '',
        minPrice: 0n,
        maxPrice: 1_000_000_000n,
        avgCompletionTime: 3600,
        metadataCID: '',
      }];
      output.info('No AGIRAILS.md found. Using default "general" service.');
    }

    const network = mode === 'testnet' ? 'base-sepolia' : 'base-mainnet';
    const networkConfig = getNetwork(network);

    if (!networkConfig.aa || !networkConfig.contracts.agentRegistry) {
      output.warning('AA or AgentRegistry not configured. Run "actp register" later.');
      return false;
    }

    // Check for valid bundler/paymaster URL (CDP_API_KEY must be set)
    const cdpUrl = networkConfig.aa.bundlerUrls.coinbase;
    const hasPimlico = !!networkConfig.aa.bundlerUrls.pimlico;
    if (cdpUrl.endsWith('/') && !hasPimlico) {
      output.warning('CDP_API_KEY not set. Skipping registration.');
      output.info('Set CDP_API_KEY and run "actp register" later.');
      return false;
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

    // Build and submit registration batch
    if (mode === 'testnet') {
      // Testnet: try combined batch first, fall back to separate UserOps
      // Some paymaster configurations reject multi-target batches in simulation
      output.info('Testnet: registering + minting 1000 test USDC...');

      const combinedCalls = buildTestnetInitBatch({
        agentRegistryAddress: networkConfig.contracts.agentRegistry,
        endpoint,
        serviceDescriptors,
        mockUsdcAddress: networkConfig.contracts.usdc,
        recipient: smartWalletAddress,
        mintAmount: '1000000000',
      });

      let receipt;
      try {
        const txRequests = combinedCalls.map((c) => ({
          to: c.target,
          data: c.data,
          value: c.value.toString(),
        }));
        receipt = await autoWallet.sendBatchTransaction(txRequests);
      } catch (combinedError) {
        // Combined batch failed — split into two separate UserOps
        output.info('Combined batch failed, trying separate transactions...');
        sdkLogger.warn('Combined testnet batch failed, splitting', {
          error: combinedError instanceof Error ? combinedError.message : String(combinedError),
        });

        // Step 1: Register agent only
        const registerCalls = buildRegisterAgentBatch(
          networkConfig.contracts.agentRegistry,
          endpoint,
          serviceDescriptors
        );
        const registerTxs = registerCalls.map((c) => ({
          to: c.target,
          data: c.data,
          value: c.value.toString(),
        }));

        const registerReceipt = await autoWallet.sendBatchTransaction(registerTxs);
        if (!registerReceipt.success) {
          output.warning(`Registration failed (tx: ${registerReceipt.hash}). Run "actp register" later.`);
          return false;
        }
        output.success('Agent registered on AgentRegistry');
        output.print(`  Tx: ${registerReceipt.hash}`);

        // Step 2: Mint test USDC
        try {
          const mintCalls = buildTestnetMintBatch(
            networkConfig.contracts.usdc,
            smartWalletAddress,
            '1000000000'
          );
          const mintTxs = mintCalls.map((c) => ({
            to: c.target,
            data: c.data,
            value: c.value.toString(),
          }));
          const mintReceipt = await autoWallet.sendBatchTransaction(mintTxs);
          if (mintReceipt.success) {
            output.success('Minted 1,000 test USDC to Smart Wallet');
            output.print(`  Tx: ${mintReceipt.hash}`);
          } else {
            output.warning('USDC mint failed. Mint manually: actp faucet');
          }
        } catch (mintError) {
          output.warning('USDC mint failed. Mint manually: actp faucet');
          sdkLogger.warn('Testnet mint failed', {
            error: mintError instanceof Error ? mintError.message : String(mintError),
          });
        }
        return true;
      }

      if (!receipt.success) {
        output.warning(`Registration failed (tx: ${receipt.hash}). Run "actp register" later.`);
        return false;
      }

      output.success('Agent registered on AgentRegistry');
      output.success('Minted 1,000 test USDC to Smart Wallet');
      output.print(`  Tx: ${receipt.hash}`);
    } else {
      // Mainnet: register only (no minting)
      output.info('Registering on AgentRegistry (gasless)...');
      const calls = buildRegisterAgentBatch(
        networkConfig.contracts.agentRegistry,
        endpoint,
        serviceDescriptors
      );
      const txRequests = calls.map((c) => ({
        to: c.target,
        data: c.data,
        value: c.value.toString(),
      }));

      const receipt = await autoWallet.sendBatchTransaction(txRequests);
      if (!receipt.success) {
        output.warning(`Registration failed (tx: ${receipt.hash}). Run "actp register" later.`);
        return false;
      }

      output.success('Agent registered on AgentRegistry');
      output.print(`  Tx: ${receipt.hash}`);
    }

    return true;
  } catch (error) {
    output.warning(`Registration failed: ${(error as Error).message}`);
    output.info('You can register later with: actp register');
    return false;
  }
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
