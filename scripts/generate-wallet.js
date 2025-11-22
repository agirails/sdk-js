const ethers = require('ethers');

console.log('🔑 Generating new test wallet...\n');

const wallet = ethers.Wallet.createRandom();

console.log('✅ Wallet created!\n');
console.log('Address:', wallet.address);
console.log('Private Key:', wallet.privateKey);
console.log('\n📝 Add to .env file:');
console.log('PRIVATE_KEY=' + wallet.privateKey);
console.log('\n💰 Get testnet ETH:');
console.log('https://www.coinbase.com/faucets/base-ethereum-goerli-faucet');
console.log('Paste address:', wallet.address);
