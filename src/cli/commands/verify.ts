/**
 * Verify Command — Trustless verification of agent identity files.
 *
 * Accepts input from file, stdin (pipe), or URL.
 * Verifies: V4 format → config hash → on-chain match → optional IPFS content match.
 *
 * The Purple Cow moment:
 *   curl -s agirails.app/a/agent/agent.md | npx actp verify
 *
 * @module cli/commands/verify
 */

import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { parseAgirailsMdV4 } from '../../config/agirailsmdV4';
import { computeConfigHash } from '../../config/agirailsmd';
import { getNetwork } from '../../config/networks';
import { AgentRegistryClient } from '../../registry/AgentRegistryClient';
import { ethers } from 'ethers';

// ============================================================================
// Types
// ============================================================================

interface VerifyResult {
  valid: boolean;
  name: string;
  slug: string;
  configHash: string;
  onChain: {
    checked: boolean;
    match: boolean;
    network?: string;
    address?: string;
    registryHash?: string;
    registryCID?: string;
  };
  ipfs: {
    checked: boolean;
    match: boolean;
    cid?: string;
  };
  reputation?: {
    score: number;
    completed: number;
    successRate: number;
    volume: string;
  };
  trustTier: 'chain-verified' | 'published' | 'unverified';
}

// ============================================================================
// Command
// ============================================================================

export function createVerifyCommand(): Command {
  const cmd = new Command('verify')
    .description('Verify an agent identity file against on-chain state')
    .argument('[source]', 'File path, URL, or - for stdin')
    .option('-n, --network <network>', 'Network (base-sepolia | base-mainnet)', 'base-sepolia')
    .option('-a, --address <address>', 'Agent address override')
    .option('--reputation', 'Also fetch and display reputation data')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output (exit code only)')
    .action(async (source, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runVerify(source, options, output);
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Core Logic
// ============================================================================

async function runVerify(
  source: string | undefined,
  options: { network: string; address?: string; reputation?: boolean; json?: boolean },
  output: Output
): Promise<void> {
  // Step 1: Read content
  const content = await readContent(source);
  if (!content) {
    output.error('No input provided. Usage: actp verify <file> or pipe from stdin.');
    process.exit(ExitCode.INVALID_INPUT);
  }

  // Step 2: Parse V4
  let v4Config;
  try {
    v4Config = parseAgirailsMdV4(content);
    output.success(`Valid V4 identity file`);
  } catch (err) {
    output.error(`Invalid identity file: ${err instanceof Error ? err.message : err}`);
    process.exit(ExitCode.INVALID_INPUT);
  }

  // Step 3: Compute hash
  const { configHash } = computeConfigHash(content);
  output.success(`Config hash: ${configHash}`);

  // Step 4: Resolve agent address
  const address = resolveAddress(v4Config, options.address);

  // Step 5: On-chain verification
  const result: VerifyResult = {
    valid: true,
    name: v4Config.name,
    slug: v4Config.slug,
    configHash,
    onChain: { checked: false, match: false },
    ipfs: { checked: false, match: false },
    trustTier: 'unverified',
  };

  if (address) {
    try {
      const networkConfig = getNetwork(options.network);
      const registryAddr = networkConfig.contracts.agentRegistry;
      if (!registryAddr) {
        output.warning('AgentRegistry not deployed on this network');
      } else {
        const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
        const registry = AgentRegistryClient.readOnly(registryAddr, provider);

        const onChainConfig = await registry.getConfig(address);
        result.onChain = {
          checked: true,
          match: onChainConfig.configHash === configHash,
          network: networkConfig.name,
          address,
          registryHash: onChainConfig.configHash,
          registryCID: onChainConfig.configCID,
        };

        if (result.onChain.match) {
          output.success(`On-chain match: ${networkConfig.name}`);
          result.trustTier = 'chain-verified';
        } else if (onChainConfig.configHash === ethers.ZeroHash) {
          output.warning('No config published on-chain yet');
          result.trustTier = 'published';
        } else {
          output.error(`On-chain mismatch: chain=${onChainConfig.configHash.slice(0, 10)}... local=${configHash.slice(0, 10)}...`);
          result.valid = false;
        }

        // Step 6: IPFS verification (if CID available)
        if (onChainConfig.configCID && onChainConfig.configCID !== '') {
          result.ipfs.cid = onChainConfig.configCID;
          result.ipfs.checked = true;
          try {
            const ipfsContent = await fetchIPFS(onChainConfig.configCID);
            if (ipfsContent) {
              const ipfsHash = computeConfigHash(ipfsContent);
              result.ipfs.match = ipfsHash.configHash === configHash;
              if (result.ipfs.match) {
                output.success(`IPFS CID: ${onChainConfig.configCID.slice(0, 16)}... (content matches)`);
              } else {
                output.warning(`IPFS content hash differs from local`);
              }
            }
          } catch {
            output.warning('IPFS fetch failed (gateways unavailable)');
          }
        }
      }
    } catch (err) {
      output.warning(`On-chain check failed: ${err instanceof Error ? err.message : 'RPC error'}`);
    }
  } else {
    output.info('No on-chain identity (mock/unpublished agent)');
    result.trustTier = v4Config.wallet ? 'published' : 'unverified';
  }

  // Step 7: Reputation (optional)
  if (options.reputation && v4Config.slug) {
    try {
      const repUrl = (content.match(/check_reputation:\s*["']?([^\s"']+)/)?.[1]) ??
        `https://agirails.app/a/${v4Config.slug}/${v4Config.slug}.reputation.json`;
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(repUrl, { signal: ctrl.signal });
        if (res.ok) {
          const rep = await res.json() as Record<string, unknown>;
          result.reputation = {
            score: Number(rep.reputation_score ?? 0),
            completed: Number(rep.completed_transactions ?? 0),
            successRate: Number(rep.success_rate ?? 0),
            volume: String(rep.total_volume_usdc ?? '0'),
          };
          output.success(`Reputation: ${result.reputation.score}/100 (${result.reputation.completed} txs, ${result.reputation.successRate}% success)`);
        }
      } finally { clearTimeout(timeout); }
    } catch {
      output.warning('Reputation fetch failed');
    }
  }

  // Step 8: Summary
  output.blank();
  output.print(`  Agent: ${v4Config.name} (${v4Config.slug}) | Trust: ${result.trustTier}`);

  // JSON output
  if (output.mode === 'json') {
    console.log(JSON.stringify(result, null, 2));
  }

  process.exit(result.valid ? ExitCode.SUCCESS : ExitCode.ERROR);
}

// ============================================================================
// Helpers
// ============================================================================

async function readContent(source?: string): Promise<string | null> {
  // Stdin (pipe)
  if (!source || source === '-') {
    if (process.stdin.isTTY) return null; // No pipe, no file
    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }

  // URL
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(source, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally { clearTimeout(timeout); }
  }

  // File
  if (existsSync(source)) {
    return readFileSync(source, 'utf-8');
  }

  throw new Error(`File not found: ${source}`);
}

function resolveAddress(
  v4Config: { wallet?: string; agent_id?: string },
  override?: string
): string | null {
  // Priority: --address flag > frontmatter wallet > skip
  if (override) return override;
  if (v4Config.wallet && /^0x[0-9a-fA-F]{40}$/.test(v4Config.wallet)) return v4Config.wallet;
  // agent_id alone requires ownerOf lookup which needs a provider — skip for now
  return null;
}

const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

async function fetchIPFS(cid: string): Promise<string | null> {
  for (const gw of IPFS_GATEWAYS) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`${gw}${cid}`, { signal: ctrl.signal });
        if (res.ok) return await res.text();
      } finally { clearTimeout(timeout); }
    } catch { /* next */ }
  }
  return null;
}
