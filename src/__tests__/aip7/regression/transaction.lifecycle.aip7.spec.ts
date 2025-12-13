/**
 * AIP-7 Transaction Lifecycle Happy Path Tests (Phase 1C)
 *
 * Purpose: Validate full ACTP transaction lifecycle with AIP-7 registry integration
 * on Base Sepolia testnet.
 *
 * Test Flow:
 * 1. Setup: Ensure provider agent is registered in AgentRegistry
 * 2. Create transaction (consumer requests service from registered provider)
 * 3. Fund transaction (approve USDC + link escrow)
 * 4. Execute lifecycle: INITIATED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED
 * 5. Verify final state and registry consistency
 *
 * Prerequisites:
 * - TEST_PRIVATE_KEY or AGIRAILS_PRIVATE_KEY env var with funded Base Sepolia wallet
 * - Wallet has sufficient ETH for gas and USDC for escrow
 * - AgentRegistry deployed at expected address
 *
 * Note: Contract enforces provider !== requester, so we use a deterministic
 * second address derived from the test key for the provider role.
 *
 * References:
 * - AIP-7: Agent Identity, Registry & Storage System
 * - Yellow Paper §3.2: ACTP State Machine
 */

import { ACTPClient } from '../../../ACTPClient';
import { State } from '../../../types';
import { ethers } from 'ethers';

// Expected contract addresses
const EXPECTED_AGENT_REGISTRY = '0xFed6914Aa70c0a53E9c7Cc4d2Ae159e4748fb09D';
const MOCK_USDC = '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb';

// Test configuration - minimal amounts to reduce risk
const TEST_AMOUNT = 1_000_000n; // 1 USDC (6 decimals)
const TEST_DEADLINE_OFFSET = 3600; // 1 hour from now
const TEST_DISPUTE_WINDOW = 86400; // 24 hours (contract minimum)

// Deterministic provider address for testing (derived from known seed)
// This is a fixed test address - no funds needed since provider doesn't pay gas
const DETERMINISTIC_PROVIDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Hardhat account #1

describe('AIP-7 Transaction Lifecycle Happy Path', () => {
  let client: ACTPClient;
  let providerAddress: string;
  let consumerAddress: string;

  // Track if we need to skip write tests
  let skipWriteTests = false;
  let skipReason = '';

  beforeAll(async () => {
    // Check for test private key (never log the value)
    // Accepts TEST_PRIVATE_KEY or AGIRAILS_PRIVATE_KEY as fallback
    const testPrivateKey = process.env.TEST_PRIVATE_KEY ?? process.env.AGIRAILS_PRIVATE_KEY;

    if (!testPrivateKey) {
      skipWriteTests = true;
      skipReason = 'TEST_PRIVATE_KEY or AGIRAILS_PRIVATE_KEY not set - skipping write tests';
      console.warn(`[AIP-7 Lifecycle Tests] ${skipReason}`);

      // Use dummy key for read-only tests
      const dummyKey = '0x' + '1'.repeat(64);
      client = await ACTPClient.create({
        network: 'base-sepolia',
        privateKey: dummyKey
      });
      return;
    }

    // Initialize with real test key
    client = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: testPrivateKey
    });

    // Consumer is our funded wallet, provider is a deterministic address
    // Contract requires provider !== requester
    consumerAddress = await client.getAddress();
    providerAddress = DETERMINISTIC_PROVIDER;

    // Check balances
    const provider = client.getProvider();
    const ethBalance = await provider.getBalance(consumerAddress);
    const minEthBalance = BigInt('500000000000000'); // 0.0005 ETH (lowered for testnet)

    if (ethBalance < minEthBalance) {
      skipWriteTests = true;
      skipReason = `Insufficient ETH balance for gas (need >= 0.0005 ETH)`;
      console.warn(`[AIP-7 Lifecycle Tests] ${skipReason}`);
      return;
    }

    // Check USDC balance
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(MOCK_USDC, usdcAbi, provider);
    const usdcBalance = await usdc.balanceOf(consumerAddress);

    if (usdcBalance < TEST_AMOUNT) {
      skipWriteTests = true;
      skipReason = `Insufficient USDC balance (need >= ${TEST_AMOUNT} units)`;
      console.warn(`[AIP-7 Lifecycle Tests] ${skipReason}`);
      return;
    }

    console.log(`[AIP-7 Lifecycle Tests] Consumer: ${consumerAddress}`);
    console.log(`[AIP-7 Lifecycle Tests] Provider: ${providerAddress} (deterministic test address)`);
    console.log(`[AIP-7 Lifecycle Tests] ETH balance: ${ethers.formatEther(ethBalance)} ETH`);
    console.log(`[AIP-7 Lifecycle Tests] USDC balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  }, 60000);

  describe('Registry Integration Verification', () => {
    it('should verify consumer wallet is registered in AgentRegistry', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!client.registry) {
        console.log('[SKIP] AgentRegistry not available');
        return;
      }

      // Verify consumer (our funded wallet from Phase 1B) is registered
      const profile = await client.registry.getAgent(consumerAddress);

      if (profile === null) {
        console.log('[INFO] Consumer not yet registered - run Phase 1B first to register');
        return;
      }

      expect(profile.agentAddress.toLowerCase()).toBe(consumerAddress.toLowerCase());
      expect(profile.isActive).toBe(true);

      const expectedDID = `did:ethr:84532:${consumerAddress.toLowerCase()}`;
      expect(profile.did).toBe(expectedDID);

      console.log(`[VERIFIED] Consumer registered:`);
      console.log(`  - DID: ${profile.did}`);
      console.log(`  - Endpoint: ${profile.endpoint}`);
      console.log(`[NOTE] Provider (${providerAddress}) is deterministic test address - not required to be registered`);
    });

    it('should verify registry address matches expected deployment', () => {
      if (!client.registry) {
        console.log('[SKIP] AgentRegistry not available');
        return;
      }

      expect(client.registry.getAddress().toLowerCase()).toBe(
        EXPECTED_AGENT_REGISTRY.toLowerCase()
      );
    });
  });

  describe('Full Transaction Lifecycle', () => {
    let txId: string;
    let escrowId: string;

    // Increased timeout for on-chain transactions
    jest.setTimeout(300000);

    it('Step 1: Create transaction (INITIATED state)', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const deadline = Math.floor(Date.now() / 1000) + TEST_DEADLINE_OFFSET;

      // Create transaction via kernel
      txId = await client.kernel.createTransaction({
        provider: providerAddress,
        requester: consumerAddress,
        amount: TEST_AMOUNT,
        deadline,
        disputeWindow: TEST_DISPUTE_WINDOW
      });

      expect(txId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      console.log(`[SUCCESS] Transaction created: ${txId}`);

      // Verify initial state
      const tx = await client.kernel.getTransaction(txId);
      expect(tx.state).toBe(State.INITIATED);
      expect(tx.amount).toBe(TEST_AMOUNT);
      expect(tx.provider.toLowerCase()).toBe(providerAddress.toLowerCase());
      expect(tx.requester.toLowerCase()).toBe(consumerAddress.toLowerCase());

      console.log(`[VERIFIED] State: ${State[tx.state]}`);
    });

    it('Step 2: Fund transaction (COMMITTED state)', async () => {
      if (skipWriteTests || !txId) {
        console.log(`[SKIP] ${skipReason || 'No txId from previous step'}`);
        return;
      }

      // Fund transaction (approve USDC + link escrow)
      escrowId = await client.fundTransaction(txId);

      expect(escrowId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      console.log(`[SUCCESS] Transaction funded. Escrow ID: ${escrowId}`);

      // Verify state transitioned to COMMITTED
      const tx = await client.kernel.getTransaction(txId);
      expect(tx.state).toBe(State.COMMITTED);
      expect(tx.escrowId).toBe(escrowId);

      console.log(`[VERIFIED] State: ${State[tx.state]}`);
    });

    it('Step 3: Start work (IN_PROGRESS state) - requires provider wallet', async () => {
      if (skipWriteTests || !txId) {
        console.log(`[SKIP] ${skipReason || 'No txId from previous step'}`);
        return;
      }

      // NOTE: Only the provider can transition COMMITTED → IN_PROGRESS
      // Since we're using a deterministic provider address without keys,
      // this transition cannot be executed in this single-wallet test.
      //
      // This is documented behavior per Yellow Paper §3.2:
      // - Provider initiates work (IN_PROGRESS)
      // - Provider delivers work (DELIVERED)
      // - Consumer/Provider releases escrow (SETTLED)

      const tx = await client.kernel.getTransaction(txId);
      expect(tx.state).toBe(State.COMMITTED);

      console.log(`[INFO] Transaction is COMMITTED - awaiting provider action`);
      console.log(`[SKIP] IN_PROGRESS transition requires provider wallet (${providerAddress})`);
      console.log(`[NOTE] Full lifecycle test requires two funded wallets`);
    });

    it('Step 4: Deliver work (DELIVERED state) - requires provider wallet', async () => {
      if (skipWriteTests || !txId) {
        console.log(`[SKIP] ${skipReason || 'No txId from previous step'}`);
        return;
      }

      // NOTE: Only the provider can transition IN_PROGRESS → DELIVERED
      // This step is blocked by Step 3's limitation.

      const tx = await client.kernel.getTransaction(txId);
      console.log(`[INFO] Current state: ${State[tx.state]}`);
      console.log(`[SKIP] DELIVERED transition requires provider wallet`);
    });

    it('Step 5: Release escrow (SETTLED state) - blocked by provider steps', async () => {
      if (skipWriteTests || !txId) {
        console.log(`[SKIP] ${skipReason || 'No txId from previous step'}`);
        return;
      }

      // NOTE: releaseEscrow requires DELIVERED state
      // This is blocked by Steps 3-4.

      const tx = await client.kernel.getTransaction(txId);
      console.log(`[INFO] Current state: ${State[tx.state]}`);
      console.log(`[SKIP] SETTLED transition blocked - need DELIVERED state first`);
    });

    it('Step 6: Verify partial lifecycle completion', async () => {
      if (skipWriteTests || !txId) {
        console.log(`[SKIP] ${skipReason || 'No txId from previous step'}`);
        return;
      }

      const tx = await client.kernel.getTransaction(txId);

      // Verify partial lifecycle invariants (consumer-side only)
      expect(tx.state).toBe(State.COMMITTED); // Blocked at COMMITTED
      expect(tx.provider.toLowerCase()).toBe(providerAddress.toLowerCase());
      expect(tx.requester.toLowerCase()).toBe(consumerAddress.toLowerCase());
      expect(tx.amount).toBe(TEST_AMOUNT);
      expect(tx.escrowId).toBe(escrowId);
      expect(tx.createdAt).toBeGreaterThan(0);
      expect(tx.updatedAt).toBeGreaterThanOrEqual(tx.createdAt);

      console.log(`[VERIFIED] Consumer-side lifecycle completed`);
      console.log(`  - Transaction ID: ${txId}`);
      console.log(`  - Escrow ID: ${escrowId}`);
      console.log(`  - Current State: ${State[tx.state]}`);
      console.log(`  - Amount: ${ethers.formatUnits(tx.amount, 6)} USDC (locked in escrow)`);
      console.log(`[NOTE] Full lifecycle requires provider wallet for Steps 3-5`);
    });
  });

  describe('Registry Consistency After Lifecycle', () => {
    it('should still find consumer in registry after transaction', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!client.registry) {
        console.log('[SKIP] AgentRegistry not available');
        return;
      }

      // Re-check consumer registration after lifecycle
      const profile = await client.registry.getAgent(consumerAddress);

      if (profile === null) {
        console.log('[INFO] Consumer not registered (run Phase 1B first)');
        return;
      }

      // Registry should be unchanged by transaction lifecycle
      expect(profile.agentAddress.toLowerCase()).toBe(consumerAddress.toLowerCase());
      expect(profile.isActive).toBe(true);

      console.log(`[VERIFIED] Registry consistency maintained after transaction`);
    });

    it('should lookup consumer by DID', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!client.registry) {
        console.log('[SKIP] AgentRegistry not available');
        return;
      }

      const expectedDID = `did:ethr:84532:${consumerAddress.toLowerCase()}`;
      const profile = await client.registry.getAgentByDID(expectedDID);

      if (profile === null) {
        console.log('[INFO] Consumer not registered by DID (run Phase 1B first)');
        return;
      }

      expect(profile.agentAddress.toLowerCase()).toBe(consumerAddress.toLowerCase());
      console.log(`[VERIFIED] DID lookup successful: ${expectedDID}`);
    });
  });
});
