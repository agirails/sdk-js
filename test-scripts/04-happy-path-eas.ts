/**
 * ACTP Happy Path Test with EAS Integration
 * Tests full transaction lifecycle with delivery attestation:
 * Create → Link → Progress → Deliver → Attest (EAS) → Settle
 */

import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

import { ACTPClient } from '../src/ACTPClient';
import { parseUnits, formatUnits, keccak256, toUtf8Bytes, AbiCoder, Wallet, Contract } from 'ethers';
import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk';

// Test wallets
const CLIENT_ADDRESS = '0xe174bd855aaA8d907334288323044d4cf79BfAfC';
const PROVIDER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';
const EAS_DELIVERY_SCHEMA_UID = process.env.EAS_DELIVERY_SCHEMA_UID || '';

if (!CLIENT_PRIVATE_KEY || !PROVIDER_PRIVATE_KEY || !EAS_DELIVERY_SCHEMA_UID) {
  console.error('❌ Missing environment variables');
  console.log('Set: CLIENT_PRIVATE_KEY, PROVIDER_PRIVATE_KEY, EAS_DELIVERY_SCHEMA_UID');
  process.exit(1);
}

// Base Sepolia EAS Contract
const EAS_CONTRACT_ADDRESS = '0x4200000000000000000000000000000000000021';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 ACTP Happy Path Test with EAS Attestation\n');
  console.log('Client:  ', CLIENT_ADDRESS);
  console.log('Provider:', PROVIDER_ADDRESS);
  console.log('');

  // Initialize clients
  const clientSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: CLIENT_PRIVATE_KEY
  });

  const providerSDK = await ACTPClient.create({
    network: 'base-sepolia',
    privateKey: PROVIDER_PRIVATE_KEY
  });

  console.log('✅ SDK clients initialized\n');

  // Transaction parameters
  const amount = parseUnits('100', 6); // 100 USDC
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const disputeWindow = 7200; // 2 hours
  const metadata = keccak256(toUtf8Bytes('Test service - translation with EAS proof'));

  try {
    // STEP 1: Create transaction
    console.log('📝 STEP 1: Client creates transaction');
    console.log('   Amount:', formatUnits(amount, 6), 'USDC');
    console.log('   Deadline: 24 hours');
    console.log('   Dispute window: 2 hours');

    const txId = await clientSDK.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: CLIENT_ADDRESS,
      amount,
      deadline,
      disputeWindow,
      metadata
    });

    console.log('   ✅ Transaction ID:', txId);
    await sleep(2000);

    // Check state
    let tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(INITIATED)');
    console.log('');

    // STEP 2: Link escrow
    console.log('💰 STEP 2: Client links escrow');
    console.log('   Approving USDC for EscrowVault...');

    const networkConfig = clientSDK.getNetworkConfig();

    // Approve USDC transfer to EscrowVault
    const usdcABI = [
      'function approve(address spender, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)'
    ];

    const provider = clientSDK.getProvider();
    const signer = new Wallet(CLIENT_PRIVATE_KEY, provider);
    const usdc = new Contract(networkConfig.contracts.usdc, usdcABI, signer);

    // Check balance
    const balance = await usdc.balanceOf(await signer.getAddress());
    console.log('   Client USDC balance:', formatUnits(balance, 6), 'USDC');

    const approveTx = await usdc.approve(networkConfig.contracts.escrowVault, amount);
    await approveTx.wait();
    await sleep(3000); // Wait for state propagation

    // Generate escrowId
    const abiCoder = AbiCoder.defaultAbiCoder();
    const escrowId = keccak256(
      abiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId, networkConfig.contracts.escrowVault, Date.now()]
      )
    );

    console.log('   Linking escrow (Kernel creates escrow)...');
    await clientSDK.kernel.linkEscrow(txId, networkConfig.contracts.escrowVault, escrowId);
    console.log('   ✅ Escrow linked! USDC locked in vault');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(COMMITTED)');
    console.log('');

    // STEP 3: Provider starts work
    console.log('🔨 STEP 3: Provider starts work');
    await providerSDK.kernel.transitionState(txId, 3); // IN_PROGRESS
    console.log('   ✅ State: IN_PROGRESS');
    await sleep(2000);
    console.log('');

    // STEP 4: Provider delivers result
    console.log('📦 STEP 4: Provider delivers result');
    await providerSDK.kernel.transitionState(txId, 4); // DELIVERED
    console.log('   ✅ State: DELIVERED');
    await sleep(2000);
    console.log('');

    // STEP 5: Provider creates EAS attestation (delivery proof)
    console.log('🔷 STEP 5: Provider creates EAS delivery attestation');
    console.log('   EAS Contract:', EAS_CONTRACT_ADDRESS);
    console.log('   Schema UID:', EAS_DELIVERY_SCHEMA_UID);

    // Prepare attestation data (per AIP-6 §5.1)
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
    console.log('     Result hash:', resultHash);
    console.log('     Delivered at:', new Date(deliveredAt * 1000).toLocaleString());

    const providerSigner = new Wallet(PROVIDER_PRIVATE_KEY, provider);

    // Create actual on-chain EAS attestation
    console.log('   Creating on-chain EAS attestation...');

    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(providerSigner);

    // Schema: bytes32 txId, string resultCID, bytes32 resultHash, uint256 deliveredAt
    const schemaEncoder = new SchemaEncoder('bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt');
    const encodedData = schemaEncoder.encodeData([
      { name: 'txId', value: txId, type: 'bytes32' },
      { name: 'resultCID', value: resultCID, type: 'string' },
      { name: 'resultHash', value: resultHash, type: 'bytes32' },
      { name: 'deliveredAt', value: deliveredAt, type: 'uint256' }
    ]);

    const attestationTx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: CLIENT_ADDRESS, // Attestation recipient is the client
        expirationTime: BigInt(0), // No expiration
        revocable: true, // Can be revoked if dispute resolution requires it
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData,
        value: BigInt(0)
      }
    });

    const attestationReceipt = await attestationTx.wait();
    const attestationUID = attestationReceipt;

    console.log('   ✅ On-chain attestation created!');
    console.log('   📝 Attestation UID:', attestationUID);
    console.log('   📊 EAS Explorer: https://base-sepolia.easscan.org/attestation/view/' + attestationUID);
    console.log('   📊 Schema: https://base-sepolia.easscan.org/schema/view/' + EAS_DELIVERY_SCHEMA_UID);
    await sleep(2000);
    console.log('');

    // Note: anchorAttestation() will be implemented in SDK in future version
    // For now, the attestation UID can be stored off-chain or in transaction metadata

    // STEP 6: Client settles transaction
    console.log('💸 STEP 6: Client settles transaction');
    console.log('   (In production, this can happen after dispute window expires)');
    console.log('   Transitioning to SETTLED state (auto-releases escrow)...');

    await clientSDK.kernel.transitionState(txId, 5); // SETTLED
    console.log('   ✅ Transaction settled! Payment released to provider.');
    await sleep(2000);

    tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   State:', tx.state, '(SETTLED)');
    console.log('');

    // Final summary
    console.log('═══════════════════════════════════════');
    console.log('✅ HAPPY PATH + EAS TEST COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log('Transaction ID:', txId);
    console.log('Attestation UID:', attestationUID);
    console.log('Final State:   SETTLED');
    console.log('');
    console.log('💰 Financial Summary:');
    console.log('   Gross amount:   100.00 USDC');
    console.log('   Platform fee:     1.00 USDC (1%)');
    console.log('   Provider net:    99.00 USDC');
    console.log('');
    console.log('📊 Links:');
    console.log(`   Basescan: https://sepolia.basescan.org/address/${tx.escrowContract}`);
    console.log(`   EAS Attestation: https://base-sepolia.easscan.org/attestation/view/${attestationUID}`);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    if (error.transaction) console.error('Transaction:', error.transaction);
    if (error.stack) console.error('Stack:', error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
