/**
 * Config Utility Tests — Ignore File Management (AIP-13)
 *
 * Tests cover:
 * - addToDockerignore: creates file, idempotent, appends to existing, symlink throws
 * - addToRailwayignore: creates file, idempotent, appends to existing, symlink throws
 *
 * @module cli/utils/config.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { addToDockerignore, addToGitignore, addToRailwayignore, writeEnvExample } from './config';

describe('Ignore File Management (AIP-13)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // addToDockerignore
  // ============================================================================

  describe('addToDockerignore', () => {
    test('creates .dockerignore when it does not exist', () => {
      addToDockerignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.dockerignore'), 'utf-8');
      expect(content).toContain('.actp/');
      expect(content).toContain('.env');
      expect(content).toContain('node_modules/');
    });

    test('is idempotent (does not duplicate entries)', () => {
      addToDockerignore(testDir);
      addToDockerignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.dockerignore'), 'utf-8');
      const matches = content.match(/\.actp/g);
      expect(matches).toHaveLength(1);
    });

    test('appends to existing .dockerignore', () => {
      const existingContent = 'dist/\n*.log\n';
      fs.writeFileSync(path.join(testDir, '.dockerignore'), existingContent);

      addToDockerignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.dockerignore'), 'utf-8');
      expect(content).toContain('dist/');
      expect(content).toContain('.actp/');
    });

    test('adds missing entries when file already has .actp but not .env', () => {
      // Pre-existing file with only .actp/
      fs.writeFileSync(path.join(testDir, '.dockerignore'), '.actp/\n');

      addToDockerignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.dockerignore'), 'utf-8');
      expect(content).toContain('.actp/');
      expect(content).toContain('.env');
      expect(content).toContain('node_modules/');
    });

    test('throws on symlinked .dockerignore', () => {
      // Create a real file and a symlink to it
      const realFile = path.join(testDir, 'real-dockerignore');
      fs.writeFileSync(realFile, '');
      fs.symlinkSync(realFile, path.join(testDir, '.dockerignore'));

      expect(() => addToDockerignore(testDir)).toThrow('symlink');
    });
  });

  // ============================================================================
  // addToRailwayignore
  // ============================================================================

  describe('addToRailwayignore', () => {
    test('creates .railwayignore when it does not exist', () => {
      addToRailwayignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.railwayignore'), 'utf-8');
      expect(content).toContain('.actp/');
      expect(content).toContain('.env');
      expect(content).toContain('node_modules/');
    });

    test('is idempotent', () => {
      addToRailwayignore(testDir);
      addToRailwayignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.railwayignore'), 'utf-8');
      const matches = content.match(/\.actp/g);
      expect(matches).toHaveLength(1);
    });

    test('appends to existing .railwayignore', () => {
      const existingContent = 'build/\n';
      fs.writeFileSync(path.join(testDir, '.railwayignore'), existingContent);

      addToRailwayignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.railwayignore'), 'utf-8');
      expect(content).toContain('build/');
      expect(content).toContain('.actp/');
    });

    test('throws on symlinked .railwayignore', () => {
      const realFile = path.join(testDir, 'real-railwayignore');
      fs.writeFileSync(realFile, '');
      fs.symlinkSync(realFile, path.join(testDir, '.railwayignore'));

      expect(() => addToRailwayignore(testDir)).toThrow('symlink');
    });
  });

  // ============================================================================
  // addToGitignore — Apex audit FIND-012(b) hardening
  // ============================================================================

  describe('addToGitignore (FIND-012b)', () => {
    test('creates .gitignore with .actp + .env patterns when absent', () => {
      addToGitignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.actp/');
      expect(content).toContain('.env');
      expect(content).toContain('.env.*');
    });

    test('is idempotent — second call does not duplicate entries', () => {
      addToGitignore(testDir);
      addToGitignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.gitignore'), 'utf-8');
      // Exactly one `.actp/` line, one `.env` line, one `.env.*` line.
      const actpMatches = content.match(/^\.actp\/?$/gm) ?? [];
      const envMatches = content.match(/^\.env$/gm) ?? [];
      const envStarMatches = content.match(/^\.env\.\*$/gm) ?? [];
      expect(actpMatches).toHaveLength(1);
      expect(envMatches).toHaveLength(1);
      expect(envStarMatches).toHaveLength(1);
    });

    test('migrates a pre-existing .gitignore that has .actp but missing .env', () => {
      // Legacy state: SDK < beta.11 only added `.actp/`.
      fs.writeFileSync(path.join(testDir, '.gitignore'), '.actp/\nnode_modules/\n');

      addToGitignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.actp/');
      expect(content).toContain('node_modules/');  // pre-existing entries preserved
      expect(content).toMatch(/^\.env$/m);
      expect(content).toMatch(/^\.env\.\*$/m);
      // .actp/ is not duplicated.
      const actpMatches = content.match(/^\.actp\/?$/gm) ?? [];
      expect(actpMatches).toHaveLength(1);
    });

    test('preserves existing unrelated content', () => {
      fs.writeFileSync(path.join(testDir, '.gitignore'), 'dist/\n*.log\n');

      addToGitignore(testDir);

      const content = fs.readFileSync(path.join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('dist/');
      expect(content).toContain('*.log');
      expect(content).toContain('.actp/');
      expect(content).toContain('.env');
    });
  });

  // ============================================================================
  // writeEnvExample — Apex audit FIND-012(b) hardening
  // ============================================================================

  describe('writeEnvExample (FIND-012b)', () => {
    test('writes .env.example with the documented schema', () => {
      writeEnvExample(testDir);

      const content = fs.readFileSync(path.join(testDir, '.env.example'), 'utf-8');
      // Must name both keystore patterns and the network selector explicitly.
      expect(content).toContain('ACTP_KEYSTORE_BASE64');
      expect(content).toContain('ACTP_KEY_PASSWORD');
      expect(content).toContain('ACTP_PRIVATE_KEY');
      expect(content).toContain('ACTP_NETWORK');
      // Must NOT contain a literal hex private key — the example is the
      // schema, not a populated value.
      expect(content).not.toMatch(/0x[0-9a-fA-F]{64}/);
      // Must warn about not committing the real file.
      expect(content).toMatch(/never commit/i);
    });

    test('is idempotent — leaves an existing .env.example untouched', () => {
      // Operator customised their schema; second call must not clobber.
      const custom = '# my custom schema\nFOO=bar\n';
      fs.writeFileSync(path.join(testDir, '.env.example'), custom);

      writeEnvExample(testDir);

      const content = fs.readFileSync(path.join(testDir, '.env.example'), 'utf-8');
      expect(content).toBe(custom);
    });

    test('throws on a symlinked .env.example (symlink-attack guard)', () => {
      const realFile = path.join(testDir, 'real-env-example');
      fs.writeFileSync(realFile, '');
      fs.symlinkSync(realFile, path.join(testDir, '.env.example'));

      expect(() => writeEnvExample(testDir)).toThrow('symlink');
    });
  });
});
