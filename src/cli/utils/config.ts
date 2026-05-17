/**
 * CLI Configuration Management
 *
 * Handles reading/writing CLI configuration stored in .actp/config.json.
 * Supports mock, testnet, and mainnet modes with mode-specific validation.
 *
 * @module cli/utils/config
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

/**
 * CLI operating mode
 */
export type CLIMode = 'mock' | 'testnet' | 'mainnet';

/**
 * CLI configuration stored in .actp/config.json
 */
export interface CLIConfig {
  /** Operating mode */
  mode: CLIMode;

  /** User's Ethereum address */
  address: string;

  /** Optional: RPC URL override */
  rpcUrl?: string;

  /** AIP-12: Wallet type — 'auto' (Smart Wallet, gasless) or 'eoa' (traditional) */
  wallet?: 'auto' | 'eoa';

  /** AIP-12: Smart Wallet address (set when wallet=auto, used by `actp publish`) */
  smartWallet?: string;

  /** AIP-12: Whether agent is registered on AgentRegistry */
  registered?: boolean;

  /** Configuration version for migrations */
  version: string;

  /** Agent name from AGIRAILS.md */
  agentName?: string;

  /** Agent intent: earn, pay, or both */
  intent?: 'earn' | 'pay' | 'both';

  /** Service capabilities from AGIRAILS.md */
  capabilities?: string[];

  /** Base price in USDC */
  price?: number;

  /** Max concurrent jobs */
  concurrency?: number;

  /** Payment mode: actp, x402, or both */
  paymentMode?: 'actp' | 'x402' | 'both';

  /** Budget cap in USDC */
  budget?: number;

  /** Identity pointer: filename of the {slug}.md identity file (e.g. "code-reviewer.md") */
  identity?: string;
}

/**
 * Default configuration values
 */
export const CONFIG_DEFAULTS: CLIConfig = {
  mode: 'mock',
  address: '',
  version: '1.0',
};

// ============================================================================
// Paths
// ============================================================================

/**
 * Get the .actp directory path.
 * Respects ACTP_DIR env var override for custom locations.
 */
export function getActpDir(projectRoot: string = process.cwd()): string {
  if (process.env.ACTP_DIR) {
    return process.env.ACTP_DIR;
  }
  return path.join(projectRoot, '.actp');
}

/**
 * Get the config.json path
 */
export function getConfigPath(projectRoot: string = process.cwd()): string {
  return path.join(getActpDir(projectRoot), 'config.json');
}

// ============================================================================
// Config Operations
// ============================================================================

/**
 * Check if ACTP is initialized in the current directory
 */
export function isInitialized(projectRoot: string = process.cwd()): boolean {
  return fs.existsSync(getConfigPath(projectRoot));
}

/**
 * Load configuration from disk
 *
 * SECURITY: Warns about private key storage in config file.
 *
 * @throws Error if config doesn't exist or is corrupted
 */
export function loadConfig(projectRoot: string = process.cwd()): CLIConfig {
  const configPath = getConfigPath(projectRoot);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      'ACTP not initialized in this directory.\n' +
        'Run "actp init" to initialize.'
    );
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as CLIConfig;

    // Validate required fields
    if (!config.mode) {
      throw new Error('Config missing required field: mode');
    }
    if (!config.address) {
      throw new Error('Config missing required field: address');
    }

    // Config migration: strip deprecated fields
    if ('privateKey' in config) {
      delete (config as unknown as Record<string, unknown>).privateKey;
    }
    // Config migration: strip deprecated `registered` field (lazy publish)
    if ('registered' in config) {
      delete (config as unknown as Record<string, unknown>).registered;
    }

    return config;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Config file corrupted: ${configPath}\n` +
          'Delete it manually or run "actp init --force"'
      );
    }
    throw error;
  }
}

/**
 * Save configuration to disk
 *
 * Creates .actp directory if it doesn't exist.
 * Uses atomic write (temp file + rename).
 */
export function saveConfig(
  config: CLIConfig,
  projectRoot: string = process.cwd()
): void {
  const actpDir = getActpDir(projectRoot);
  const configPath = getConfigPath(projectRoot);
  const tempPath = `${configPath}.tmp`;

  // Ensure .actp directory exists
  if (!fs.existsSync(actpDir)) {
    fs.mkdirSync(actpDir, { recursive: true, mode: 0o755 });
  }

  try {
    // Atomic write: write to temp, then rename
    const json = JSON.stringify(config, null, 2);
    fs.writeFileSync(tempPath, json, { encoding: 'utf-8', mode: 0o600 }); // Secure permissions
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    // Clean up temp file on error
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw error;
  }
}

/**
 * Update specific config values
 *
 * Loads existing config, merges updates, and saves.
 */
export function updateConfig(
  updates: Partial<CLIConfig>,
  projectRoot: string = process.cwd()
): CLIConfig {
  const config = loadConfig(projectRoot);
  const updated = { ...config, ...updates };
  saveConfig(updated, projectRoot);
  return updated;
}

/**
 * Get a specific config value
 */
export function getConfigValue<K extends keyof CLIConfig>(
  key: K,
  projectRoot: string = process.cwd()
): CLIConfig[K] {
  const config = loadConfig(projectRoot);
  return config[key];
}

/**
 * Set a specific config value
 */
export function setConfigValue<K extends keyof CLIConfig>(
  key: K,
  value: CLIConfig[K],
  projectRoot: string = process.cwd()
): void {
  updateConfig({ [key]: value } as Partial<CLIConfig>, projectRoot);
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate Ethereum address format
 */
export function validateAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate private key format (64 hex chars, optionally with 0x prefix)
 */
export function validatePrivateKey(key: string): boolean {
  // Remove 0x prefix if present
  const normalized = key.startsWith('0x') ? key.slice(2) : key;
  return /^[a-fA-F0-9]{64}$/.test(normalized);
}

/**
 * Validate config for the specified mode
 *
 * @throws Error if config is invalid for the mode
 */
export function validateConfigForMode(config: CLIConfig): void {
  // All modes require a valid address
  if (!validateAddress(config.address)) {
    throw new Error(
      `Invalid address: "${config.address}"\n` +
        'Expected 0x-prefixed 40-character hex string.'
    );
  }

  // Testnet/mainnet credentials are resolved via AIP-13 keystore at runtime.
  // No private key validation needed here — ACTPClient.create() handles it.
}

// ============================================================================
// Gitignore Management
// ============================================================================

/**
 * Add .actp to .gitignore if not already present
 */
export function addToGitignore(projectRoot: string = process.cwd()): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }

  // Apex audit FIND-012(b): consumers regularly commit `.env` files
  // containing ACTP_KEY_PASSWORD or ACTP_PRIVATE_KEY without realising
  // it. The dockerignore / railwayignore helpers already cover `.env`
  // patterns; gitignore covered only `.actp/` before this fix. Now
  // adds the same `.env` patterns to `.gitignore` so a downstream
  // `actp init` user is protected at the git boundary too.
  const desired: Array<{ pattern: RegExp; line: string }> = [
    { pattern: /^\.actp\/?$/m, line: '.actp/' },
    { pattern: /^\.env$/m, line: '.env' },
    { pattern: /^\.env\.\*$/m, line: '.env.*' },
  ];

  const missing = desired.filter(({ pattern }) => !pattern.test(content));
  if (missing.length === 0) return;

  const header = '# ACTP — local state + secrets (do not commit)\n';
  const headerPresent = content.includes(header.trim());

  const newContent =
    content +
    (content.length > 0 && !content.endsWith('\n') ? '\n' : '') +
    (headerPresent ? '' : header) +
    missing.map((m) => m.line).join('\n') + '\n';

  fs.writeFileSync(gitignorePath, newContent, 'utf-8');
}

/**
 * Write a starter `.env.example` to the project root if one isn't already
 * present. Apex audit FIND-012(b): downstream agents that read secrets
 * from `.env` need a documented schema with placeholder values, not raw
 * keys committed to git. The example commits to git; the live `.env`
 * sits in `.gitignore` (see `addToGitignore` above).
 *
 * Idempotent: if `.env.example` already exists, leaves it alone — the
 * project owner may have customised it.
 */
export function writeEnvExample(projectRoot: string = process.cwd()): void {
  const envExamplePath = path.join(projectRoot, '.env.example');
  assertNotSymlink(envExamplePath);
  if (fs.existsSync(envExamplePath)) return;

  const content =
    '# ACTP runtime secrets — never commit a populated `.env` to git.\n' +
    '#\n' +
    '# `actp init` adds `.env` and `.env.*` to .gitignore so the live\n' +
    '# file stays local. This example is committed to document the schema.\n' +
    '#\n' +
    '# Wallet selection (pick ONE of the two patterns):\n' +
    '#\n' +
    '# Pattern A — encrypted keystore + password (recommended for CI / deploy):\n' +
    '#   ACTP_KEYSTORE_BASE64=<base64 of your .actp/keystore.json>\n' +
    '#   ACTP_KEY_PASSWORD=<password that decrypts the keystore>\n' +
    '# Tip: `actp deploy:env` formats both for your env target.\n' +
    '#\n' +
    '# Pattern B — raw private key (testnet ONLY; mainnet refuses this path):\n' +
    '#   ACTP_PRIVATE_KEY=0x...\n' +
    '#\n' +
    '# Network selector:\n' +
    '#   ACTP_NETWORK=testnet     # mock | testnet | mainnet\n' +
    '#\n' +
    '# Optional overrides:\n' +
    '#   BASE_SEPOLIA_RPC=https://...    # custom Base Sepolia RPC\n' +
    '#   BASE_MAINNET_RPC=https://...    # custom Base mainnet RPC\n' +
    '#   CDP_API_KEY=...                 # Coinbase Cloud bundler / paymaster\n' +
    '#   PIMLICO_API_KEY=...             # Pimlico bundler / paymaster\n';

  fs.writeFileSync(envExamplePath, content, 'utf-8');
}

// ============================================================================
// Ignore File Management (AIP-13)
// ============================================================================

const IGNORE_ENTRIES = ['.actp/', '.env', '.env.*', 'node_modules/'];
const IGNORE_HEADER = '# ACTP deployment security (AIP-13)';

/**
 * Validate that a file path is not a symlink.
 * Throws if the path exists and is a symlink (security: prevents symlink attacks).
 */
function assertNotSymlink(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to write ${path.basename(filePath)}: path is a symlink. Remove the symlink and retry.`
      );
    }
  } catch (err) {
    // Re-throw symlink errors; ENOENT (file doesn't exist) is fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Add standard ignore entries to a file (idempotent).
 * Creates the file if it doesn't exist.
 */
function addIgnoreEntries(filePath: string): void {
  assertNotSymlink(filePath);

  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  // Only add entries that are missing (check each individually)
  const missingEntries = IGNORE_ENTRIES.filter(entry => !content.includes(entry));
  if (missingEntries.length === 0) return;

  const newContent =
    content +
    (content.length > 0 && !content.endsWith('\n') ? '\n' : '') +
    IGNORE_HEADER + '\n' +
    missingEntries.join('\n') + '\n';

  fs.writeFileSync(filePath, newContent, 'utf-8');
}

/**
 * Add .actp/ and related entries to .dockerignore (AIP-13).
 * Creates the file if it doesn't exist. Idempotent.
 * Throws if .dockerignore is a symlink.
 */
export function addToDockerignore(projectRoot: string = process.cwd()): void {
  addIgnoreEntries(path.join(projectRoot, '.dockerignore'));
}

/**
 * Add .actp/ and related entries to .railwayignore (AIP-13).
 * Creates the file if it doesn't exist. Idempotent.
 * Throws if .railwayignore is a symlink.
 */
export function addToRailwayignore(projectRoot: string = process.cwd()): void {
  addIgnoreEntries(path.join(projectRoot, '.railwayignore'));
}

// ============================================================================
// Identity File Resolution
// ============================================================================

/**
 * Resolve the absolute path to the agent's {slug}.md identity file.
 *
 * Reads the `identity` pointer from config.json. Returns null if
 * no pointer is set or if the file doesn't exist on disk.
 *
 * @param projectRoot - Project root directory
 * @returns Absolute path to the identity file, or null
 */
export function resolveIdentityPath(projectRoot: string = process.cwd()): string | null {
  // Primary: read config.identity pointer
  try {
    const config = loadConfig(projectRoot);
    if (config.identity) {
      const identityPath = path.join(projectRoot, config.identity);
      if (fs.existsSync(identityPath)) return identityPath;
    }
  } catch {
    // fall through to auto-detect
  }

  // Fallback: scan project root for {slug}.md identity files.
  // This handles cases where init ran before the identity file was created,
  // or where the user manually wrote a .md file after init.
  try {
    const skip = new Set(['AGIRAILS.md', 'README.md', 'CHANGELOG.md', 'SCRATCHPAD.md', 'NOTES.md']);
    const mdFiles = fs.readdirSync(projectRoot).filter(
      (f) => f.endsWith('.md') && !skip.has(f)
    );

    for (const mdFile of mdFiles) {
      try {
        // Use a lazy require to avoid a circular import between config → agirailsmdV4
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { parseAgirailsMdV4 } = require('../../config/agirailsmdV4');
        const content = fs.readFileSync(path.join(projectRoot, mdFile), 'utf-8');
        const v4 = parseAgirailsMdV4(content);
        if (v4.name && v4.services && v4.services.length > 0) {
          return path.join(projectRoot, mdFile);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }

  return null;
}
