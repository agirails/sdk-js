/**
 * Deploy AIP-4 Delivery Proof Schema to EAS
 * Run with: npx tsx scripts/deployEASSchema.ts
 *
 * Requirements:
 * - PRIVATE_KEY environment variable (wallet with Base Sepolia ETH)
 * - Base Sepolia RPC URL (defaults to public RPC)
 */

import { ethers, Wallet } from 'ethers';
import { SchemaRegistry } from '@ethereum-attestation-service/eas-sdk';

// Base Sepolia configuration
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const SCHEMA_REGISTRY_ADDRESS = '0x4200000000000000000000000000000000000020'; // Base Sepolia

// AIP-4 Delivery Proof Schema
const DELIVERY_SCHEMA = 'bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt';
const RESOLVER_ADDRESS = ethers.constants.AddressZero; // No resolver
const REVOCABLE = false; // Attestations are non-revocable

async function main() {
  console.log('=== AIP-4 Delivery Proof Schema Deployment ===\n');

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ ERROR: PRIVATE_KEY environment variable not set');
    console.error('\nUsage:');
    console.error('  PRIVATE_KEY=0x... npx tsx scripts/deployEASSchema.ts');
    console.error('\nOr add to .env file:');
    console.error('  PRIVATE_KEY=0x...');
    process.exit(1);
  }

  // Connect to Base Sepolia
  console.log('📡 Connecting to Base Sepolia...');
  const provider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const wallet = new Wallet(privateKey, provider);

  const network = await provider.getNetwork();
  console.log(`✅ Connected to network: ${network.name} (chainId: ${network.chainId})`);

  if (network.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    console.error(`❌ ERROR: Wrong network! Expected Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}), got ${network.chainId}`);
    process.exit(1);
  }

  // Check wallet balance
  const balance = await wallet.getBalance();
  console.log(`💰 Wallet address: ${wallet.address}`);
  console.log(`💰 Balance: ${ethers.utils.formatEther(balance)} ETH`);

  if (balance.isZero()) {
    console.error('\n❌ ERROR: Wallet has no ETH for gas!');
    console.error('Get testnet ETH from:');
    console.error('  - https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet');
    console.error('  - https://sepolia-faucet.pk910.de/');
    process.exit(1);
  }

  // Initialize SchemaRegistry
  console.log('\n📝 Initializing Schema Registry...');
  const registry = new SchemaRegistry(SCHEMA_REGISTRY_ADDRESS);
  registry.connect(wallet as any);

  // Display schema details
  console.log('\n📋 Schema Details:');
  console.log(`  Schema: ${DELIVERY_SCHEMA}`);
  console.log(`  Resolver: ${RESOLVER_ADDRESS}`);
  console.log(`  Revocable: ${REVOCABLE}`);

  // Estimate gas
  console.log('\n⛽ Estimating gas...');
  try {
    const tx = await registry.register({
      schema: DELIVERY_SCHEMA,
      resolverAddress: RESOLVER_ADDRESS,
      revocable: REVOCABLE
    });

    console.log('\n🚀 Deploying schema...');
    console.log(`  Transaction hash: ${tx.tx.hash}`);

    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block: ${receipt.blockNumber}`);

    // Extract schema UID from events
    const schemaUID = receipt.logs
      .map((log: any) => {
        try {
          const parsed = registry.contract.interface.parseLog(log);
          if (parsed.name === 'Registered') {
            return parsed.args.uid;
          }
        } catch {
          return null;
        }
      })
      .filter(Boolean)[0];

    if (!schemaUID) {
      console.error('❌ ERROR: Could not extract schema UID from receipt');
      process.exit(1);
    }

    console.log('\n🎉 SUCCESS! Schema deployed!\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Schema UID: ${schemaUID}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('📍 View on EAS Scan:');
    console.log(`  https://base-sepolia.easscan.org/schema/view/${schemaUID}\n`);

    console.log('📝 Next Steps:');
    console.log('1. Update DeliveryProofBuilder.ts:');
    console.log(`   export const AGIRAILS_DELIVERY_SCHEMA_UID = '${schemaUID}';`);
    console.log('\n2. Update AIP-4.md:');
    console.log(`   Schema UID: ${schemaUID}`);
    console.log('\n3. Update aip-4-delivery.eip712.json:');
    console.log(`   "schemaUID": "${schemaUID}"`);

    console.log('\n✅ Deployment complete!');

  } catch (error) {
    console.error('\n❌ ERROR during deployment:');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);

      // Check for common errors
      if (error.message.includes('insufficient funds')) {
        console.error('\n💡 Get more testnet ETH from:');
        console.error('  - https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet');
      } else if (error.message.includes('nonce')) {
        console.error('\n💡 Nonce error - try again in a few seconds');
      } else if (error.message.includes('gas')) {
        console.error('\n💡 Gas error - check gas price and try again');
      }
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
