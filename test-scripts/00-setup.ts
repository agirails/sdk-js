/**
 * ACTP Test Setup - Mint MockUSDC to test wallets
 * Run this FIRST before any tests
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

import { ethers, parseUnits, formatUnits, JsonRpcProvider, Wallet, Contract } from 'ethers';

// Base Sepolia configuration
const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
const MOCK_USDC_ADDRESS = process.env.MOCK_USDC_ADDRESS || '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb';

// You need to set these environment variables
// NOTE: MockUSDC has OPEN MINTING - any wallet can mint!
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || CLIENT_PRIVATE_KEY || '';

// Derive addresses from private keys (don't hardcode)
const CLIENT_ADDRESS = CLIENT_PRIVATE_KEY ? new Wallet(CLIENT_PRIVATE_KEY).address : '';
const PROVIDER_ADDRESS = PROVIDER_PRIVATE_KEY ? new Wallet(PROVIDER_PRIVATE_KEY).address : '';

if (!ADMIN_PRIVATE_KEY) {
  console.error('❌ Missing ADMIN_PRIVATE_KEY environment variable');
  console.log('💡 TIP: MockUSDC has open minting - use ANY wallet with ETH for gas');
  console.log('   You can even use: ADMIN_PRIVATE_KEY=<same as CLIENT_PRIVATE_KEY>');
  console.log('');
  console.log('Set it with: export ADMIN_PRIVATE_KEY="0x..."');
  process.exit(1);
}

const USDC_ABI = [
  'function mint(address to, uint256 amount) external',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

async function main() {
  console.log('🚀 ACTP Test Setup - Minting MockUSDC\n');

  const provider = new JsonRpcProvider(RPC_URL);
  const adminWallet = new Wallet(ADMIN_PRIVATE_KEY, provider);
  const usdc = new Contract(MOCK_USDC_ADDRESS, USDC_ABI, adminWallet);

  console.log('Admin wallet:', adminWallet.address);
  console.log('MockUSDC:', MOCK_USDC_ADDRESS);
  console.log('');

  // Mint amounts
  const MINT_AMOUNT = parseUnits('10000', 6); // 10,000 USDC each

  try {
    // Mint to client
    console.log('💰 Minting 10,000 USDC to CLIENT...');
    console.log('   Address:', CLIENT_ADDRESS);
    const tx1 = await usdc.mint(CLIENT_ADDRESS, MINT_AMOUNT);
    console.log('   Tx:', tx1.hash);
    await tx1.wait();
    console.log('   ✅ Confirmed!');

    // Mint to provider
    console.log('\n💰 Minting 10,000 USDC to PROVIDER...');
    console.log('   Address:', PROVIDER_ADDRESS);
    const tx2 = await usdc.mint(PROVIDER_ADDRESS, MINT_AMOUNT);
    console.log('   Tx:', tx2.hash);
    await tx2.wait();
    console.log('   ✅ Confirmed!');

    // Check balances
    console.log('\n📊 Final Balances:');
    const clientBalance = await usdc.balanceOf(CLIENT_ADDRESS);
    const providerBalance = await usdc.balanceOf(PROVIDER_ADDRESS);

    console.log('   Client:  ', formatUnits(clientBalance, 6), 'USDC');
    console.log('   Provider:', formatUnits(providerBalance, 6), 'USDC');

    console.log('\n✅ Setup complete! Ready to run tests.');
    console.log('\nNext steps:');
    console.log('1. Set CLIENT_PRIVATE_KEY and PROVIDER_PRIVATE_KEY env vars');
    console.log('2. Run: npm run test:happy-path');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    process.exit(1);
  }
}

main().catch(console.error);
