/**
 * Lazy Publish Integration Tests
 *
 * Tests the full lazy publish flow:
 * - Scenario A: pending-publish → first payment → 6 calls (3 activation + 3 payment)
 * - Scenario B1: registered + re-publish + not listed → 5 calls
 * - Scenario B2: registered + re-publish + listed → 4 calls
 * - Scenario C: stale pending → deleted, normal 3-call payment
 * - ACTP_DIR env var override for config.ts getActpDir
 * - Mock mode auto-address generation
 */

import { ethers } from 'ethers';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import { detectLazyPublishScenario, ACTPClient } from '../ACTPClient';
import {
  PendingPublish,
  savePendingPublish,
  loadPendingPublish,
  deletePendingPublish,
  getActpDir as pendingGetActpDir,
} from '../config/pendingPublish';
import {
  buildActivationBatch,
  buildACTPPayBatch,
  ActivationBatchParams,
} from '../wallet/aa/TransactionBatcher';
import { getActpDir as configGetActpDir } from '../cli/utils/config';

// ============================================================================
// Constants
// ============================================================================

const ZERO_HASH = '0x' + '0'.repeat(64);
const CONFIG_HASH_A = '0x' + 'aa'.repeat(32);
const CONFIG_HASH_B = '0x' + 'bb'.repeat(32);
const REGISTRY_ADDRESS = '0x' + 'ff'.repeat(20);
const CID = 'bafybeiexamplecid123456789';

const SAMPLE_PENDING: PendingPublish = {
  version: 1,
  configHash: CONFIG_HASH_A,
  cid: CID,
  endpoint: 'https://agent.example.com',
  serviceDescriptors: [
    {
      serviceTypeHash: ethers.keccak256(ethers.toUtf8Bytes('text-generation')),
      serviceType: 'text-generation',
      schemaURI: '',
      minPrice: 0n,
      maxPrice: 1_000_000_000n,
      avgCompletionTime: 3600,
      metadataCID: '',
    },
  ],
  createdAt: '2026-02-11T12:00:00.000Z',
};

const TEST_DIR = join(__dirname, '__lazy_publish_integration__');

// ============================================================================
// Helpers
// ============================================================================

function cleanTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Lazy Publish Integration', () => {
  const originalEnv = process.env.ACTP_DIR;

  beforeEach(() => {
    cleanTestDir();
    process.env.ACTP_DIR = TEST_DIR;
  });

  afterEach(() => {
    cleanTestDir();
    if (originalEnv !== undefined) {
      process.env.ACTP_DIR = originalEnv;
    } else {
      delete process.env.ACTP_DIR;
    }
  });

  // --------------------------------------------------------------------------
  // Scenario A: First activation (not registered, has pending)
  // --------------------------------------------------------------------------
  describe('Scenario A: First activation', () => {
    it('should produce 3 activation calls (register + publishConfig + setListed)', () => {
      const scenario = detectLazyPublishScenario(
        { registeredAt: 0n, configHash: ZERO_HASH, listed: false },
        SAMPLE_PENDING
      );
      expect(scenario).toBe('A');

      const params: ActivationBatchParams = {
        scenario: 'A',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
        endpoint: SAMPLE_PENDING.endpoint,
        serviceDescriptors: SAMPLE_PENDING.serviceDescriptors,
      };

      const calls = buildActivationBatch(params);
      expect(calls).toHaveLength(3); // register + publishConfig + setListed
    });

    it('should produce 6 total calls when combined with 3-call payment batch', () => {
      const activationParams: ActivationBatchParams = {
        scenario: 'A',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
        endpoint: SAMPLE_PENDING.endpoint,
        serviceDescriptors: SAMPLE_PENDING.serviceDescriptors,
      };

      const activationCalls = buildActivationBatch(activationParams);
      const { calls: paymentCalls } = buildACTPPayBatch({
        provider: '0x' + 'bb'.repeat(20),
        requester: '0x' + 'aa'.repeat(20),
        amount: '1000000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 86400,
        serviceHash: ethers.ZeroHash,
        agentId: '0',
        actpNonce: 0n,
        contracts: {
          usdc: '0x' + 'cc'.repeat(20),
          actpKernel: '0x' + 'dd'.repeat(20),
          escrowVault: '0x' + 'ee'.repeat(20),
        },
      });

      const combined = [...activationCalls, ...paymentCalls];
      expect(combined).toHaveLength(6); // 3 activation + 3 payment
    });

    it('should delete pending-publish.json after successful activation', () => {
      savePendingPublish(SAMPLE_PENDING);
      expect(loadPendingPublish()).not.toBeNull();

      // Simulate onSuccess callback
      deletePendingPublish();
      expect(loadPendingPublish()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario B1: Re-publish + not listed
  // --------------------------------------------------------------------------
  describe('Scenario B1: Config update + set listed', () => {
    it('should produce 2 activation calls (publishConfig + setListed)', () => {
      const scenario = detectLazyPublishScenario(
        { registeredAt: 100n, configHash: CONFIG_HASH_B, listed: false },
        SAMPLE_PENDING
      );
      expect(scenario).toBe('B1');

      const calls = buildActivationBatch({
        scenario: 'B1',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
      });
      expect(calls).toHaveLength(2); // publishConfig + setListed
    });

    it('should produce 5 total calls when combined with payment batch', () => {
      const activationCalls = buildActivationBatch({
        scenario: 'B1',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
      });
      const { calls: paymentCalls } = buildACTPPayBatch({
        provider: '0x' + 'bb'.repeat(20),
        requester: '0x' + 'aa'.repeat(20),
        amount: '1000000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 86400,
        serviceHash: ethers.ZeroHash,
        agentId: '0',
        actpNonce: 0n,
        contracts: {
          usdc: '0x' + 'cc'.repeat(20),
          actpKernel: '0x' + 'dd'.repeat(20),
          escrowVault: '0x' + 'ee'.repeat(20),
        },
      });

      const combined = [...activationCalls, ...paymentCalls];
      expect(combined).toHaveLength(5); // 2 activation + 3 payment
    });
  });

  // --------------------------------------------------------------------------
  // Scenario B2: Re-publish, already listed
  // --------------------------------------------------------------------------
  describe('Scenario B2: Config update only', () => {
    it('should produce 1 activation call (publishConfig only)', () => {
      const scenario = detectLazyPublishScenario(
        { registeredAt: 100n, configHash: CONFIG_HASH_B, listed: true },
        SAMPLE_PENDING
      );
      expect(scenario).toBe('B2');

      const calls = buildActivationBatch({
        scenario: 'B2',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
      });
      expect(calls).toHaveLength(1); // publishConfig only
    });

    it('should produce 4 total calls when combined with payment batch', () => {
      const activationCalls = buildActivationBatch({
        scenario: 'B2',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
      });
      const { calls: paymentCalls } = buildACTPPayBatch({
        provider: '0x' + 'bb'.repeat(20),
        requester: '0x' + 'aa'.repeat(20),
        amount: '1000000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 86400,
        serviceHash: ethers.ZeroHash,
        agentId: '0',
        actpNonce: 0n,
        contracts: {
          usdc: '0x' + 'cc'.repeat(20),
          actpKernel: '0x' + 'dd'.repeat(20),
          escrowVault: '0x' + 'ee'.repeat(20),
        },
      });

      const combined = [...activationCalls, ...paymentCalls];
      expect(combined).toHaveLength(4); // 1 activation + 3 payment
    });
  });

  // --------------------------------------------------------------------------
  // Scenario C: Stale pending (hash already matches on-chain)
  // --------------------------------------------------------------------------
  describe('Scenario C: Stale pending', () => {
    it('should produce 0 activation calls', () => {
      const scenario = detectLazyPublishScenario(
        { registeredAt: 100n, configHash: CONFIG_HASH_A, listed: true },
        SAMPLE_PENDING // same CONFIG_HASH_A
      );
      expect(scenario).toBe('C');

      const calls = buildActivationBatch({
        scenario: 'C',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
      });
      expect(calls).toHaveLength(0);
    });

    it('should result in normal 3-call payment', () => {
      const activationCalls = buildActivationBatch({
        scenario: 'C',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: CID,
        configHash: CONFIG_HASH_A,
        listed: true,
      });
      const { calls: paymentCalls } = buildACTPPayBatch({
        provider: '0x' + 'bb'.repeat(20),
        requester: '0x' + 'aa'.repeat(20),
        amount: '1000000',
        deadline: Math.floor(Date.now() / 1000) + 3600,
        disputeWindow: 86400,
        serviceHash: ethers.ZeroHash,
        agentId: '0',
        actpNonce: 0n,
        contracts: {
          usdc: '0x' + 'cc'.repeat(20),
          actpKernel: '0x' + 'dd'.repeat(20),
          escrowVault: '0x' + 'ee'.repeat(20),
        },
      });

      const combined = [...activationCalls, ...paymentCalls];
      expect(combined).toHaveLength(3); // 0 activation + 3 payment
    });

    it('should delete stale pending-publish.json', () => {
      savePendingPublish(SAMPLE_PENDING);
      expect(loadPendingPublish()).not.toBeNull();

      // Scenario C detected — delete stale pending
      deletePendingPublish();
      expect(loadPendingPublish()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario "none": No pending, normal operation
  // --------------------------------------------------------------------------
  describe('Scenario none: Normal operation', () => {
    it('should produce 0 activation calls when no pending publish', () => {
      const scenario = detectLazyPublishScenario(
        { registeredAt: 100n, configHash: CONFIG_HASH_A, listed: true },
        null
      );
      expect(scenario).toBe('none');

      const calls = buildActivationBatch({
        scenario: 'none',
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: '',
        configHash: '',
        listed: true,
      });
      expect(calls).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // ACTP_DIR env var override
  // --------------------------------------------------------------------------
  describe('ACTP_DIR env var override', () => {
    it('should use ACTP_DIR for pendingPublish module', () => {
      const customDir = join(TEST_DIR, 'custom-pp');
      process.env.ACTP_DIR = customDir;

      savePendingPublish(SAMPLE_PENDING);
      expect(existsSync(join(customDir, 'pending-publish.json'))).toBe(true);

      const loaded = loadPendingPublish();
      expect(loaded).not.toBeNull();
      expect(loaded!.configHash).toBe(CONFIG_HASH_A);
    });

    it('should use ACTP_DIR for CLI config getActpDir', () => {
      const customDir = '/tmp/test-actp-dir';
      process.env.ACTP_DIR = customDir;

      expect(configGetActpDir()).toBe(customDir);
      // Should ignore projectRoot when ACTP_DIR is set
      expect(configGetActpDir('/some/other/path')).toBe(customDir);
    });

    it('should use ACTP_DIR for pendingPublish getActpDir', () => {
      const customDir = '/tmp/test-pp-dir';
      process.env.ACTP_DIR = customDir;

      expect(pendingGetActpDir()).toBe(customDir);
    });
  });

  // --------------------------------------------------------------------------
  // Pending-publish.json roundtrip with activation batch
  // --------------------------------------------------------------------------
  describe('Pending-publish.json → activation batch roundtrip', () => {
    it('should save pending, reload it, and build correct activation batch', () => {
      // Step 1: Save pending (simulates `actp publish`)
      savePendingPublish(SAMPLE_PENDING);

      // Step 2: Load pending (simulates ACTPClient.create())
      const loaded = loadPendingPublish();
      expect(loaded).not.toBeNull();

      // Step 3: Detect scenario (simulates ACTPClient.create())
      const scenario = detectLazyPublishScenario(
        { registeredAt: 0n, configHash: ZERO_HASH, listed: false },
        loaded
      );
      expect(scenario).toBe('A');

      // Step 4: Build activation calls (simulates getActivationCalls())
      const params: ActivationBatchParams = {
        scenario,
        agentRegistryAddress: REGISTRY_ADDRESS,
        cid: loaded!.cid,
        configHash: loaded!.configHash,
        listed: true,
        endpoint: loaded!.endpoint,
        serviceDescriptors: loaded!.serviceDescriptors,
      };

      const calls = buildActivationBatch(params);
      expect(calls).toHaveLength(3);

      // Verify BigInt survived the roundtrip
      expect(loaded!.serviceDescriptors[0].maxPrice).toBe(1_000_000_000n);

      // Step 5: After successful payment, delete pending
      deletePendingPublish();
      expect(loadPendingPublish()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Mock mode auto-address
  // --------------------------------------------------------------------------
  describe('Mock mode auto-address', () => {
    it('should create client with auto-generated address in mock mode', async () => {
      const client = await ACTPClient.create({
        mode: 'mock',
      });

      const address = client.getAddress();
      // Should be a valid lowercase hex address
      expect(address).toMatch(/^0x[a-f0-9]{40}$/);
    });

    it('should create different addresses on each invocation', async () => {
      const client1 = await ACTPClient.create({ mode: 'mock' });
      const client2 = await ACTPClient.create({ mode: 'mock' });

      expect(client1.getAddress()).not.toBe(client2.getAddress());
    });
  });
});
