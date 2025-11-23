/**
 * Comprehensive EAS Test Suite
 *
 * Tests all EAS integration scenarios:
 * 1. Dispute flow with EAS attestation
 * 2. Attestation revocation
 * 3. Edge cases:
 *    - Attest before DELIVERED state
 *    - Multiple attestations for same transaction
 *    - Invalid attestation UIDs
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ACTPClient } from '../src/ACTPClient';
import { parseUnits, keccak256, toUtf8Bytes, AbiCoder, Wallet, Contract, ZeroAddress } from 'ethers';
import { EAS, SchemaEncoder } from '@ethereum-attestation-service/eas-sdk';

const CLIENT_ADDRESS = '0xe174bd855aaA8d907334288323044d4cf79BfAfC';
const PROVIDER_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY || '';
const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY || '';
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || '';
const EAS_DELIVERY_SCHEMA_UID = process.env.EAS_DELIVERY_SCHEMA_UID || '';

if (!CLIENT_PRIVATE_KEY || !PROVIDER_PRIVATE_KEY || !ADMIN_PRIVATE_KEY || !EAS_DELIVERY_SCHEMA_UID) {
  console.error('❌ Missing environment variables');
  console.log('Required: CLIENT_PRIVATE_KEY, PROVIDER_PRIVATE_KEY, ADMIN_PRIVATE_KEY, EAS_DELIVERY_SCHEMA_UID');
  process.exit(1);
}

const EAS_CONTRACT_ADDRESS = '0x4200000000000000000000000000000000000021';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface TestResult {
  scenario: string;
  status: 'PASS' | 'FAIL';
  details: string;
  attestationUID?: string;
  transactionID?: string;
}

const results: TestResult[] = [];

/**
 * TEST 1: Dispute Flow with EAS Attestation
 * Create → Link → Deliver → Attest → Dispute → Resolve
 * Verify attestation persists after dispute resolution
 */
async function testDisputeFlowWithEAS(): Promise<TestResult> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║ TEST 1: Dispute Flow with EAS Attestation             ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  try {
    const clientSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: CLIENT_PRIVATE_KEY
    });

    const providerSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: PROVIDER_PRIVATE_KEY
    });

    const adminSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: ADMIN_PRIVATE_KEY
    });

    const amount = parseUnits('50', 6); // 50 USDC
    const deadline = Math.floor(Date.now() / 1000) + 86400;
    const disputeWindow = 7200;
    const metadata = keccak256(toUtf8Bytes('Dispute test with EAS'));

    // Create transaction
    console.log('📝 Creating transaction...');
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

    // Link escrow
    console.log('💰 Linking escrow...');
    const networkConfig = clientSDK.getNetworkConfig();
    const provider = clientSDK.getProvider();
    const signer = new Wallet(CLIENT_PRIVATE_KEY, provider);

    const usdcABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const usdc = new Contract(networkConfig.contracts.usdc, usdcABI, signer);

    const approveTx = await usdc.approve(networkConfig.contracts.escrowVault, amount);
    await approveTx.wait();
    await sleep(3000);

    const abiCoder = AbiCoder.defaultAbiCoder();
    const escrowId = keccak256(
      abiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId, networkConfig.contracts.escrowVault, Date.now()]
      )
    );

    await clientSDK.kernel.linkEscrow(txId, networkConfig.contracts.escrowVault, escrowId);
    console.log('   ✅ Escrow linked');
    await sleep(2000);

    // Provider delivers
    console.log('🔨 Provider works and delivers...');
    await providerSDK.kernel.transitionState(txId, 3); // IN_PROGRESS
    await sleep(2000);
    await providerSDK.kernel.transitionState(txId, 4); // DELIVERED
    console.log('   ✅ Delivered');
    await sleep(2000);

    // Create EAS attestation
    console.log('🔷 Provider creates EAS attestation...');
    const resultCID = 'QmDisputeTest123';
    const resultHash = keccak256(toUtf8Bytes('dispute test data'));
    const deliveredAt = Math.floor(Date.now() / 1000);

    const providerSigner = new Wallet(PROVIDER_PRIVATE_KEY, provider);
    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(providerSigner);

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
        recipient: CLIENT_ADDRESS,
        expirationTime: BigInt(0),
        revocable: true,
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData,
        value: BigInt(0)
      }
    });

    const attestationUID = await attestationTx.wait();
    console.log('   ✅ Attestation UID:', attestationUID);
    await sleep(2000);

    // Client disputes
    console.log('⚠️  Client disputes delivery...');
    await clientSDK.kernel.transitionState(txId, 6); // DISPUTED
    console.log('   ✅ Dispute raised');
    await sleep(2000);

    // Admin resolves (50/50 split)
    console.log('👨‍⚖️  Admin resolves dispute (50/50 split)...');
    await adminSDK.kernel.resolveDispute(txId, {
      requesterAmount: parseUnits('25', 6),
      providerAmount: parseUnits('25', 6),
      mediatorAmount: parseUnits('0', 6),
      mediator: undefined
    });
    console.log('   ✅ Dispute resolved, transaction settled');
    await sleep(2000);

    // Verify attestation still exists
    console.log('🔍 Verifying attestation persists after dispute...');
    const attestationData = await eas.getAttestation(attestationUID as string);

    if (!attestationData || !attestationData.uid) {
      throw new Error('Attestation not found after dispute resolution');
    }

    console.log('   ✅ Attestation still valid on EAS');
    console.log('   📊 View: https://base-sepolia.easscan.org/attestation/view/' + attestationUID);

    return {
      scenario: 'Dispute Flow with EAS Attestation',
      status: 'PASS',
      details: 'Transaction disputed and resolved. Attestation persists on EAS after resolution.',
      attestationUID: attestationUID as string,
      transactionID: txId
    };

  } catch (error: any) {
    return {
      scenario: 'Dispute Flow with EAS Attestation',
      status: 'FAIL',
      details: error.message
    };
  }
}

/**
 * TEST 2: Attestation Revocation
 * Create attestation → Revoke → Verify revocation status
 */
async function testAttestationRevocation(): Promise<TestResult> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║ TEST 2: Attestation Revocation                        ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  try {
    const clientSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: CLIENT_PRIVATE_KEY
    });

    const providerSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: PROVIDER_PRIVATE_KEY
    });

    const amount = parseUnits('25', 6);
    const deadline = Math.floor(Date.now() / 1000) + 86400;
    const disputeWindow = 7200;
    const metadata = keccak256(toUtf8Bytes('Revocation test'));

    // Create and deliver transaction
    console.log('📝 Creating transaction...');
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

    // Link escrow (simplified for speed)
    const networkConfig = clientSDK.getNetworkConfig();
    const provider = clientSDK.getProvider();
    const signer = new Wallet(CLIENT_PRIVATE_KEY, provider);

    const usdcABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const usdc = new Contract(networkConfig.contracts.usdc, usdcABI, signer);

    await (await usdc.approve(networkConfig.contracts.escrowVault, amount)).wait();
    await sleep(3000);

    const abiCoder = AbiCoder.defaultAbiCoder();
    const escrowId = keccak256(
      abiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId, networkConfig.contracts.escrowVault, Date.now()]
      )
    );

    await clientSDK.kernel.linkEscrow(txId, networkConfig.contracts.escrowVault, escrowId);
    await sleep(2000);

    await providerSDK.kernel.transitionState(txId, 3); // IN_PROGRESS first
    await sleep(2000);
    await providerSDK.kernel.transitionState(txId, 4); // DELIVERED
    await sleep(2000);

    // Create attestation
    console.log('🔷 Creating attestation...');
    const providerSigner = new Wallet(PROVIDER_PRIVATE_KEY, provider);
    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(providerSigner);

    const schemaEncoder = new SchemaEncoder('bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt');
    const encodedData = schemaEncoder.encodeData([
      { name: 'txId', value: txId, type: 'bytes32' },
      { name: 'resultCID', value: 'QmRevocationTest', type: 'string' },
      { name: 'resultHash', value: keccak256(toUtf8Bytes('revocation test')), type: 'bytes32' },
      { name: 'deliveredAt', value: Math.floor(Date.now() / 1000), type: 'uint256' }
    ]);

    const attestationTx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: CLIENT_ADDRESS,
        expirationTime: BigInt(0),
        revocable: true, // MUST be revocable
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData,
        value: BigInt(0)
      }
    });

    const attestationUID = await attestationTx.wait();
    console.log('   ✅ Attestation created:', attestationUID);
    await sleep(2000);

    // Revoke attestation
    console.log('🔶 Revoking attestation...');
    const revokeTx = await eas.revoke({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        uid: attestationUID as string,
        value: BigInt(0)
      }
    });
    await revokeTx.wait();
    console.log('   ✅ Attestation revoked');
    await sleep(2000);

    // Verify revocation
    console.log('🔍 Verifying revocation status...');
    const attestationData = await eas.getAttestation(attestationUID as string);

    // Check revocationTime field (should be non-zero after revocation)
    if (!attestationData.revocationTime || attestationData.revocationTime === BigInt(0)) {
      throw new Error('Attestation not properly revoked (revocationTime is 0)');
    }

    console.log('   ✅ Revocation confirmed (revocationTime:', attestationData.revocationTime.toString(), ')');
    console.log('   📊 View: https://base-sepolia.easscan.org/attestation/view/' + attestationUID);

    return {
      scenario: 'Attestation Revocation',
      status: 'PASS',
      details: 'Attestation created and successfully revoked. Revocation timestamp: ' + attestationData.revocationTime.toString(),
      attestationUID: attestationUID as string,
      transactionID: txId
    };

  } catch (error: any) {
    return {
      scenario: 'Attestation Revocation',
      status: 'FAIL',
      details: error.message
    };
  }
}

/**
 * TEST 3: Edge Case - Attest Before DELIVERED State
 * Attempt to create attestation when transaction is still IN_PROGRESS
 * Expected: Attestation succeeds (EAS doesn't validate ACTP state)
 */
async function testAttestBeforeDelivered(): Promise<TestResult> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║ TEST 3: Attest Before DELIVERED State                 ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  try {
    const clientSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: CLIENT_PRIVATE_KEY
    });

    const providerSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: PROVIDER_PRIVATE_KEY
    });

    const amount = parseUnits('10', 6);
    const deadline = Math.floor(Date.now() / 1000) + 86400;
    const disputeWindow = 7200;
    const metadata = keccak256(toUtf8Bytes('Early attestation test'));

    console.log('📝 Creating transaction...');
    const txId = await clientSDK.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: CLIENT_ADDRESS,
      amount,
      deadline,
      disputeWindow,
      metadata
    });
    await sleep(2000);

    // Link escrow
    const networkConfig = clientSDK.getNetworkConfig();
    const provider = clientSDK.getProvider();
    const signer = new Wallet(CLIENT_PRIVATE_KEY, provider);

    const usdcABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const usdc = new Contract(networkConfig.contracts.usdc, usdcABI, signer);

    await (await usdc.approve(networkConfig.contracts.escrowVault, amount)).wait();
    await sleep(3000);

    const abiCoder = AbiCoder.defaultAbiCoder();
    const escrowId = keccak256(
      abiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId, networkConfig.contracts.escrowVault, Date.now()]
      )
    );

    await clientSDK.kernel.linkEscrow(txId, networkConfig.contracts.escrowVault, escrowId);
    await sleep(2000);

    // Move to IN_PROGRESS (not DELIVERED yet!)
    console.log('🔨 Moving to IN_PROGRESS state...');
    await providerSDK.kernel.transitionState(txId, 3); // IN_PROGRESS
    await sleep(2000);

    let tx = await clientSDK.kernel.getTransaction(txId);
    console.log('   Current state:', tx.state, '(should be IN_PROGRESS, not DELIVERED)');

    // Attempt to create attestation BEFORE delivery
    console.log('🔷 Attempting to create attestation in IN_PROGRESS state...');
    const providerSigner = new Wallet(PROVIDER_PRIVATE_KEY, provider);
    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(providerSigner);

    const schemaEncoder = new SchemaEncoder('bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt');
    const encodedData = schemaEncoder.encodeData([
      { name: 'txId', value: txId, type: 'bytes32' },
      { name: 'resultCID', value: 'QmEarlyAttestation', type: 'string' },
      { name: 'resultHash', value: keccak256(toUtf8Bytes('early data')), type: 'bytes32' },
      { name: 'deliveredAt', value: Math.floor(Date.now() / 1000), type: 'uint256' }
    ]);

    const attestationTx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: CLIENT_ADDRESS,
        expirationTime: BigInt(0),
        revocable: true,
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData,
        value: BigInt(0)
      }
    });

    const attestationUID = await attestationTx.wait();
    console.log('   ✅ Attestation created despite IN_PROGRESS state:', attestationUID);
    console.log('   ⚠️  Note: EAS does NOT validate ACTP state - consumer must verify!');
    console.log('   📊 View: https://base-sepolia.easscan.org/attestation/view/' + attestationUID);

    return {
      scenario: 'Attest Before DELIVERED State',
      status: 'PASS',
      details: 'Attestation created in IN_PROGRESS state. EAS does not validate ACTP state transitions. Consumer responsibility to verify state before trusting attestation.',
      attestationUID: attestationUID as string,
      transactionID: txId
    };

  } catch (error: any) {
    return {
      scenario: 'Attest Before DELIVERED State',
      status: 'FAIL',
      details: error.message
    };
  }
}

/**
 * TEST 4: Edge Case - Multiple Attestations
 * Create multiple attestations for the same transaction
 * Expected: EAS allows it (no uniqueness constraint)
 */
async function testMultipleAttestations(): Promise<TestResult> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║ TEST 4: Multiple Attestations for Same Transaction    ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  try {
    const clientSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: CLIENT_PRIVATE_KEY
    });

    const providerSDK = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: PROVIDER_PRIVATE_KEY
    });

    const amount = parseUnits('15', 6);
    const deadline = Math.floor(Date.now() / 1000) + 86400;
    const disputeWindow = 7200;
    const metadata = keccak256(toUtf8Bytes('Multiple attestations test'));

    console.log('📝 Creating transaction...');
    const txId = await clientSDK.kernel.createTransaction({
      provider: PROVIDER_ADDRESS,
      requester: CLIENT_ADDRESS,
      amount,
      deadline,
      disputeWindow,
      metadata
    });
    await sleep(2000);

    // Quick escrow link
    const networkConfig = clientSDK.getNetworkConfig();
    const provider = clientSDK.getProvider();
    const signer = new Wallet(CLIENT_PRIVATE_KEY, provider);

    const usdcABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const usdc = new Contract(networkConfig.contracts.usdc, usdcABI, signer);

    await (await usdc.approve(networkConfig.contracts.escrowVault, amount)).wait();
    await sleep(3000);

    const abiCoder = AbiCoder.defaultAbiCoder();
    const escrowId = keccak256(
      abiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [txId, networkConfig.contracts.escrowVault, Date.now()]
      )
    );

    await clientSDK.kernel.linkEscrow(txId, networkConfig.contracts.escrowVault, escrowId);
    await sleep(2000);

    await providerSDK.kernel.transitionState(txId, 3); // IN_PROGRESS first
    await sleep(2000);
    await providerSDK.kernel.transitionState(txId, 4); // DELIVERED
    await sleep(2000);

    // Create FIRST attestation
    console.log('🔷 Creating first attestation...');
    const providerSigner = new Wallet(PROVIDER_PRIVATE_KEY, provider);
    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(providerSigner);

    const schemaEncoder = new SchemaEncoder('bytes32 txId,string resultCID,bytes32 resultHash,uint256 deliveredAt');

    const encodedData1 = schemaEncoder.encodeData([
      { name: 'txId', value: txId, type: 'bytes32' },
      { name: 'resultCID', value: 'QmFirstAttestation', type: 'string' },
      { name: 'resultHash', value: keccak256(toUtf8Bytes('first result')), type: 'bytes32' },
      { name: 'deliveredAt', value: Math.floor(Date.now() / 1000), type: 'uint256' }
    ]);

    const attestation1Tx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: CLIENT_ADDRESS,
        expirationTime: BigInt(0),
        revocable: true,
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData1,
        value: BigInt(0)
      }
    });

    const attestationUID1 = await attestation1Tx.wait();
    console.log('   ✅ First attestation:', attestationUID1);
    await sleep(2000);

    // Create SECOND attestation for SAME transaction
    console.log('🔷 Creating second attestation for same txId...');

    const encodedData2 = schemaEncoder.encodeData([
      { name: 'txId', value: txId, type: 'bytes32' },
      { name: 'resultCID', value: 'QmSecondAttestation', type: 'string' },
      { name: 'resultHash', value: keccak256(toUtf8Bytes('second result')), type: 'bytes32' },
      { name: 'deliveredAt', value: Math.floor(Date.now() / 1000) + 60, type: 'uint256' }
    ]);

    const attestation2Tx = await eas.attest({
      schema: EAS_DELIVERY_SCHEMA_UID,
      data: {
        recipient: CLIENT_ADDRESS,
        expirationTime: BigInt(0),
        revocable: true,
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        data: encodedData2,
        value: BigInt(0)
      }
    });

    const attestationUID2 = await attestation2Tx.wait();
    console.log('   ✅ Second attestation:', attestationUID2);
    console.log('   ⚠️  Note: EAS allows multiple attestations per txId!');
    console.log('   ⚠️  Consumer must implement logic to handle duplicates/conflicts.');

    return {
      scenario: 'Multiple Attestations for Same Transaction',
      status: 'PASS',
      details: `Created 2 attestations for same txId. UIDs: ${attestationUID1}, ${attestationUID2}. EAS does not enforce uniqueness - consumer must handle conflicts.`,
      attestationUID: `${attestationUID1} & ${attestationUID2}`,
      transactionID: txId
    };

  } catch (error: any) {
    return {
      scenario: 'Multiple Attestations for Same Transaction',
      status: 'FAIL',
      details: error.message
    };
  }
}

/**
 * TEST 5: Edge Case - Invalid Attestation UID
 * Test behavior when using non-existent attestation UID
 */
async function testInvalidAttestationUID(): Promise<TestResult> {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║ TEST 5: Invalid Attestation UID                       ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  try {
    const provider = (await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: CLIENT_PRIVATE_KEY
    })).getProvider();

    const signer = new Wallet(CLIENT_PRIVATE_KEY, provider);
    const eas = new EAS(EAS_CONTRACT_ADDRESS);
    eas.connect(signer);

    // Generate fake UID (very unlikely to exist)
    const fakeUID = '0x' + '9'.repeat(64);

    console.log('🔍 Querying non-existent attestation UID:', fakeUID);
    const attestationData = await eas.getAttestation(fakeUID);

    // EAS returns default/empty struct for non-existent UIDs
    if (attestationData.uid === ZeroAddress.padEnd(66, '0') || !attestationData.time || attestationData.time === BigInt(0)) {
      console.log('   ✅ Non-existent UID returns empty/zero data as expected');
      console.log('   ⚠️  Consumer must check attestation.time != 0 to verify existence');

      return {
        scenario: 'Invalid Attestation UID',
        status: 'PASS',
        details: 'Non-existent UID query returns empty struct. Consumer must validate attestation.time != 0 before trusting data.'
      };
    } else {
      throw new Error('Unexpectedly found data for fake UID (collision or EAS behavior changed)');
    }

  } catch (error: any) {
    return {
      scenario: 'Invalid Attestation UID',
      status: 'FAIL',
      details: error.message
    };
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('     COMPREHENSIVE EAS TEST SUITE - Base Sepolia Testnet       ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Schema UID:', EAS_DELIVERY_SCHEMA_UID);
  console.log('EAS Contract:', EAS_CONTRACT_ADDRESS);
  console.log('Test Accounts:', CLIENT_ADDRESS, PROVIDER_ADDRESS);
  console.log('');
  console.log('Running 5 comprehensive test scenarios...\n');

  // Run all tests
  results.push(await testDisputeFlowWithEAS());
  results.push(await testAttestationRevocation());
  results.push(await testAttestBeforeDelivered());
  results.push(await testMultipleAttestations());
  results.push(await testInvalidAttestationUID());

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                      TEST SUMMARY                             ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;

  results.forEach((result, index) => {
    const icon = result.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} TEST ${index + 1}: ${result.scenario}`);
    console.log(`   Status: ${result.status}`);
    console.log(`   ${result.details}`);
    if (result.attestationUID) {
      console.log(`   Attestation: ${result.attestationUID}`);
    }
    if (result.transactionID) {
      console.log(`   Transaction: ${result.transactionID}`);
    }
    console.log('');
  });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total Tests: ${results.length}`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ${failed > 0 ? '❌' : ''}`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
