/**
 * anvil-fork harness for blockchain-runtime e2e tests (PRD §8.2).
 *
 * Spawns a local `anvil` process forked from Base Sepolia at a pinned
 * block, waits for the JSON-RPC endpoint to be reachable, and returns
 * lifecycle handles for the test suite. Per-suite isolation: each
 * describe block gets its own anvil instance, killed on suite teardown.
 *
 * Why per-suite (not per-test): anvil cold-start is ~1s. 16 cases
 * spinning up 16 instances costs ~16s; running them under one shared
 * anvil with snapshot/revert is ~5x faster but adds state-isolation
 * complexity we don't need for the v1 e2e baseline. PRD §8.2 doesn't
 * mandate either; pick the simpler one.
 *
 * Skip-gate: the helpers throw a typed `AnvilUnavailableError` when
 * the anvil binary is missing or `BASE_SEPOLIA_RPC` is unset. Use the
 * `describeAnvilSuite` wrapper from `./skipGate.ts` (next file) to
 * skip rather than fail in those environments.
 *
 * @module __e2e__/blockchain-runtime/helpers/anvil
 */

import { spawn, ChildProcess, spawnSync } from 'child_process';
import { JsonRpcProvider } from 'ethers';

/** Pinned Base Sepolia fork block. Bump deliberately when chain state changes
 *  in a way the e2e suite depends on (new MockUSDC mint, new kernel deploy, …). */
export const FORK_BLOCK = 19_500_000;

/** Default port range — pick the next free one per spawn to avoid clashes. */
const PORT_BASE = 18_545;

export interface AnvilHandle {
  /** ethers provider pointed at the local anvil RPC. */
  provider: JsonRpcProvider;
  /** Anvil's RPC URL (http://127.0.0.1:<port>). */
  rpcUrl: string;
  /** Tear down: kill the child process. Idempotent. */
  stop: () => Promise<void>;
  /** Send a raw JSON-RPC method (e.g. `evm_setNextBlockTimestamp`). */
  rpc: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
}

export class AnvilUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`anvil-fork suite unavailable: ${reason}`);
    this.name = 'AnvilUnavailableError';
  }
}

let nextPort = PORT_BASE;

/**
 * Spawn a fresh anvil instance forked from Base Sepolia.
 *
 * Throws `AnvilUnavailableError` if the binary or fork URL is missing.
 * The caller is responsible for calling `handle.stop()` in `afterAll`.
 */
export async function startAnvilFork(opts: {
  /** Pinned fork block. Defaults to {@link FORK_BLOCK}. */
  forkBlockNumber?: number;
  /** Chain ID anvil should report. Defaults to 84532 (Base Sepolia). */
  chainId?: number;
  /** Override the fork URL (otherwise reads BASE_SEPOLIA_RPC env). */
  forkUrl?: string;
} = {}): Promise<AnvilHandle> {
  const forkUrl = opts.forkUrl ?? process.env.BASE_SEPOLIA_RPC;
  if (!forkUrl) {
    throw new AnvilUnavailableError(
      'BASE_SEPOLIA_RPC env var is not set — anvil needs a fork upstream RPC URL.'
    );
  }
  if (!hasAnvilBinary()) {
    throw new AnvilUnavailableError(
      "`anvil` binary is not on PATH. Install foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`."
    );
  }

  const port = nextPort++;
  const chainId = opts.chainId ?? 84_532;
  const forkBlockNumber = opts.forkBlockNumber ?? FORK_BLOCK;
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child = spawn(
    'anvil',
    [
      '--fork-url', forkUrl,
      '--fork-block-number', String(forkBlockNumber),
      '--chain-id', String(chainId),
      '--port', String(port),
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  // Surface spawn failures (e.g. ENOENT) as our typed error.
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    child.once('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(new AnvilUnavailableError(`anvil spawn failed: ${err.message}`));
    });
    setImmediate(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
  });

  const provider = new JsonRpcProvider(rpcUrl);
  await waitForReady(provider, 10_000);

  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    return provider.send(method, params) as Promise<T>;
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    provider.destroy();
    if (child.killed) return;
    return new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 3000).unref();
    });
  };

  return { provider, rpcUrl, stop, rpc };
}

/** True if `anvil --version` runs cleanly. */
function hasAnvilBinary(): boolean {
  try {
    const r = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Poll `eth_chainId` until the endpoint responds or the deadline elapses. */
async function waitForReady(provider: JsonRpcProvider, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await provider.send('eth_chainId', []);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw new AnvilUnavailableError(
    `anvil did not become reachable within ${timeoutMs}ms — last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Time-travel helper. Anvil supports `evm_setNextBlockTimestamp` + `evm_mine`
 * to fast-forward past the kernel's 1h minimum dispute window.
 *
 * @example
 * ```ts
 * await advanceTime(anvil, 3601); // +1h + 1s — settle becomes legal
 * ```
 */
export async function advanceTime(anvil: AnvilHandle, seconds: number): Promise<void> {
  const block = await anvil.provider.getBlock('latest');
  if (!block) throw new Error('advanceTime: latest block not available');
  const nextTs = Number(block.timestamp) + seconds;
  await anvil.rpc('evm_setNextBlockTimestamp', [nextTs]);
  await anvil.rpc('evm_mine', []);
}
