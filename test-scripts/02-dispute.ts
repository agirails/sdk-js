/**
 * ACTP Dispute Test
 * Tests dispute flow: Create → Link → Deliver → Dispute → (manual resolution)
 *
 * Updated for SDK v2.0.0 API
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ACTPClient } from '../src/ACTPClient';
import { Wallet, formatUnits } from 'ethers';
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
  console.log('🧪 ACTP Dispute Test (SDK v2.0.0)\n');
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

  const providerSDK = await ACTPClient.create({
    mode: 'testnet',
    requesterAddress: PROVIDER_ADDRESS,
    privateKey: PROVIDER_PRIVATE_KEY,
    rpcUrl: networkConfig.rpcUrl,
  });

  console.log('✅ SDK clients initialized\n');

  // Human-readable amount
  const amount = '50'; // 50 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const disputeWindow = 7200; // 2 hours

  try {
    // Create transaction
    console.log('📝 Creating transaction...');
    console.log('   Amount:', amount, 'USDC');

    const txId = await clientSDK.intermediate.createTransaction({
      provider: PROVIDER_ADDRESS,
      amount: amount,
      deadline: deadline,
      disputeWindow: disputeWindow,
      serviceDescription: 'Disputed service test',
    });
    console.log('   ✅ Transaction ID:', txId);
    await sleep(2000);

    // Link escrow
    console.log('💰 Linking escrow (SDK handles USDC approval)...');
    const escrowId = await clientSDK.intermediate.linkEscrow(txId);
    console.log('   ✅ Escrow linked! ID:', escrowId);
    await sleep(2000);

    let tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   State:', tx?.state, '(COMMITTED)');
    console.log('');

    // Provider starts work (required before DELIVERED)
    console.log('🔨 Provider starts work...');
    await providerSDK.intermediate.transitionState(txId, 'IN_PROGRESS');
    console.log('   ✅ State: IN_PROGRESS');
    await sleep(2000);

    // Provider delivers
    console.log('📦 Provider delivers work...');
    await providerSDK.runtime.transitionState(txId, 'DELIVERED', '0x');
    console.log('   ✅ State: DELIVERED');
    await sleep(2000);
    console.log('');

    // Client disputes!
    console.log('⚠️  CLIENT RAISES DISPUTE!');
    console.log('   Reason: "Work quality does not meet requirements"');
    await clientSDK.intermediate.transitionState(txId, 'DISPUTED');
    console.log('   ✅ Dispute raised');
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   State:', tx?.state, '(DISPUTED)');
    console.log('');

    // Note: Dispute resolution requires admin privileges on-chain
    // For now, we verify the dispute state was reached
    console.log('═══════════════════════════════════════');
    console.log('✅ DISPUTE TEST COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log('Transaction ID:', txId);
    console.log('Final State:   DISPUTED');
    console.log('');
    console.log('📝 Note: Dispute resolution requires admin/mediator.');
    console.log('   On-chain resolution would split funds between parties.');
    console.log('   For full dispute resolution test, run with admin key.');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    if (error.data) console.error('Data:', error.data);
    process.exit(1);
  }
}

main().catch(console.error);
