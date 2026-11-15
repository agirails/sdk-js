/**
 * PendingPublish Module Tests
 *
 * Tests cover:
 * - save/load roundtrip with BigInt serialization
 * - loadPendingPublish returns null on missing file
 * - deletePendingPublish removes file and swallows errors
 * - ACTP_DIR env var override
 * - Chain-scoped (network) pending files
 * - Legacy fallback migration
 */

import { existsSync, rmSync, chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import {
  PendingPublish,
  savePendingPublish,
  loadPendingPublish,
  deletePendingPublish,
  getActpDir,
  getPendingPublishPath,
} from './pendingPublish';

const TEST_DIR = join(__dirname, '__test_actp_dir__');

function cleanTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

const SAMPLE_PENDING: PendingPublish = {
  version: 1,
  configHash: '0x' + 'ab'.repeat(32),
  cid: 'bafybeiexamplecid123456789',
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

const SAMPLE_PENDING_V2: PendingPublish = {
  ...SAMPLE_PENDING,
  version: 2,
  erc8004RegistrationCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
};

describe('pendingPublish', () => {
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

  describe('getActpDir()', () => {
    it('should respect ACTP_DIR env var', () => {
      process.env.ACTP_DIR = '/custom/path';
      expect(getActpDir()).toBe('/custom/path');
    });

    it('should default to cwd/.actp when ACTP_DIR not set', () => {
      delete process.env.ACTP_DIR;
      expect(getActpDir()).toBe(join(process.cwd(), '.actp'));
    });
  });

  describe('save/load roundtrip', () => {
    it('should save and load with BigInt fields preserved', () => {
      savePendingPublish(SAMPLE_PENDING);

      const loaded = loadPendingPublish();
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(1);
      expect(loaded!.configHash).toBe(SAMPLE_PENDING.configHash);
      expect(loaded!.cid).toBe(SAMPLE_PENDING.cid);
      expect(loaded!.endpoint).toBe(SAMPLE_PENDING.endpoint);
      expect(loaded!.createdAt).toBe(SAMPLE_PENDING.createdAt);

      // Verify BigInt roundtrip
      const sd = loaded!.serviceDescriptors[0];
      expect(sd.minPrice).toBe(0n);
      expect(sd.maxPrice).toBe(1_000_000_000n);
      expect(typeof sd.minPrice).toBe('bigint');
      expect(typeof sd.maxPrice).toBe('bigint');
      expect(sd.serviceType).toBe('text-generation');
    });

    it('should create .actp directory if it does not exist', () => {
      expect(existsSync(TEST_DIR)).toBe(false);
      savePendingPublish(SAMPLE_PENDING);
      expect(existsSync(TEST_DIR)).toBe(true);
    });

    it('should preserve the registration-v1 CID for v2 state', () => {
      savePendingPublish(SAMPLE_PENDING_V2);

      const loaded = loadPendingPublish();
      expect(loaded?.version).toBe(2);
      if (loaded?.version !== 2) {
        throw new Error('Expected pending publish v2');
      }
      expect(loaded.erc8004RegistrationCid).toBe(
        SAMPLE_PENDING_V2.erc8004RegistrationCid
      );
    });
  });

  describe('loadPendingPublish()', () => {
    it('should return null when file does not exist', () => {
      expect(loadPendingPublish()).toBeNull();
    });

    it('should return null when network-scoped file does not exist', () => {
      expect(loadPendingPublish('base-sepolia')).toBeNull();
    });

    it('should reject unknown schema versions', () => {
      savePendingPublish(SAMPLE_PENDING);
      writeFileSync(
        getPendingPublishPath(),
        JSON.stringify({
          ...SAMPLE_PENDING,
          version: 99,
          serviceDescriptors: [],
        })
      );

      expect(() => loadPendingPublish()).toThrow('Unsupported pending publish version: 99');
    });

    it('should reject v2 state missing the registration-v1 CID', () => {
      savePendingPublish(SAMPLE_PENDING);
      writeFileSync(
        getPendingPublishPath(),
        JSON.stringify({
          ...SAMPLE_PENDING,
          version: 2,
          serviceDescriptors: [],
        })
      );

      expect(() => loadPendingPublish()).toThrow('missing erc8004RegistrationCid');
    });

    it('should reject malformed v2 registration CIDs before activation', () => {
      expect(() => savePendingPublish({
        ...SAMPLE_PENDING_V2,
        erc8004RegistrationCid: 'not-a-cid',
      })).toThrow('Invalid CID format');

      savePendingPublish(SAMPLE_PENDING_V2);
      writeFileSync(
        getPendingPublishPath(),
        JSON.stringify({
          ...SAMPLE_PENDING_V2,
          erc8004RegistrationCid: 'ipfs://not-bare',
          serviceDescriptors: [],
        })
      );
      expect(() => loadPendingPublish()).toThrow('Invalid CID format');
    });
  });

  describe('deletePendingPublish()', () => {
    it('should remove the file', () => {
      savePendingPublish(SAMPLE_PENDING);
      expect(existsSync(getPendingPublishPath())).toBe(true);

      deletePendingPublish();
      expect(existsSync(getPendingPublishPath())).toBe(false);
    });

    it('should be a no-op when file does not exist', () => {
      // Should not throw
      deletePendingPublish();
    });

    it('should swallow errors on permission issues (Fix 6)', () => {
      // Create a read-only directory to force unlink errors
      savePendingPublish(SAMPLE_PENDING);
      const filePath = getPendingPublishPath();
      expect(existsSync(filePath)).toBe(true);

      // Make file read-only — unlinkSync may fail on some OSes
      try {
        chmodSync(filePath, 0o000);
        // Should not throw even if unlink fails
        expect(() => deletePendingPublish()).not.toThrow();
      } finally {
        // Restore permissions for cleanup
        try { chmodSync(filePath, 0o600); } catch { /* ignore */ }
      }
    });
  });

  describe('ACTP_DIR override', () => {
    it('should use custom directory from env var', () => {
      const customDir = join(TEST_DIR, 'custom-subdir');
      process.env.ACTP_DIR = customDir;

      savePendingPublish(SAMPLE_PENDING);
      expect(existsSync(join(customDir, 'pending-publish.json'))).toBe(true);

      const loaded = loadPendingPublish();
      expect(loaded).not.toBeNull();
      expect(loaded!.cid).toBe(SAMPLE_PENDING.cid);
    });
  });

  // ========================================================================
  // Chain-scoped pending-publish (Fix 1)
  // ========================================================================

  describe('chain-scoped pending publish (Fix 1)', () => {
    it('should save to network-scoped file when network is set', () => {
      const pending: PendingPublish = { ...SAMPLE_PENDING, network: 'base-sepolia' };
      savePendingPublish(pending);

      const scopedPath = getPendingPublishPath('base-sepolia');
      expect(existsSync(scopedPath)).toBe(true);
      expect(scopedPath).toContain('pending-publish.base-sepolia.json');

      // Legacy file should NOT exist
      expect(existsSync(getPendingPublishPath())).toBe(false);
    });

    it('should load network-scoped file', () => {
      savePendingPublish({ ...SAMPLE_PENDING, network: 'base-mainnet' });

      const loaded = loadPendingPublish('base-mainnet');
      expect(loaded).not.toBeNull();
      expect(loaded!.configHash).toBe(SAMPLE_PENDING.configHash);
      expect(loaded!.network).toBe('base-mainnet');
    });

    it('should support testnet and mainnet files coexisting independently', () => {
      const testnetPending: PendingPublish = {
        ...SAMPLE_PENDING,
        configHash: '0x' + 'aa'.repeat(32),
        network: 'base-sepolia',
      };
      const mainnetPending: PendingPublish = {
        ...SAMPLE_PENDING,
        configHash: '0x' + 'bb'.repeat(32),
        network: 'base-mainnet',
      };

      savePendingPublish(testnetPending);
      savePendingPublish(mainnetPending);

      const loadedTestnet = loadPendingPublish('base-sepolia');
      const loadedMainnet = loadPendingPublish('base-mainnet');

      expect(loadedTestnet).not.toBeNull();
      expect(loadedMainnet).not.toBeNull();
      expect(loadedTestnet!.configHash).toBe(testnetPending.configHash);
      expect(loadedMainnet!.configHash).toBe(mainnetPending.configHash);
    });

    it('should fall back to legacy file when network-scoped file missing', () => {
      // Save as legacy (no network)
      savePendingPublish(SAMPLE_PENDING);
      expect(existsSync(getPendingPublishPath())).toBe(true);

      // Load with network — should fall back to legacy
      const loaded = loadPendingPublish('base-mainnet');
      expect(loaded).not.toBeNull();
      expect(loaded!.configHash).toBe(SAMPLE_PENDING.configHash);
    });

    it('should prefer network-scoped file over legacy file', () => {
      // Save both legacy and scoped
      savePendingPublish(SAMPLE_PENDING); // legacy
      savePendingPublish({ ...SAMPLE_PENDING, configHash: '0x' + 'cc'.repeat(32), network: 'base-mainnet' });

      const loaded = loadPendingPublish('base-mainnet');
      expect(loaded!.configHash).toBe('0x' + 'cc'.repeat(32));
    });

    it('should delete both network-scoped and legacy files on delete', () => {
      // Save both
      savePendingPublish(SAMPLE_PENDING); // legacy
      savePendingPublish({ ...SAMPLE_PENDING, network: 'base-mainnet' });

      expect(existsSync(getPendingPublishPath())).toBe(true);
      expect(existsSync(getPendingPublishPath('base-mainnet'))).toBe(true);

      deletePendingPublish('base-mainnet');
      expect(existsSync(getPendingPublishPath('base-mainnet'))).toBe(false);
      expect(existsSync(getPendingPublishPath())).toBe(false); // legacy also cleaned up
    });

    it('should only delete legacy file when no network specified', () => {
      savePendingPublish({ ...SAMPLE_PENDING, network: 'base-sepolia' });
      savePendingPublish(SAMPLE_PENDING); // legacy

      deletePendingPublish(); // no network
      expect(existsSync(getPendingPublishPath())).toBe(false);
      // Network-scoped file should still exist
      expect(existsSync(getPendingPublishPath('base-sepolia'))).toBe(true);
    });

    it('should return correct path for network-scoped file', () => {
      expect(getPendingPublishPath('base-sepolia')).toBe(
        join(TEST_DIR, 'pending-publish.base-sepolia.json')
      );
      expect(getPendingPublishPath('base-mainnet')).toBe(
        join(TEST_DIR, 'pending-publish.base-mainnet.json')
      );
      expect(getPendingPublishPath()).toBe(
        join(TEST_DIR, 'pending-publish.json')
      );
    });
  });
});
