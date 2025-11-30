/**
 * Create Official AIP-6 EAS Schema for ACTP Delivery Proofs
 *
 * Per AIP-6 §5.1: Deploy official delivery attestation schema to Base Sepolia EAS.
 * This schema EXACTLY matches the AIP-6 specification.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SchemaRegistry } from '@ethereum-attestation-service/eas-sdk';
import { ethers } from 'ethers';

// Base Sepolia EAS Contracts
const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

// Admin wallet (schema creator)
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || '';

if (!ADMIN_PRIVATE_KEY) {
  console.error('❌ Missing ADMIN_PRIVATE_KEY in .env');
  process.exit(1);
}

async function main() {
  console.log('🔷 Creating Official AIP-6 EAS Schema for Delivery Proofs\n');
  console.log('📖 Reference: AIP-6 §5.1 - Delivery Attestation Schema\n');

  // Connect to Base Sepolia
  const provider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const signer = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
  const signerAddress = await signer.getAddress();

  console.log('Deployer:', signerAddress);
  console.log('Network: Base Sepolia (Chain ID: 84532)');
  console.log('Schema Registry:', SCHEMA_REGISTRY_ADDRESS);
  console.log('EAS Contract: 0x4200000000000000000000000000000000000021');
  console.log('');

  // Initialize Schema Registry
  const schemaRegistry = new SchemaRegistry(SCHEMA_REGISTRY_ADDRESS);
  schemaRegistry.connect(signer as any);

  // OFFICIAL AIP-6 Delivery Proof Schema (per AIP-6 §5.1)
  const schema = 'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt';
  const revocable = false; // Attestations are PERMANENT (per AIP-6 §2.1)

  console.log('📋 Official AIP-6 Schema Definition:');
  console.log('   Schema: ', schema);
  console.log('   Revocable: ', revocable, '(permanent attestations)');
  console.log('');
  console.log('📚 Field Definitions:');
  console.log('   - bytes32 txId:       ACTP transaction ID');
  console.log('   - string resultCID:   IPFS CID of delivered work');
  console.log('   - bytes32 resultHash: Keccak256 hash of result');
  console.log('   - uint256 deliveredAt: Unix timestamp of delivery');
  console.log('');

  try {
    console.log('🔄 Registering schema on-chain...');

    const transaction = await schemaRegistry.register({
      schema,
      resolverAddress: ethers.constants.AddressZero, // No custom resolver
      revocable,
    });

    console.log('   Transaction hash:', transaction);

    // Wait for confirmation
    await transaction.wait();

    console.log('   ✅ Schema registered!');
    console.log('');

    // Calculate schema UID (deterministic based on schema content)
    const schemaUID = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['string', 'address', 'bool'],
        [schema, ethers.constants.AddressZero, revocable]
      )
    );

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ OFFICIAL AIP-6 SCHEMA CREATED SUCCESSFULLY!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Schema UID:', schemaUID);
    console.log('');
    console.log('📊 View on EAS Scan:');
    console.log(`   https://base-sepolia.easscan.org/schema/view/${schemaUID}`);
    console.log('');
    console.log('💾 Update .env:');
    console.log(`   EAS_DELIVERY_SCHEMA_UID=${schemaUID}`);
    console.log('');
    console.log('📝 Update AIP-6.md:');
    console.log(`   Line 169: Schema UID: ${schemaUID}`);
    console.log('   Line 71: Status: ✅ DEPLOYED');

  } catch (error: any) {
    console.error('\n❌ Schema registration failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    process.exit(1);
  }
}

main().catch(console.error);
