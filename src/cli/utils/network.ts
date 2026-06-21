/**
 * Unified CLI network resolution (F-2 fix).
 *
 * The CLI historically resolved the transacting network three different ways:
 *   - `actp request` used the `--network` flag (default `testnet`), ignoring
 *     `.actp/config.json` mode AND `ACTP_NETWORK`.
 *   - `actp pay` / `tx` / `mint` / ... used `config.mode` (default `mock`),
 *     ignoring `--network` (no such flag) AND `ACTP_NETWORK`.
 *   - `ACTP_NETWORK` (advertised in `.env.example` as the network selector)
 *     was honored by neither path.
 *
 * This module is the single source of truth. Precedence:
 *
 *     explicit --network flag  >  ACTP_NETWORK env  >  config.mode  >  testnet
 *
 * Real-money guard (the "hybrid" policy): an explicit signal may freely
 * DOWNGRADE to testnet/mock, but the resolver will NEVER resolve to `mainnet`
 * unless `config.mode === 'mainnet'`. A transient `--network mainnet` or
 * `ACTP_NETWORK=mainnet` over a non-mainnet config is refused — moving real
 * funds requires `actp config --mode mainnet` first. This makes an accidental
 * mainnet send structurally impossible from a stray flag or env var.
 *
 * @module cli/utils/network
 */

import { loadConfig, type CLIMode } from './config';

export type NetworkSource = 'flag' | 'env' | 'config' | 'default';

export interface ResolvedNetwork {
  network: CLIMode;
  source: NetworkSource;
}

/**
 * Parse + validate a network string from a flag or env var.
 * @throws if the value is not mock | testnet | mainnet.
 */
export function parseCliNetwork(raw: string, origin: string): CLIMode {
  const value = raw.trim().toLowerCase();
  if (value === 'mock' || value === 'testnet' || value === 'mainnet') return value;
  throw new Error(`Invalid ${origin}: "${raw}". Expected mock | testnet | mainnet.`);
}

/** Read config.mode, treating an uninitialized project as "no signal". */
function configMode(projectRoot?: string): CLIMode | undefined {
  try {
    return loadConfig(projectRoot).mode;
  } catch {
    // Not initialized / unreadable — config contributes no signal. The
    // mainnet guard below still applies (undefined !== 'mainnet'), so a
    // config-less project can never resolve to mainnet via flag/env alone.
    return undefined;
  }
}

/**
 * Resolve the effective network for a value-moving or query CLI command.
 *
 * @param flag        the raw `--network` flag value, if the command accepts one
 * @param projectRoot project root (defaults to cwd inside `loadConfig`)
 * @throws if a flag/env value is invalid, or if mainnet is requested via
 *         flag/env while config mode is not mainnet (the real-money guard).
 */
export function resolveNetwork(flag?: string, projectRoot?: string): ResolvedNetwork {
  const flagNet =
    flag !== undefined && flag.trim() !== '' ? parseCliNetwork(flag, '--network') : undefined;
  const envRaw = process.env.ACTP_NETWORK;
  const envNet =
    envRaw !== undefined && envRaw.trim() !== '' ? parseCliNetwork(envRaw, 'ACTP_NETWORK') : undefined;
  const cfg = configMode(projectRoot);

  let candidate: CLIMode;
  let source: NetworkSource;
  if (flagNet) {
    candidate = flagNet;
    source = 'flag';
  } else if (envNet) {
    candidate = envNet;
    source = 'env';
  } else if (cfg) {
    candidate = cfg;
    source = 'config';
  } else {
    candidate = 'testnet';
    source = 'default';
  }

  // Hybrid real-money guard: mainnet is only ever resolved when config mode
  // is mainnet. A flag/env can downgrade freely but can never escalate to
  // mainnet on its own.
  if (candidate === 'mainnet' && cfg !== 'mainnet') {
    const requestedBy = source === 'flag' ? '--network mainnet' : 'ACTP_NETWORK=mainnet';
    throw new Error(
      `Refusing to run on mainnet: ${requestedBy} was requested but config mode is ` +
        `${cfg ?? 'unset'}. Real funds require 'actp config --mode mainnet' first — ` +
        `a flag or env var cannot escalate to mainnet.`,
    );
  }

  return { network: candidate, source };
}

/** Human-readable "testnet (from --network)" for command output. */
export function describeNetwork(r: ResolvedNetwork): string {
  const label: Record<NetworkSource, string> = {
    flag: 'from --network',
    env: 'from ACTP_NETWORK',
    config: 'from config mode',
    default: 'default',
  };
  return `${r.network} (${label[r.source]})`;
}
