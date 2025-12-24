/**
 * Deploy Official AIP-6 EAS Schema for ACTP Delivery Proofs
 * Updated for ethers v6
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SchemaRegistry } from '@ethereum-attestation-service/eas-sdk';
import { JsonRpcProvider, Wallet, ZeroAddress, keccak256, AbiCoder } from 'ethers';

// Base Sepolia EAS Contracts
const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

// Admin wallet (schema creator)
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || '';

if (!ADMIN_PRIVATE_KEY) {
  console.error('Missing ADMIN_PRIVATE_KEY in .env');
  process.exit(1);
}

async function main() {
  console.log('Creating Official AIP-6 EAS Schema for Delivery Proofs\n');

  // Connect to Base Sepolia
  const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC);
  const signer = new Wallet(ADMIN_PRIVATE_KEY, provider);
  const signerAddress = await signer.getAddress();

  console.log('Deployer:', signerAddress);
  console.log('Network: Base Sepolia (Chain ID: 84532)');
  console.log('Schema Registry:', SCHEMA_REGISTRY_ADDRESS);
  console.log('');

  // Initialize Schema Registry
  const schemaRegistry = new SchemaRegistry(SCHEMA_REGISTRY_ADDRESS);
  schemaRegistry.connect(signer as any);

  // OFFICIAL AIP-6 Delivery Proof Schema
  const schema = 'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt';
  const revocable = false; // Per AIP-6: delivery attestations are PERMANENT

  console.log('Schema Definition:', schema);
  console.log('Revocable:', revocable);
  console.log('');

  // Calculate expected schema UID
  const abiCoder = AbiCoder.defaultAbiCoder();
  const expectedSchemaUID = keccak256(
    abiCoder.encode(
      ['string', 'address', 'bool'],
      [schema, ZeroAddress, revocable]
    )
  );
  console.log('Expected Schema UID:', expectedSchemaUID);

  try {
    console.log('\nRegistering schema on-chain...');

    const transaction = await schemaRegistry.register({
      schema,
      resolverAddress: ZeroAddress,
      revocable,
    });

    console.log('Transaction hash:', transaction);

    // Wait for confirmation
    const receipt = await transaction.wait();
    console.log('Confirmed in block:', receipt);

    console.log('\n=========================================');
    console.log('AIP-6 SCHEMA CREATED SUCCESSFULLY!');
    console.log('=========================================');
    console.log('Schema UID:', expectedSchemaUID);
    console.log('');
    console.log('View on EAS Scan:');
    console.log(`https://base-sepolia.easscan.org/schema/view/${expectedSchemaUID}`);
    console.log('');
    console.log('Add to .env:');
    console.log(`EAS_DELIVERY_SCHEMA_UID=${expectedSchemaUID}`);

  } catch (error: any) {
    if (error.message?.includes('AlreadyExists') || error.message?.includes('already exists')) {
      console.log('\nSchema already exists! Using existing schema.');
      console.log('Schema UID:', expectedSchemaUID);
      console.log('\nAdd to .env:');
      console.log(`EAS_DELIVERY_SCHEMA_UID=${expectedSchemaUID}`);
    } else {
      console.error('\nSchema registration failed:', error.message);
      if (error.reason) console.error('Reason:', error.reason);
      process.exit(1);
    }
  }
}

main().catch(console.error);
