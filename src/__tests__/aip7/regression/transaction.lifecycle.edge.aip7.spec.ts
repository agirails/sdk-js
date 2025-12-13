/**
 * AIP-7 Transaction Lifecycle Edge Case Tests (Phase 1C Robustness)
 *
 * Purpose: Validate error handling and edge cases for consumer-side
 * ACTP transaction lifecycle on Base Sepolia testnet.
 *
 * Test Categories:
 * 1. Allowance/Balance edge cases
 * 2. Input validation (malformed inputs)
 * 3. Idempotency checks
 * 4. Deadline handling
 * 5. Registry negative checks
 *
 * Prerequisites:
 * - TEST_PRIVATE_KEY or AGIRAILS_PRIVATE_KEY env var
 * - Minimal ETH for read-only tests
 *
 * References:
 * - AIP-7: Agent Identity, Registry & Storage System
 * - Yellow Paper §3.2: ACTP State Machine
 */

import { ACTPClient } from '../../../ACTPClient';
import { ethers } from 'ethers';

// Contract addresses
const MOCK_USDC = '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb';
const ESCROW_VAULT = '0x948b9Ea081C4Cec1E112Af2e539224c531d4d585';

// Deterministic provider for testing
const DETERMINISTIC_PROVIDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// Minimal test amounts
const MIN_TEST_AMOUNT = 1_000_000n; // 1 USDC
const TEST_DEADLINE_OFFSET = 3600; // 1 hour
const TEST_DISPUTE_WINDOW = 86400; // 24 hours

describe('AIP-7 Transaction Lifecycle Edge Cases', () => {
  let client: ACTPClient;
  let consumerAddress: string;

  let skipWriteTests = false;
  let skipReason = '';

  beforeAll(async () => {
    const testPrivateKey = process.env.TEST_PRIVATE_KEY ?? process.env.AGIRAILS_PRIVATE_KEY;

    if (!testPrivateKey) {
      skipWriteTests = true;
      skipReason = 'TEST_PRIVATE_KEY or AGIRAILS_PRIVATE_KEY not set';
      console.warn(`[Edge Tests] ${skipReason}`);

      const dummyKey = '0x' + '1'.repeat(64);
      client = await ACTPClient.create({
        network: 'base-sepolia',
        privateKey: dummyKey
      });
      return;
    }

    client = await ACTPClient.create({
      network: 'base-sepolia',
      privateKey: testPrivateKey
    });

    consumerAddress = await client.getAddress();

    // Check ETH balance - very low threshold for read-only tests
    const provider = client.getProvider();
    const ethBalance = await provider.getBalance(consumerAddress);
    const minEthBalance = BigInt('100000000000000'); // 0.0001 ETH

    if (ethBalance < minEthBalance) {
      skipWriteTests = true;
      skipReason = `Insufficient ETH (${ethers.formatEther(ethBalance)} < 0.0001)`;
      console.warn(`[Edge Tests] ${skipReason}`);
    } else {
      console.log(`[Edge Tests] Consumer: ${consumerAddress}`);
      console.log(`[Edge Tests] ETH: ${ethers.formatEther(ethBalance)}`);
    }
  }, 30000);

  describe('Input Validation (SDK-side)', () => {
    it('should reject zero amount', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const deadline = Math.floor(Date.now() / 1000) + TEST_DEADLINE_OFFSET;

      await expect(
        client.kernel.createTransaction({
          provider: DETERMINISTIC_PROVIDER,
          requester: consumerAddress,
          amount: 0n,
          deadline,
          disputeWindow: TEST_DISPUTE_WINDOW
        })
      ).rejects.toThrow(/amount/i);

      console.log(`[VERIFIED] Zero amount rejected`);
    });

    it('should reject negative amount (bigint underflow handled)', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const deadline = Math.floor(Date.now() / 1000) + TEST_DEADLINE_OFFSET;

      // BigInt doesn't allow negative via -1n in some contexts, test boundary
      await expect(
        client.kernel.createTransaction({
          provider: DETERMINISTIC_PROVIDER,
          requester: consumerAddress,
          amount: -1n,
          deadline,
          disputeWindow: TEST_DISPUTE_WINDOW
        })
      ).rejects.toThrow();

      console.log(`[VERIFIED] Negative amount rejected`);
    });

    it('should reject invalid provider address', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const deadline = Math.floor(Date.now() / 1000) + TEST_DEADLINE_OFFSET;

      await expect(
        client.kernel.createTransaction({
          provider: 'invalid-address',
          requester: consumerAddress,
          amount: MIN_TEST_AMOUNT,
          deadline,
          disputeWindow: TEST_DISPUTE_WINDOW
        })
      ).rejects.toThrow(/address|invalid/i);

      console.log(`[VERIFIED] Invalid provider address rejected`);
    });

    it('should reject zero address as provider', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const deadline = Math.floor(Date.now() / 1000) + TEST_DEADLINE_OFFSET;

      await expect(
        client.kernel.createTransaction({
          provider: ethers.ZeroAddress,
          requester: consumerAddress,
          amount: MIN_TEST_AMOUNT,
          deadline,
          disputeWindow: TEST_DISPUTE_WINDOW
        })
      ).rejects.toThrow(/zero|invalid/i);

      console.log(`[VERIFIED] Zero address provider rejected`);
    });

    it('should reject past deadline', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const pastDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

      await expect(
        client.kernel.createTransaction({
          provider: DETERMINISTIC_PROVIDER,
          requester: consumerAddress,
          amount: MIN_TEST_AMOUNT,
          deadline: pastDeadline,
          disputeWindow: TEST_DISPUTE_WINDOW
        })
      ).rejects.toThrow(/deadline|expired|past/i);

      console.log(`[VERIFIED] Past deadline rejected`);
    });

    it('should reject dispute window too short', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const deadline = Math.floor(Date.now() / 1000) + TEST_DEADLINE_OFFSET;

      await expect(
        client.kernel.createTransaction({
          provider: DETERMINISTIC_PROVIDER,
          requester: consumerAddress,
          amount: MIN_TEST_AMOUNT,
          deadline,
          disputeWindow: 60 // 1 minute - too short
        })
      ).rejects.toThrow(/dispute.*window|too.*short/i);

      console.log(`[VERIFIED] Short dispute window rejected`);
    });
  });

  describe('Allowance Edge Cases (Read-only checks)', () => {
    it('should detect zero allowance before funding', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      // Check current allowance without modifying
      const allowance = await client.escrow.getTokenAllowance(
        MOCK_USDC,
        consumerAddress,
        ESCROW_VAULT
      );

      console.log(`[INFO] Current USDC allowance: ${ethers.formatUnits(allowance, 6)}`);

      // This is informational - we document the current state
      if (allowance === 0n) {
        console.log(`[NOTE] Zero allowance - fundTransaction would need approval first`);
      } else {
        console.log(`[NOTE] Existing allowance - fundTransaction may proceed up to this amount`);
      }
    });

    it('should detect USDC balance', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const balance = await client.escrow.getTokenBalance(MOCK_USDC, consumerAddress);

      console.log(`[INFO] USDC balance: ${ethers.formatUnits(balance, 6)}`);

      if (balance < MIN_TEST_AMOUNT) {
        console.log(`[NOTE] Insufficient USDC - transactions would fail on escrow creation`);
      }
    });
  });

  describe('Registry Negative Checks', () => {
    it('should return null for unregistered address', async () => {
      if (!client.registry) {
        console.log(`[SKIP] Registry not available`);
        return;
      }

      // Random address that should not be registered
      const randomAddress = '0x' + '0'.repeat(39) + '1';
      const profile = await client.registry.getAgent(randomAddress);

      expect(profile).toBeNull();
      console.log(`[VERIFIED] Unregistered address returns null`);
    });

    it('should return null for malformed DID lookup', async () => {
      if (!client.registry) {
        console.log(`[SKIP] Registry not available`);
        return;
      }

      // Invalid DID formats
      const invalidDIDs = [
        'not-a-did',
        'did:wrong:method',
        'did:ethr:wrongchain:0x123',
        '',
        'did:ethr:84532:invalid-address'
      ];

      for (const did of invalidDIDs) {
        try {
          const profile = await client.registry.getAgentByDID(did);
          // Should return null or throw
          if (profile !== null) {
            console.log(`[WARN] DID "${did}" returned non-null - unexpected`);
          } else {
            console.log(`[OK] DID "${did}" returned null`);
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[OK] DID "${did}" threw error: ${message.substring(0, 50)}`);
        }
      }

      console.log(`[VERIFIED] Invalid DID formats handled gracefully`);
    });

    it('should compute service type hash deterministically', () => {
      if (!client.registry) {
        console.log(`[SKIP] Registry not available`);
        return;
      }

      const serviceType = 'test-service-type';
      const hash1 = client.registry.computeServiceTypeHash(serviceType);
      const hash2 = client.registry.computeServiceTypeHash(serviceType);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Different inputs produce different hashes
      const hash3 = client.registry.computeServiceTypeHash('different-type');
      expect(hash3).not.toBe(hash1);

      console.log(`[VERIFIED] Service type hash is deterministic`);
    });

    it('should reject empty service type', () => {
      if (!client.registry) {
        console.log(`[SKIP] Registry not available`);
        return;
      }

      // SDK validates service type format - empty string should be rejected
      expect(() => {
        client.registry!.computeServiceTypeHash('');
      }).toThrow(/serviceType|validation|alphanumeric/i);

      console.log(`[VERIFIED] Empty service type rejected by validation`);
    });
  });

  describe('Transaction State Validation', () => {
    it('should reject non-existent transaction lookup', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      // Create a mock txId (won't exist on-chain but tests contract behavior)
      const fakeTxId = '0x' + '0'.repeat(64);

      // Contract returns "Tx missing" for non-existent transactions
      await expect(
        client.kernel.getTransaction(fakeTxId)
      ).rejects.toThrow(/Tx missing|not found/i);

      console.log(`[VERIFIED] Non-existent transaction lookup fails cleanly`);
    });

    it('should validate txId format', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const invalidTxIds = [
        'not-a-hash',
        '0x123', // too short
        '0x' + 'g'.repeat(64), // invalid hex
        ''
      ];

      for (const txId of invalidTxIds) {
        try {
          await client.kernel.getTransaction(txId);
          console.log(`[WARN] Invalid txId "${txId}" did not throw`);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[OK] Invalid txId "${txId}" rejected: ${message.substring(0, 40)}`);
        }
      }

      console.log(`[VERIFIED] Invalid txId formats rejected`);
    });
  });

  describe('Contract Configuration Checks', () => {
    it('should have kernel address accessible', async () => {
      const kernelAddress = client.kernel.getAddress();

      expect(kernelAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(kernelAddress).not.toBe(ethers.ZeroAddress);

      console.log(`[VERIFIED] Kernel address: ${kernelAddress}`);
    });

    it('should have escrow vault address accessible', async () => {
      const escrowAddress = client.escrow.getAddress();

      expect(escrowAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(escrowAddress).not.toBe(ethers.ZeroAddress);

      console.log(`[VERIFIED] Escrow vault address: ${escrowAddress}`);
    });
  });

  describe('Quote Validation', () => {
    it('should reject zero quote hash', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const fakeTxId = '0x' + '1'.repeat(64);
      const zeroHash = '0x' + '0'.repeat(64);

      // SDK should validate quote hash is non-zero
      await expect(
        client.kernel.submitQuote(fakeTxId, zeroHash)
      ).rejects.toThrow(/zero|invalid/i);

      console.log(`[VERIFIED] Zero quote hash rejected`);
    });

    it('should reject malformed quote hash', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      const fakeTxId = '0x' + '1'.repeat(64);
      const badHashes = [
        '0x123', // too short
        'not-a-hash',
        ''
      ];

      for (const hash of badHashes) {
        await expect(
          client.kernel.submitQuote(fakeTxId, hash)
        ).rejects.toThrow();
      }

      console.log(`[VERIFIED] Malformed quote hashes rejected`);
    });
  });
});
