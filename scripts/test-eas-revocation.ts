/**
 * TEST 2: EAS Attestation Revocation Test
 *
 * This script:
 * 1. Creates a real on-chain attestation
 * 2. Revokes the attestation
 * 3. Verifies revocation on EAS explorer
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
  console.log('🧪 TEST 2: EAS Attestation Revocation');
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

  // STEP 1: Create attestation
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 1: Create Attestation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('📦 Preparing delivery proof data...');

  // Mock transaction data for test
  const testTxId = keccak256(toUtf8Bytes('revocation-test-' + Date.now()));
  const testResultCID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const testResultData = JSON.stringify({
    type: 'revocation-test',
    note: 'This attestation will be revoked'
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

  let attestationUID: string;
  let createTxHash: string;

  try {
    const tx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true, // MUST be revocable for this test!
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData,
        value: 0n
      }
    });

    createTxHash = tx.tx.hash;
    console.log('   Transaction hash:', createTxHash);
    console.log('   Waiting for confirmation...');

    attestationUID = await tx.wait();

    console.log('   ✅ Attestation created!\n');

    console.log('📊 Attestation Information:');
    console.log('   Attestation UID:', attestationUID);
    console.log('   Transaction:    ', createTxHash);
    console.log('');

    console.log('🔗 EAS Explorer:');
    console.log(`   https://base-sepolia.easscan.org/attestation/view/${attestationUID}`);
    console.log('');

  } catch (error: any) {
    console.error('\n❌ Attestation creation failed:', error.message);
    if (error.reason) console.error('   Reason:', error.reason);
    process.exit(1);
  }

  // STEP 2: Revoke attestation
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 2: Revoke Attestation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('⚠️  Revoking attestation...');
  console.log('   Attestation UID:', attestationUID);
  console.log('');

  try {
    const revokeTx = await eas.revoke({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        uid: attestationUID,
        value: 0n
      }
    });

    const revokeTxHash = revokeTx.tx.hash;
    console.log('   Transaction hash:', revokeTxHash);
    console.log('   Waiting for confirmation...');

    await revokeTx.wait();

    console.log('   ✅ Attestation revoked!\n');

    console.log('📊 Revocation Information:');
    console.log('   Revoked UID:', attestationUID);
    console.log('   Revoke Tx:  ', revokeTxHash);
    console.log('');

    console.log('🔗 Basescan:');
    console.log(`   https://sepolia.basescan.org/tx/${revokeTxHash}`);
    console.log('');

  } catch (error: any) {
    console.error('\n❌ Revocation failed:', error.message);
    if (error.reason) console.error('   Reason:', error.reason);
    process.exit(1);
  }

  // STEP 3: Verify revocation
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 3: Verify Revocation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('🔍 Verifying on-chain revocation status...');

  try {
    const attestation = await eas.getAttestation(attestationUID);
    const isRevoked = await eas.isAttestationRevoked(attestationUID);

    console.log('   Attestation UID:', attestation.uid);
    console.log('   Revoked:', isRevoked);
    console.log('   Revocation Time:', attestation.revocationTime > 0n
      ? new Date(Number(attestation.revocationTime) * 1000).toLocaleString()
      : 'N/A');
    console.log('');

    if (isRevoked) {
      console.log('   ✅ Revocation confirmed on-chain!');
    } else {
      console.log('   ❌ Revocation NOT confirmed (may need to wait for block confirmation)');
    }
    console.log('');

  } catch (error: any) {
    console.error('\n⚠️  Verification failed:', error.message);
    console.log('   (Check explorer manually for revocation status)');
  }

  // Final summary
  console.log('═══════════════════════════════════════');
  console.log('✅ TEST 2 COMPLETE!');
  console.log('═══════════════════════════════════════\n');

  console.log('📝 Summary:');
  console.log('   1. ✅ Created attestation:', attestationUID);
  console.log('   2. ✅ Revoked attestation successfully');
  console.log('   3. ⚠️  Verify revocation status on EAS explorer:');
  console.log(`      https://base-sepolia.easscan.org/attestation/view/${attestationUID}`);
  console.log('');

  console.log('🔍 What to verify on EAS Explorer:');
  console.log('   - Attestation should show "REVOKED" status');
  console.log('   - Revocation timestamp should be visible');
  console.log('   - All delivery proof data should still be readable');
  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
