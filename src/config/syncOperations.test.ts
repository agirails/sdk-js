/**
 * Sync Operations Tests (diff + pull)
 *
 * Tests diff status detection (6 statuses), pull with integrity
 * verification, IPFS gateway fallback, pull stamp, and force mode.
 *
 * @module config/syncOperations.test
 */

import { diff, pull, DiffOptions, PullOptions } from './syncOperations';
import { computeConfigHash, serializeAgirailsMd } from './agirailsmd';
import * as fs from 'fs';

// ============================================================================
// Mocks
// ============================================================================

jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(),
}));

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

// Mock AgentRegistryClient
const mockGetConfig = jest.fn();
jest.mock('../registry/AgentRegistryClient', () => ({
  AgentRegistryClient: {
    readOnly: jest.fn(() => ({
      getConfig: mockGetConfig,
    })),
  },
}));

// Mock global fetch for IPFS gateway calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock validation (CID validation)
jest.mock('../utils/validation', () => ({
  validateCID: jest.fn(),
}));

// ============================================================================
// Constants and fixtures
// ============================================================================

const ZERO_HASH = '0x' + '0'.repeat(64);

const SAMPLE_MD = `---
name: test-agent
version: "1.0.0"
capabilities:
  - text-generation
---
# Test Agent
`;

const SAMPLE_HASH = computeConfigHash(SAMPLE_MD).configHash;

const SAMPLE_MD_WITH_CONFIG_HASH = `---
name: test-agent
version: "1.0.0"
capabilities:
  - text-generation
config_hash: "${SAMPLE_HASH}"
---
# Test Agent
`;

// Different content (simulates local edit)
const EDITED_MD = `---
name: test-agent
version: "1.0.0"
capabilities:
  - text-generation
  - code-review
---
# Test Agent (edited)
`;

const EDITED_HASH = computeConfigHash(EDITED_MD).configHash;

function defaultDiffOptions(overrides: Partial<DiffOptions> = {}): DiffOptions {
  return {
    path: '/test/AGIRAILS.md',
    agentAddress: '0xagent',
    registryAddress: '0xregistry',
    provider: {} as any,
    ...overrides,
  };
}

function defaultPullOptions(overrides: Partial<PullOptions> = {}): PullOptions {
  return {
    ...defaultDiffOptions(),
    force: false,
    ...overrides,
  };
}

// ============================================================================
// diff()
// ============================================================================

describe('diff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('in-sync: local hash matches on-chain hash', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_MD);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    const result = await diff(defaultDiffOptions());

    expect(result.inSync).toBe(true);
    expect(result.status).toBe('in-sync');
    expect(result.localHash).toBe(SAMPLE_HASH);
    expect(result.onChainHash).toBe(SAMPLE_HASH);
    expect(result.hasLocalFile).toBe(true);
    expect(result.hasOnChainConfig).toBe(true);
  });

  test('no-local: no local file, no on-chain config', async () => {
    mockExistsSync.mockReturnValue(false);
    mockGetConfig.mockResolvedValue({
      configHash: ZERO_HASH,
      configCID: '',
    });

    const result = await diff(defaultDiffOptions());

    expect(result.inSync).toBe(true);
    expect(result.status).toBe('no-local');
    expect(result.localHash).toBeNull();
    expect(result.hasLocalFile).toBe(false);
    expect(result.hasOnChainConfig).toBe(false);
  });

  test('remote-ahead: no local file but config on-chain', async () => {
    mockExistsSync.mockReturnValue(false);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    const result = await diff(defaultDiffOptions());

    expect(result.inSync).toBe(false);
    expect(result.status).toBe('remote-ahead');
    expect(result.hasLocalFile).toBe(false);
    expect(result.hasOnChainConfig).toBe(true);
  });

  test('no-remote: local file exists but nothing on-chain', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_MD);
    mockGetConfig.mockResolvedValue({
      configHash: ZERO_HASH,
      configCID: '',
    });

    const result = await diff(defaultDiffOptions());

    expect(result.inSync).toBe(false);
    expect(result.status).toBe('no-remote');
    expect(result.hasLocalFile).toBe(true);
    expect(result.hasOnChainConfig).toBe(false);
  });

  test('local-ahead: never published (no config_hash in frontmatter)', async () => {
    // Local file has been edited, no config_hash → never published → local-ahead
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(EDITED_MD);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH, // on-chain has different hash
      configCID: 'bafytest123',
    });

    const result = await diff(defaultDiffOptions());

    expect(result.inSync).toBe(false);
    expect(result.status).toBe('local-ahead');
  });

  test('local-ahead: config_hash matches on-chain (local edits after last publish)', async () => {
    // frontmatter.config_hash matches on-chain → user edited locally → local-ahead
    const mdWithMatchingHash = `---
name: test-agent
version: "2.0.0"
capabilities:
  - text-generation
  - new-capability
config_hash: "${SAMPLE_HASH}"
---
# Edited Agent
`;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(mdWithMatchingHash);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH, // matches frontmatter.config_hash
      configCID: 'bafytest123',
    });

    const result = await diff(defaultDiffOptions());

    expect(result.inSync).toBe(false);
    expect(result.status).toBe('local-ahead');
  });

  test('diverged: config_hash does not match on-chain', async () => {
    // frontmatter.config_hash is old, on-chain has newer hash → diverged
    const differentHash = '0x' + 'ab'.repeat(32);
    const mdWithOldHash = `---
name: test-agent
version: "2.0.0"
config_hash: "${differentHash}"
---
# Edited Agent
`;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(mdWithOldHash);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH, // different from frontmatter.config_hash
      configCID: 'bafytest123',
    });

    const result = await diff(defaultDiffOptions());

    expect(result.inSync).toBe(false);
    expect(result.status).toBe('diverged');
  });
});

// ============================================================================
// pull()
// ============================================================================

describe('pull', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns early if no on-chain config', async () => {
    mockExistsSync.mockReturnValue(false);
    mockGetConfig.mockResolvedValue({
      configHash: ZERO_HASH,
      configCID: '',
    });

    const result = await pull(defaultPullOptions());

    expect(result.written).toBe(false);
    expect(result.status).toContain('No config published');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns early if already in sync', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(SAMPLE_MD);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    const result = await pull(defaultPullOptions());

    expect(result.written).toBe(false);
    expect(result.status).toContain('Already in sync');
  });

  test('fetches from IPFS and writes file on force pull', async () => {
    // Local has edited version, on-chain has original
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(EDITED_MD);
    mockWriteFileSync.mockImplementation(() => {});
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    // Mock IPFS fetch returning original content
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_MD),
    });

    const result = await pull(defaultPullOptions({ force: true }));

    expect(result.written).toBe(true);
    expect(result.cid).toBe('bafytest123');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    // Verify stamped content includes config_hash
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('config_hash:');
  });

  test('requires --force when local file exists and differs', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(EDITED_MD);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    // Mock IPFS fetch
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_MD),
    });

    const result = await pull(defaultPullOptions({ force: false }));

    expect(result.written).toBe(false);
    expect(result.status).toContain('--force');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('integrity check fails on tampered content', async () => {
    mockExistsSync.mockReturnValue(false);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    // Mock IPFS returning different content (tampered)
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(EDITED_MD), // Wrong content
    });

    const result = await pull(defaultPullOptions());

    expect(result.written).toBe(false);
    expect(result.status).toContain('Integrity check failed');
  });

  test('IPFS gateway fallback on first failure', async () => {
    mockExistsSync.mockReturnValue(false);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    // First gateway fails, second succeeds
    mockFetch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(SAMPLE_MD),
      });

    const result = await pull(defaultPullOptions());

    expect(result.written).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('all IPFS gateways fail → throws', async () => {
    mockExistsSync.mockReturnValue(false);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    // All gateways fail
    mockFetch.mockRejectedValue(new Error('timeout'));

    await expect(pull(defaultPullOptions())).rejects.toThrow('Failed to fetch CID');
  });

  test('pull stamps config_hash into written file', async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => {});
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_MD),
    });

    await pull(defaultPullOptions());

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    // The stamped file should contain config_hash matching on-chain
    expect(writtenContent).toContain(SAMPLE_HASH);
    expect(writtenContent).toContain('bafytest123');
  });

  test('pull writes to correct path', async () => {
    const customPath = '/custom/path/AGIRAILS.md';
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => {});
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_MD),
    });

    await pull(defaultPullOptions({ path: customPath }));

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      customPath,
      expect.any(String),
      'utf-8'
    );
  });
});

// ============================================================================
// diff + pull integration
// ============================================================================

describe('diff → pull round-trip', () => {
  test('pull makes subsequent diff report in-sync', async () => {
    // Step 1: No local file, config on-chain → remote-ahead
    mockExistsSync.mockReturnValue(false);
    mockGetConfig.mockResolvedValue({
      configHash: SAMPLE_HASH,
      configCID: 'bafytest123',
    });

    const diffBefore = await diff(defaultDiffOptions());
    expect(diffBefore.status).toBe('remote-ahead');

    // Step 2: Pull the file
    let writtenContent = '';
    mockWriteFileSync.mockImplementation((_path, content) => {
      writtenContent = content as string;
    });

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_MD),
    });

    await pull(defaultPullOptions());

    // Step 3: After pull, local file exists with stamped content
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(writtenContent);

    // The stamped file has config_hash in frontmatter (publish metadata),
    // which gets stripped during hash computation. So the hash of the
    // stamped file should match the original SAMPLE_HASH.
    const { configHash: stamped } = computeConfigHash(writtenContent);
    expect(stamped).toBe(SAMPLE_HASH);

    const diffAfter = await diff(defaultDiffOptions());
    expect(diffAfter.status).toBe('in-sync');
  });
});
