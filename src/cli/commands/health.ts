/**
 * Health Command - Check agent endpoint and config health
 *
 * Runs 6 sequential checks:
 * 1. AGIRAILS.md exists and parses (fatal)
 * 2. Endpoint set and not placeholder (fatal)
 * 3. Endpoint reachable via HEAD→GET probe (fatal)
 * 4. Response time + HTTP status health (warning)
 * 5. Pending-publish status (info)
 * 6. Config hash matches on-chain (warning)
 *
 * @module cli/commands/health
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

// ============================================================================
// Types
// ============================================================================

type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

interface HealthCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface HealthResult {
  checks: HealthCheck[];
  healthy: boolean;
  warnings: number;
}

// ============================================================================
// Command Definition
// ============================================================================

export function createHealthCommand(): Command {
  const cmd = new Command('health')
    .description('Check agent endpoint and config health')
    .argument('[path]', 'Path to AGIRAILS.md', './AGIRAILS.md')
    .option('-n, --network <network>', 'Network (base-sepolia | base-mainnet)', 'base-sepolia')
    .option('-a, --address <address>', 'Agent address')
    .option('--timeout <ms>', 'Endpoint probe timeout in ms', '5000')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (path, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runHealth(path, options, output);
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

interface HealthCommandOptions {
  network: string;
  address?: string;
  timeout: string;
}

const SLA_THRESHOLD_MS = 2000;

async function runHealth(
  filePath: string,
  options: HealthCommandOptions,
  output: Output
): Promise<void> {
  const resolvedPath = resolve(filePath);
  const timeoutMs = parseInt(options.timeout, 10) || 5000;
  const checks: HealthCheck[] = [];
  let fatal = false;

  // ── Check 1: AGIRAILS.md exists and parses ──────────────────────────
  let frontmatter: Record<string, unknown> = {};
  try {
    if (!existsSync(resolvedPath)) {
      checks.push({ name: 'AGIRAILS.md', status: 'fail', detail: `Not found: ${resolvedPath}` });
      fatal = true;
    } else {
      const content = readFileSync(resolvedPath, 'utf-8');
      const { parseAgirailsMd } = await import('../../config/agirailsmd');
      const parsed = parseAgirailsMd(content);
      frontmatter = parsed.frontmatter;
      const name = (frontmatter.name as string) || (frontmatter.slug as string) || 'unknown';
      checks.push({ name: 'AGIRAILS.md', status: 'pass', detail: `Parsed (${name})` });
    }
  } catch (err) {
    checks.push({ name: 'AGIRAILS.md', status: 'fail', detail: `Parse error: ${(err as Error).message}` });
    fatal = true;
  }

  // ── Check 2: Endpoint set and not placeholder ───────────────────────
  if (!fatal) {
    const { PENDING_ENDPOINT } = await import('../../config/publishPipeline');
    const endpoint = frontmatter.endpoint as string | undefined;
    if (!endpoint || endpoint === PENDING_ENDPOINT) {
      checks.push({ name: 'Endpoint', status: 'fail', detail: 'No endpoint set (placeholder or missing)' });
      fatal = true;
    } else {
      checks.push({ name: 'Endpoint', status: 'pass', detail: endpoint });
    }
  }

  // ── Check 3 & 4: Endpoint reachable + response time ─────────────────
  if (!fatal) {
    const endpoint = frontmatter.endpoint as string;
    const probeResult = await probeEndpoint(endpoint, timeoutMs);

    if (probeResult.reachable) {
      checks.push({
        name: 'Endpoint reachable',
        status: 'pass',
        detail: `${probeResult.responseTimeMs}ms (${probeResult.method} ${probeResult.statusCode})`,
      });

      // Check 4: SLA + HTTP status health
      if (probeResult.statusCode && probeResult.statusCode >= 500) {
        checks.push({
          name: 'Endpoint health',
          status: 'warn',
          detail: `Endpoint returned ${probeResult.statusCode} — server error`,
        });
      } else if (probeResult.responseTimeMs > SLA_THRESHOLD_MS) {
        checks.push({
          name: 'Response time',
          status: 'warn',
          detail: `${probeResult.responseTimeMs}ms exceeds ${SLA_THRESHOLD_MS}ms SLA`,
        });
      } else {
        checks.push({
          name: 'Response time',
          status: 'pass',
          detail: `${probeResult.responseTimeMs}ms (< ${SLA_THRESHOLD_MS}ms)`,
        });
      }
    } else {
      checks.push({
        name: 'Endpoint reachable',
        status: 'fail',
        detail: probeResult.error || 'Endpoint unreachable',
      });
      fatal = true;
    }
  }

  // ── Check 5: Pending publish status ─────────────────────────────────
  if (!fatal) {
    try {
      const { loadPendingPublish } = await import('../../config/pendingPublish');
      const pending = loadPendingPublish(options.network);
      if (pending) {
        checks.push({
          name: 'Pending publish',
          status: 'info',
          detail: `Mainnet activation on first payment (hash: ${pending.configHash.slice(0, 10)}...)`,
        });
      } else {
        checks.push({ name: 'Pending publish', status: 'pass', detail: 'No pending publish' });
      }
    } catch {
      checks.push({ name: 'Pending publish', status: 'pass', detail: 'No pending publish file' });
    }
  }

  // ── Check 6: Config hash matches on-chain ───────────────────────────
  if (!fatal) {
    try {
      const { getNetwork } = await import('../../config/networks');
      const { ethers } = await import('ethers');
      const networkConfig = getNetwork(options.network);

      if (!networkConfig.contracts.agentRegistry) {
        checks.push({ name: 'On-chain config', status: 'info', detail: `No AgentRegistry on ${options.network}` });
      } else {
        let agentAddress = options.address;
        if (!agentAddress) {
          const { resolvePrivateKey } = await import('../../wallet/keystore');
          const networkTier = options.network === 'base-mainnet' ? 'mainnet' : 'testnet';
          const privKey = await resolvePrivateKey(undefined, { network: networkTier });
          if (privKey) {
            agentAddress = new ethers.Wallet(privKey).address;
          }
        }

        if (!agentAddress) {
          checks.push({ name: 'On-chain config', status: 'info', detail: 'No agent address (use --address or set ACTP_PRIVATE_KEY)' });
        } else {
          const content = readFileSync(resolve(filePath), 'utf-8');
          const { computeConfigHash } = await import('../../config/agirailsmd');
          const { configHash: localHash } = computeConfigHash(content);

          const { getOnChainAgentState } = await import('../../ACTPClient');
          const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
          const onChain = await getOnChainAgentState(
            provider,
            networkConfig.contracts.agentRegistry,
            agentAddress
          );

          if (onChain.registeredAt === 0n) {
            checks.push({ name: 'On-chain config', status: 'info', detail: 'Agent not yet registered on-chain' });
          } else if (onChain.configHash === localHash) {
            checks.push({ name: 'On-chain config', status: 'pass', detail: `Hash matches (${options.network})` });
          } else {
            checks.push({
              name: 'On-chain config',
              status: 'warn',
              detail: `Hash mismatch — local ${localHash.slice(0, 10)}... vs on-chain ${onChain.configHash.slice(0, 10)}...`,
            });
          }
        }
      }
    } catch (err) {
      checks.push({ name: 'On-chain config', status: 'warn', detail: `Could not check: ${(err as Error).message}` });
    }
  }

  // ── Output ──────────────────────────────────────────────────────────
  const warnings = checks.filter(c => c.status === 'warn').length;
  const healthy = !fatal;

  const result: HealthResult = { checks, healthy, warnings };

  output.result(result as unknown as Record<string, unknown>, { quietKey: 'healthy' });

  if (output.mode === 'human') {
    output.blank();
    for (const check of checks) {
      const icon = check.status === 'pass' ? '\u2713'
        : check.status === 'warn' ? '\u26A0'
        : check.status === 'info' ? '\u2139'
        : '\u2717';
      output.print(`  ${icon} ${check.name}: ${check.detail}`);
    }
    output.blank();
    if (healthy) {
      output.success(`Health: PASS${warnings > 0 ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}`);
    } else {
      output.error(`Health: FAIL`);
    }
  }
}

// ============================================================================
// Endpoint Probe (HEAD → GET)
// ============================================================================

interface ProbeResult {
  reachable: boolean;
  method?: string;
  statusCode?: number;
  responseTimeMs: number;
  error?: string;
}

async function probeEndpoint(url: string, timeoutMs: number): Promise<ProbeResult> {
  // Try HEAD first
  const headResult = await tryProbe(url, 'HEAD', timeoutMs);
  if (headResult.reachable) return headResult;

  // HEAD failed at network level — try GET
  const getResult = await tryProbe(url, 'GET', timeoutMs);
  return getResult;
}

async function tryProbe(url: string, method: string, timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timer);
    const elapsed = Date.now() - start;

    // Any HTTP response = reachable (server is alive)
    return {
      reachable: true,
      method,
      statusCode: response.status,
      responseTimeMs: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const message = (err as Error).name === 'AbortError'
      ? `Timeout after ${timeoutMs}ms`
      : (err as Error).message;

    return {
      reachable: false,
      method,
      responseTimeMs: elapsed,
      error: message,
    };
  }
}
