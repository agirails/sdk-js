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
import { todaysReflection } from '../lib/sentinelReflections';
import { renderReceiptV3 } from './receipt';
import {
  buildMockTweet,
  buildTestnetTweet,
  buildTwitterIntentUrl,
  copyToClipboardOSC52,
  openUrl,
} from '../utils/share';
import { RelayDeliveryChannel } from '../../delivery/RelayDeliveryChannel';
import { getNetwork } from '../../config/networks';

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
  //
  // AIP-16: wire the delivery channel so the buyer posts a setup envelope
  // and subscribes for Sentinel's response envelope. Without these three
  // opts (`deliveryChannel`, `expectedKernelAddress`, `expectedChainId`)
  // `runRequest`'s `deliveryEnabled` gate stays false, the whole AIP-16
  // path is skipped, no envelope is ever requested, and the reflection
  // falls through to the vendored local cache (`reflectionSource:
  // local-fallback`). Per Sentinel's descriptor (sentinel.md) the channel
  // privacy is `public`, so no buyer ephemeral keypair is needed —
  // CANONICAL_EMPTY_BYTES32 is signed for the pubkey field.
  const networkConfig = getNetwork('base-sepolia');
  const deliveryChannel = new RelayDeliveryChannel({
    // Default `baseUrl` is the production AGIRAILS relay; keeping it
    // explicit here makes the intent reviewable without grepping
    // RelayDeliveryChannel internals.
    baseUrl: process.env.AGIRAILS_RELAY_URL || 'https://www.agirails.app',
  });
  const result = await runRequest({
    provider: sentinel.address,
    amount: '10',
    service: 'onboarding',
    network: 'testnet',
    autoAccept: true,
    deliveryChannel,
    expectedKernelAddress: networkConfig.contracts.actpKernel as `0x${string}`,
    expectedChainId: networkConfig.chainId,
    deliveryPrivacy: 'public',
    onTransition: (state, txId, ts) => {
      output.print(`  [${ts.toISOString()}] ${state.padEnd(12)} ${txId}`);
    },
  });

  // 4. Reflection is the canonical Sentinel payload. Resilient extraction:
  //    Sentinel returns { reflection, service, timestamp }; if it's wrapped
  //    in a delivery-proof envelope (`{ type: 'delivery.proof', result: {...} }`),
  //    unwrap once. Fall back to printing the raw payload otherwise.
  const channelReflection = extractReflection(result.payload);

  // 4b. Local fallback path. If the channel produced nothing (envelope
  //     missing, decrypt failed, wrong shape) AND we know this is the
  //     Sentinel provider, render the day's reflection from the vendored
  //     local table. The determinism contract means buyers who later
  //     retry will see the same quote Sentinel would have streamed.
  //
  //     Strictly additive: when `channelReflection` is set, we use it
  //     verbatim and never look at the local table. The local path only
  //     activates when the channel is dormant — there is no race here.
  const isSentinel = isSentinelProvider(sentinel.address);
  const fallback =
    channelReflection === undefined && isSentinel ? safeLocalReflection() : undefined;
  const reflection = channelReflection ?? fallback?.text;
  const reflectionSource: 'channel' | 'local-fallback' | 'none' = channelReflection
    ? 'channel'
    : fallback
      ? 'local-fallback'
      : 'none';

  output.print('');
  output.result(
    {
      txId: result.txId,
      finalState: result.finalState,
      elapsedMs: result.elapsedMs,
      settled: result.settled,
      reflection,
      reflectionSource,
      payload: result.payload,
      receiptUrl: result.receiptUrl,
    },
    { quietKey: 'reflection' }
  );

  // Caveat indicator — shown only in human mode and only when we filled
  // in the reflection from the local table. JSON consumers learn the same
  // thing via the `reflectionSource` field above, so we don't need to
  // duplicate it through `output.warning` for them.
  if (reflectionSource === 'local-fallback') {
    output.info(
      'Reflection rendered from local cache while channel delivery activates.'
    );
  }

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

  // FIX-5: Ceremonial framed receipt (renderReceiptV3) — the wow-path
  // visual artifact for the buyer. Human mode only: JSON / quiet consumers
  // already received their structured payload from `output.result(...)`
  // above. Calling V3 in those modes would emit a duplicate JSON line or
  // a duplicate "$9.90 USDC" line.
  if (output.mode === 'human') {
    output.blank();
    renderReceiptV3(
      {
        agent: 'your-agent',
        counterparty: 'Sentinel',
        // In `actp test` the local agent always pays Sentinel for an
        // onboarding reflection — regardless of whether the agent itself
        // is buyer / earn / both in real use. Mark the receipt as buyer
        // perspective so the frame reads "your-agent paid $10.00 USDC"
        // (gross outflow) and labels the payload block "Service delivered
        // (from Sentinel)" — matching what the user actually sees.
        perspective: 'buyer',
        // The `onboarding` keyword is the on-chain service tag (matches
        // Sentinel's covenant). Tagged here as "Test onboarding" so the
        // human-mode receipt makes sense to a buyer who has no idea why
        // a security-auditor agent is requesting "onboarding".
        service: 'Test onboarding (reflection)',
        amountWei: 10_000_000n,
        network: 'base-sepolia',
        txId: result.txId,
        timing: { totalMs: result.elapsedMs, escrowLockMs: 0, settlementMs: 0 },
        reflection: reflection ?? undefined,
        receiptUrl: result.receiptUrl,
        requester: sentinel.address,
      },
      output
    );
  }

  // Receipt URL — the wow artifact. Only present when the buyer-side V2
  // push succeeded (real on-chain network + signer). Silent when null:
  // either mock, or the push failed (indexer cron is the backstop).
  //
  // We keep the standalone "Receipt: <url>" line even though the V3 frame
  // above already renders the URL inside its own block: the single-line
  // form is the copy-paste-friendly anchor that downstream tests / scripts
  // grep for (`captured.log.find(l => l.startsWith('Receipt: '))`).
  if (result.receiptUrl) {
    output.blank();
    output.print(`Receipt: ${result.receiptUrl}`);
  }

  // 5. Tweet offer — the Purple Cow moment. Non-TTY skips silently so
  //    CI / piped consumers never block. Failures (browser open, clipboard)
  //    degrade gracefully to printing the raw URL.
  await offerShareOnX(
    {
      txId: result.txId,
      receiptUrl: result.receiptUrl,
      settled: result.settled,
    },
    output
  );
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

/**
 * Return the day's local-fallback reflection text + id. Defensively wrapped
 * so any future failure inside `todaysReflection` (corrupted table import,
 * invalid Date) can never abort the `actp test` flow — the buyer still
 * gets their receipt, just without a quote.
 */
function safeLocalReflection(): { id: number; text: string } | undefined {
  try {
    const r = todaysReflection();
    if (!r || typeof r.text !== 'string' || r.text.length === 0) return undefined;
    return { id: r.id, text: r.text };
  } catch {
    return undefined;
  }
}

/**
 * Does `providerAddress` match a known Sentinel deployment? We compare
 * against the resolved Sentinel address for Base Sepolia (env override or
 * constant table), case-insensitively because EIP-55 checksum casing is
 * not stable across components in the pipeline.
 *
 * Defensive: any failure to resolve Sentinel (missing table entry,
 * invalid env var) returns false — the local-fallback path is opt-in
 * only when we are confident the provider is Sentinel. Mis-rendering a
 * Sentinel reflection on someone else's transaction would be worse than
 * silently omitting it.
 */
function isSentinelProvider(providerAddress: string): boolean {
  try {
    const sentinel = resolveAgent('sentinel', 'base-sepolia');
    return sentinel.address.toLowerCase() === providerAddress.toLowerCase();
  } catch {
    return false;
  }
}

export { runTest, isSentinelProvider, safeLocalReflection };

// ============================================================================
// Tweet offer (Purple Cow moment)
// ============================================================================

/**
 * Dependencies used by `offerShareOnX`.
 *
 * Surface is intentionally tiny — readline, openUrl, copyToClipboardOSC52,
 * and the TTY check — so tests can inject deterministic stubs without
 * needing to hijack global stdin/stdout.
 */
export interface ShareDeps {
  /**
   * Read a single line from the user. Resolves with the raw input (no
   * trim). Tests inject a stub that returns a fixed answer.
   */
  prompt: (question: string) => Promise<string>;
  /** Open a URL in the user's default browser. */
  openUrl: (url: string) => boolean;
  /** Copy text to the system clipboard via OSC 52. */
  copyToClipboard: (text: string) => boolean;
  /** Returns true when stdout is a TTY. */
  isTty: () => boolean;
}

/**
 * Minimal shape the share offer needs from `runRequest`'s result.
 *
 * Decoupled from `RunRequestResult` so the tests can construct fixtures
 * without having to satisfy the full result type.
 */
export interface ShareInput {
  txId: string;
  receiptUrl: string | null;
  settled: boolean;
}

/**
 * Default dependency bundle that wires to the real readline / share.ts
 * implementations. Tests override these via the second arg.
 */
function defaultShareDeps(): ShareDeps {
  return {
    prompt: async (question: string): Promise<string> => {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await new Promise<string>((resolve) => {
          rl.question(question, resolve);
        });
      } finally {
        rl.close();
      }
    },
    openUrl,
    copyToClipboard: copyToClipboardOSC52,
    isTty: () => Boolean(process.stdout.isTTY),
  };
}

/**
 * After a successful test transaction, ask the user whether they want to
 * share it on X (formerly Twitter). The whole flow is fail-soft:
 *
 *   - human mode only — json / quiet never see this UX
 *   - non-TTY → skip entirely (no blocking prompt in CI)
 *   - declined → no browser open, no clipboard touch
 *   - accepted → openUrl; if openUrl returns false, fall back to printing
 *     the URL and copying it to the clipboard so the user can paste it
 *   - 'c' option → copy URL to clipboard only (no browser)
 *
 * The function returns the chosen action so the caller / tests can assert
 * which path was taken without having to scrape console output.
 *
 * Visible only in `human` mode; returns `'skipped'` for json / quiet.
 *
 * @param result - Subset of the runRequest result needed to build the tweet.
 * @param output - Output instance (controls human / json / quiet mode).
 * @param deps - Injected dependencies (defaults to readline + share.ts).
 * @returns The action taken: 'tweet', 'copy', 'declined', 'skipped', or 'failed'.
 */
export async function offerShareOnX(
  result: ShareInput,
  output: Output,
  deps: ShareDeps = defaultShareDeps()
): Promise<'tweet' | 'copy' | 'declined' | 'skipped' | 'failed'> {
  // Never prompt in json / quiet — those modes are for scripts.
  if (output.mode !== 'human') return 'skipped';

  // Non-TTY skips silently. CI / piped consumers must never block.
  if (!deps.isTty()) return 'skipped';

  // Build tweet variants. We don't have a settle eth-tx-hash in the
  // RunRequestResult, but the ACTP txId is the canonical reference and
  // round-trips back to the receipt page. When the receipt URL is
  // present, we splice it in — that's the strongest single artifact.
  // Net amount: the runTest amount is fixed at $10, and the fee floor is
  // max($10 * 1%, $0.05) = $0.10, so net = $9.90. We don't recompute it
  // from the result because (a) the result currently doesn't expose the
  // fee breakdown and (b) keeping it stable keeps the tweet template
  // testable.
  const NET_AMOUNT_USD = '9.90';
  let tweetText: string;
  if (result.receiptUrl) {
    // Testnet template + receipt URL takes precedence over the txId
    // fragment — the receipt URL is the prettier, click-throughable
    // artifact.
    const base = buildTestnetTweet(NET_AMOUNT_USD, result.txId);
    tweetText = `${base}\n\nReceipt: ${result.receiptUrl}`;
  } else if (result.settled) {
    // Settled but no receipt URL (push failed / not pushed). Use the
    // testnet template with just the txId — basescan link still works.
    tweetText = buildTestnetTweet(NET_AMOUNT_USD, result.txId);
  } else {
    // Mock or unsettled: use the generic earn template.
    tweetText = buildMockTweet(NET_AMOUNT_USD);
  }

  // Twitter's hard limit is 280; URL-encoding can balloon the actual
  // request URL but the displayed tweet text is what counts. If we're
  // over budget, fall back to the mock template which is short.
  if (tweetText.length > 280) {
    tweetText = buildMockTweet(NET_AMOUNT_USD);
  }

  const intentUrl = buildTwitterIntentUrl(tweetText);

  // Prompt. Y = open browser, c = copy URL, anything else = decline.
  output.blank();
  output.print('Share your first AGIRAILS transaction on X?');
  output.print('  [Y] open in browser   [c] copy link only   [n] skip');

  let answer: string;
  try {
    answer = await deps.prompt('Choice (Y/c/n): ');
  } catch {
    // Prompt failed (stdin closed mid-flight). Treat as decline.
    return 'declined';
  }
  const trimmed = answer.trim().toLowerCase();

  // Copy-only branch.
  if (trimmed === 'c' || trimmed === 'copy') {
    const copied = deps.copyToClipboard(intentUrl);
    if (copied) {
      output.info('Tweet URL copied to clipboard — paste it anywhere to share.');
    } else {
      // OSC 52 unsupported. Print the URL so the user can copy manually.
      output.print('Tweet URL (copy manually):');
      output.print(`  ${intentUrl}`);
    }
    return 'copy';
  }

  // Decline branch: any explicit "no" answer.
  if (trimmed === 'n' || trimmed === 'no') {
    return 'declined';
  }

  // Accept branch: empty (Enter), y, yes. Open browser.
  const opened = deps.openUrl(intentUrl);
  if (opened) {
    output.info('Opening X in your browser…');
    return 'tweet';
  }

  // Browser open failed (unsupported platform, spawn error). Fall back
  // to clipboard + visible URL so the user still has a path forward.
  output.warning('Could not open browser automatically.');
  const copied = deps.copyToClipboard(intentUrl);
  if (copied) {
    output.info('Tweet URL copied to clipboard instead — paste it in your browser.');
  } else {
    output.print('Open this URL to tweet:');
    output.print(`  ${intentUrl}`);
  }
  return 'failed';
}
