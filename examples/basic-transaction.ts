/**
 * Basic Transaction Example
 * 
 * This example demonstrates:
 * - Creating a transaction
 * - Monitoring state changes
 * - Creating escrow
 * - Transitioning states
 * - Settling transaction
 */

import { ACTPClient, State } from '../src';
import { ethers } from 'ethers';

async function main() {
  // Initialize client
  const client = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: process.env.PRIVATE_KEY!
  });

  const myAddress = await client.getAddress();
  console.log(`My address: ${myAddress}`);

  // Transaction parameters
  const providerAddress = '0xProviderAddress...'; // Replace with actual provider
  const requesterAddress = myAddress;
  const amount = ethers.utils.parseUnits('100', 6); // 100 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const disputeWindow = 3600; // 1 hour

  // 1. Create transaction
  console.log('\n1. Creating transaction...');
  const txId = await client.kernel.createTransaction({
    provider: providerAddress,
    requester: requesterAddress,
    amount,
    deadline,
    disputeWindow
  });

  console.log(`✅ Transaction created: ${txId}`);

  // 2. Monitor transaction
  console.log('\n2. Setting up event monitoring...');
  const unsubscribe = client.events.watchTransaction(txId, (newState) => {
    console.log(`📡 State changed: ${State[newState]}`);
  });

  // 3. Get transaction details
  console.log('\n3. Fetching transaction details...');
  const tx = await client.kernel.getTransaction(txId);
  console.log('Transaction:', {
    txId: tx.txId,
    requester: tx.requester,
    provider: tx.provider,
    amount: ethers.utils.formatUnits(tx.amount, 6) + ' USDC',
    state: State[tx.state],
    deadline: new Date(tx.deadline * 1000).toISOString()
  });

  // 4. Create escrow (requester does this)
  console.log('\n4. Creating escrow...');
  const usdcAddress = client.getNetworkConfig().contracts.usdc;
  
  const escrowId = await client.escrow.createEscrow({
    kernelAddress: client.kernel.getAddress(),
    txId,
    token: usdcAddress,
    amount,
    beneficiary: providerAddress
  });

  console.log(`✅ Escrow created: ${escrowId}`);

  // 5. Link escrow to transaction
  console.log('\n5. Linking escrow...');
  await client.kernel.linkEscrow(
    txId,
    client.escrow.getAddress(),
    escrowId
  );

  console.log('✅ Escrow linked');

  // 6. Transition to IN_PROGRESS
  console.log('\n6. Starting work (IN_PROGRESS)...');
  await client.kernel.transitionState(txId, State.IN_PROGRESS);
  console.log('✅ State: IN_PROGRESS');

  // 7. Generate delivery proof
  console.log('\n7. Generating delivery proof...');
  const deliverable = 'This is the completed work...';
  
  const proof = client.proofGenerator.generateDeliveryProof({
    txId,
    deliverable,
    metadata: {
      mimeType: 'text/plain',
      description: 'Translation work completed'
    }
  });

  console.log('Proof generated:', {
    contentHash: proof.contentHash,
    size: proof.metadata.size + ' bytes',
    timestamp: new Date(proof.timestamp).toISOString()
  });

  // 8. Mark as delivered
  console.log('\n8. Marking as delivered...');
  const proofData = client.proofGenerator.encodeProof(proof);
  await client.kernel.transitionState(txId, State.DELIVERED, proofData);
  console.log('✅ State: DELIVERED');

  // 9. Wait for settlement (timeout: 2 minutes)
  console.log('\n9. Waiting for settlement...');
  try {
    await client.events.waitForState(txId, State.SETTLED, 120000);
    console.log('✅ Transaction settled!');
  } catch (error) {
    console.error('⚠️ Settlement timeout - requester needs to approve');
  }

  // 10. Get final state
  console.log('\n10. Final transaction state:');
  const finalTx = await client.kernel.getTransaction(txId);
  console.log({
    state: State[finalTx.state],
    amount: ethers.utils.formatUnits(finalTx.amount, 6) + ' USDC'
  });

  // Cleanup
  unsubscribe();
  console.log('\n✨ Example complete!');
}

// Run
main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

