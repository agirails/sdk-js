/**
 * NonceManager Unit Tests
 *
 * Tests nonce generation, tracking, and replay protection.
 * Critical security module for preventing transaction replay attacks.
 */

import {
  InMemoryNonceManager,
  DIDScopedNonceManager,
  FileBasedNonceManager,
  createNonceManager,
  MAX_NONCE_VALUE
} from './NonceManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('InMemoryNonceManager', () => {
  let nonceManager: InMemoryNonceManager;

  beforeEach(() => {
    nonceManager = new InMemoryNonceManager();
  });

  describe('constructor', () => {
    it('should create nonce manager with default state', () => {
      expect(nonceManager).toBeInstanceOf(InMemoryNonceManager);
    });

    it('should accept initial nonces', () => {
      const manager = new InMemoryNonceManager({
        'message.type.a': 5,
        'message.type.b': 10
      });

      expect(manager.getCurrentNonce('message.type.a')).toBe(5);
      expect(manager.getCurrentNonce('message.type.b')).toBe(10);
    });

    it('should throw if initial nonce exceeds MAX_NONCE_VALUE', () => {
      expect(() => {
        new InMemoryNonceManager({
          'overflow': MAX_NONCE_VALUE + 1
        });
      }).toThrow('exceeds maximum');
    });
  });

  describe('getCurrentNonce()', () => {
    it('should return 0 for new message type', () => {
      const nonce = nonceManager.getCurrentNonce('new-type');
      expect(nonce).toBe(0);
    });

    it('should return recorded nonce', () => {
      nonceManager.recordNonce('test-type', 5);
      expect(nonceManager.getCurrentNonce('test-type')).toBe(5);
    });
  });

  describe('getNextNonce()', () => {
    it('should return 1 for new message type', () => {
      const nonce = nonceManager.getNextNonce('new-type');
      expect(nonce).toBe(1);
    });

    it('should return current + 1', () => {
      nonceManager.recordNonce('test-type', 10);
      const nonce = nonceManager.getNextNonce('test-type');
      expect(nonce).toBe(11);
    });

    it('should not mutate state', () => {
      nonceManager.getNextNonce('test-type');
      nonceManager.getNextNonce('test-type');
      expect(nonceManager.getCurrentNonce('test-type')).toBe(0);
    });

    it('should throw on overflow', () => {
      const manager = new InMemoryNonceManager({
        'overflow-type': MAX_NONCE_VALUE
      });

      expect(() => {
        manager.getNextNonce('overflow-type');
      }).toThrow('Nonce overflow');
    });
  });

  describe('getAndIncrementNonce()', () => {
    it('should return and increment nonce atomically', async () => {
      const nonce1 = await nonceManager.getAndIncrementNonce('sender');
      const nonce2 = await nonceManager.getAndIncrementNonce('sender');
      const nonce3 = await nonceManager.getAndIncrementNonce('sender');

      expect(nonce1).toBe(1);
      expect(nonce2).toBe(2);
      expect(nonce3).toBe(3);
    });

    it('should maintain separate nonces per message type', async () => {
      const nonceA1 = await nonceManager.getAndIncrementNonce('type-a');
      const nonceB1 = await nonceManager.getAndIncrementNonce('type-b');
      const nonceA2 = await nonceManager.getAndIncrementNonce('type-a');

      expect(nonceA1).toBe(1);
      expect(nonceB1).toBe(1);
      expect(nonceA2).toBe(2);
    });

    it('should handle concurrent calls correctly', async () => {
      // Launch 10 concurrent nonce requests
      const promises = Array(10).fill(null).map(() =>
        nonceManager.getAndIncrementNonce('concurrent-type')
      );

      const nonces = await Promise.all(promises);

      // Should have 10 unique nonces from 1-10
      const sortedNonces = [...nonces].sort((a, b) => a - b);
      expect(sortedNonces).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('should throw on overflow', async () => {
      const manager = new InMemoryNonceManager({
        'overflow-type': MAX_NONCE_VALUE
      });

      await expect(
        manager.getAndIncrementNonce('overflow-type')
      ).rejects.toThrow('Nonce overflow');
    });
  });

  describe('recordNonce()', () => {
    it('should record new nonce', () => {
      nonceManager.recordNonce('sender', 5);
      expect(nonceManager.getCurrentNonce('sender')).toBe(5);
    });

    it('should throw for non-increasing nonce', () => {
      nonceManager.recordNonce('sender', 10);

      expect(() => {
        nonceManager.recordNonce('sender', 5);
      }).toThrow('strictly increasing');
    });

    it('should throw for same nonce (replay attempt)', () => {
      nonceManager.recordNonce('sender', 10);

      expect(() => {
        nonceManager.recordNonce('sender', 10);
      }).toThrow('strictly increasing');
    });

    it('should accept higher nonce', () => {
      nonceManager.recordNonce('sender', 5);
      nonceManager.recordNonce('sender', 10);

      expect(nonceManager.getCurrentNonce('sender')).toBe(10);
    });

    it('should throw on nonce exceeding MAX_NONCE_VALUE', () => {
      expect(() => {
        nonceManager.recordNonce('sender', MAX_NONCE_VALUE + 1);
      }).toThrow('exceeds maximum');
    });
  });

  describe('resetNonce()', () => {
    it('should clear nonce for message type', () => {
      nonceManager.recordNonce('type-a', 10);
      nonceManager.recordNonce('type-b', 20);

      nonceManager.resetNonce('type-a');

      expect(nonceManager.getCurrentNonce('type-a')).toBe(0);
      expect(nonceManager.getCurrentNonce('type-b')).toBe(20);
    });
  });

  describe('clearAll()', () => {
    it('should clear all nonces', () => {
      nonceManager.recordNonce('type-a', 10);
      nonceManager.recordNonce('type-b', 20);

      nonceManager.clearAll();

      expect(nonceManager.getCurrentNonce('type-a')).toBe(0);
      expect(nonceManager.getCurrentNonce('type-b')).toBe(0);
    });
  });

  describe('getAllNonces()', () => {
    it('should return all nonces', () => {
      nonceManager.recordNonce('type-a', 10);
      nonceManager.recordNonce('type-b', 20);

      const allNonces = nonceManager.getAllNonces();

      expect(allNonces['type-a']).toBe(10);
      expect(allNonces['type-b']).toBe(20);
    });
  });
});

describe('DIDScopedNonceManager', () => {
  const TEST_DID = 'did:ethr:0x1234567890123456789012345678901234567890';
  let nonceManager: DIDScopedNonceManager;

  beforeEach(() => {
    nonceManager = new DIDScopedNonceManager(TEST_DID);
  });

  describe('constructor', () => {
    it('should create DID-scoped nonce manager', () => {
      expect(nonceManager).toBeInstanceOf(DIDScopedNonceManager);
    });

    it('should accept initial nonces', () => {
      const manager = new DIDScopedNonceManager(TEST_DID, {
        'message.type.a': 5
      });

      expect(manager.getCurrentNonce('message.type.a')).toBe(5);
    });
  });

  describe('DID scoping', () => {
    it('should track nonces per DID', () => {
      const did1 = 'did:ethr:0x1111111111111111111111111111111111111111';
      const did2 = 'did:ethr:0x2222222222222222222222222222222222222222';

      nonceManager.recordNonceForDID(did1, 'type-a', 5);
      nonceManager.recordNonceForDID(did2, 'type-a', 10);

      expect(nonceManager.getCurrentNonceForDID(did1, 'type-a')).toBe(5);
      expect(nonceManager.getCurrentNonceForDID(did2, 'type-a')).toBe(10);
    });

    it('should switch DID context', () => {
      const did2 = 'did:ethr:0x2222222222222222222222222222222222222222';

      nonceManager.recordNonce('type-a', 5);
      nonceManager.switchDID(did2);
      nonceManager.recordNonce('type-a', 10);

      expect(nonceManager.getCurrentNonceForDID(TEST_DID, 'type-a')).toBe(5);
      expect(nonceManager.getCurrentNonce('type-a')).toBe(10);
    });
  });

  describe('getAllNonces()', () => {
    it('should return nested structure', () => {
      const did2 = 'did:ethr:0x2222222222222222222222222222222222222222';

      nonceManager.recordNonceForDID(TEST_DID, 'type-a', 5);
      nonceManager.recordNonceForDID(did2, 'type-b', 10);

      const allNonces = nonceManager.getAllNonces();

      expect(allNonces[TEST_DID]['type-a']).toBe(5);
      expect(allNonces[did2]['type-b']).toBe(10);
    });
  });
});

describe('FileBasedNonceManager', () => {
  let tempDir: string;
  let fileNonceManager: FileBasedNonceManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonce-test-'));
    fileNonceManager = new FileBasedNonceManager(tempDir);
  });

  afterEach(() => {
    // Cleanup
    try {
      const actpDir = path.join(tempDir, '.actp');
      const nonceFile = path.join(actpDir, 'nonces.json');
      const lockFile = path.join(actpDir, 'nonces.json.lock');

      if (fs.existsSync(nonceFile)) {
        fs.unlinkSync(nonceFile);
      }
      if (fs.existsSync(lockFile)) {
        fs.rmSync(lockFile, { recursive: true, force: true });
      }
      if (fs.existsSync(actpDir)) {
        fs.rmdirSync(actpDir);
      }
      fs.rmdirSync(tempDir);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create file-based nonce manager', () => {
      expect(fileNonceManager).toBeInstanceOf(FileBasedNonceManager);
    });

    it('should create .actp directory', () => {
      const actpDir = path.join(tempDir, '.actp');
      expect(fs.existsSync(actpDir)).toBe(true);
    });
  });

  describe('persistence', () => {
    it('should persist nonces to file', async () => {
      await fileNonceManager.getAndIncrementNonce('type-a');
      await fileNonceManager.getAndIncrementNonce('type-a');

      // Create new manager with same directory
      const newManager = new FileBasedNonceManager(tempDir);
      const nonce = await newManager.getAndIncrementNonce('type-a');

      expect(nonce).toBe(3); // Continued from previous
    });

    it('should throw on corrupted file', () => {
      const actpDir = path.join(tempDir, '.actp');
      const nonceFile = path.join(actpDir, 'nonces.json');

      // Write corrupted data
      fs.writeFileSync(nonceFile, 'invalid json {{{');

      // Should throw meaningful error
      expect(() => {
        new FileBasedNonceManager(tempDir);
      }).toThrow('Failed to parse');
    });

    it('should handle missing file gracefully', async () => {
      // File doesn't exist yet - should work fine
      const nonce = await fileNonceManager.getAndIncrementNonce('new-type');
      expect(nonce).toBe(1);
    });
  });

  describe('concurrent file access', () => {
    it('should handle rapid sequential writes', async () => {
      for (let i = 0; i < 20; i++) {
        await fileNonceManager.getAndIncrementNonce('sender');
      }

      const currentNonce = fileNonceManager.getCurrentNonce('sender');
      expect(currentNonce).toBe(20);
    });

    it('should handle multiple message types sequentially', async () => {
      // FileBasedNonceManager uses file locking, so we run sequentially to avoid lock contention
      for (let i = 0; i < 10; i++) {
        await fileNonceManager.getAndIncrementNonce(`type-${i % 3}`);
      }

      // Should have processed all without errors
      expect(fileNonceManager.getCurrentNonce('type-0')).toBeGreaterThan(0);
      expect(fileNonceManager.getCurrentNonce('type-1')).toBeGreaterThan(0);
      expect(fileNonceManager.getCurrentNonce('type-2')).toBeGreaterThan(0);
    });
  });

  describe('clearAll()', () => {
    it('should delete file on clearAll', async () => {
      await fileNonceManager.getAndIncrementNonce('type-a');

      const actpDir = path.join(tempDir, '.actp');
      const nonceFile = path.join(actpDir, 'nonces.json');

      expect(fs.existsSync(nonceFile)).toBe(true);

      fileNonceManager.clearAll();

      expect(fs.existsSync(nonceFile)).toBe(false);
    });
  });
});

describe('createNonceManager factory', () => {
  it('should create InMemoryNonceManager by default', () => {
    const manager = createNonceManager();
    expect(manager).toBeInstanceOf(InMemoryNonceManager);
  });

  it('should create DIDScopedNonceManager when DID provided', () => {
    const manager = createNonceManager({
      did: 'did:ethr:0x1234567890123456789012345678901234567890'
    });
    expect(manager).toBeInstanceOf(DIDScopedNonceManager);
  });

  it('should create FileBasedNonceManager when stateDirectory provided', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonce-factory-'));

    try {
      const manager = createNonceManager({ stateDirectory: tempDir });
      expect(manager).toBeInstanceOf(FileBasedNonceManager);
    } finally {
      // Cleanup
      const actpDir = path.join(tempDir, '.actp');
      if (fs.existsSync(actpDir)) {
        fs.rmSync(actpDir, { recursive: true, force: true });
      }
      fs.rmdirSync(tempDir);
    }
  });

  it('should accept initial nonces', () => {
    const manager = createNonceManager({
      initialNonces: { 'type-a': 100 }
    });

    expect(manager.getCurrentNonce('type-a')).toBe(100);
  });
});

describe('NonceManager edge cases', () => {
  let nonceManager: InMemoryNonceManager;

  beforeEach(() => {
    nonceManager = new InMemoryNonceManager();
  });

  it('should handle very large nonces', () => {
    const largeNonce = MAX_NONCE_VALUE - 1;
    nonceManager.recordNonce('sender', largeNonce);

    expect(nonceManager.getCurrentNonce('sender')).toBe(largeNonce);
  });

  it('should handle empty message type string', () => {
    nonceManager.recordNonce('', 5);

    expect(nonceManager.getCurrentNonce('')).toBe(5);
  });

  it('should handle special characters in message type', () => {
    const messageType = 'agirails.delivery.v1!@#$%^&*()';
    nonceManager.recordNonce(messageType, 5);

    expect(nonceManager.getCurrentNonce(messageType)).toBe(5);
  });

  it('should handle rapid nonce generation', async () => {
    const startTime = Date.now();
    const count = 1000;

    for (let i = 0; i < count; i++) {
      await nonceManager.getAndIncrementNonce('rapid-type');
    }

    const elapsed = Date.now() - startTime;

    expect(nonceManager.getCurrentNonce('rapid-type')).toBe(count);
    // Should complete in reasonable time (less than 1 second for 1000 operations)
    expect(elapsed).toBeLessThan(1000);
  });

  it('should maintain monotonic ordering across resets', async () => {
    await nonceManager.getAndIncrementNonce('type-a');
    await nonceManager.getAndIncrementNonce('type-a');

    const beforeReset = nonceManager.getCurrentNonce('type-a');
    expect(beforeReset).toBe(2);

    nonceManager.resetNonce('type-a');

    const afterReset = nonceManager.getCurrentNonce('type-a');
    expect(afterReset).toBe(0);
  });
});

describe('Nonce deadlock prevention', () => {
  let nonceManager: InMemoryNonceManager;

  beforeEach(() => {
    nonceManager = new InMemoryNonceManager();
  });

  it('should not deadlock on concurrent access', async () => {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error('Timeout')), ms);
      });

    const operations = Array(100).fill(null).map(() =>
      nonceManager.getAndIncrementNonce('deadlock-test')
    );

    try {
      // Should complete within 5 seconds, not deadlock
      await expect(
        Promise.race([
          Promise.all(operations),
          timeout(5000)
        ])
      ).resolves.toBeDefined();
    } finally {
      // Always clear the timeout to prevent Jest open handle warning
      if (timerId) clearTimeout(timerId);
    }
  });

  it('should release lock after error', async () => {
    // Create manager at max nonce
    const manager = new InMemoryNonceManager({
      'error-type': MAX_NONCE_VALUE
    });

    // This should throw due to overflow
    try {
      await manager.getAndIncrementNonce('error-type');
    } catch (e) {
      // Expected error
    }

    // Should still work for other message types
    const nonce = await manager.getAndIncrementNonce('other-type');
    expect(typeof nonce).toBe('number');
  });
});
