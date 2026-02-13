/**
 * Deploy:check Command Tests (AIP-13)
 *
 * @module cli/commands/deploy-check.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Output } from '../utils/output';
import { runDeployCheck } from './deploy-check';

describe('deploy:check command', () => {
  let testDir: string;
  let originalCwd: () => string;
  let printedLines: string[];
  let resultData: Record<string, unknown> | null;
  let output: Output;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-check-test-'));

    // Mock cwd
    originalCwd = process.cwd;
    process.cwd = () => testDir;

    // Create .actp dir with keystore
    const actpDir = path.join(testDir, '.actp');
    fs.mkdirSync(actpDir, { recursive: true });
    fs.writeFileSync(path.join(actpDir, 'keystore.json'), '{"address":"0x1234"}', { mode: 0o600 });

    // Create ignore files with .actp
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.actp/\n');
    fs.writeFileSync(path.join(testDir, '.dockerignore'), '.actp/\n');

    // Capture output
    printedLines = [];
    resultData = null;
    output = new Output('human');
    jest.spyOn(output, 'print').mockImplementation((msg: string) => { printedLines.push(msg); });
    jest.spyOn(output, 'result').mockImplementation((data: Record<string, unknown>) => { resultData = data; });
  });

  afterEach(() => {
    process.cwd = originalCwd;
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    jest.restoreAllMocks();
  });

  test('all checks pass scenario', () => {
    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(0);
    const joined = printedLines.join('\n');
    expect(joined).toContain('0 failed');
  });

  test('missing .gitignore entry → FAIL', () => {
    fs.writeFileSync(path.join(testDir, '.gitignore'), 'node_modules/\n');

    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(1);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[FAIL]');
    expect(joined).toContain('.gitignore');
  });

  test('missing .dockerignore → FAIL', () => {
    fs.unlinkSync(path.join(testDir, '.dockerignore'));

    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(1);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[FAIL]');
    expect(joined).toContain('.dockerignore');
  });

  test('raw key in .env file → FAIL', () => {
    fs.writeFileSync(
      path.join(testDir, '.env'),
      'ACTP_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n'
    );

    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(1);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[FAIL]');
    expect(joined).toContain('.env');
  });

  test('raw key in GitHub workflow → FAIL', () => {
    const workflowDir = path.join(testDir, '.github', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, 'deploy.yml'),
      'env:\n  ACTP_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n'
    );

    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(1);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[FAIL]');
    expect(joined).toContain('CI/workflow');
  });

  test('raw key in Dockerfile → FAIL', () => {
    fs.writeFileSync(
      path.join(testDir, 'Dockerfile'),
      'ENV ACTP_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n'
    );

    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(1);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[FAIL]');
    expect(joined).toContain('Dockerfiles');
  });

  test('raw key in nested .env (monorepo) → FAIL', () => {
    const nestedDir = path.join(testDir, 'apps', 'worker');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(nestedDir, '.env'),
      'ACTP_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n'
    );

    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(1);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[FAIL]');
    expect(joined).toContain('.env');
  });

  test('symlinked keystore → FAIL', () => {
    const actpDir = path.join(testDir, '.actp');
    const keystorePath = path.join(actpDir, 'keystore.json');

    // Replace keystore with symlink
    fs.unlinkSync(keystorePath);
    const realFile = path.join(testDir, 'real-keystore.json');
    fs.writeFileSync(realFile, '{"address":"0x1234"}');
    fs.symlinkSync(realFile, keystorePath);

    const exitCode = runDeployCheck({}, output);

    expect(exitCode).toBe(1);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[FAIL]');
    expect(joined).toContain('symlink');
  });

  test('wrong file permissions → WARN (not FAIL)', () => {
    if (process.platform === 'win32') return; // Skip on Windows

    const keystorePath = path.join(testDir, '.actp', 'keystore.json');
    fs.chmodSync(keystorePath, 0o644);

    const exitCode = runDeployCheck({}, output);

    // Should still pass (WARN, not FAIL)
    expect(exitCode).toBe(0);
    const joined = printedLines.join('\n');
    expect(joined).toContain('[WARN]');
    expect(joined).toContain('0o644');
  });

  test('JSON output mode', () => {
    const exitCode = runDeployCheck({ json: true }, output);

    expect(exitCode).toBe(0);
    expect(resultData).toBeTruthy();
    const data = resultData as { checks: unknown[]; summary: { passed: number; warnings: number; failed: number } };
    expect(data.checks).toBeTruthy();
    expect(data.summary.failed).toBe(0);
  });

  test('quiet mode only shows failures (hides PASS and WARN)', () => {
    // Force a WARN by setting bad permissions
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(testDir, '.actp', 'keystore.json'), 0o644);
    }

    const exitCode = runDeployCheck({ quiet: true }, output);
    expect(exitCode).toBe(0);

    // In quiet mode, neither PASS nor WARN should appear
    const passLines = printedLines.filter(l => l.includes('[PASS]'));
    const warnLines = printedLines.filter(l => l.includes('[WARN]'));
    const failLines = printedLines.filter(l => l.includes('[FAIL]'));
    expect(passLines).toHaveLength(0);
    expect(warnLines).toHaveLength(0);
    expect(failLines).toHaveLength(0);
  });

  test('Windows: permission check skipped gracefully', () => {
    // Save and mock platform
    const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      const exitCode = runDeployCheck({}, output);
      expect(exitCode).toBe(0);
      const joined = printedLines.join('\n');
      expect(joined).toContain('skipped on Windows');
    } finally {
      if (origDescriptor) {
        Object.defineProperty(process, 'platform', origDescriptor);
      }
    }
  });
});
