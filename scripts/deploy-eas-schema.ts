/**
 * Deploy AGIRAILS Delivery Proof Schema to Base Sepolia EAS
 *
 * Schema per AIP-4 §4.1:
 * bytes32 txId, string resultCID, bytes32 resultHash, uint256 deliveredAt
 *
 * This script:
 * 1. Connects to Base Sepolia EAS SchemaRegistry
 * 2. Registers the delivery proof schema
 * 3. Records the schema UID for use in SDK and contracts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { JsonRpcProvider, Wallet, ZeroAddress, formatEther } from 'ethers';
import { SchemaRegistry } from '@ethereum-attestation-service/eas-sdk';

// Base Sepolia configuration
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const DEPLOYER_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || process.env.PRIVATE_KEY || '';

// Base Sepolia EAS Contracts
const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020';

// AIP-4 Schema Definition
const SCHEMA_STRING = 'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt';
const SCHEMA_RESOLVER = ZeroAddress; // No custom resolver (ethers v6)
const SCHEMA_REVOCABLE = true; // Allow revocation for dispute scenarios

async function main() {
  console.log('🔷 AGIRAILS EAS Schema Deployment');
  console.log('═══════════════════════════════════════\n');

  // Validate environment
  if (!DEPLOYER_PRIVATE_KEY) {
    console.error('❌ Missing DEPLOYER_PRIVATE_KEY in .env');
    console.log('   Set CLIENT_PRIVATE_KEY or PRIVATE_KEY');
    process.exit(1);
  }

  // Connect to Base Sepolia
  console.log('🌐 Connecting to Base Sepolia...');
  const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC);
  const signer = new Wallet(DEPLOYER_PRIVATE_KEY, provider);
  const deployerAddress = await signer.getAddress();

  console.log('   Deployer:', deployerAddress);
  console.log('   Network: Base Sepolia (chainId 84532)');
  console.log('   Schema Registry:', SCHEMA_REGISTRY_ADDRESS);
  console.log('');

  // Check balance
  const balance = await provider.getBalance(deployerAddress);
  console.log('   Balance:', formatEther(balance), 'ETH');

  if (balance === 0n) {
    console.error('❌ Deployer has zero ETH balance');
    console.log('   Fund address with Base Sepolia ETH from faucet:');
    console.log('   https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet');
    process.exit(1);
  }

  console.log('');

  // Initialize SchemaRegistry
  console.log('📝 Initializing EAS SchemaRegistry...');
  const schemaRegistry = new SchemaRegistry(SCHEMA_REGISTRY_ADDRESS);
  schemaRegistry.connect(signer);
  console.log('   ✅ Connected to SchemaRegistry\n');

  // Display schema details
  console.log('📋 Schema Details (AIP-4 §4.1):');
  console.log('   Schema String:', SCHEMA_STRING);
  console.log('   Resolver:     ', SCHEMA_RESOLVER, '(no custom logic)');
  console.log('   Revocable:    ', SCHEMA_REVOCABLE);
  console.log('');

  // Register schema
  console.log('🚀 Registering schema on-chain...');
  console.log('   (This will cost ~0.0001 ETH gas)');

  try {
    const transaction = await schemaRegistry.register({
      schema: SCHEMA_STRING,
      resolverAddress: SCHEMA_RESOLVER,
      revocable: SCHEMA_REVOCABLE
    });

    console.log('   Transaction hash:', transaction.tx.hash);
    console.log('   Waiting for confirmation...');

    // Wait for transaction - returns schema UID (Transaction<string>.wait() => string)
    const schemaUID = await transaction.wait();

    console.log('   ✅ Schema registered!\n');

    console.log('═══════════════════════════════════════');
    console.log('✅ DEPLOYMENT SUCCESSFUL!');
    console.log('═══════════════════════════════════════\n');

    console.log('📊 Schema Information:');
    console.log('   Schema UID:   ', schemaUID);
    console.log('   Transaction:  ', transaction.tx.hash);
    console.log('');

    console.log('🔗 Explorer Links:');
    console.log(`   EAS Explorer: https://base-sepolia.easscan.org/schema/view/${schemaUID}`);
    console.log(`   Basescan:     https://sepolia.basescan.org/tx/${transaction.tx.hash}`);
    console.log('');

    console.log('📝 Next Steps:');
    console.log('   1. Add to .env file:');
    console.log(`      EAS_DELIVERY_SCHEMA_UID=${schemaUID}`);
    console.log('   2. Update AIP-4.md §4.1 with schema UID');
    console.log('   3. Update SDK config (src/config/networks.ts)');
    console.log('   4. Run integration test: npm run test:happy-path-eas');
    console.log('');

    // Write schema UID to file for automated workflows
    const fs = require('fs');
    const outputPath = '.eas-schema-uid';
    fs.writeFileSync(outputPath, schemaUID);
    console.log(`   ✅ Schema UID saved to: ${outputPath}`);

  } catch (error: any) {
    console.error('\n❌ Deployment failed:', error.message);
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
