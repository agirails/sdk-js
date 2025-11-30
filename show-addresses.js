const { Wallet } = require('ethers');
require('dotenv').config();

console.log('📋 Wallet Addresses:\n');

const requesterKey = process.env.PRIVATE_KEY;
const providerKey = process.env.PROVIDER_PRIVATE_KEY;

if (!requesterKey) {
  console.log('❌ PRIVATE_KEY not found in .env');
} else {
  const requester = new Wallet(requesterKey);
  console.log('Requester:', requester.address);
}

if (!providerKey) {
  console.log('❌ PROVIDER_PRIVATE_KEY not found in .env');
} else {
  const provider = new Wallet(providerKey);
  console.log('Provider:', provider.address);
}

console.log('\n💰 Next step: Fund the provider wallet with Base Sepolia ETH from:');
console.log('   https://www.alchemy.com/faucets/base-sepolia');
console.log('   or https://cloud.google.com/application/web3/faucet/ethereum/sepolia');
