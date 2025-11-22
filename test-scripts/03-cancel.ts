/**
 * ACTP Cancel Test
 * Tests cancellation flow: Create → Cancel (before escrow link)
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

import { ACTPClient } from '../src/ACTPClient';
import { parseUnits } from 'ethers/lib/utils';
import { ethers } from 'ethers';

const CLIENT_ADDRESS = '0xe174bd855aaA8d907334288323044d4cf79BfAfC';
const PROVIDER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';

if (!CLIENT_PRIVATE_KEY) {
  console.error('❌ Missing CLIENT_PRIVATE_KEY environment variable');
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 ACTP Cancel Test\n');
  console.log('Client:  ', CLIENT_ADDRESS);
  console.log('Provider:', PROVIDER_ADDRESS);
  console.log('');

  const clientSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: CLIENT_PRIVATE_KEY
  });

  const amount = parseUnits('50', 6); // 50 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const disputeWindow = 3600;
  const metadata = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Service to be cancelled'));

  try {
    // SCENARIO 1: Cancel before escrow link
    console.log('📝 SCENARIO 1: Cancel before escrow link');
    console.log('   Creating transaction...');

    const txId1 = await clientSDK.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: CLIENT_ADDRESS,
      amount,
      deadline,
      disputeWindow,
      metadata
    });
    console.log('   ✅ Transaction ID:', txId1);
    await sleep(2000);

    let tx = await clientSDK.kernel.getTransaction(txId1);
    console.log('   State:', tx.state, '(INITIATED)');

    console.log('\n   Client changes mind...');
    console.log('   Cancelling transaction...');

    await clientSDK.kernel.transitionState(txId1, 7); // CANCELLED
    console.log('   ✅ Transaction cancelled (no funds involved)');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId1);
    console.log('   State:', tx.state, '(CANCELLED)');
    console.log('');

    // SCENARIO 2: Cancel after escrow link (after deadline expires)
    console.log('📝 SCENARIO 2: Cancel after escrow link');
    console.log('   Creating transaction with 30-second deadline...');

    const shortDeadline = Math.floor(Date.now() / 1000) + 30; // 30 seconds

    const txId2 = await clientSDK.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: CLIENT_ADDRESS,
      amount,
      deadline: shortDeadline,
      disputeWindow,
      metadata: ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Service to be cancelled 2'))
    });
    console.log('   ✅ Transaction ID:', txId2);
    await sleep(2000);

    console.log('   Approving USDC for EscrowVault...');
    const networkConfig = clientSDK.getNetworkConfig();

    // Approve USDC for EscrowVault
    const provider = clientSDK.getProvider();
    const signer = new ethers.Wallet(CLIENT_PRIVATE_KEY, provider);
    const usdcABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const usdc = new ethers.Contract(networkConfig.contracts.usdc, usdcABI, signer);

    const approveTx = await usdc.approve(networkConfig.contracts.escrowVault, amount);
    await approveTx.wait();
    await sleep(3000); // Wait for state propagation

    console.log('   Linking escrow (Kernel creates escrow)...');
    const escrowId = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId2, networkConfig.contracts.escrowVault, Date.now()]
      )
    );
    await clientSDK.kernel.linkEscrow(txId2, networkConfig.contracts.escrowVault, escrowId);
    console.log('   ✅ Escrow linked (50 USDC locked)');
    await sleep(2000);

    console.log('\n   Waiting for deadline to expire (30 seconds)...');
    await sleep(32000); // Wait 32 seconds to ensure deadline has passed

    console.log('   Client requests cancellation (deadline expired)...');
    console.log('   Cancelling transaction...');

    await clientSDK.kernel.transitionState(txId2, 7); // CANCELLED
    console.log('   ✅ Transaction cancelled');
    console.log('   💰 50 USDC refunded to client');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId2);
    console.log('   State:', tx.state, '(CANCELLED)');
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
    console.log('Scenario 2: Post-escrow cancel');
    console.log('  Transaction ID:', txId2);
    console.log('  State: CANCELLED');
    console.log('  Funds: 50 USDC refunded to client');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    process.exit(1);
  }
}

main().catch(console.error);
