/**
 * Register Command — Register agent on AgentRegistry for gas-free transactions.
 *
 * Parses AGIRAILS.md for service descriptors and endpoint, then registers
 * on-chain via a single gasless UserOp (bootstrap-allowed).
 *
 * For testnet: also mints 1000 test USDC in the same UserOp.
 *
 * WARNING: This creates a NEW Smart Wallet address (different from EOA).
 * Old EOA reputation/history does not transfer.
 *
 * @module cli/commands/register
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { loadConfig, updateConfig } from '../utils/config';
import { resolvePrivateKey } from '../../wallet/keystore';

// ============================================================================
// Command Definition
// ============================================================================

export function createRegisterCommand(): Command {
  const cmd = new Command('register')
    .description('Register agent on AgentRegistry for gas-free transactions')
    .option('--endpoint <url>', 'Service endpoint URL (overrides AGIRAILS.md)')
    .option('--force-legacy', 'Bypass deprecation and run legacy registration')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      // Deprecation warning
      output.warning(
        'DEPRECATED: "actp register" is deprecated. Use "actp publish" instead.\n' +
        '  "actp publish" saves config locally. On-chain activation happens\n' +
        '  automatically on your first payment (lazy publish).'
      );
      output.blank();

      if (!options.forceLegacy) {
        output.print('To proceed anyway, use: actp register --force-legacy');
        return;
      }

      try {
        await runRegister(options, output);
      } catch (error) {
        output.errorResult({
          code: 'REGISTER_FAILED',
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

async function runRegister(
  options: { endpoint?: string },
  output: Output
): Promise<void> {
  const projectRoot = process.cwd();

  // Load config
  const config = loadConfig(projectRoot);
  if (!config) {
    throw new Error(
      'ACTP not initialized. Run "actp init" first.'
    );
  }

  if (config.mode === 'mock') {
    throw new Error('Registration is not available in mock mode.');
  }

  // Resolve private key
  const privateKey = await resolvePrivateKey(projectRoot, { network: config.mode });
  if (!privateKey) {
    throw new Error(
      'No wallet found. Run "actp init" first to generate a wallet.'
    );
  }

  // Parse AGIRAILS.md for service descriptors
  const { parseAgirailsMd } = await import('../../config/agirailsmd');
  const { extractRegistrationParams } = await import('../../config/publishPipeline');

  const agirailsMdPath = path.join(projectRoot, 'AGIRAILS.md');
  let endpoint = options.endpoint || '';
  let serviceDescriptors;

  if (fs.existsSync(agirailsMdPath)) {
    const content = fs.readFileSync(agirailsMdPath, 'utf-8');
    const parsed = parseAgirailsMd(content);
    const regParams = extractRegistrationParams(parsed.frontmatter);
    endpoint = options.endpoint || regParams.endpoint;
    serviceDescriptors = regParams.serviceDescriptors;
    output.info(`Parsed ${serviceDescriptors.length} service(s) from AGIRAILS.md`);
  } else {
    // No AGIRAILS.md — use minimal defaults
    const { ethers: ethersLib } = await import('ethers');
    const serviceType = 'general';
    serviceDescriptors = [{
      serviceTypeHash: ethersLib.keccak256(ethersLib.toUtf8Bytes(serviceType)),
      serviceType,
      schemaURI: '',
      minPrice: 0n,
      maxPrice: 1_000_000_000n, // 1000 USDC
      avgCompletionTime: 3600,
      metadataCID: '',
    }];
    output.warning('No AGIRAILS.md found. Using default "general" service descriptor.');
    output.info('Create AGIRAILS.md with services to customize registration.');
  }

  // Dynamic imports
  const { ethers } = await import('ethers');
  const { getNetwork } = await import('../../config/networks');
  const { AutoWalletProvider } = await import('../../wallet/AutoWalletProvider');
  const { buildRegisterAgentBatch, buildTestnetInitBatch } = await import('../../wallet/aa/TransactionBatcher');

  const network = config.mode === 'testnet' ? 'base-sepolia' : 'base-mainnet';
  const networkConfig = getNetwork(network);

  if (!networkConfig.aa) {
    throw new Error(
      `AA configuration not available for ${config.mode}. ` +
      'Smart Wallet registration requires AA support.'
    );
  }

  if (!networkConfig.contracts.agentRegistry) {
    throw new Error(
      'AgentRegistry contract not deployed yet. Registration not available.'
    );
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
      'AA bundler/paymaster endpoints are not configured.\n' +
      'Set CDP_API_KEY or PIMLICO_API_KEY (or explicit *_BUNDLER_URL/*_PAYMASTER_URL).'
    );
  }

  const rpcUrl = networkConfig.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  output.info('Creating Smart Wallet...');

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

  if (smartWalletAddress.toLowerCase() !== config.address.toLowerCase()) {
    output.warning(
      `This creates a NEW address: ${smartWalletAddress}\n` +
      `  Your current address: ${config.address}\n` +
      '  Old address reputation/history does NOT transfer.'
    );
  }

  // Build batch — testnet gets register + mint, mainnet gets register only
  let calls;
  if (config.mode === 'testnet') {
    output.info('Testnet mode: will register + mint 1000 test USDC in one UserOp');
    calls = buildTestnetInitBatch({
      agentRegistryAddress: networkConfig.contracts.agentRegistry,
      endpoint,
      serviceDescriptors,
      mockUsdcAddress: networkConfig.contracts.usdc,
      recipient: smartWalletAddress,
      mintAmount: '1000000000', // 1000 USDC
    });
  } else {
    calls = buildRegisterAgentBatch(
      networkConfig.contracts.agentRegistry,
      endpoint,
      serviceDescriptors
    );
  }

  // Convert SmartWalletCall[] to TransactionRequest[]
  const txRequests = calls.map((c) => ({
    to: c.target,
    data: c.data,
    value: c.value.toString(),
  }));

  output.info('Submitting registration (gasless UserOp)...');

  const receipt = await autoWallet.sendBatchTransaction(txRequests);

  if (!receipt.success) {
    throw new Error(`Registration UserOp failed: ${receipt.hash}`);
  }

  output.success('Agent registered on AgentRegistry');
  if (config.mode === 'testnet') {
    output.success('Minted 1,000 test USDC to Smart Wallet');
  }

  // Update config: flip address to Smart Wallet, mark as registered
  updateConfig({
    address: smartWalletAddress.toLowerCase(),
    smartWallet: smartWalletAddress.toLowerCase(),
    registered: true,
  }, projectRoot);
  output.info('Config updated: address set to Smart Wallet');

  output.blank();
  output.result(
    {
      registered: true,
      smartWallet: smartWalletAddress,
      services: serviceDescriptors.length,
      txHash: receipt.hash,
      ...(config.mode === 'testnet' && { mintedUSDC: '1000' }),
    },
    { quietKey: 'smartWallet' }
  );

  output.blank();
  output.print('Your agent now has gas-free transactions!');
  output.print(`Smart Wallet address: ${smartWalletAddress}`);
  output.print('');
  output.print('To use gas-free mode, add to your agent config:');
  output.print('  wallet: "auto"');
}
