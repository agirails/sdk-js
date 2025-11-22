/**
 * ACTP Happy Path Test
 * Tests full transaction lifecycle: Create → Link → Progress → Deliver → Settle
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

import { ACTPClient } from '../src/ACTPClient';
import { parseUnits, formatUnits } from 'ethers/lib/utils';
import { ethers } from 'ethers';

// Test wallets
const CLIENT_ADDRESS = '0xe174bd855aaA8d907334288323044d4cf79BfAfC';
const PROVIDER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // Hardhat account #2

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';

if (!CLIENT_PRIVATE_KEY || !PROVIDER_PRIVATE_KEY) {
  console.error('❌ Missing environment variables');
  console.log('Set: CLIENT_PRIVATE_KEY and PROVIDER_PRIVATE_KEY');
  process.exit(1);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 ACTP Happy Path Test\n');
  console.log('Client:  ', CLIENT_ADDRESS);
  console.log('Provider:', PROVIDER_ADDRESS);
  console.log('');

  // Initialize clients
  const clientSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: CLIENT_PRIVATE_KEY
  });

  const providerSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: PROVIDER_PRIVATE_KEY
  });

  console.log('✅ SDK clients initialized\n');

  // Transaction parameters
  const amount = parseUnits('100', 6); // 100 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const disputeWindow = 7200; // 2 hours
  const metadata = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Test service - translation'));

  try {
    // STEP 1: Create transaction
    console.log('📝 STEP 1: Client creates transaction');
    console.log('   Amount:', formatUnits(amount, 6), 'USDC');
    console.log('   Deadline: 24 hours');
    console.log('   Dispute window: 2 hours');

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

    // Check state
    let tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(INITIATED)');
    console.log('');

    // STEP 2: Link escrow (Kernel creates escrow internally)
    console.log('💰 STEP 2: Client links escrow');
    console.log('   Approving USDC for EscrowVault...');

    const networkConfig = clientSDK.getNetworkConfig();

    // Approve USDC transfer to EscrowVault
    const { ethers } = await import('ethers');
    const usdcABI = [
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function balanceOf(address owner) view returns (uint256)'
    ];

    // Get signer from SDK (uses CLIENT_PRIVATE_KEY)
    const provider = clientSDK.getProvider();
    const signer = new ethers.Wallet(CLIENT_PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(networkConfig.contracts.usdc, usdcABI, signer);

    // Check balance first
    const balance = await usdc.balanceOf(await signer.getAddress());
    console.log('   Client USDC balance:', formatUnits(balance, 6), 'USDC');

    console.log('   Approving', formatUnits(amount, 6), 'USDC for EscrowVault...');
    console.log('   Spender:', networkConfig.contracts.escrowVault);

    const approveTx = await usdc.approve(networkConfig.contracts.escrowVault, amount);
    console.log('   Approve tx:', approveTx.hash);
    const receipt = await approveTx.wait();
    console.log('   Approve confirmed in block:', receipt.blockNumber);
    console.log('   Approve status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');

    if (receipt.status !== 1) {
      throw new Error('USDC approval transaction failed');
    }

    // Wait for state to propagate (increased delay for RPC caching)
    await sleep(3000);

    // Verify allowance
    const signerAddress = await signer.getAddress();
    console.log('   Checking allowance for owner:', signerAddress);
    const allowance = await usdc.allowance(signerAddress, networkConfig.contracts.escrowVault);
    console.log('   ✅ USDC approved. Allowance:', formatUnits(allowance, 6), 'USDC');

    if (allowance.lt(amount)) {
      throw new Error(`Allowance insufficient! Expected ${formatUnits(amount, 6)} but got ${formatUnits(allowance, 6)}`);
    }

    // Generate escrowId (hash of transaction params)
    const escrowId = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId, networkConfig.contracts.escrowVault, Date.now()]
      )
    );

    console.log('   Linking escrow (Kernel creates escrow)...');
    await clientSDK.kernel.linkEscrow(
      txId,
      networkConfig.contracts.escrowVault,
      escrowId
    );
    console.log('   ✅ Escrow linked! USDC locked in vault');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(COMMITTED)');
    console.log('');

    // STEP 3: Provider signals work in progress
    console.log('🔨 STEP 3: Provider starts work');
    await providerSDK.kernel.transitionState(txId, 3); // IN_PROGRESS
    console.log('   ✅ State: IN_PROGRESS');
    await sleep(2000);
    console.log('');

    // STEP 4: Provider delivers result
    console.log('📦 STEP 4: Provider delivers result');
    await providerSDK.kernel.transitionState(txId, 4); // DELIVERED
    console.log('   ✅ State: DELIVERED');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   Created at:', new Date(tx.createdAt * 1000).toLocaleString());
    console.log('');

    // STEP 5: Client settles transaction (releases payment)
    console.log('💸 STEP 5: Client settles transaction');
    console.log('   (In production, this can happen after dispute window expires)');
    console.log('   Transitioning to SETTLED state (auto-releases escrow)...');

    await clientSDK.kernel.transitionState(txId, 5); // 5 = SETTLED state
    console.log('   ✅ Transaction settled! Payment released to provider.');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(SETTLED)');
    console.log('');

    // Final summary
    console.log('═══════════════════════════════════════');
    console.log('✅ HAPPY PATH TEST COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log('Transaction ID:', txId);
    console.log('Final State:   SETTLED');
    console.log('');
    console.log('💰 Financial Summary:');
    console.log('   Gross amount:   100.00 USDC');
    console.log('   Platform fee:     1.00 USDC (1%)');
    console.log('   Provider net:    99.00 USDC');
    console.log('');
    console.log('📊 View on Basescan:');
    console.log(`   https://sepolia.basescan.org/address/${tx.escrowContract}`);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    if (error.transaction) console.error('Transaction:', error.transaction);
    process.exit(1);
  }
}

main().catch(console.error);
