/**
 * ACTP Status Checker
 * Check balances and transaction status
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

import { ACTPClient } from '../src/ACTPClient';
import { formatUnits } from 'ethers/lib/utils';
import { ethers } from 'ethers';

const CLIENT_ADDRESS = '0xe174bd855aaA8d907334288323044d4cf79BfAfC';
const PROVIDER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const MOCK_USDC_ADDRESS = '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb';

const RPC_URL = 'https://sepolia.base.org';

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

const STATE_NAMES = [
  'INITIATED',
  'QUOTED',
  'COMMITTED',
  'IN_PROGRESS',
  'DELIVERED',
  'SETTLED',
  'DISPUTED',
  'CANCELLED'
];

async function main() {
  const txId = process.argv[2]; // Optional: check specific transaction

  console.log('📊 ACTP Status Check\n');
  console.log('═══════════════════════════════════════');
  console.log('WALLET BALANCES');
  console.log('═══════════════════════════════════════\n');

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const usdc = new ethers.Contract(MOCK_USDC_ADDRESS, USDC_ABI, provider);

  // Check ETH balances
  const clientEth = await provider.getBalance(CLIENT_ADDRESS);
  const providerEth = await provider.getBalance(PROVIDER_ADDRESS);

  console.log('Client Wallet:', CLIENT_ADDRESS);
  console.log('  ETH:  ', formatUnits(clientEth, 18), 'ETH');

  const clientUsdc = await usdc.balanceOf(CLIENT_ADDRESS);
  console.log('  USDC: ', formatUnits(clientUsdc, 6), 'USDC');
  console.log('');

  console.log('Provider Wallet:', PROVIDER_ADDRESS);
  console.log('  ETH:  ', formatUnits(providerEth, 18), 'ETH');

  const providerUsdc = await usdc.balanceOf(PROVIDER_ADDRESS);
  console.log('  USDC: ', formatUnits(providerUsdc, 6), 'USDC');
  console.log('');

  // If transaction ID provided, check it
  if (txId) {
    console.log('═══════════════════════════════════════');
    console.log('TRANSACTION DETAILS');
    console.log('═══════════════════════════════════════\n');

    try {
      // Need a private key just to initialize SDK (for read operations)
      const dummyKey = '0x' + '1'.repeat(64);
      const sdk = await ACTPClient.create({
        network: 'base-sepolia',
        privateKey: dummyKey
      });

      const tx = await sdk.kernel.getTransaction(txId);

      console.log('Transaction ID:', txId);
      console.log('State:        ', STATE_NAMES[tx.state], `(${tx.state})`);
      console.log('Amount:       ', formatUnits(tx.amount, 6), 'USDC');
      console.log('Requester:    ', tx.requester);
      console.log('Provider:     ', tx.provider);
      console.log('Created:      ', new Date(tx.createdAt * 1000).toLocaleString());
      console.log('Deadline:     ', new Date(tx.deadline * 1000).toLocaleString());
      console.log('Dispute Win:  ', tx.disputeWindow, 'seconds');

      if (tx.escrowContract !== ethers.constants.AddressZero) {
        console.log('Escrow:       ', tx.escrowContract);
        console.log('Escrow ID:    ', tx.escrowId);
      }

      if (tx.metadata && tx.metadata !== ethers.constants.HashZero) {
        console.log('Metadata:     ', tx.metadata);
      }

      console.log('');
      console.log('🔗 View on Basescan:');
      console.log(`   https://sepolia.basescan.org/address/${tx.escrowContract || 'N/A'}`);

    } catch (error: any) {
      console.error('❌ Error fetching transaction:', error.message);
    }
  } else {
    console.log('💡 Tip: Add transaction ID as argument to see details');
    console.log('   Usage: npm run test:status <txId>');
  }

  console.log('');
}

main().catch(console.error);
