const crypto = require('crypto');

console.log('🔑 Generating provider test wallet...\n');

// Generate random 32 bytes for private key
const privateKeyBytes = crypto.randomBytes(32);
const privateKey = '0x' + privateKeyBytes.toString('hex');

console.log('✅ Provider wallet generated!\n');
console.log('Private Key:', privateKey);
console.log('\n⚠️  IMPORTANT: This is the PROVIDER wallet (second wallet)');
console.log('\n📝 Next step:');
console.log('Add to .env file as PROVIDER_PRIVATE_KEY');
