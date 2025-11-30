const { ethers } = require('ethers');
const ACTPKernelABI = require('./src/abi/ACTPKernel.json');

async function testABI() {
  const provider = new ethers.providers.JsonRpcProvider('https://sepolia.base.org');
  const contract = new ethers.Contract(
    '0xb5B002A73743765450d427e2F8a472C24FDABF9b',
    ACTPKernelABI,
    provider
  );

  console.log('Testing getEconomicParams()...');
  try {
    const params = await contract.getEconomicParams();
    console.log('✅ Success! Economic params:', params);
  } catch (error) {
    console.log('❌ Failed:', error.message);
  }

  console.log('\nTesting paused()...');
  try {
    const paused = await contract.paused();
    console.log('✅ Success! Paused:', paused);
  } catch (error) {
    console.log('❌ Failed:', error.message);
  }

  console.log('\nTesting createTransaction gas estimation...');
  const signer = new ethers.Wallet('0xREDACTED_KEY_COMPROMISED_DO_NOT_USE', provider);
  const contractWithSigner = contract.connect(signer);

  try {
    const txId = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const gas = await contractWithSigner.estimateGas.createTransaction(
      txId,
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      ethers.utils.parseUnits('100', 6),
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      Math.floor(Date.now() / 1000) + 3600
    );
    console.log('✅ Success! Gas estimate:', gas.toString());
  } catch (error) {
    console.log('❌ Failed:', error.message);
    console.log('Error details:', error);
  }
}

testABI();
