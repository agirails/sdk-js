/**
 * ACTP Dispute Test
 * Tests dispute flow: Create → Link → Deliver → Dispute → Resolve
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

import { ACTPClient } from '../src/ACTPClient';
import { parseUnits } from 'ethers/lib/utils';
import { ethers } from 'ethers';

const CLIENT_ADDRESS = '0xe174bd855aaA8d907334288323044d4cf79BfAfC';
const PROVIDER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || ''; // For dispute resolution

if (!CLIENT_PRIVATE_KEY || !PROVIDER_PRIVATE_KEY || !ADMIN_PRIVATE_KEY) {
  console.error('❌ Missing environment variables');
  console.log('Set: CLIENT_PRIVATE_KEY, PROVIDER_PRIVATE_KEY, ADMIN_PRIVATE_KEY');
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 ACTP Dispute Test\n');
  console.log('Client:  ', CLIENT_ADDRESS);
  console.log('Provider:', PROVIDER_ADDRESS);
  console.log('');

  const clientSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: CLIENT_PRIVATE_KEY
  });

  const providerSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: PROVIDER_PRIVATE_KEY
  });

  const adminSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: ADMIN_PRIVATE_KEY
  });

  const amount = parseUnits('100', 6);
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const disputeWindow = 7200;
  const metadata = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Disputed service'));

  try {
    // Create and fund transaction
    console.log('📝 Creating transaction...');
    const txId = await clientSDK.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: CLIENT_ADDRESS,
      amount,
      deadline,
      disputeWindow,
      metadata
    });
    console.log('   ✅ Transaction ID:', txId);
    await sleep(2000);

    console.log('💰 Linking escrow...');
    const networkConfig = clientSDK.getNetworkConfig();

    // Approve USDC for EscrowVault
    const provider = clientSDK.getProvider();
    const signer = new ethers.Wallet(CLIENT_PRIVATE_KEY, provider);
    const usdcABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const usdc = new ethers.Contract(networkConfig.contracts.usdc, usdcABI, signer);

    const approveTx = await usdc.approve(networkConfig.contracts.escrowVault, amount);
    await approveTx.wait();
    await sleep(3000); // Wait for state propagation

    // Generate escrowId and link
    const escrowId = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId, networkConfig.contracts.escrowVault, Date.now()]
      )
    );

    await clientSDK.kernel.linkEscrow(txId, networkConfig.contracts.escrowVault, escrowId);
    console.log('   ✅ Escrow linked');
    await sleep(2000);
    console.log('');

    // Provider starts work
    console.log('🔨 Provider starts work...');
    await providerSDK.kernel.transitionState(txId, 3); // IN_PROGRESS
    console.log('   ✅ Work in progress');
    await sleep(2000);

    // Provider delivers
    console.log('📦 Provider delivers work...');
    await providerSDK.kernel.transitionState(txId, 4); // DELIVERED
    console.log('   ✅ Delivered');
    await sleep(2000);
    console.log('');

    // Client disputes!
    console.log('⚠️  CLIENT RAISES DISPUTE!');
    console.log('   Reason: "Work quality does not meet requirements"');
    await clientSDK.kernel.transitionState(txId, 6); // DISPUTED
    console.log('   ✅ Dispute raised');
    await sleep(2000);

    let tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(DISPUTED)');
    console.log('');

    // Admin resolves dispute
    console.log('👨‍⚖️  ADMIN RESOLVES DISPUTE');
    console.log('   Reviewing evidence...');
    console.log('   Decision: Split 70/30 (Provider favored)');
    console.log('');

    // Calculate split amounts (70% to provider, 30% to requester)
    const requesterAmount = amount.mul(30).div(100); // 30 USDC
    const providerAmount = amount.mul(70).div(100);  // 70 USDC

    console.log('   Resolving with splits:');
    console.log('     Client:   30% = 30.00 USDC');
    console.log('     Provider: 70% = 70.00 USDC');

    await adminSDK.kernel.resolveDispute(txId, {
      requesterAmount,
      providerAmount,
      mediatorAmount: parseUnits('0', 6),
      mediator: undefined
    });
    console.log('   ✅ Dispute resolved');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(SETTLED)');
    console.log('');

    // Summary
    console.log('═══════════════════════════════════════');
    console.log('✅ DISPUTE TEST COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log('Transaction ID:', txId);
    console.log('Final State:   SETTLED (via dispute)');
    console.log('');
    console.log('💰 Financial Summary:');
    console.log('   Original amount: 100.00 USDC');
    console.log('   Client refund:    30.00 USDC');
    console.log('   Provider payout:  70.00 USDC');
    console.log('   (Dispute resolution: 70/30 split)');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    process.exit(1);
  }
}

main().catch(console.error);
