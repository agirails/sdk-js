/**
 * Keystore Resolution Tests
 *
 * Tests cover:
 * - resolvePrivateKey: env var priority, keystore decrypt, cache behavior,
 *   missing password, invalid key format, path validation
 * - ACTP_KEYSTORE_BASE64: base64 decryption, priority, cache, error handling
 * - ACTP_PRIVATE_KEY policy: fail-closed (mainnet/unknown), warn (testnet), silent (mock)
 * - Error redaction: no secret leakage in error messages
 * - getCachedAddress: env var path, base64 path, keystore path, no-cache returns undefined
 * - _clearCache: resets all caches
 *
 * @module wallet/keystore.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Wallet, HDNodeWallet } from 'ethers';
import { resolvePrivateKey, getCachedAddress, _clearCache } from './keystore';
import { sdkLogger } from '../utils/Logger';

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
    delete process.env.ACTP_KEYSTORE_BASE64;
    delete process.env.ACTP_NETWORK;
    // Set testnet by default so existing ACTP_PRIVATE_KEY tests don't fail-closed
    process.env.ACTP_NETWORK = 'testnet';
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
      const _firstCallMs = Date.now() - start;

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
      await expect(resolvePrivateKey('../../etc')).rejects.toThrow(
        'path traversal'
      );
    });
  });

  // ============================================================================
  // resolvePrivateKey — ACTP_KEYSTORE_BASE64
  // ============================================================================

  describe('resolvePrivateKey — ACTP_KEYSTORE_BASE64', () => {
    let encryptedKeystore: string;
    let base64Keystore: string;

    beforeAll(async () => {
      const wallet = new Wallet(TEST_KEY);
      encryptedKeystore = await wallet.encrypt(TEST_PASSWORD);
      base64Keystore = Buffer.from(encryptedKeystore).toString('base64');
    });

    test('decrypts base64 keystore', async () => {
      process.env.ACTP_KEYSTORE_BASE64 = base64Keystore;
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      const key = await resolvePrivateKey();
      expect(key).toBe(TEST_KEY);
    });

    test('priority: ACTP_PRIVATE_KEY > ACTP_KEYSTORE_BASE64 > file keystore', async () => {
      // Set all three sources with different keys
      const otherWallet = Wallet.createRandom();
      const otherKeystore = await otherWallet.encrypt(TEST_PASSWORD);
      const otherBase64 = Buffer.from(otherKeystore).toString('base64');

      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      process.env.ACTP_KEYSTORE_BASE64 = otherBase64;
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      // ACTP_PRIVATE_KEY wins
      const key = await resolvePrivateKey(testDir);
      expect(key).toBe(TEST_KEY);
    });

    test('base64 takes priority over file keystore', async () => {
      const otherWallet = Wallet.createRandom();
      await writeKeystore(testDir, otherWallet, TEST_PASSWORD);

      process.env.ACTP_KEYSTORE_BASE64 = base64Keystore;
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      const key = await resolvePrivateKey(testDir);
      expect(key).toBe(TEST_KEY); // base64 keystore has TEST_KEY
    });

    test('missing ACTP_KEY_PASSWORD throws clear error', async () => {
      process.env.ACTP_KEYSTORE_BASE64 = base64Keystore;
      delete process.env.ACTP_KEY_PASSWORD;

      await expect(resolvePrivateKey()).rejects.toThrow(
        'ACTP_KEY_PASSWORD is not set'
      );
    });

    test('invalid base64 throws clear error', async () => {
      process.env.ACTP_KEYSTORE_BASE64 = '!!!not-base64!!!';
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      await expect(resolvePrivateKey()).rejects.toThrow(
        'not valid encrypted keystore JSON'
      );
    });

    test('non-JSON base64 content throws', async () => {
      process.env.ACTP_KEYSTORE_BASE64 = Buffer.from('hello world').toString('base64');
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      await expect(resolvePrivateKey()).rejects.toThrow(
        'not valid encrypted keystore JSON'
      );
    });

    test('whitespace/newlines in base64 string are stripped', async () => {
      // Simulate platform injecting whitespace
      const withWhitespace = base64Keystore.match(/.{1,40}/g)!.join('\n');
      process.env.ACTP_KEYSTORE_BASE64 = withWhitespace;
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      const key = await resolvePrivateKey();
      expect(key).toBe(TEST_KEY);
    });

    test('caches base64 result (second call near-instant)', async () => {
      process.env.ACTP_KEYSTORE_BASE64 = base64Keystore;
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      await resolvePrivateKey(); // warm cache

      const start = Date.now();
      const key = await resolvePrivateKey();
      const elapsed = Date.now() - start;

      expect(key).toBe(TEST_KEY);
      expect(elapsed).toBeLessThan(50);
    });
  });

  // ============================================================================
  // resolvePrivateKey — ACTP_PRIVATE_KEY policy (fail-closed)
  // ============================================================================

  describe('resolvePrivateKey — ACTP_PRIVATE_KEY policy', () => {
    test('mainnet + ACTP_PRIVATE_KEY → throws', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      delete process.env.ACTP_NETWORK;

      await expect(
        resolvePrivateKey(undefined, { network: 'mainnet' })
      ).rejects.toThrow('not allowed in production');
    });

    test('unknown network (null) + ACTP_PRIVATE_KEY → throws (fail-closed)', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      delete process.env.ACTP_NETWORK;

      await expect(
        resolvePrivateKey(undefined, { network: undefined })
      ).rejects.toThrow('not allowed in unknown network');
    });

    test('ACTP_NETWORK unset + no options.network → throws (fail-closed)', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      delete process.env.ACTP_NETWORK;

      await expect(resolvePrivateKey()).rejects.toThrow('fail-closed');
    });

    test('testnet + ACTP_PRIVATE_KEY → warns but returns key', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      const warnSpy = jest.spyOn(sdkLogger, 'warn').mockImplementation();

      const key = await resolvePrivateKey(undefined, { network: 'testnet' });
      expect(key).toBe(TEST_KEY);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('deprecated')
      );

      warnSpy.mockRestore();
    });

    test('mock + ACTP_PRIVATE_KEY → returns key, no warning', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      const warnSpy = jest.spyOn(sdkLogger, 'warn').mockImplementation();

      const key = await resolvePrivateKey(undefined, { network: 'mock' });
      expect(key).toBe(TEST_KEY);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    test('testnet warning NOT repeated on cache hits', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      const warnSpy = jest.spyOn(sdkLogger, 'warn').mockImplementation();

      await resolvePrivateKey(undefined, { network: 'testnet' });
      await resolvePrivateKey(undefined, { network: 'testnet' });

      // Only called once (first resolution)
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    test('ACTP_NETWORK env var fallback works', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      process.env.ACTP_NETWORK = 'mock';

      // No options.network → falls back to ACTP_NETWORK=mock → silent
      const key = await resolvePrivateKey();
      expect(key).toBe(TEST_KEY);
    });
  });

  // ============================================================================
  // resolvePrivateKey — error redaction
  // ============================================================================

  describe('resolvePrivateKey — error redaction', () => {
    test('ACTP_KEYSTORE_BASE64 errors do NOT contain raw keystore content', async () => {
      // Valid JSON but not a valid keystore
      const fakeKeystore = JSON.stringify({ address: '0x1234', notAKeystore: true });
      process.env.ACTP_KEYSTORE_BASE64 = Buffer.from(fakeKeystore).toString('base64');
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      try {
        await resolvePrivateKey();
        fail('Expected an error');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain('notAKeystore');
        expect(message).toContain('Failed to decrypt');
      }
    });

    test('ACTP_PRIVATE_KEY mainnet error does NOT contain the key value', async () => {
      process.env.ACTP_PRIVATE_KEY = TEST_KEY;
      delete process.env.ACTP_NETWORK;

      try {
        await resolvePrivateKey(undefined, { network: 'mainnet' });
        fail('Expected an error');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(TEST_KEY);
        expect(message).not.toContain(TEST_KEY.slice(2));
      }
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

    test('returns address after base64 resolution', async () => {
      const wallet = new Wallet(TEST_KEY);
      const encrypted = await wallet.encrypt(TEST_PASSWORD);
      process.env.ACTP_KEYSTORE_BASE64 = Buffer.from(encrypted).toString('base64');
      process.env.ACTP_KEY_PASSWORD = TEST_PASSWORD;

      await resolvePrivateKey();
      expect(getCachedAddress()).toBe(TEST_ADDRESS);
    });

    test('returns undefined before base64 resolution', () => {
      process.env.ACTP_KEYSTORE_BASE64 = 'something';
      // Not resolved yet
      expect(getCachedAddress()).toBeUndefined();
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
