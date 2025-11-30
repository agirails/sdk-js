import * as dotenv from 'dotenv';
dotenv.config();

import { ACTPClient } from '../src/ACTPClient';
import { parseUnits } from 'ethers/lib/utils';
import { ethers } from 'ethers';

const CLIENT_ADDRESS = '0xe174bd855aaA8d907334288323044d4cf79BfAfC';
const PROVIDER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';

async function main() {
  console.log('🔍 Debug Create Transaction\n');

  const client = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: CLIENT_PRIVATE_KEY
  });

  const amount = parseUnits('100', 6);
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const disputeWindow = 7200;
  const metadata = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Test'));

  console.log('Params:');
  console.log('  Provider:', PROVIDER_ADDRESS);
  console.log('  Requester:', CLIENT_ADDRESS);
  console.log('  Amount:', amount.toString(), '(100 USDC)');
  console.log('  Deadline:', deadline);
  console.log('  DisputeWindow:', disputeWindow);
  console.log('  Metadata:', metadata);
  console.log('');

  try {
    console.log('Calling createTransaction...');
    const txId = await client.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: CLIENT_ADDRESS,
      amount,
      deadline,
      disputeWindow,
      metadata
    });
    console.log('✅ Success! TxID:', txId);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.error) console.error('Inner error:', JSON.stringify(error.error, null, 2));
    if (error.reason) console.error('Reason:', error.reason);
    if (error.code) console.error('Code:', error.code);
    if (error.transaction) {
      console.error('Transaction:', JSON.stringify(error.transaction, null, 2));
    }
    throw error;
  }
}

main().catch(console.error);
