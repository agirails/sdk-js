/**
 * Test Command — Run a real ACTP request against the deployed Sentinel.
 *
 * PRD-event-driven-provider-listening §5.7. Pre-4.0.0 this command ran a
 * mock simulation of the earning loop. From 4.0.0 it hits the live
 * Sentinel agent on Base Sepolia, walks the full state machine, settles
 * the escrow as the requester, and prints the day's curated reflection.
 *
 * Requirements:
 *  - A keystore wallet at `~/.actp/wallets/base-sepolia` (or
 *    `ACTP_PRIVATE_KEY` env var) with small ETH for gas + test USDC.
 *  - Base Sepolia RPC reachable (defaults to the SDK's bundled URL; can be
 *    overridden via `BASE_SEPOLIA_RPC`).
 *
 * Escape hatch: `ACTP_SENTINEL_ADDRESS=0x...` overrides the constant-table
 * Sentinel address. See `src/cli/lib/resolveAgent.ts`.
 *
 * @module cli/commands/test
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import {
  resolveAgent,
  AgentNotFoundError,
  InvalidAgentAddressError,
} from '../lib/resolveAgent';
import {
  runRequest,
  QuoteTimeoutError,
  DeliveryTimeoutError,
} from '../lib/runRequest';

// ============================================================================
// Command Definition
// ============================================================================

export function createTestCommand(): Command {
  return new Command('test')
    .description('Run a real onboarding request against the deployed Sentinel on Base Sepolia')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the reflection')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runTest(output);
      } catch (error) {
        // Quote-timeout has its own exit code so scripts can distinguish
        // "Sentinel offline" from generic failure modes.
        if (error instanceof QuoteTimeoutError) {
          output.errorResult({
            code: 'QUOTE_TIMEOUT',
            message: error.message,
            details: { txId: error.txId, timeoutMs: error.timeoutMs },
          });
          process.exit(2);
        }
        // Setup errors get a clearer hint than the generic mapError path.
        if (error instanceof AgentNotFoundError || error instanceof InvalidAgentAddressError) {
          output.errorResult({
            code: 'SENTINEL_NOT_RESOLVED',
            message: error.message,
            details: { hint: 'Set ACTP_SENTINEL_ADDRESS=0x... to override the built-in table.' },
          });
          process.exit(ExitCode.ERROR);
        }
        if (error instanceof DeliveryTimeoutError) {
          output.errorResult({
            code: 'DELIVERY_TIMEOUT',
            message: error.message,
            details: { txId: error.txId, timeoutMs: error.timeoutMs, lastState: error.lastState },
          });
          process.exit(ExitCode.ERROR);
        }
        const structured = mapError(error);
        output.errorResult({
          code: structured.code,
          message: structured.message,
          details: structured.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Run an onboarding request against the deployed Sentinel.
 *
 * Exported so `cli/agirails.ts` can call it directly from the onboarding
 * UX after detecting an existing identity file.
 *
 * @param output - Output instance (controls human / json / quiet mode).
 */
async function runTest(output: Output): Promise<void> {
  // 1. Resolve Sentinel for Base Sepolia (env override → constant table).
  const sentinel = resolveAgent('sentinel', 'base-sepolia');

  // 2. Header line in human mode. JSON / quiet modes get only the final
  //    structured result.
  output.print('');
  output.print(`→ Requesting onboarding service from Sentinel`);
  output.print(`  address: ${sentinel.address}`);
  output.print(`  network: base-sepolia (source: ${sentinel.source})`);
  output.print('');

  // 3. Hit Sentinel via the shared Level 1 requester flow. Sentinel's
  //    covenant is $0.05 USDC for the onboarding service; PRD §5.6 quote
  //    timeout default (30s) is generous on Base Sepolia.
  const result = await runRequest({
    provider: sentinel.address,
    amount: '0.05',
    service: 'onboarding',
    network: 'testnet',
    autoAccept: true,
    onTransition: (state, txId, ts) => {
      output.print(`  [${ts.toISOString()}] ${state.padEnd(12)} ${txId}`);
    },
  });

  // 4. Reflection is the canonical Sentinel payload. Resilient extraction:
  //    Sentinel returns { reflection, service, timestamp }; if it's wrapped
  //    in a delivery-proof envelope (`{ type: 'delivery.proof', result: {...} }`),
  //    unwrap once. Fall back to printing the raw payload otherwise.
  const reflection = extractReflection(result.payload);

  output.print('');
  output.result(
    {
      txId: result.txId,
      finalState: result.finalState,
      elapsedMs: result.elapsedMs,
      settled: result.settled,
      reflection,
      payload: result.payload,
    },
    { quietKey: 'reflection' }
  );

  if (reflection) {
    output.blank();
    output.success(`Reflection: ${reflection}`);
  } else {
    output.blank();
    output.success(`Settled in ${result.elapsedMs} ms`);
  }
}

function extractReflection(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.reflection === 'string') return obj.reflection;
  // Provider-side `Agent.processJob` wraps handler output as
  // `{ type: 'delivery.proof', result: <handler_output>, ... }`. Peel it.
  if (obj.type === 'delivery.proof' && obj.result && typeof obj.result === 'object') {
    const inner = obj.result as Record<string, unknown>;
    if (typeof inner.reflection === 'string') return inner.reflection;
  }
  return undefined;
}

export { runTest };
