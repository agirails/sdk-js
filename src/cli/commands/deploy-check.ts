/**
 * Deploy:check Command - Pre-deploy security audit (AIP-13)
 *
 * Scans the project for common deployment security issues:
 * - Missing ignore files
 * - Raw private keys in env files, Dockerfiles, CI configs
 * - Symlinked keystore
 * - Incorrect file permissions
 *
 * Exit code 0: all checks pass (warnings allowed)
 * Exit code 1: at least one FAIL check
 *
 * @module cli/commands/deploy-check
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { getActpDir } from '../utils/config';

// ============================================================================
// Types
// ============================================================================

type CheckSeverity = 'FAIL' | 'WARN';
type CheckResult = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

interface CheckOutput {
  name: string;
  result: CheckResult;
  message?: string;
}

// ============================================================================
// Command Definition
// ============================================================================

export function createDeployCheckCommand(): Command {
  const cmd = new Command('deploy:check')
    .description('Pre-deploy security audit (AIP-13)')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Only show failures')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        const exitCode = runDeployCheck(options, output);
        process.exit(exitCode);
      } catch (error) {
        output.errorResult({
          code: 'DEPLOY_CHECK_FAILED',
          message: (error as Error).message,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

/** Regex matching a raw private key pattern */
const RAW_KEY_PATTERN = /0x[0-9a-fA-F]{64}/;
const RAW_KEY_ENV_PATTERN = /ACTP_PRIVATE_KEY\s*=\s*0x/;

interface DeployCheckOptions {
  json?: boolean;
  quiet?: boolean;
}

export function runDeployCheck(options: DeployCheckOptions, output: Output): number {
  const projectRoot = process.cwd();
  const actpDir = getActpDir(projectRoot);
  const results: CheckOutput[] = [];
  let failCount = 0;
  let warnCount = 0;
  let passCount = 0;

  // ── FAIL checks ──────────────────────────────────────────────────────

  // 1. .actp/ in .gitignore
  results.push(checkIgnoreFile(projectRoot, '.gitignore', '.actp', 'FAIL'));

  // 2. .actp/ in .dockerignore
  results.push(checkIgnoreFile(projectRoot, '.dockerignore', '.actp', 'FAIL'));

  // 3. No ACTP_PRIVATE_KEY in .env* files
  results.push(checkNoRawKeysInEnvFiles(projectRoot));

  // 4. No raw keys in Dockerfiles
  results.push(checkNoRawKeysInFiles(
    projectRoot,
    ['Dockerfile', 'Dockerfile.*', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
    'No raw keys in Dockerfiles'
  ));

  // 5. No raw keys in CI/workflow files
  results.push(checkNoRawKeysInCIFiles(projectRoot));

  // 6. Keystore is not a symlink
  results.push(checkKeystoreNotSymlink(actpDir));

  // ── WARN checks ──────────────────────────────────────────────────────

  // 7. ACTP_KEYSTORE_BASE64 or keystore.json exists
  results.push(checkKeystoreAvailable(actpDir));

  // 8. Keystore file permissions (POSIX only)
  results.push(checkKeystorePermissions(actpDir));

  // ── Output ───────────────────────────────────────────────────────────

  for (const check of results) {
    if (check.result === 'FAIL') failCount++;
    else if (check.result === 'WARN') warnCount++;
    else if (check.result === 'PASS') passCount++;
  }

  if (options.json) {
    output.result({
      checks: results,
      summary: { passed: passCount, warnings: warnCount, failed: failCount },
    });
  } else {
    output.print('actp deploy:check');
    for (const check of results) {
      if (options.quiet && check.result !== 'FAIL') continue;
      const tag = `[${check.result}]`;
      const msg = check.message ? ` ${check.message}` : '';
      output.print(`  ${tag} ${check.name}${msg}`);
    }
    output.print('');
    output.print(`  ${passCount} passed, ${warnCount} warnings, ${failCount} failed`);
  }

  return failCount > 0 ? ExitCode.ERROR : ExitCode.SUCCESS;
}

// ============================================================================
// Individual Checks
// ============================================================================

function checkIgnoreFile(
  projectRoot: string,
  fileName: string,
  entry: string,
  _severity: CheckSeverity
): CheckOutput {
  const filePath = path.join(projectRoot, fileName);
  const name = `${entry} in ${fileName}`;

  if (!fs.existsSync(filePath)) {
    return { name, result: 'FAIL', message: `${fileName} does not exist` };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(entry)) {
    return { name, result: 'PASS' };
  }

  return { name, result: 'FAIL', message: `${entry} not found in ${fileName}` };
}

function checkNoRawKeysInEnvFiles(projectRoot: string): CheckOutput {
  const name = 'No raw keys in .env files';
  const envFiles = findMatchingFiles(projectRoot, ['.env', '.env.*', '.env.local', '.env.production']);

  for (const file of envFiles) {
    const content = safeReadFile(file);
    if (content && (RAW_KEY_PATTERN.test(content) || RAW_KEY_ENV_PATTERN.test(content))) {
      return { name, result: 'FAIL', message: `Raw key found in ${path.basename(file)}` };
    }
  }

  return { name, result: 'PASS' };
}

function checkNoRawKeysInFiles(
  projectRoot: string,
  patterns: string[],
  name: string
): CheckOutput {
  const files = findMatchingFiles(projectRoot, patterns);

  for (const file of files) {
    const content = safeReadFile(file);
    if (content && RAW_KEY_PATTERN.test(content)) {
      return { name, result: 'FAIL', message: `Raw key found in ${path.basename(file)}` };
    }
  }

  return { name, result: 'PASS' };
}

function checkNoRawKeysInCIFiles(projectRoot: string): CheckOutput {
  const name = 'No raw keys in CI/workflow files';

  // Collect all CI-related files
  const files: string[] = [];

  // GitHub workflows
  const workflowDir = path.join(projectRoot, '.github', 'workflows');
  if (fs.existsSync(workflowDir)) {
    try {
      const entries = fs.readdirSync(workflowDir);
      for (const entry of entries) {
        if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
          files.push(path.join(workflowDir, entry));
        }
      }
    } catch { /* ignore read errors */ }
  }

  // Platform config files
  const platformFiles = [
    'railway.json', 'fly.toml', 'vercel.json',
    'pm2.config.js', 'pm2.config.cjs', 'ecosystem.config.js', 'ecosystem.config.cjs',
  ];
  for (const pf of platformFiles) {
    const fp = path.join(projectRoot, pf);
    if (fs.existsSync(fp)) files.push(fp);
  }

  for (const file of files) {
    const content = safeReadFile(file);
    if (content && (RAW_KEY_PATTERN.test(content) || RAW_KEY_ENV_PATTERN.test(content))) {
      return { name, result: 'FAIL', message: `Raw key found in ${path.relative(projectRoot, file)}` };
    }
  }

  return { name, result: 'PASS' };
}

function checkKeystoreNotSymlink(actpDir: string): CheckOutput {
  const name = 'Keystore is not a symlink';
  const keystorePath = path.join(actpDir, 'keystore.json');

  if (!fs.existsSync(keystorePath)) {
    return { name, result: 'PASS' };
  }

  try {
    const stat = fs.lstatSync(keystorePath);
    if (stat.isSymbolicLink()) {
      return { name, result: 'FAIL', message: 'keystore.json is a symlink (security risk)' };
    }
  } catch { /* ignore */ }

  return { name, result: 'PASS' };
}

function checkKeystoreAvailable(actpDir: string): CheckOutput {
  const name = 'Keystore available';
  const keystorePath = path.join(actpDir, 'keystore.json');

  if (process.env.ACTP_KEYSTORE_BASE64) {
    return { name, result: 'PASS' };
  }

  if (fs.existsSync(keystorePath)) {
    return { name, result: 'PASS' };
  }

  return { name, result: 'WARN', message: 'ACTP_KEYSTORE_BASE64 not set (OK for local dev)' };
}

function checkKeystorePermissions(actpDir: string): CheckOutput {
  const name = 'Keystore file permissions';
  const keystorePath = path.join(actpDir, 'keystore.json');

  // Skip on Windows
  if (process.platform === 'win32') {
    return { name, result: 'SKIP', message: 'Permission check skipped on Windows' };
  }

  if (!fs.existsSync(keystorePath)) {
    return { name, result: 'PASS' };
  }

  try {
    const stat = fs.statSync(keystorePath);
    const mode = stat.mode & 0o777;
    if (mode === 0o600) {
      return { name, result: 'PASS' };
    }
    return { name, result: 'WARN', message: `Permissions are 0o${mode.toString(8)} (expected 0o600)` };
  } catch {
    return { name, result: 'WARN', message: 'Could not check file permissions' };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Directories to skip during recursive scan */
const SKIP_DIRS = new Set(['node_modules', '.git', '.actp', 'dist', 'build', '.next', 'coverage']);

/** Max recursion depth to prevent runaway scans */
const MAX_SCAN_DEPTH = 5;

function findMatchingFiles(projectRoot: string, patterns: string[], maxDepth = MAX_SCAN_DEPTH): string[] {
  const files: string[] = [];
  walkDir(projectRoot, patterns, files, 0, maxDepth);
  return files;
}

function walkDir(dir: string, patterns: string[], files: string[], depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);

    // Match files against patterns
    for (const pattern of patterns) {
      if (matchPattern(entry, pattern)) {
        try {
          if (fs.statSync(fullPath).isFile()) {
            files.push(fullPath);
          }
        } catch { /* ignore */ }
        break;
      }
    }

    // Recurse into subdirectories (skip noise dirs)
    if (!SKIP_DIRS.has(entry)) {
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          walkDir(fullPath, patterns, files, depth + 1, maxDepth);
        }
      } catch { /* ignore */ }
    }
  }
}

function matchPattern(filename: string, pattern: string): boolean {
  // Simple glob: support * and exact match
  if (pattern === filename) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return regex.test(filename);
  }
  return false;
}

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
