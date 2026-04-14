/**
 * Autopublish Command — Watch AGIRAILS.md and auto-publish on changes.
 *
 * Watches the specified file (or auto-detected AGIRAILS.md) for changes,
 * debounces (2s), validates the config hash, and re-publishes if changed.
 *
 * NOTE: This is NOT `actp watch` (which watches transaction state).
 *
 * @module cli/commands/autopublish
 */

import { Command } from 'commander';
import { Output, ExitCode, fmt } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve, basename } from 'path';
import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { computeConfigHash } from '../../config/agirailsmd';
import { execFile } from 'child_process';

// ============================================================================
// Command Definition
// ============================================================================

export function createAutopublishCommand(): Command {
  const cmd = new Command('autopublish')
    .description('Watch AGIRAILS.md and auto-publish on changes')
    .argument('[path]', 'Path to AGIRAILS.md or {slug}.md')
    .option('--no-publish', 'Validate only, do not publish')
    .option('--debounce <ms>', 'Debounce interval in ms', '2000')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (path, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runAutopublish(path, options, output);
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
          details: structuredError.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

interface AutopublishOptions {
  publish: boolean; // --no-publish sets this to false
  debounce?: string;
}

async function runAutopublish(
  filePath: string | undefined,
  options: AutopublishOptions,
  output: Output,
): Promise<void> {
  // Resolve file path
  const resolvedPath = resolveFilePath(filePath);
  if (!resolvedPath) {
    output.errorResult({
      code: 'FILE_NOT_FOUND',
      message: filePath
        ? `File not found: ${filePath}`
        : 'No AGIRAILS.md found in current directory',
    });
    process.exit(ExitCode.ERROR);
  }

  const debounceMs = Math.max(500, parseInt(options.debounce ?? '2000', 10) || 2000);

  // Compute initial hash
  let lastHash = computeHash(resolvedPath);
  const fileName = basename(resolvedPath);

  output.print(`Watching ${fmt.cyan(fileName)} for changes (debounce: ${debounceMs}ms)...`);
  if (!options.publish) {
    output.print(fmt.dim('  --no-publish: validate only, will not publish'));
  }
  output.print(fmt.dim(`  Initial hash: ${lastHash}`));
  output.print(fmt.dim('  Press Ctrl+C to stop'));
  output.blank();

  // Use fs.watchFile (polling) for cross-platform reliability.
  // fs.watch has issues with atomic writes on macOS (editors write to tmp + rename).
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  watchFile(resolvedPath, { interval: 500 }, () => {
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(async () => {
      try {
        const newHash = computeHash(resolvedPath);

        if (newHash === lastHash) {
          // File touched but content hash unchanged (e.g. only metadata/mtime changed)
          return;
        }

        const timestamp = new Date().toISOString().slice(11, 19);
        output.print(`${fmt.dim(timestamp)} Change detected — hash: ${fmt.cyan(newHash.slice(0, 16))}...`);

        lastHash = newHash;

        if (!options.publish) {
          output.success('  Validated (--no-publish)');
          return;
        }

        // Invoke actp publish as subprocess
        output.print('  Publishing...');
        const exitCode = await runPublishSubprocess(resolvedPath);

        if (exitCode === 0) {
          output.success('  Published successfully');
        } else {
          output.print(`  ${fmt.yellow('Publish failed')} (exit code ${exitCode})`);
        }
      } catch (err) {
        output.print(`  ${fmt.yellow('Error:')} ${err instanceof Error ? err.message : String(err)}`);
      }
    }, debounceMs);
  });

  // Keep process alive until Ctrl+C
  process.on('SIGINT', () => {
    unwatchFile(resolvedPath);
    if (debounceTimer) clearTimeout(debounceTimer);
    output.blank();
    output.print('Stopped watching.');
    process.exit(0);
  });

  // Block forever (watchFile is non-blocking)
  await new Promise(() => {});
}

// ============================================================================
// Helpers
// ============================================================================

function resolveFilePath(filePath: string | undefined): string | null {
  if (filePath) {
    const resolved = resolve(filePath);
    return existsSync(resolved) ? resolved : null;
  }

  // Auto-detect: AGIRAILS.md in cwd
  const agirailsMd = resolve(process.cwd(), 'AGIRAILS.md');
  if (existsSync(agirailsMd)) return agirailsMd;

  return null;
}

function computeHash(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const result = computeConfigHash(content);
  return result.configHash;
}

function runPublishSubprocess(filePath: string): Promise<number> {
  return new Promise((res) => {
    // Resolve CLI entry from package rather than relying on process.argv
    // (process.argv[1] may point to npx cache or ts-node wrapper)
    let actpBin: string;
    try {
      actpBin = require.resolve('../../cli/agirails');
    } catch {
      actpBin = process.argv[1]; // Fallback to original behavior
    }
    const args = ['publish', filePath, '--quiet'];

    execFile(process.argv[0], [actpBin, ...args], { timeout: 60_000 }, (error) => {
      if (error && 'code' in error && typeof error.code === 'number') {
        res(error.code);
      } else if (error) {
        res(1);
      } else {
        res(0);
      }
    });
  });
}
