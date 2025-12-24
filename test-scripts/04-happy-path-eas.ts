/**
 * ACTP Happy Path Test with EAS Integration
 * Tests full transaction lifecycle with delivery attestation:
 * Create → Link → Progress → Deliver → Attest (EAS) → Settle
 *
 * Updated for SDK v2.0.0 API
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ACTPClient } from '../src/ACTPClient';
import { keccak256, toUtf8Bytes, Wallet, JsonRpcProvider } from 'ethers';
import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk';
import { getNetwork } from '../src/config/networks';

// Test wallets - derived from private keys in .env
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';
const EAS_DELIVERY_SCHEMA_UID = process.env.EAS_DELIVERY_SCHEMA_UID || '';

const CLIENT_ADDRESS = CLIENT_PRIVATE_KEY ? new Wallet(CLIENT_PRIVATE_KEY).address : '';
const PROVIDER_ADDRESS = PROVIDER_PRIVATE_KEY ? new Wallet(PROVIDER_PRIVATE_KEY).address : '';

if (!CLIENT_PRIVATE_KEY || !PROVIDER_PRIVATE_KEY || !EAS_DELIVERY_SCHEMA_UID) {
  console.error('Missing environment variables');
  console.log('Set: CLIENT_PRIVATE_KEY, PROVIDER_PRIVATE_KEY, EAS_DELIVERY_SCHEMA_UID');
  process.exit(1);
}

// Base Sepolia EAS Contract
const EAS_CONTRACT_ADDRESS = '0x4200000000000000000000000000000000000021';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('ACTP Happy Path Test with EAS Attestation (SDK v2.0.0)\n');
  console.log('Client:  ', CLIENT_ADDRESS);
  console.log('Provider:', PROVIDER_ADDRESS);
  console.log('');

  const networkConfig = getNetwork('base-sepolia');

  // Initialize clients
  const clientSDK = await ACTPClient.create({
    mode: 'testnet',
    requesterAddress: CLIENT_ADDRESS,
    privateKey: CLIENT_PRIVATE_KEY,
    rpcUrl: networkConfig.rpcUrl,
  });

  const providerSDK = await ACTPClient.create({
    mode: 'testnet',
    requesterAddress: PROVIDER_ADDRESS,
    privateKey: PROVIDER_PRIVATE_KEY,
    rpcUrl: networkConfig.rpcUrl,
  });

  console.log('SDK clients initialized\n');

  // Transaction parameters (human-readable)
  const amount = '75'; // 75 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const disputeWindow = 7200; // 2 hours

  try {
    // STEP 1: Create transaction
    console.log('STEP 1: Client creates transaction');
    console.log('   Amount:', amount, 'USDC');
    console.log('   Deadline: 24 hours');
    console.log('   Dispute window: 2 hours');

    const txId = await clientSDK.intermediate.createTransaction({
      provider: PROVIDER_ADDRESS,
      amount: amount,
      deadline: deadline,
      disputeWindow: disputeWindow,
      serviceDescription: 'Test service - translation with EAS proof',
    });

    console.log('   Transaction ID:', txId);
    await sleep(2000);

    let tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   State:', tx?.state, '(INITIATED)');
    console.log('');

    // STEP 2: Link escrow
    console.log('STEP 2: Client links escrow (SDK handles USDC approval)');
    const escrowId = await clientSDK.intermediate.linkEscrow(txId);
    console.log('   Escrow linked! ID:', escrowId);
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   State:', tx?.state, '(COMMITTED)');
    console.log('');

    // STEP 3: Provider starts work
    console.log('STEP 3: Provider starts work');
    await providerSDK.intermediate.transitionState(txId, 'IN_PROGRESS');
    console.log('   State: IN_PROGRESS');
    await sleep(2000);
    console.log('');

    // STEP 4: Provider delivers result
    console.log('STEP 4: Provider delivers result');
    await providerSDK.runtime.transitionState(txId, 'DELIVERED', '0x');
    console.log('   State: DELIVERED');
    await sleep(2000);
    console.log('');

    // STEP 5: Provider creates EAS attestation (delivery proof)
    console.log('STEP 5: Provider creates EAS delivery attestation');
    console.log('   EAS Contract:', EAS_CONTRACT_ADDRESS);
    console.log('   Schema UID:', EAS_DELIVERY_SCHEMA_UID);

    // Prepare attestation data (per AIP-6)
    const resultCID = 'QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX'; // Example IPFS CID
    const resultData = JSON.stringify({
      type: 'translation',
      language: 'en-es',
      wordCount: 1500,
      quality: 'professional'
    });
    const resultHash = keccak256(toUtf8Bytes(resultData));
    const deliveredAt = Math.floor(Date.now() / 1000);

    console.log('   Delivery proof:');
    console.log('     Result CID:', resultCID);
    console.log('     Result hash:', resultHash.slice(0, 20) + '...');
    console.log('     Delivered at:', new Date(deliveredAt * 1000).toLocaleString());

    const provider = new JsonRpcProvider(networkConfig.rpcUrl);
    const providerSigner = new Wallet(PROVIDER_PRIVATE_KEY, provider);

    console.log('   Creating on-chain EAS attestation...');

    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(providerSigner as any);

    // Schema: bytes32 txId, string resultCID, bytes32 resultHash, uint256 deliveredAt, uint256 testTimestamp
    const schemaEncoder = new SchemaEncoder('bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt,uint256 testTimestamp');
    const encodedData = schemaEncoder.encodeData([
      { name: 'txId', value: txId, type: 'bytes32' },
      { name: 'resultCID', value: resultCID, type: 'string' },
      { name: 'resultHash', value: resultHash, type: 'bytes32' },
      { name: 'deliveredAt', value: BigInt(deliveredAt), type: 'uint256' },
      { name: 'testTimestamp', value: BigInt(Date.now()), type: 'uint256' }
    ]);

    const attestationTx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: CLIENT_ADDRESS,
        expirationTime: BigInt(0),
        revocable: false, // Per AIP-6: delivery attestations are permanent
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData,
        value: BigInt(0)
      }
    });

    const attestationUID = await attestationTx.wait();

    console.log('   On-chain attestation created!');
    console.log('   Attestation UID:', attestationUID);
    console.log('   EAS Explorer: https://base-sepolia.easscan.org/attestation/view/' + attestationUID);
    await sleep(2000);
    console.log('');

    // STEP 6: Client settles transaction
    console.log('STEP 6: Client settles transaction');
    console.log('   (In production, this can happen after dispute window expires)');

    await clientSDK.intermediate.transitionState(txId, 'SETTLED');
    console.log('   Transaction settled! Payment released to provider.');
    await sleep(2000);

    tx = await clientSDK.runtime.getTransaction(txId);
    console.log('   State:', tx?.state, '(SETTLED)');
    console.log('');

    // Final summary
    console.log('=========================================');
    console.log('HAPPY PATH + EAS TEST COMPLETE!');
    console.log('=========================================');
    console.log('Transaction ID:', txId);
    console.log('Attestation UID:', attestationUID);
    console.log('Final State:   SETTLED');
    console.log('');
    console.log('Financial Summary:');
    console.log('   Gross amount:   75.00 USDC');
    console.log('   Platform fee:    0.75 USDC (1%)');
    console.log('   Provider net:   74.25 USDC');
    console.log('');
    console.log('Links:');
    console.log(`   Basescan: https://sepolia.basescan.org/tx/${txId}`);
    console.log(`   EAS Attestation: https://base-sepolia.easscan.org/attestation/view/${attestationUID}`);

  } catch (error: any) {
    console.error('\nTest failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    if (error.data) console.error('Data:', error.data);
    process.exit(1);
  }
}

main().catch(console.error);
