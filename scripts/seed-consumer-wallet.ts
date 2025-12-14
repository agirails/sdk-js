#!/usr/bin/env npx ts-node
/**
 * Seed Consumer Wallet from Provider Wallet
 *
 * Transfers ETH from provider to consumer on Base Sepolia.
 * Never prints private keys - only addresses and tx hashes.
 */

import { config } from 'dotenv';
import { ethers } from 'ethers';
import * as path from 'path';

// Load env files
config({ path: path.resolve(__dirname, '../.env.test') });
config({ path: path.resolve(__dirname, '../.env') });

const EXPECTED_CHAIN_ID = 84532;
const EXPECTED_CONSUMER = '0x4b44169753188a6F08F872Ee6f3cf4661bA254C8';
const TRANSFER_AMOUNT = ethers.parseEther('0.002');
const MIN_PROVIDER_BALANCE = ethers.parseEther('0.003'); // Need buffer for gas

async function main() {
  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');

  // Step 1: Confirm chainId
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log(`Chain ID: ${chainId}`);

  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`ABORT: Wrong chain! Expected ${EXPECTED_CHAIN_ID}, got ${chainId}`);
    process.exit(1);
  }
  console.log('Chain: Base Sepolia (OK)\n');

  // Step 2: Derive addresses
  const providerKey = process.env.ACTP_PROVIDER_PRIVATE_KEY;
  const consumerKey = process.env.AGIRAILS_PRIVATE_KEY;

  if (!providerKey) {
    console.error('ABORT: ACTP_PROVIDER_PRIVATE_KEY not set');
    process.exit(1);
  }
  if (!consumerKey) {
    console.error('ABORT: AGIRAILS_PRIVATE_KEY not set');
    process.exit(1);
  }

  const providerWallet = new ethers.Wallet(providerKey, provider);
  const consumerWallet = new ethers.Wallet(consumerKey, provider);

  console.log(`Provider address: ${providerWallet.address}`);
  console.log(`Consumer address: ${consumerWallet.address}`);

  // Verify consumer matches expected
  if (consumerWallet.address.toLowerCase() !== EXPECTED_CONSUMER.toLowerCase()) {
    console.error(`\nABORT: Consumer address mismatch!`);
    console.error(`  Expected: ${EXPECTED_CONSUMER}`);
    console.error(`  Derived:  ${consumerWallet.address}`);
    process.exit(1);
  }
  console.log('Consumer address match: OK\n');

  // Step 3: Check balances
  const providerBalance = await provider.getBalance(providerWallet.address);
  const consumerBalanceBefore = await provider.getBalance(consumerWallet.address);

  console.log(`Provider ETH: ${ethers.formatEther(providerBalance)}`);
  console.log(`Consumer ETH (before): ${ethers.formatEther(consumerBalanceBefore)}\n`);

  // Check provider has enough
  if (providerBalance < MIN_PROVIDER_BALANCE) {
    console.error(`ABORT: Provider balance too low (need >= ${ethers.formatEther(MIN_PROVIDER_BALANCE)} ETH)`);
    process.exit(1);
  }

  // Step 4: Send ETH
  console.log(`Sending ${ethers.formatEther(TRANSFER_AMOUNT)} ETH to consumer...`);

  const tx = await providerWallet.sendTransaction({
    to: EXPECTED_CONSUMER,
    value: TRANSFER_AMOUNT
  });

  console.log(`\nTx hash: ${tx.hash}`);
  console.log(`Explorer: https://sepolia.basescan.org/tx/${tx.hash}`);

  // Step 5: Wait for confirmation
  console.log('\nWaiting for 1 confirmation...');
  const receipt = await tx.wait(1);

  if (receipt?.status === 1) {
    console.log('Transaction confirmed!\n');
  } else {
    console.error('Transaction failed!');
    process.exit(1);
  }

  // Step 6: Re-check consumer balance
  const consumerBalanceAfter = await provider.getBalance(consumerWallet.address);
  console.log(`Consumer ETH (after): ${ethers.formatEther(consumerBalanceAfter)}`);
  console.log(`Increase: +${ethers.formatEther(consumerBalanceAfter - consumerBalanceBefore)} ETH`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
