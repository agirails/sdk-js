#!/usr/bin/env ts-node
/**
 * EAS Schema Registration Script
 *
 * Registers the AIP-6 delivery proof schema on EAS SchemaRegistry.
 * Run this on mainnet before first deployment.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx ts-node scripts/register-eas-schema.ts [network]
 *
 * Networks: base-sepolia, base-mainnet
 *
 * AIP-6 Delivery Proof Schema:
 *   bytes32 txId, string resultCID, bytes32 resultHash, uint256 deliveredAt
 */

import { ethers } from 'ethers';
import { SchemaRegistry } from '@ethereum-attestation-service/eas-sdk';

// Network configurations
const NETWORKS: Record<string, { rpcUrl: string; schemaRegistry: string; name: string }> = {
  'base-sepolia': {
    rpcUrl: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
    schemaRegistry: '0x4200000000000000000000000000000000000020',
    name: 'Base Sepolia',
  },
  'base-mainnet': {
    rpcUrl: process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org',
    schemaRegistry: '0x4200000000000000000000000000000000000020',
    name: 'Base Mainnet',
  },
};

// AIP-6 Delivery Proof Schema
const DELIVERY_PROOF_SCHEMA = 'bytes32 txId, string resultCID, bytes32 resultHash, uint256 deliveredAt';

// Resolver address (0x0 = no resolver, attestations are self-contained)
const RESOLVER_ADDRESS = '0x0000000000000000000000000000000000000000';

// Revocable flag (true = attestations can be revoked if needed)
const REVOCABLE = true;

async function main() {
  // Parse network from args
  const network = process.argv[2] || 'base-sepolia';
  const networkConfig = NETWORKS[network];

  if (!networkConfig) {
    console.error(`❌ Unknown network: ${network}`);
    console.error(`   Available networks: ${Object.keys(NETWORKS).join(', ')}`);
    process.exit(1);
  }

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ PRIVATE_KEY environment variable is required');
    console.error('   Usage: PRIVATE_KEY=0x... npx ts-node scripts/register-eas-schema.ts [network]');
    process.exit(1);
  }

  console.log(`\n🔧 EAS Schema Registration`);
  console.log(`   Network: ${networkConfig.name} (${network})`);
  console.log(`   Schema Registry: ${networkConfig.schemaRegistry}`);
  console.log(`   Schema: ${DELIVERY_PROOF_SCHEMA}`);
  console.log(`   Resolver: ${RESOLVER_ADDRESS} (none)`);
  console.log(`   Revocable: ${REVOCABLE}`);
  console.log('');

  // Create provider and signer
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  // Check balance
  const balance = await provider.getBalance(signer.address);
  console.log(`   Signer: ${signer.address}`);
  console.log(`   Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error('\n❌ Signer has no ETH for gas. Fund the account first.');
    process.exit(1);
  }

  // Initialize SchemaRegistry
  const schemaRegistry = new SchemaRegistry(networkConfig.schemaRegistry);
  schemaRegistry.connect(signer);

  console.log('\n📝 Registering schema...');

  try {
    const tx = await schemaRegistry.register({
      schema: DELIVERY_PROOF_SCHEMA,
      resolverAddress: RESOLVER_ADDRESS,
      revocable: REVOCABLE,
    });

    console.log(`   Transaction hash: ${tx.tx.hash}`);
    console.log('   Waiting for confirmation...');

    // Wait for transaction and get schema UID
    // Transaction<string>.wait() returns the schema UID
    const schemaUID = await tx.wait();

    // Get gas from transaction receipt
    const receipt = await tx.tx.wait();

    console.log(`\n✅ Schema registered successfully!`);
    console.log(`   Schema UID: ${schemaUID}`);
    console.log(`   Gas used: ${receipt?.gasUsed?.toString() || 'unknown'}`);

    console.log(`\n📋 Update networks.ts with this value:`);
    console.log(`   eas: {`);
    console.log(`     deliverySchemaUID: '${schemaUID}'`);
    console.log(`   }`);

    // Verify registration
    console.log('\n🔍 Verifying registration...');
    const schema = await schemaRegistry.getSchema({ uid: schemaUID });
    console.log(`   UID: ${schema.uid}`);
    console.log(`   Schema: ${schema.schema}`);
    console.log(`   Resolver: ${schema.resolver}`);
    console.log(`   Revocable: ${schema.revocable}`);

    console.log('\n✨ Done! Schema is ready to use.');

  } catch (error: any) {
    // Check if schema already exists
    if (error.message?.includes('already registered') || error.message?.includes('AlreadyExists')) {
      console.log('\n⚠️  Schema may already be registered.');
      console.log('   Computing schema UID from definition...');

      // The schema UID is keccak256(abi.encodePacked(schema, resolver, revocable))
      // EAS uses specific encoding - need to check existing registration
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['string', 'address', 'bool'],
        [DELIVERY_PROOF_SCHEMA, RESOLVER_ADDRESS, REVOCABLE]
      );
      const computedUID = ethers.keccak256(encodedData);
      console.log(`   Computed UID (may differ from actual): ${computedUID}`);
      console.log('   Check EAS scan for the actual UID or query the registry.');
    } else {
      console.error('\n❌ Failed to register schema:', error.message);
      throw error;
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
