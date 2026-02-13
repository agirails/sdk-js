/**
 * Keystore auto-resolution for ACTP wallets.
 *
 * Resolution order:
 *   1. ACTP_PRIVATE_KEY env var (backward compat, highest priority)
 *   2. .actp/keystore.json decrypted with ACTP_KEY_PASSWORD
 *   3. undefined (caller decides what to do)
 */
import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from 'ethers';

/** 30-minute TTL for cached private keys */
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  key: string;
  address: string;
  expiresAt: number;
}

// Cache keyed by resolved keystorePath to support multiple stateDirectories
const _cache = new Map<string, CacheEntry>();

// Separate cache for env-var-resolved key (no path dependency)
let _envCache: CacheEntry | null = null;

function isExpired(entry: CacheEntry): boolean {
  return Date.now() >= entry.expiresAt;
}

/**
 * Validate that stateDirectory doesn't escape expected boundaries.
 * Guards against path traversal when stateDirectory comes from user input.
 */
function validateStateDirectory(stateDirectory: string): void {
  if (stateDirectory.includes('\0')) {
    throw new Error('Invalid stateDirectory: null byte detected');
  }
  // Reject raw '..' in the input (before normalization resolves it)
  // Catches both relative traversal (../../etc) and embedded traversal (/tmp/../../etc)
  if (stateDirectory.includes('..')) {
    throw new Error('Invalid stateDirectory: path traversal detected (..)');
  }
}

/**
 * Validate and normalize a raw private key string.
 * Trims whitespace and verifies 0x-prefixed 64-char hex format.
 */
function validateRawKey(raw: string, source: string): string {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      `Invalid private key from ${source}: expected 0x-prefixed 64-char hex string`
    );
  }
  return trimmed;
}

/**
 * Auto-resolve private key: env var → keystore → undefined.
 * Never logs or prints the key itself.
 */
export async function resolvePrivateKey(
  stateDirectory?: string
): Promise<string | undefined> {
  // 1. Env var (highest priority, backward compat)
  if (process.env.ACTP_PRIVATE_KEY) {
    if (_envCache && !isExpired(_envCache)) return _envCache.key;

    const key = validateRawKey(process.env.ACTP_PRIVATE_KEY, 'ACTP_PRIVATE_KEY env var');
    const address = new Wallet(key).address;
    _envCache = { key, address, expiresAt: Date.now() + CACHE_TTL_MS };
    return key;
  }

  // 2. Resolve keystore path
  if (stateDirectory) {
    validateStateDirectory(stateDirectory);
  }
  const actpDir = stateDirectory
    ? path.join(stateDirectory, '.actp')
    : path.join(process.cwd(), '.actp');
  const keystorePath = path.resolve(actpDir, 'keystore.json');

  // 3. Cache hit (keyed by resolved path, with TTL)
  const cached = _cache.get(keystorePath);
  if (cached && !isExpired(cached)) return cached.key;
  if (cached) _cache.delete(keystorePath); // expired

  // 4. Keystore file
  if (!fs.existsSync(keystorePath)) return undefined;

  const password = process.env.ACTP_KEY_PASSWORD;
  if (!password) {
    throw new Error(
      'Keystore found at ' + keystorePath + ' but ACTP_KEY_PASSWORD is not set.\n' +
      'Set it: export ACTP_KEY_PASSWORD="your-password"'
    );
  }

  const keystore = fs.readFileSync(keystorePath, 'utf-8');
  const wallet = await Wallet.fromEncryptedJson(keystore, password);

  _cache.set(keystorePath, { key: wallet.privateKey, address: wallet.address, expiresAt: Date.now() + CACHE_TTL_MS });
  return wallet.privateKey;
}

/**
 * Get cached address from last resolvePrivateKey() call.
 * Works for both env-var and keystore resolution paths.
 */
export function getCachedAddress(stateDirectory?: string): string | undefined {
  // Env var path
  if (_envCache && !isExpired(_envCache)) return _envCache.address;

  // Keystore path — look up by resolved path
  const actpDir = stateDirectory
    ? path.join(stateDirectory, '.actp')
    : path.join(process.cwd(), '.actp');
  const keystorePath = path.resolve(actpDir, 'keystore.json');
  const cached = _cache.get(keystorePath);
  if (cached && !isExpired(cached)) return cached.address;
  return undefined;
}

/**
 * Clear all cached keys and addresses (for testing).
 * @internal
 */
export function _clearCache(): void {
  _cache.clear();
  _envCache = null;
}
