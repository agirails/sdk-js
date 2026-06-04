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
        // Note the two cases get OPPOSITE remediations: AgentNotFoundError
        // fires when no override is set + no table entry exists, so the
        // user needs to SET the env var. InvalidAgentAddressError fires
        // only when the env var IS set but contains garbage, so telling
        // them to set it is exactly the wrong advice.
        if (error instanceof AgentNotFoundError) {
          output.errorResult({
            code: 'SENTINEL_NOT_RESOLVED',
            message: error.message,
            details: {
              hint:
                'Set ACTP_SENTINEL_ADDRESS=0x... to point at a Sentinel deployment, ' +
                'or upgrade the SDK to pick up a refreshed built-in table.',
            },
          });
          process.exit(ExitCode.ERROR);
        }
        if (error instanceof InvalidAgentAddressError) {
          output.errorResult({
            code: 'SENTINEL_ADDRESS_INVALID',
            message: error.message,
            details: {
              envVar: error.envVar,
              hint:
                `Fix or unset ${error.envVar} — the value "${error.value}" is not a valid ` +
                'Ethereum address. Use a 0x-prefixed 40-character hex string, ' +
                'or unset the variable to fall back to the SDK\'s built-in Sentinel address.',
            },
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
  //    covenant is $10 USDC for the onboarding service ($10–$100 band).
  //    Picked to clear the 1%/$0.05 fee floor so receipts show a real
  //    net earning instead of "$0 earned". PRD §5.6 quote timeout
  //    default (30s) is generous on Base Sepolia.
  const result = await runRequest({
    provider: sentinel.address,
    amount: '10',
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
      receiptUrl: result.receiptUrl,
    },
    { quietKey: 'reflection' }
  );

  // Footer wording is conditional on what actually happened. The
  // structured JSON output above always reports `settled`, but human-mode
  // consumers see only the line emitted here — so a settle failure that
  // still produced a reflection must not be celebrated as "Settled".
  if (!result.settled) {
    output.blank();
    output.warning(
      `Escrow settlement did NOT complete after delivery (finalState=${result.finalState}). ` +
      'The reflection arrived, but the requester-side releaseEscrow call failed. ' +
      'Verify with `actp tx status ' + result.txId + '` and retry settlement manually.'
    );
    return;
  }
  if (reflection) {
    output.blank();
    output.success(`Reflection: ${reflection}`);
  } else {
    output.blank();
    output.success(`Settled in ${result.elapsedMs} ms`);
  }

  // Receipt URL — the wow artifact. Only present when the buyer-side V2
  // push succeeded (real on-chain network + signer). Silent when null:
  // either mock, or the push failed (indexer cron is the backstop).
  if (result.receiptUrl) {
    output.blank();
    output.print(`Receipt: ${result.receiptUrl}`);
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
