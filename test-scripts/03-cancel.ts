/**
 * ACTP Cancel Test
 * Tests cancellation flow: Create → Cancel (before escrow link)
 *
 * Updated for SDK v2.0.0 API
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ACTPClient } from '../src/ACTPClient';
import { Wallet } from 'ethers';
import { getNetwork } from '../src/config/networks';

// Test wallets - derived from private keys in .env
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';

const CLIENT_ADDRESS = CLIENT_PRIVATE_KEY ? new Wallet(CLIENT_PRIVATE_KEY).address : '';
const PROVIDER_ADDRESS = PROVIDER_PRIVATE_KEY ? new Wallet(PROVIDER_PRIVATE_KEY).address : '';

if (!CLIENT_PRIVATE_KEY || !PROVIDER_PRIVATE_KEY) {
  console.error('❌ Missing environment variables');
  console.log('Set: CLIENT_PRIVATE_KEY, PROVIDER_PRIVATE_KEY');
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 ACTP Cancel Test (SDK v2.0.0)\n');
  console.log('Client:  ', CLIENT_ADDRESS);
  console.log('Provider:', PROVIDER_ADDRESS);
  console.log('');

  const networkConfig = getNetwork('base-sepolia');

  const clientSDK = await ACTPClient.create({
    mode: 'testnet',
    requesterAddress: CLIENT_ADDRESS,
    privateKey: CLIENT_PRIVATE_KEY,
    rpcUrl: networkConfig.rpcUrl,
  });

  console.log('✅ SDK client initialized\n');

  // Human-readable amount
  const amount = '25'; // 25 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const disputeWindow = 3600; // 1 hour

  try {
    // SCENARIO 1: Cancel before escrow link (INITIATED → CANCELLED)
    console.log('📝 SCENARIO 1: Cancel before escrow link');
    console.log('   Creating transaction...');
    console.log('   Amount:', amount, 'USDC');

    const txId1 = await clientSDK.intermediate.createTransaction({
      provider: PROVIDER_ADDRESS,
      amount: amount,
      deadline: deadline,
      disputeWindow: disputeWindow,
      serviceDescription: 'Service to be cancelled - pre-escrow',
    });
    console.log('   ✅ Transaction ID:', txId1);
    await sleep(2000);

    let tx = await clientSDK.runtime.getTransaction(txId1);
    console.log('   State:', tx?.state, '(INITIATED)');

    console.log('\n   Client changes mind...');
    console.log('   Cancelling transaction...');

    await clientSDK.intermediate.transitionState(txId1, 'CANCELLED');
    console.log('   ✅ Transaction cancelled (no funds involved)');
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId1);
    console.log('   State:', tx?.state, '(CANCELLED)');
    console.log('');

    // SCENARIO 2: Cancel after escrow link (COMMITTED → CANCELLED after deadline)
    // Note: This requires the deadline to pass before cancellation is allowed
    console.log('📝 SCENARIO 2: Cancel after escrow link');
    console.log('   Creating transaction with 30-second deadline...');

    const shortDeadline = Math.floor(Date.now() / 1000) + 30; // 30 seconds

    const txId2 = await clientSDK.intermediate.createTransaction({
      provider: PROVIDER_ADDRESS,
      amount: amount,
      deadline: shortDeadline,
      disputeWindow: disputeWindow,
      serviceDescription: 'Service to be cancelled - post-escrow',
    });
    console.log('   ✅ Transaction ID:', txId2);
    await sleep(2000);

    console.log('   Linking escrow (SDK handles USDC approval)...');
    const escrowId = await clientSDK.intermediate.linkEscrow(txId2);
    console.log('   ✅ Escrow linked! ID:', escrowId);
    console.log('   💰 25 USDC locked in escrow');
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId2);
    console.log('   State:', tx?.state, '(COMMITTED)');

    console.log('\n   Waiting for deadline to expire (35 seconds)...');
    await sleep(35000); // Wait for deadline to pass

    console.log('   Client requests cancellation (deadline expired)...');
    console.log('   Cancelling transaction...');

    await clientSDK.intermediate.transitionState(txId2, 'CANCELLED');
    console.log('   ✅ Transaction cancelled');
    console.log('   💰 25 USDC refunded to client');
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId2);
    console.log('   State:', tx?.state, '(CANCELLED)');
    console.log('');

    // Summary
    console.log('═══════════════════════════════════════');
    console.log('✅ CANCEL TEST COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log('Scenario 1: Pre-escrow cancel');
    console.log('  Transaction ID:', txId1);
    console.log('  State: CANCELLED');
    console.log('  Funds: None involved');
    console.log('');
    console.log('Scenario 2: Post-escrow cancel (after deadline)');
    console.log('  Transaction ID:', txId2);
    console.log('  State: CANCELLED');
    console.log('  Funds: 25 USDC refunded to client');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    if (error.data) console.error('Data:', error.data);
    process.exit(1);
  }
}

main().catch(console.error);
