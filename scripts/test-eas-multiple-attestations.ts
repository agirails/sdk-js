/**
 * TEST 4: Multiple Attestations Per Transaction
 *
 * This script:
 * 1. Creates multiple attestations for the same txId
 * 2. Verifies all attestations are created successfully
 * 3. Checks if EAS enforces uniqueness (expected: no)
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

// Number of attestations to create for the same txId
const NUM_ATTESTATIONS = 3;

async function main() {
  console.log('🧪 TEST 4: Multiple Attestations Per Transaction');
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

  // Single txId for all attestations
  const testTxId = keccak256(toUtf8Bytes('multiple-attestation-test-' + Date.now()));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TEST SCENARIO: Same txId, Multiple Attestations');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('   Shared Transaction ID:', testTxId);
  console.log('   Number of Attestations:', NUM_ATTESTATIONS);
  console.log('');

  console.log('📊 Expected Behavior:');
  console.log('   - EAS does NOT enforce uniqueness on schema fields');
  console.log('   - Each attestation gets unique UID regardless of duplicate data');
  console.log('   - All attestations should be created successfully');
  console.log('');

  const attestationUIDs: string[] = [];
  const schemaEncoder = new SchemaEncoder(SCHEMA_STRING);

  // Create multiple attestations
  for (let i = 1; i <= NUM_ATTESTATIONS; i++) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`ATTESTATION ${i}/${NUM_ATTESTATIONS}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Different result data for each attestation
    const testResultCID = `bafybeig${i.toString().padStart(48, '0')}`; // Unique CID
    const testResultData = JSON.stringify({
      type: 'multiple-attestation-test',
      attemptNumber: i,
      timestamp: Date.now()
    });
    const testResultHash = keccak256(toUtf8Bytes(testResultData));
    const deliveredAt = Math.floor(Date.now() / 1000);

    console.log('   Transaction ID:', testTxId, '(SAME)');
    console.log('   Result CID:', testResultCID, `(unique #${i})`);
    console.log('   Result Hash:', testResultHash);
    console.log('   Delivered At:', new Date(deliveredAt * 1000).toLocaleString());
    console.log('');

    // Encode attestation data
    const encodedData = schemaEncoder.encodeData([
      { name: 'txId', value: testTxId, type: 'bytes32' },
      { name: 'resultCID', value: testResultCID, type: 'string' },
      { name: 'resultHash', value: testResultHash, type: 'bytes32' },
      { name: 'deliveredAt', value: deliveredAt, type: 'uint256' }
    ]);

    console.log(`🚀 Creating attestation ${i}/${NUM_ATTESTATIONS}...`);

    try {
      const tx = await eas.attest({
        schema: EAS_DELIVERY_SCHEMA_UID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
          data: encodedData,
          value: 0n
        }
      });

      const txHash = tx.tx.hash;
      console.log('   Transaction hash:', txHash);
      console.log('   Waiting for confirmation...');

      const attestationUID = await tx.wait();

      console.log(`   ✅ Attestation ${i} created!`);
      console.log('   Attestation UID:', attestationUID);
      console.log('');

      attestationUIDs.push(attestationUID);

      // Wait 2 seconds between attestations to avoid nonce issues
      if (i < NUM_ATTESTATIONS) {
        console.log('   ⏳ Waiting 2 seconds before next attestation...\n');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch (error: any) {
      console.error(`\n❌ Attestation ${i} creation failed:`, error.message);
      if (error.reason) console.error('   Reason:', error.reason);
      console.log(`\n   Stopping after ${i - 1} successful attestations.`);
      break;
    }
  }

  // Summary
  console.log('═══════════════════════════════════════');
  console.log('✅ TEST 4 COMPLETE!');
  console.log('═══════════════════════════════════════\n');

  console.log('📝 Results:');
  console.log(`   Total Attestations Created: ${attestationUIDs.length}/${NUM_ATTESTATIONS}`);
  console.log(`   Shared Transaction ID: ${testTxId}`);
  console.log('');

  console.log('📊 Attestation UIDs:');
  attestationUIDs.forEach((uid, index) => {
    console.log(`   ${index + 1}. ${uid}`);
  });
  console.log('');

  console.log('🔗 EAS Explorer Links:');
  attestationUIDs.forEach((uid, index) => {
    console.log(`   ${index + 1}. https://base-sepolia.easscan.org/attestation/view/${uid}`);
  });
  console.log('');

  console.log('🔍 What to verify on EAS Explorer:');
  console.log('   1. All attestations should have the SAME txId');
  console.log('   2. Each attestation has a UNIQUE attestation UID');
  console.log('   3. Each attestation has different resultCID/resultHash');
  console.log('   4. EAS does NOT enforce uniqueness on txId field');
  console.log('');

  console.log('⚠️  Implications for ACTP Protocol:');
  console.log('   - Provider can create multiple delivery attestations for same transaction');
  console.log('   - Consumer MUST select correct attestation (latest? highest quality?)');
  console.log('   - ACTPKernel.anchorAttestation() accepts any attestation UID');
  console.log('   - Future: Consider uniqueness enforcement in ACTPKernel V2');
  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
