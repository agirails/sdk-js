/**
 * Create EAS Schema for ACTP Delivery Proofs
 *
 * Registers a schema on Base Sepolia EAS for on-chain delivery proof attestations.
 * Schema defines the structure of delivery proofs that providers submit.
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
  console.log('🔷 Creating EAS Schema for ACTP Delivery Proofs\n');

  // Connect to Base Sepolia
  const provider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const signer = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
  const signerAddress = await signer.getAddress();

  console.log('Deployer:', signerAddress);
  console.log('Network: Base Sepolia');
  console.log('Schema Registry:', SCHEMA_REGISTRY_ADDRESS);
  console.log('');

  // Initialize Schema Registry
  const schemaRegistry = new SchemaRegistry(SCHEMA_REGISTRY_ADDRESS);
  schemaRegistry.connect(signer as any);

  // Define ACTP Delivery Proof Schema
  const schema = 'bytes32 transactionId,bytes32 deliveryHash,string deliveryProof,uint64 timestamp,string metadata';
  const revocable = true; // Allow revoking attestations (e.g., if proof was fraudulent)

  console.log('📋 Schema Definition:');
  console.log('   Fields:', schema);
  console.log('   Revocable:', revocable);
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

    // Calculate schema UID manually (keccak256 of schema string + resolver + revocable)
    const schemaUID = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ['string', 'address', 'bool'],
        [schema, ethers.constants.AddressZero, revocable]
      )
    );

    console.log('═══════════════════════════════════════');
    console.log('✅ SCHEMA CREATED SUCCESSFULLY!');
    console.log('═══════════════════════════════════════');
    console.log('Schema UID:', schemaUID);
    console.log('');
    console.log('📊 View on EAS Scan:');
    console.log(`   https://base-sepolia.easscan.org/schema/view/${schemaUID}`);
    console.log('');
    console.log('💾 Save this Schema UID to .env:');
    console.log(`   EAS_SCHEMA_UID=${schemaUID}`);

  } catch (error: any) {
    console.error('\n❌ Schema registration failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    process.exit(1);
  }
}

main().catch(console.error);
