/**
 * USDC Approval Flow Example
 *
 * This example demonstrates the proper 2-step USDC approval pattern required
 * before linking escrow to a transaction.
 *
 * IMPORTANT: USDC (and some other ERC20 tokens) require approval to be reset
 * to zero before setting a new allowance value. This prevents front-running attacks.
 *
 * The SDK handles this automatically in EscrowVault.createEscrow(), but this example
 * shows what happens under the hood for educational purposes.
 */

import { ethers, BigNumber } from 'ethers';
import { ACTPClient } from '../src';

// Network configuration
const NETWORK = 'base-sepolia';
const RPC_URL = 'https://sepolia.base.org';

// Example addresses (replace with your own)
const REQUESTER_PRIVATE_KEY = process.env.REQUESTER_KEY || '0x...';
const PROVIDER_ADDRESS = process.env.PROVIDER_ADDRESS || '0x...';

/**
 * Main example function
 */
async function demonstrateUSDCApprovalFlow() {
  console.log('🔄 USDC Approval Flow Demo\n');

  // Step 1: Initialize SDK client
  console.log('Step 1: Initializing ACTP Client...');
  const client = await ACTPClient.create({
    network: NETWORK,
    privateKey: REQUESTER_PRIVATE_KEY
  });

  const requesterAddress = await client.signer.getAddress();
  console.log(`✅ Client initialized for: ${requesterAddress}\n`);

  // Step 2: Get contract addresses
  const kernelAddress = client.kernel.getAddress();
  const escrowAddress = client.escrow.getAddress();
  const usdcAddress = client.config.contracts.usdc;

  console.log('Step 2: Contract addresses:');
  console.log(`  ACTPKernel: ${kernelAddress}`);
  console.log(`  EscrowVault: ${escrowAddress}`);
  console.log(`  USDC: ${usdcAddress}\n`);

  // Step 3: Create USDC contract instance
  const usdcABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)'
  ];

  const usdc = new ethers.Contract(usdcAddress, usdcABI, client.signer);

  // Step 4: Check USDC balance
  console.log('Step 3: Checking USDC balance...');
  const balance = await usdc.balanceOf(requesterAddress);
  const decimals = await usdc.decimals();
  console.log(`  Balance: ${ethers.utils.formatUnits(balance, decimals)} USDC\n`);

  if (balance.eq(0)) {
    console.log('❌ No USDC balance. Please acquire testnet USDC first.');
    console.log('   Visit https://faucet.circle.com for testnet USDC.\n');
    return;
  }

  // Step 5: Create a transaction
  console.log('Step 4: Creating ACTP transaction...');
  const amount = ethers.utils.parseUnits('10', decimals); // 10 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours

  const txId = await client.kernel.createTransaction({
    provider: PROVIDER_ADDRESS,
    requester: requesterAddress,
    amount,
    deadline,
    disputeWindow: 3600 // 1 hour
  });
  console.log(`✅ Transaction created: ${txId}\n`);

  // Step 6: Check current USDC allowance
  console.log('Step 5: Checking current USDC allowance...');
  const currentAllowance = await usdc.allowance(requesterAddress, escrowAddress);
  console.log(`  Current allowance: ${ethers.utils.formatUnits(currentAllowance, decimals)} USDC\n`);

  // ========================================
  // CRITICAL: USDC Approval Pattern
  // ========================================

  console.log('Step 6: USDC Approval (2-step pattern)\n');

  if (currentAllowance.gt(0)) {
    console.log('⚠️  Current allowance > 0');
    console.log('   USDC requires reset to 0 before setting new value\n');

    // Step 6a: Reset allowance to 0
    console.log('Step 6a: Resetting allowance to 0...');
    const resetTx = await usdc.approve(escrowAddress, 0);
    console.log(`   Transaction: ${resetTx.hash}`);
    await resetTx.wait();
    console.log('✅ Allowance reset to 0\n');
  } else {
    console.log('✅ Current allowance is 0, no reset needed\n');
  }

  // Step 6b: Approve new amount
  console.log('Step 6b: Approving escrow to spend USDC...');
  const approveTx = await usdc.approve(escrowAddress, amount);
  console.log(`   Transaction: ${approveTx.hash}`);
  await approveTx.wait();
  console.log(`✅ Approved ${ethers.utils.formatUnits(amount, decimals)} USDC\n`);

  // Step 7: Verify new allowance
  console.log('Step 7: Verifying new allowance...');
  const newAllowance = await usdc.allowance(requesterAddress, escrowAddress);
  console.log(`   New allowance: ${ethers.utils.formatUnits(newAllowance, decimals)} USDC`);

  if (newAllowance.gte(amount)) {
    console.log('✅ Approval successful!\n');
  } else {
    console.log('❌ Approval failed or insufficient\n');
    return;
  }

  // ========================================
  // Now escrow can transfer USDC
  // ========================================

  // Step 8: Create escrow (now that approval is set)
  console.log('Step 8: Creating escrow...');
  console.log('   (EscrowVault will now transferFrom USDC)\n');

  try {
    const escrowId = await client.escrow.createEscrow({
      kernelAddress,
      txId,
      token: usdcAddress,
      amount,
      beneficiary: PROVIDER_ADDRESS
    });
    console.log(`✅ Escrow created: ${escrowId}\n`);

    // Step 9: Link escrow to transaction
    console.log('Step 9: Linking escrow to transaction...');
    await client.kernel.linkEscrow(txId, escrowId, amount);
    console.log('✅ Escrow linked!\n');

    console.log('🎉 Complete! Transaction is now in COMMITTED state.\n');
    console.log('Summary:');
    console.log(`  Transaction ID: ${txId}`);
    console.log(`  Escrow ID: ${escrowId}`);
    console.log(`  Amount: ${ethers.utils.formatUnits(amount, decimals)} USDC`);
    console.log(`  Status: COMMITTED (ready for provider to start work)\n`);
  } catch (error: any) {
    console.log('❌ Error creating escrow:');
    console.log(`   ${error.message}\n`);
    console.log('   This should not happen if approval was successful.');
    console.log('   Check that EscrowVault address is correct.\n');
  }
}

/**
 * Simplified version using SDK helper (recommended)
 */
async function usingSDKHelper() {
  console.log('\n========================================');
  console.log('SDK Helper Method (Recommended)');
  console.log('========================================\n');

  const client = await ACTPClient.create({
    network: NETWORK,
    privateKey: REQUESTER_PRIVATE_KEY
  });

  const amount = ethers.utils.parseUnits('10', 6); // 10 USDC

  console.log('SDK automatically handles USDC approval!\n');
  console.log('Just call createEscrow() - no manual approval needed:\n');

  console.log('```typescript');
  console.log('const escrowId = await client.escrow.createEscrow({');
  console.log('  kernelAddress: client.kernel.getAddress(),');
  console.log('  txId,');
  console.log('  token: USDC_ADDRESS,');
  console.log('  amount,');
  console.log('  beneficiary: provider.address');
  console.log('});');
  console.log('```\n');

  console.log('The SDK will:');
  console.log('  1. Check current allowance');
  console.log('  2. Reset to 0 if needed (USDC requirement)');
  console.log('  3. Approve new amount');
  console.log('  4. Create escrow\n');

  console.log('✅ You don\'t need to worry about the 2-step pattern!\n');
}

// Run the example
if (require.main === module) {
  // Check for required environment variables
  if (!process.env.REQUESTER_KEY) {
    console.log('❌ Missing environment variable: REQUESTER_KEY\n');
    console.log('Usage:');
    console.log('  REQUESTER_KEY=0x... PROVIDER_ADDRESS=0x... ts-node examples/usdc-approval-flow.ts\n');
    console.log('Or create a .env file:\n');
    console.log('  REQUESTER_KEY=0x...');
    console.log('  PROVIDER_ADDRESS=0x...\n');
    process.exit(1);
  }

  demonstrateUSDCApprovalFlow()
    .then(() => usingSDKHelper())
    .then(() => {
      console.log('Demo complete! 🎉');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error:', error);
      process.exit(1);
    });
}

export { demonstrateUSDCApprovalFlow, usingSDKHelper };
