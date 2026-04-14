/**
 * Keystore auto-resolution for ACTP wallets.
 *
 * Resolution order (AIP-13):
 *   1. ACTP_PRIVATE_KEY env var (policy-gated: mainnet/unknown = hard fail)
 *   2. ACTP_KEYSTORE_BASE64 + ACTP_KEY_PASSWORD (deployment-safe, preferred)
 *   3. .actp/keystore.json decrypted with ACTP_KEY_PASSWORD
 *   4. undefined (caller decides what to do)
 */
import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from 'ethers';
import { sdkLogger } from '../utils/Logger';

/** 30-minute TTL for cached private keys */
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  key: string;
  address: string;
  expiresAt: number;
}

export interface ResolvePrivateKeyOptions {
  /** Network mode: 'mainnet', 'testnet', or 'mock'. Controls ACTP_PRIVATE_KEY policy. */
  network?: string;
}

// Cache keyed by resolved keystorePath to support multiple stateDirectories
const _cache = new Map<string, CacheEntry>();

// Separate cache for env-var-resolved key (no path dependency)
let _envCache: CacheEntry | null = null;

// Separate cache for base64-resolved key (no path dependency)
let _base64Cache: CacheEntry | null = null;

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
  // Normalize, then check if any '..' segments remain (relative traversal)
  const path = require('path');
  const normalized = path.normalize(stateDirectory);
  const segments = normalized.split(path.sep);
  if (segments.includes('..')) {
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
 * Determine the effective network for ACTP_PRIVATE_KEY policy.
 * Falls back to ACTP_NETWORK env var. Null means unknown (fail-closed).
 */
function getEffectiveNetwork(options?: ResolvePrivateKeyOptions): string | null {
  return options?.network ?? process.env.ACTP_NETWORK ?? null;
}

/**
 * Enforce ACTP_PRIVATE_KEY policy based on network (AIP-13).
 * - mainnet/unknown: hard fail
 * - testnet: warn once (on first resolution, not cache hits)
 * - mock: silent
 */
function enforcePrivateKeyPolicy(network: string | null): void {
  if (network === 'mock') return;

  if (network === 'testnet') {
    // Warn once (only on first resolution — _envCache is null)
    if (_envCache === null) {
      sdkLogger.warn(
        'ACTP_PRIVATE_KEY is deprecated. Use ACTP_KEYSTORE_BASE64 instead.\n' +
        'Run: actp deploy:env'
      );
    }
    return;
  }

  // mainnet or unknown (null) — fail-closed
  const networkLabel = network === 'mainnet' ? 'production' : 'unknown network (fail-closed)';
  throw new Error(
    `ACTP_PRIVATE_KEY is not allowed in ${networkLabel}. Use ACTP_KEYSTORE_BASE64 instead.\n` +
    'Run: actp deploy:env\n' +
    'If this is testnet, set ACTP_NETWORK=testnet'
  );
}

/**
 * Auto-resolve private key: env var → base64 keystore → file keystore → undefined.
 * Never logs or prints the key itself.
 *
 * @param stateDirectory - Directory containing .actp/ (defaults to cwd)
 * @param options - Options including network for ACTP_PRIVATE_KEY policy
 */
export async function resolvePrivateKey(
  stateDirectory?: string,
  options?: ResolvePrivateKeyOptions
): Promise<string | undefined> {
  // 1. ACTP_PRIVATE_KEY (highest priority, policy-gated)
  if (process.env.ACTP_PRIVATE_KEY) {
    const network = getEffectiveNetwork(options);
    enforcePrivateKeyPolicy(network);

    if (_envCache && !isExpired(_envCache)) return _envCache.key;

    const key = validateRawKey(process.env.ACTP_PRIVATE_KEY, 'ACTP_PRIVATE_KEY env var');
    const address = new Wallet(key).address;
    _envCache = { key, address, expiresAt: Date.now() + CACHE_TTL_MS };
    return key;
  }

  // 2. ACTP_KEYSTORE_BASE64 (deployment-safe, preferred for production)
  if (process.env.ACTP_KEYSTORE_BASE64) {
    if (_base64Cache && !isExpired(_base64Cache)) return _base64Cache.key;

    const raw = process.env.ACTP_KEYSTORE_BASE64.replace(/\s/g, '');
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf-8');
    } catch {
      throw new Error(
        'ACTP_KEYSTORE_BASE64 is not valid base64.\n' +
        'Run: actp deploy:env'
      );
    }

    try {
      JSON.parse(decoded);
    } catch {
      throw new Error(
        'ACTP_KEYSTORE_BASE64 is not valid encrypted keystore JSON.\n' +
        'Run: actp deploy:env'
      );
    }

    const password = process.env.ACTP_KEY_PASSWORD;
    if (!password) {
      throw new Error(
        'ACTP_KEYSTORE_BASE64 is set but ACTP_KEY_PASSWORD is not set.\n' +
        'Set it: export ACTP_KEY_PASSWORD="your-password"'
      );
    }

    let wallet: Wallet;
    try {
      wallet = (await Wallet.fromEncryptedJson(decoded, password)) as Wallet;
    } catch (err) {
      // Sanitize: do not leak keystore content in error messages
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new Error(
        `Failed to decrypt ACTP_KEYSTORE_BASE64: ${message}`
      );
    }

    _base64Cache = { key: wallet.privateKey, address: wallet.address, expiresAt: Date.now() + CACHE_TTL_MS };
    return wallet.privateKey;
  }

  // 3. Resolve keystore path
  if (stateDirectory) {
    validateStateDirectory(stateDirectory);
  }
  const actpDir = stateDirectory
    ? path.join(stateDirectory, '.actp')
    : path.join(process.cwd(), '.actp');
  const keystorePath = path.resolve(actpDir, 'keystore.json');

  // 4. Cache hit (keyed by resolved path, with TTL)
  const cached = _cache.get(keystorePath);
  if (cached && !isExpired(cached)) return cached.key;
  if (cached) _cache.delete(keystorePath); // expired

  // 5. Keystore file
  if (!fs.existsSync(keystorePath)) return undefined;

  const password = process.env.ACTP_KEY_PASSWORD;
  if (!password) {
    throw new Error(
      'Keystore found but ACTP_KEY_PASSWORD is not set.\n' +
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
 * Works for env-var, base64, and keystore resolution paths.
 */
export function getCachedAddress(stateDirectory?: string): string | undefined {
  // Env var path
  if (_envCache && !isExpired(_envCache)) return _envCache.address;

  // Base64 path
  if (_base64Cache && !isExpired(_base64Cache)) return _base64Cache.address;

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
  _base64Cache = null;
}
