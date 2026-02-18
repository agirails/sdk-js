#!/usr/bin/env ts-node
/**
 * E2E Testnet: Full Smart Wallet Lifecycle Test
 *
 * Tests pay → startWork → deliver → release on Base Sepolia,
 * verifying all operations route through Smart Wallet UserOps.
 * Zero ETH needed — paymaster sponsors all gas including MockUSDC mint.
 *
 * Usage:
 *   # Generate new wallets
 *   npx ts-node scripts/testnet-e2e.ts --generate-wallets
 *
 *   # Run full test (no workaround; requires agent already published)
 *   E2E_REQUESTER_KEY=0x... E2E_PROVIDER_KEY=0x... npx ts-node scripts/testnet-e2e.ts
 *
 *   # Optional: force pending-publish stub workaround (legacy/debug only)
 *   E2E_REQUESTER_KEY=0x... E2E_PROVIDER_KEY=0x... npx ts-node scripts/testnet-e2e.ts --use-pending-stub
 *
 *   # Use custom RPC
 *   BASE_SEPOLIA_RPC=https://... E2E_REQUESTER_KEY=0x... E2E_PROVIDER_KEY=0x... npx ts-node scripts/testnet-e2e.ts
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { ACTPClient } from '../src/ACTPClient';
import { computeSmartWalletAddress } from '../src/wallet/aa/UserOpBuilder';

// ─── Config ──────────────────────────────────────────────────────────────────

const NETWORK = 'base-sepolia';
const RPC_URL = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const MOCK_USDC = '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb';
const DISPUTE_WINDOW_SECONDS = 3600; // 1 hour (protocol minimum)

const BASESCAN = 'https://sepolia.basescan.org/tx';

// MockUSDC mint(address,uint256) selector + ABI for balance check
const MINT_SELECTOR = '0x40c10f19'; // bytes4(keccak256("mint(address,uint256)"))
const MOCK_USDC_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(step: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${step}] ${msg}`);
}

function logTx(label: string, hash: string) {
  log('TX', `${label}: ${hash}`);
  log('TX', `  → ${BASESCAN}/${hash}`);
}

async function sleep(seconds: number) {
  await new Promise(r => setTimeout(r, seconds * 1000));
}

/**
 * Poll getStatus until expected state or timeout.
 */
async function waitForState(
  client: ACTPClient,
  txId: string,
  expectedState: string,
  timeoutSec = 30,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const status = await client.getStatus(txId);
    if (status.state === expectedState) {
      log('VERIFY', `State: ${expectedState}`);
      return;
    }
    log('POLL', `State is ${status.state}, waiting for ${expectedState}...`);
    await sleep(3);
  }
  const final = await client.getStatus(txId);
  throw new Error(`Timeout waiting for ${expectedState}, stuck at ${final.state}`);
}

/**
 * Create a temp state directory.
 * Optionally seeds pending-publish.json (workaround mode only).
 */
function createStateDir(label: string, withPendingPublish: boolean): string {
  const baseDir = path.join(process.cwd(), '.e2e-tmp');
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(baseDir, `${label}-`));
  const actpDir = path.join(dir, '.actp');
  fs.mkdirSync(actpDir, { mode: 0o700 });

  if (withPendingPublish) {
    const configHash = ethers.keccak256(ethers.toUtf8Bytes('e2e-test'));
    const serviceType = 'e2e-test';
    const serviceTypeHash = ethers.keccak256(ethers.toUtf8Bytes(serviceType));
    const pending = {
      version: 1,
      configHash,
      cid: 'QmE2ETest',
      endpoint: 'https://test.agirails.io',
      serviceDescriptors: [{
        serviceTypeHash,
        serviceType,
        schemaURI: '',
        minPrice: '50000',      // $0.05 USDC
        maxPrice: '10000000',   // $10 USDC
        avgCompletionTime: 60,
        metadataCID: '',
      }],
      createdAt: new Date().toISOString(),
      network: NETWORK,
    };

    const filePath = path.join(actpDir, `pending-publish.${NETWORK}.json`);
    fs.writeFileSync(filePath, JSON.stringify(pending, null, 2), { mode: 0o600 });
  }

  log('SETUP', `${label} state dir: ${dir}`);
  return dir;
}

function cleanup(dirs: string[]) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Encode MockUSDC.mint(to, amount) calldata for sending via Smart Wallet UserOp.
 */
function encodeMintCalldata(to: string, amount: bigint): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const params = abiCoder.encode(['address', 'uint256'], [to, amount]);
  return MINT_SELECTOR + params.slice(2);
}

// ─── Generate Wallets Mode ───────────────────────────────────────────────────

async function generateWallets() {
  console.log('\n=== Generate Wallets for E2E Test ===\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const requesterWallet = ethers.Wallet.createRandom();
  const providerWallet = ethers.Wallet.createRandom();

  const swRequester = await computeSmartWalletAddress(requesterWallet.address, provider);
  const swProvider = await computeSmartWalletAddress(providerWallet.address, provider);

  console.log('Requester:');
  console.log(`  EOA:          ${requesterWallet.address}`);
  console.log(`  Private Key:  ${requesterWallet.privateKey}`);
  console.log(`  Smart Wallet: ${swRequester}`);
  console.log('');
  console.log('Provider:');
  console.log(`  EOA:          ${providerWallet.address}`);
  console.log(`  Private Key:  ${providerWallet.privateKey}`);
  console.log(`  Smart Wallet: ${swProvider}`);
  console.log('');
  console.log('Run the E2E test (no funding needed — paymaster covers all gas):');
  console.log(`  E2E_REQUESTER_KEY=${requesterWallet.privateKey} \\`);
  console.log(`  E2E_PROVIDER_KEY=${providerWallet.privateKey} \\`);
  console.log('  npx ts-node scripts/testnet-e2e.ts');
  console.log('');
}

// ─── Main E2E Test ───────────────────────────────────────────────────────────

async function runE2E() {
  const requesterKey = process.env.E2E_REQUESTER_KEY;
  const providerKey = process.env.E2E_PROVIDER_KEY;
  const usePendingStub = process.argv.includes('--use-pending-stub');

  if (!requesterKey || !providerKey) {
    console.error('Missing env vars: E2E_REQUESTER_KEY and E2E_PROVIDER_KEY');
    console.error('Run with --generate-wallets first to create new keypairs.');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   ACTP E2E Test: Full Smart Wallet Lifecycle (Testnet)  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const stateDirs: string[] = [];

  try {
    // ─── Phase 1: Setup ────────────────────────────────────────────────

    log('SETUP', `RPC: ${RPC_URL}`);
    log('SETUP', `Network: ${NETWORK}`);
    log('SETUP', `Pending-publish workaround: ${usePendingStub ? 'ENABLED' : 'DISABLED'}`);

    const requesterSigner = new ethers.Wallet(requesterKey, provider);
    const providerSigner = new ethers.Wallet(providerKey, provider);

    log('SETUP', `Requester EOA: ${requesterSigner.address}`);
    log('SETUP', `Provider EOA:  ${providerSigner.address}`);

    // Compute Smart Wallet addresses
    const swRequester = await computeSmartWalletAddress(requesterSigner.address, provider);
    const swProvider = await computeSmartWalletAddress(providerSigner.address, provider);
    log('SETUP', `Requester Smart Wallet: ${swRequester}`);
    log('SETUP', `Provider Smart Wallet:  ${swProvider}`);

    // Create temp state directories (optionally with pending-publish stubs)
    const requesterDir = createStateDir('requester', usePendingStub);
    const providerDir = createStateDir('provider', usePendingStub);
    stateDirs.push(requesterDir, providerDir);

    // ─── Phase 2: Create ACTP Clients ──────────────────────────────────
    log('CLIENT', 'Creating requester ACTP client (wallet: auto)...');
    if (usePendingStub) {
      process.env.ACTP_DIR = path.join(requesterDir, '.actp');
    }
    const requesterClient = await ACTPClient.create({
      mode: 'testnet',
      privateKey: requesterKey,
      wallet: 'auto',
      stateDirectory: requesterDir,
    });
    log('CLIENT', 'Requester client created (Smart Wallet active)');

    log('CLIENT', 'Creating provider ACTP client (wallet: auto)...');
    if (usePendingStub) {
      process.env.ACTP_DIR = path.join(providerDir, '.actp');
    }
    const providerClient = await ACTPClient.create({
      mode: 'testnet',
      privateKey: providerKey,
      wallet: 'auto',
      stateDirectory: providerDir,
    });
    if (usePendingStub) {
      delete process.env.ACTP_DIR; // cleanup
    }
    log('CLIENT', 'Provider client created (Smart Wallet active)');

    // Enforce true Smart Wallet routing for this E2E.
    const requesterTier = requesterClient.getWalletProvider()?.getWalletInfo().tier;
    const providerTier = providerClient.getWalletProvider()?.getWalletInfo().tier;
    if (requesterTier !== 'auto' || providerTier !== 'auto') {
      throw new Error(
        'E2E requires Smart Wallet (auto) for both parties. ' +
        `Detected requester=${requesterTier ?? 'unknown'}, provider=${providerTier ?? 'unknown'}. ` +
        'Run "actp publish" for both agents, then rerun. ' +
        'Use --use-pending-stub only for legacy debugging.'
      );
    }

    // ─── Phase 3: Mint MockUSDC via Smart Wallet UserOp ────────────────

    const mintAmount = ethers.parseUnits('10', 6); // 10 USDC
    const mintCalldata = encodeMintCalldata(swRequester, mintAmount);

    log('SETUP', 'Minting 10 MockUSDC via Smart Wallet UserOp...');
    const walletProvider = requesterClient.getWalletProvider()!;
    const mintReceipt = await walletProvider.sendTransaction({
      to: MOCK_USDC,
      data: mintCalldata,
    });

    if (!mintReceipt.success) {
      throw new Error(`MockUSDC mint UserOp failed: ${mintReceipt.hash}`);
    }
    logTx('MockUSDC mint (UserOp)', mintReceipt.hash);

    // Check balance
    const usdc = new ethers.Contract(MOCK_USDC, MOCK_USDC_ABI, provider);
    const usdcBalance = await usdc.balanceOf(swRequester);
    log('SETUP', `Requester SW USDC balance: ${ethers.formatUnits(usdcBalance, 6)}`);

    if (usdcBalance < ethers.parseUnits('1', 6)) {
      throw new Error('Insufficient USDC balance after mint. Something went wrong.');
    }

    // ─── Phase 4: Pay (createTx + approve + linkEscrow batched) ────────

    log('STEP 1', `Requester paying 1 USDC to provider SW (${swProvider})...`);
    log('STEP 1', `Dispute window: ${DISPUTE_WINDOW_SECONDS}s`);

    const payResult = await requesterClient.pay({
      to: swProvider,
      amount: '1',
      disputeWindow: DISPUTE_WINDOW_SECONDS,
      description: 'E2E Smart Wallet lifecycle test',
    });

    if (!payResult.success) {
      throw new Error(`pay() failed: ${payResult.error}`);
    }

    const txId = payResult.txId;
    const escrowId = payResult.escrowId!;
    log('STEP 1', `Payment successful!`);
    log('STEP 1', `  txId:     ${txId}`);
    log('STEP 1', `  escrowId: ${escrowId}`);
    log('STEP 1', `  adapter:  ${payResult.adapter}`);
    log('STEP 1', `  state:    ${payResult.state}`);

    // Verify COMMITTED (poll until chain confirms)
    await waitForState(requesterClient, txId, 'COMMITTED');

    // ─── Phase 5: Start Work (provider transitions to IN_PROGRESS) ─────

    log('STEP 2', 'Provider starting work...');
    await providerClient.startWork(txId);
    log('STEP 2', 'startWork() completed');

    await waitForState(providerClient, txId, 'IN_PROGRESS');

    // ─── Phase 6: Deliver (provider transitions to DELIVERED) ──────────

    log('STEP 3', 'Provider delivering...');
    await providerClient.deliver(txId, DISPUTE_WINDOW_SECONDS);
    log('STEP 3', 'deliver() completed');

    await waitForState(providerClient, txId, 'DELIVERED');

    // ─── Phase 7: Release (requester settles immediately) ──────────────
    // Requester can settle during dispute window (waives dispute rights).
    // This now goes through the official SDK release path (no workaround).
    log('STEP 4', 'Requester releasing escrow (official SDK path)...');
    await requesterClient.release(txId);
    log('STEP 4', 'release() completed');

    await waitForState(requesterClient, txId, 'SETTLED');

    // ─── Summary ───────────────────────────────────────────────────────

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                    E2E TEST PASSED                      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    console.log('State transitions: COMMITTED → IN_PROGRESS → DELIVERED → SETTLED');
    console.log(`Transaction ID: ${txId}`);
    console.log(`Escrow ID: ${escrowId}`);
    console.log(`Mint UserOp: ${BASESCAN}/${mintReceipt.hash}`);
    console.log('');
    console.log('All 5 UserOps routed through Smart Wallet (paymaster-sponsored):');
    console.log('  1. MockUSDC mint');
    console.log('  2. pay (batched: createTx + approve + linkEscrow)');
    console.log('  3. startWork (transitionState → IN_PROGRESS)');
    console.log('  4. deliver (transitionState → DELIVERED)');
    console.log('  5. release (transitionState → SETTLED)');

  } catch (error: any) {
    console.error('\n╔══════════════════════════════════════════════════════════╗');
    console.error('║                    E2E TEST FAILED                      ║');
    console.error('╚══════════════════════════════════════════════════════════╝\n');
    console.error('Error:', error.message || error);

    if (error.message?.includes('paymaster') || error.message?.includes('UserOp')) {
      console.error('\nHint: This may be a paymaster allowlist issue.');
      console.error('ACTPKernel/MockUSDC may not be allowlisted for gas sponsorship.');
      console.error('Check CDP/Pimlico paymaster configuration.');
    }

    if (error.message?.includes('requires Smart Wallet (auto)')) {
      console.error('\nHint: Publish both agents first so wallet=auto stays active:');
      console.error('  1. actp init --mode testnet --wallet auto');
      console.error('  2. actp publish');
    }

    if (error.message?.includes('503') || error.message?.includes('rate limit')) {
      console.error('\nHint: RPC rate limit. Set BASE_SEPOLIA_RPC to an Alchemy URL.');
    }

    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }

    process.exit(1);
  } finally {
    cleanup(stateDirs);
    log('CLEANUP', 'Temp directories removed');
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

(async () => {
  if (process.argv.includes('--generate-wallets')) {
    await generateWallets();
  } else {
    await runE2E();
  }
})();
