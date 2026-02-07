/**
 * Keystore Resolution Tests
 *
 * Tests cover:
 * - resolvePrivateKey: env var priority, keystore decrypt, cache behavior,
 *   missing password, invalid key format, path validation
 * - getCachedAddress: env var path, keystore path, no-cache returns undefined
 * - _clearCache: resets all caches
 *
 * @module wallet/keystore.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Wallet, HDNodeWallet } from 'ethers';
import { resolvePrivateKey, getCachedAddress, _clearCache } from './keystore';

// Known test wallet (DO NOT use for real funds)
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = new Wallet(TEST_KEY).address;
const TEST_PASSWORD = 'test-password-123';

describe('Keystore Resolution', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Snapshot env
    originalEnv = { ...process.env };
    // Clean env vars that affect resolution
    delete process.env.ACTP_PRIVATE_KEY;
    delete process.env.ACTP_KEY_PASSWORD;
    // Clear module-level cache
    _clearCache();
    // Create temp directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-test-'));
  });

  afterEach(() => {
    // Restore env
    process.env = originalEnv;
    // Cleanup temp dir
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // resolvePrivateKey — env var path
  // ============================================================================

  describe('resolvePrivateKey — env var', () => {
    test('returns ACTP_PRIVATE_KEY when set', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      const key = await resolvePrivateKey();
      expect(key).toBe(TEST_KEY);
    });

    test('env var takes priority over keystore', async () => {
      // Create a keystore with a DIFFERENT key
      const otherWallet = Wallet.createRandom();
      await writeKeystore(testDir, otherWallet, TEST_PASSWORD);
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      // Set env var to TEST_KEY
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;

      const key = await resolvePrivateKey(testDir);
      expect(key).toBe(TEST_KEY);
    });

    test('trims whitespace from env var', async () => {
      process.env.ACTP_PRIVATE_KEY = `  ${TEST_KEY}  `;
      const key = await resolvePrivateKey();
      expect(key).toBe(TEST_KEY);
    });

    test('rejects invalid env var format', async () => {
      process.env.ACTP_PRIVATE_KEY = 'not-a-valid-key';
      await expect(resolvePrivateKey()).rejects.toThrow('Invalid private key');
    });

    test('rejects env var without 0x prefix', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY.slice(2); // remove 0x
      await expect(resolvePrivateKey()).rejects.toThrow('Invalid private key');
    });

    test('caches env var result', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      const key1 = await resolvePrivateKey();
      const key2 = await resolvePrivateKey();
      expect(key1).toBe(key2);
      expect(key1).toBe(TEST_KEY);
    });
  });

  // ============================================================================
  // resolvePrivateKey — keystore path
  // ============================================================================

  describe('resolvePrivateKey — keystore', () => {
    test('decrypts keystore with correct password', async () => {
      const wallet = new Wallet(TEST_KEY);
      await writeKeystore(testDir, wallet, TEST_PASSWORD);
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      const key = await resolvePrivateKey(testDir);
      expect(key).toBe(TEST_KEY);
    });

    test('returns undefined when no keystore and no env var', async () => {
      const key = await resolvePrivateKey(testDir);
      expect(key).toBeUndefined();
    });

    test('throws when keystore exists but no ACTP_KEY_PASSWORD', async () => {
      const wallet = new Wallet(TEST_KEY);
      await writeKeystore(testDir, wallet, TEST_PASSWORD);
      // Don't set ACTP_KEY_PASSWORD

      await expect(resolvePrivateKey(testDir)).rejects.toThrow(
        'ACTP_KEY_PASSWORD is not set'
      );
    });

    test('throws on wrong password (bad MAC)', async () => {
      const wallet = new Wallet(TEST_KEY);
      await writeKeystore(testDir, wallet, TEST_PASSWORD);
      process.env.ACTP_KEY_PASSWORD = 'wrong-password';

      await expect(resolvePrivateKey(testDir)).rejects.toThrow();
    });

    test('uses cwd when stateDirectory is undefined', async () => {
      // No keystore in cwd → undefined (just verifying it doesn't throw)
      const key = await resolvePrivateKey();
      expect(key).toBeUndefined();
    });
  });

  // ============================================================================
  // resolvePrivateKey — cache behavior
  // ============================================================================

  describe('resolvePrivateKey — cache', () => {
    test('caches keystore result (scrypt runs once)', async () => {
      const wallet = new Wallet(TEST_KEY);
      await writeKeystore(testDir, wallet, TEST_PASSWORD);
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      const start = Date.now();
      const key1 = await resolvePrivateKey(testDir);
      const firstCallMs = Date.now() - start;

      const start2 = Date.now();
      const key2 = await resolvePrivateKey(testDir);
      const secondCallMs = Date.now() - start2;

      expect(key1).toBe(key2);
      // Second call should be near-instant (cache hit) vs first call (scrypt ~1-2s)
      expect(secondCallMs).toBeLessThan(50);
    });

    test('different stateDirectories get separate cache entries', async () => {
      const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-test-1-'));
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-test-2-'));

      try {
        const wallet1 = new Wallet(TEST_KEY);
        const wallet2 = Wallet.createRandom();

        await writeKeystore(dir1, wallet1, TEST_PASSWORD);
        await writeKeystore(dir2, wallet2, TEST_PASSWORD);
        process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

        const key1 = await resolvePrivateKey(dir1);
        const key2 = await resolvePrivateKey(dir2);

        expect(key1).toBe(TEST_KEY);
        expect(key2).toBe(wallet2.privateKey);
        expect(key1).not.toBe(key2);
      } finally {
        fs.rmSync(dir1, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });

    test('_clearCache resets all caches', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      await resolvePrivateKey();
      expect(getCachedAddress()).toBe(TEST_ADDRESS);

      _clearCache();
      expect(getCachedAddress()).toBeUndefined();
    });
  });

  // ============================================================================
  // resolvePrivateKey — path validation
  // ============================================================================

  describe('resolvePrivateKey — path validation', () => {
    test('rejects null bytes in stateDirectory', async () => {
      await expect(resolvePrivateKey('/tmp/test\0evil')).rejects.toThrow(
        'null byte'
      );
    });

    test('rejects path traversal in stateDirectory', async () => {
      await expect(resolvePrivateKey('/tmp/../../../etc')).rejects.toThrow(
        'path traversal'
      );
    });
  });

  // ============================================================================
  // getCachedAddress
  // ============================================================================

  describe('getCachedAddress', () => {
    test('returns undefined before any resolution', () => {
      expect(getCachedAddress()).toBeUndefined();
    });

    test('returns address after env var resolution', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      await resolvePrivateKey();
      expect(getCachedAddress()).toBe(TEST_ADDRESS);
    });

    test('returns address after keystore resolution', async () => {
      const wallet = new Wallet(TEST_KEY);
      await writeKeystore(testDir, wallet, TEST_PASSWORD);
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      await resolvePrivateKey(testDir);
      expect(getCachedAddress(testDir)).toBe(TEST_ADDRESS);
    });

    test('returns undefined for unresolved stateDirectory', async () => {
      const wallet = new Wallet(TEST_KEY);
      await writeKeystore(testDir, wallet, TEST_PASSWORD);
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      await resolvePrivateKey(testDir);
      // Different directory → no cache hit
      expect(getCachedAddress('/some/other/dir')).toBeUndefined();
    });
  });
});

// ============================================================================
// Helpers
// ============================================================================

async function writeKeystore(
  stateDirectory: string,
  wallet: Wallet | HDNodeWallet,
  password: string
): Promise<void> {
  const actpDir = path.join(stateDirectory, '.actp');
  fs.mkdirSync(actpDir, { recursive: true });
  const keystore = await wallet.encrypt(password);
  fs.writeFileSync(path.join(actpDir, 'keystore.json'), keystore, { mode: 0o600 });
}
