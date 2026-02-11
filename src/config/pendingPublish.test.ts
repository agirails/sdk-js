/**
 * PendingPublish Module Tests
 *
 * Tests cover:
 * - save/load roundtrip with BigInt serialization
 * - loadPendingPublish returns null on missing file
 * - deletePendingPublish removes file
 * - ACTP_DIR env var override
 */

import { existsSync, rmSync } from 'fs';
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
  });

  describe('loadPendingPublish()', () => {
    it('should return null when file does not exist', () => {
      expect(loadPendingPublish()).toBeNull();
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
});
