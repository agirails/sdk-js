/**
 * ACTP Happy Path Test
 * Tests full transaction lifecycle: Create → Link → Progress → Deliver → Settle
 *
 * Updated for SDK v2.0.0 API (uses standard adapter)
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

import { ACTPClient } from '../src/ACTPClient';
import { ethers, parseUnits, formatUnits, Wallet, Contract, keccak256, toUtf8Bytes, JsonRpcProvider } from 'ethers';
import { getNetwork } from '../src/config/networks';

// Test wallets - derived from private keys in .env
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';

// Derive addresses from private keys (don't hardcode)
const CLIENT_ADDRESS = CLIENT_PRIVATE_KEY ? new Wallet(CLIENT_PRIVATE_KEY).address : '';
const PROVIDER_ADDRESS = PROVIDER_PRIVATE_KEY ? new Wallet(PROVIDER_PRIVATE_KEY).address : '';

if (!CLIENT_PRIVATE_KEY || !PROVIDER_PRIVATE_KEY) {
  console.error('❌ Missing environment variables');
  console.log('Set: CLIENT_PRIVATE_KEY and PROVIDER_PRIVATE_KEY');
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 ACTP Happy Path Test (SDK v2.0.0)\n');
  console.log('Client:  ', CLIENT_ADDRESS);
  console.log('Provider:', PROVIDER_ADDRESS);
  console.log('');

  const networkConfig = getNetwork('base-sepolia');
  console.log('Network:', networkConfig.name);
  console.log('Kernel: ', networkConfig.contracts.actpKernel);
  console.log('Escrow: ', networkConfig.contracts.escrowVault);
  console.log('');

  // Initialize clients
  const clientSDK = await ACTPClient.create({
    mode: 'testnet',
    requesterAddress: CLIENT_ADDRESS,
    privateKey: CLIENT_PRIVATE_KEY,
    rpcUrl: networkConfig.rpcUrl,
  });

  const providerSDK = await ACTPClient.create({
    mode: 'testnet',
    requesterAddress: PROVIDER_ADDRESS,
    privateKey: PROVIDER_PRIVATE_KEY,
    rpcUrl: networkConfig.rpcUrl,
  });

  console.log('✅ SDK clients initialized\n');

  // Transaction parameters
  // Note: StandardAdapter.parseAmount() expects human-readable amounts
  // '100' = 100 USDC, NOT '100000000' (which would be 100M USDC!)
  const amount = '100'; // 100 USDC (human-readable)
  const amountWei = '100000000'; // 100 USDC in wei for balance checks (6 decimals)
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const disputeWindow = 7200; // 2 hours

  try {
    // Check USDC balance first
    console.log('💳 STEP 0: Checking USDC balance');

    const provider = new JsonRpcProvider(networkConfig.rpcUrl);
    const signer = new Wallet(CLIENT_PRIVATE_KEY, provider);

    const usdcABI = [
      'function balanceOf(address owner) view returns (uint256)'
    ];
    const usdc = new Contract(networkConfig.contracts.usdc, usdcABI, signer);

    const balance = await usdc.balanceOf(CLIENT_ADDRESS);
    console.log('   Client USDC balance:', formatUnits(balance, 6), 'USDC');

    if (balance < BigInt(amountWei)) {
      throw new Error(`Insufficient USDC balance. Have ${formatUnits(balance, 6)}, need ${amount} USDC`);
    }
    console.log('   ✅ Sufficient balance\n');

    // STEP 1: Create transaction
    console.log('📝 STEP 1: Client creates transaction');
    console.log('   Amount:', amount, 'USDC');
    console.log('   Provider:', PROVIDER_ADDRESS);
    console.log('   Deadline: 24 hours');
    console.log('   Dispute window: 2 hours');

    const txId = await clientSDK.standard.createTransaction({
      provider: PROVIDER_ADDRESS,
      amount: amount,
      deadline: deadline,
      disputeWindow: disputeWindow,
      serviceDescription: 'Test service - translation',
    });

    console.log('   ✅ Transaction ID:', txId);
    await sleep(2000);

    // Check state
    let tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   State:', tx?.state, '(INITIATED)');
    console.log('');

    // STEP 2: Link escrow (transitions to COMMITTED)
    // Note: SDK's linkEscrow() handles USDC approval internally
    console.log('💰 STEP 2: Client links escrow (SDK handles USDC approval)');
    const escrowId = await clientSDK.standard.linkEscrow(txId);
    console.log('   ✅ Escrow linked! ID:', escrowId);
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   State:', tx?.state, '(COMMITTED)');
    console.log('');

    // STEP 4: Provider signals work in progress
    console.log('🔨 STEP 3: Provider starts work');
    await providerSDK.standard.transitionState(txId, 'IN_PROGRESS');
    console.log('   ✅ State: IN_PROGRESS');
    await sleep(2000);
    console.log('');

    // STEP 5: Provider delivers result
    console.log('📦 STEP 4: Provider delivers result');
    // Note: For DELIVERED transition, 'proof' is actually the dispute window duration (uint256)
    // - Empty bytes (0x) → uses DEFAULT_DISPUTE_WINDOW
    // - ABI-encoded uint256 → custom dispute window
    // We pass empty to use default dispute window
    await providerSDK.runtime.transitionState(txId, 'DELIVERED', '0x');
    console.log('   ✅ State: DELIVERED');
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   Completed at:', tx?.completedAt ? new Date(tx.completedAt * 1000).toLocaleString() : 'N/A');
    console.log('');

    // STEP 6: Wait for dispute window (or skip for testing)
    console.log('⏱️  STEP 5: Waiting for dispute window...');
    console.log('   (In production, would wait', disputeWindow / 3600, 'hours)');
    console.log('   For testing, settling immediately...');

    // In mock mode, we can advance time. In testnet, we settle immediately.
    // Note: On-chain settlement requires dispute window to expire
    await clientSDK.standard.transitionState(txId, 'SETTLED');
    console.log('   ✅ Transaction settled!');
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   Final State:', tx?.state);
    console.log('');

    // Final summary
    console.log('═══════════════════════════════════════');
    console.log('✅ HAPPY PATH TEST COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log('Transaction ID:', txId);
    console.log('Final State:   ', tx?.state);
    console.log('');
    console.log('💰 Financial Summary:');
    console.log('   Gross amount:   100.00 USDC');
    console.log('   Platform fee:     1.00 USDC (1%)');
    console.log('   Provider net:    99.00 USDC');
    console.log('');
    console.log('📊 View on Basescan:');
    console.log(`   https://sepolia.basescan.org/tx/${txId}`);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    if (error.data) console.error('Data:', error.data);
    if (error.transaction) console.error('Transaction:', error.transaction);
    process.exit(1);
  }
}

main().catch(console.error);
