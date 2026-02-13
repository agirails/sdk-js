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
import { addToDockerignore, addToRailwayignore } from './config';

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
});
