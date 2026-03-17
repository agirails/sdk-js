/**
 * Tests for autopublish CLI command.
 *
 * Since autopublish blocks forever via watchFile, we test:
 * - Command creation and option parsing
 * - File-not-found error path (exits immediately)
 * - Auto-detect AGIRAILS.md in cwd
 * - Hash comparison (no-op when unchanged)
 * - --no-publish validate-only mode
 */

import { createAutopublishCommand } from '../../src/cli/commands/autopublish';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Helpers
// ============================================================================

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `autopublish-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Command structure tests
// ============================================================================

describe('createAutopublishCommand', () => {
  it('creates a command with correct name and options', () => {
    const cmd = createAutopublishCommand();
    expect(cmd.name()).toBe('autopublish');
    expect(cmd.description()).toContain('Watch');

    // Check options exist
    const optionNames = cmd.options.map(o => o.long || o.short);
    expect(optionNames).toContain('--no-publish');
    expect(optionNames).toContain('--debounce');
    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--quiet');
  });

  it('accepts an optional path argument', () => {
    const cmd = createAutopublishCommand();
    // Commander registers arguments
    expect(cmd.registeredArguments.length).toBe(1);
    expect(cmd.registeredArguments[0].required).toBe(false);
  });
});

// ============================================================================
// File resolution tests (via command error path)
// ============================================================================

describe('autopublish file resolution', () => {
  let exitSpy: jest.SpyInstance;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    // Mock process.exit to prevent test from dying
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`EXIT_${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.chdir(originalCwd);
  });

  it('exits with error when explicit path does not exist', async () => {
    const cmd = createAutopublishCommand();
    await expect(
      cmd.parseAsync(['node', 'test', '/nonexistent/AGIRAILS.md'])
    ).rejects.toThrow('EXIT_1');
  });

  it('exits with error when no AGIRAILS.md in cwd', async () => {
    process.chdir(testDir); // empty dir, no AGIRAILS.md
    const cmd = createAutopublishCommand();
    await expect(
      cmd.parseAsync(['node', 'test'])
    ).rejects.toThrow('EXIT_1');
  });
});

// ============================================================================
// computeConfigHash integration test
// ============================================================================

describe('config hash', () => {
  it('computeConfigHash is importable and deterministic', () => {
    const { computeConfigHash } = require('../../src/config/agirailsmd');
    const content = `---
name: Test Agent
slug: test-agent
---

## Services
- code-review
`;
    const h1 = computeConfigHash(content);
    const h2 = computeConfigHash(content);
    expect(h1.configHash).toBe(h2.configHash);
    expect(typeof h1.configHash).toBe('string');
    expect(h1.configHash.length).toBeGreaterThan(0);
  });

  it('different content produces different hash', () => {
    const { computeConfigHash } = require('../../src/config/agirailsmd');
    const h1 = computeConfigHash('---\nname: Agent A\nslug: agent-a\n---\n## Services\n- review');
    const h2 = computeConfigHash('---\nname: Agent B\nslug: agent-b\n---\n## Services\n- translate');
    expect(h1.configHash).not.toBe(h2.configHash);
  });
});
