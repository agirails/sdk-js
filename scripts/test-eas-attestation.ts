/**
 * Test EAS Attestation Creation on Base Sepolia
 *
 * This script creates a real on-chain attestation using the deployed schema
 * to verify the complete EAS integration workflow.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { JsonRpcProvider, Wallet, ZeroAddress, keccak256, toUtf8Bytes } from 'ethers';
import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk';

// Configuration
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';
const EAS_DELIVERY_SCHEMA_UID = process.env.EAS_DELIVERY_SCHEMA_UID || '';

// Base Sepolia EAS Contract
const EAS_CONTRACT_ADDRESS = '0x4200000000000000000000000000000000000021';

// Schema definition (must match deployed schema)
const SCHEMA_STRING = 'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt';

async function main() {
  console.log('🧪 EAS Attestation Creation Test');
  console.log('═══════════════════════════════════════\n');

  // Validate environment
  if (!PROVIDER_PRIVATE_KEY || !EAS_DELIVERY_SCHEMA_UID) {
    console.error('❌ Missing environment variables');
    console.log('   Set PROVIDER_PRIVATE_KEY and EAS_DELIVERY_SCHEMA_UID');
    process.exit(1);
  }

  // Connect to Base Sepolia
  console.log('🌐 Connecting to Base Sepolia...');
  const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC);
  const signer = new Wallet(PROVIDER_PRIVATE_KEY, provider);
  const providerAddress = await signer.getAddress();

  console.log('   Provider:', providerAddress);
  console.log('   EAS Contract:', EAS_CONTRACT_ADDRESS);
  console.log('   Schema UID:', EAS_DELIVERY_SCHEMA_UID);
  console.log('');

  // Initialize EAS
  console.log('📝 Initializing EAS...');
  const eas = new EAS(EAS_CONTRACT_ADDRESS);
  eas.connect(signer);
  console.log('   ✅ Connected to EAS\n');

  // Prepare attestation data
  console.log('📦 Preparing delivery proof data...');

  // Mock transaction data for test
  const testTxId = keccak256(toUtf8Bytes('test-transaction-' + Date.now()));
  const testResultCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'; // Example CIDv1
  const testResultData = JSON.stringify({
    type: 'translation',
    language: 'en-es',
    wordCount: 1500,
    result: 'Test translation result...'
  });
  const testResultHash = keccak256(toUtf8Bytes(testResultData));
  const deliveredAt = Math.floor(Date.now() / 1000);

  console.log('   Test Transaction ID:', testTxId);
  console.log('   Result CID:', testResultCID);
  console.log('   Result Hash:', testResultHash);
  console.log('   Delivered At:', new Date(deliveredAt * 1000).toLocaleString());
  console.log('');

  // Encode attestation data
  console.log('🔷 Encoding attestation data...');
  const schemaEncoder = new SchemaEncoder(SCHEMA_STRING);

  const encodedData = schemaEncoder.encodeData([
    { name: 'txId', value: testTxId, type: 'bytes32' },
    { name: 'resultCID', value: testResultCID, type: 'string' },
    { name: 'resultHash', value: testResultHash, type: 'bytes32' },
    { name: 'deliveredAt', value: deliveredAt, type: 'uint256' }
  ]);

  console.log('   ✅ Data encoded\n');

  // Create attestation
  console.log('🚀 Creating on-chain attestation...');
  console.log('   (This will cost ~0.0001 ETH gas)');

  try {
    const tx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: ZeroAddress, // No specific recipient
        expirationTime: 0n, // No expiration
        revocable: true,
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000', // No reference
        data: encodedData,
        value: 0n
      }
    });

    console.log('   Transaction hash:', tx.tx.hash);
    console.log('   Waiting for confirmation...');

    const attestationUID = await tx.wait();

    console.log('   ✅ Attestation created!\n');

    console.log('═══════════════════════════════════════');
    console.log('✅ TEST SUCCESSFUL!');
    console.log('═══════════════════════════════════════\n');

    console.log('📊 Attestation Information:');
    console.log('   Attestation UID:', attestationUID);
    console.log('   Transaction:    ', tx.tx.hash);
    console.log('');

    console.log('🔗 Explorer Links:');
    console.log(`   EAS Explorer: https://base-sepolia.easscan.org/attestation/view/${attestationUID}`);
    console.log(`   Basescan:     https://sepolia.basescan.org/tx/${tx.tx.hash}`);
    console.log('');

    console.log('✅ Attestation is now visible on-chain!');
    console.log('   Open EAS Explorer link above to verify delivery proof data.');

  } catch (error: any) {
    console.error('\n❌ Attestation creation failed:', error.message);
    if (error.reason) console.error('   Reason:', error.reason);
    if (error.transaction) {
      console.error('   Transaction:', error.transaction.hash);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
