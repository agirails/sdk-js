const crypto = require('crypto');

console.log('🔑 Generating new test wallet...\n');

// Generate random 32 bytes for private key
const privateKeyBytes = crypto.randomBytes(32);
const privateKey = '0x' + privateKeyBytes.toString('hex');

console.log('✅ Wallet generated!\n');
console.log('Private Key:', privateKey);
console.log('\n⚠️  IMPORTANT: Save this private key securely!');
console.log('\n📝 Next steps:');
console.log('1. Add to .env file:');
console.log('   PRIVATE_KEY=' + privateKey);
console.log('\n2. Derive address (run this after npm install):');
console.log('   npx ts-node -e "const ethers = require(\'ethers\'); const w = new ethers.Wallet(\'' + privateKey + '\'); console.log(\'Address:\', w.address);"');
console.log('\n3. Get testnet ETH from faucet after you get the address');
