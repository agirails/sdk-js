/**
 * Request Command — Level 1 negotiated job request (PRD §5.6).
 *
 * Creates an on-chain INITIATED transaction whose routing key is
 * `keccak256(toUtf8Bytes(serviceName))`. A registered provider listening for
 * that hash (via `Agent.provide(name, handler)`) will quote, accept, run the
 * handler, and deliver. The CLI waits for delivery and prints each state
 * transition.
 *
 * Distinct from `actp pay`: pay is a Level 0 primitive that commits funds
 * directly without a handler; request is a Level 1 negotiated flow that
 * routes to a provider's handler. See PRD §A.2 for the decision log.
 *
 * @module cli/commands/request
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { discoverAgents } from '../../api/agirailsApp';
import {
  runRequest,
  QuoteTimeoutError,
  DeliveryTimeoutError,
  type RequestNetwork,
} from '../lib/runRequest';
import { renderReceiptV3 } from './receipt';
import { RelayDeliveryChannel } from '../../delivery/RelayDeliveryChannel';
import { getNetwork } from '../../config/networks';

// ============================================================================
// Command Definition
// ============================================================================

export function createRequestCommand(): Command {
  return new Command('request')
    .description('Request a Level 1 negotiated service (quote → accept → deliver)')
    .argument('<provider>', 'Provider address or agirails.app slug URL')
    .argument('<amount>', 'Amount to escrow (e.g., "0.05" USDC)')
    .requiredOption('--service <name>', 'Service name; on-chain key is keccak256(toUtf8Bytes(name))')
    .option('--deadline <iso-or-unix>', 'Job deadline as ISO 8601 or unix seconds', '')
    .option('--network <network>', 'Target network: mock | testnet | mainnet', 'testnet')
    .option('--quote-timeout <ms>', 'Max wait for INITIATED → QUOTED (or beyond), in ms', '30000')
    .option('--delivery-timeout <ms>', 'Max wait for DELIVERED, in ms', '300000')
    // Commander idiom: declaring `--no-auto-accept` makes options.autoAccept
    // default to true while still giving callers a working off-switch. The
    // previous form `--auto-accept ... true` shipped no toggle at all.
    .option('--no-auto-accept', 'Prompt before accepting the first quote (default: auto-accept)')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only the transaction ID')
    .action(async (provider: string, amount: string, options: RequestOptionsRaw) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runRequestCommand(provider, amount, options, output);
      } catch (error) {
        if (error instanceof QuoteTimeoutError) {
          output.errorResult({
            code: 'QUOTE_TIMEOUT',
            message: error.message,
            details: { txId: error.txId, timeoutMs: error.timeoutMs },
          });
          // PRD §5.6: exit code 2 is the canonical no-quote signal so scripts
          // can distinguish "provider offline" from other failure modes.
          process.exit(2);
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

interface RequestOptionsRaw {
  service: string;
  deadline?: string;
  network?: string;
  quoteTimeout?: string;
  deliveryTimeout?: string;
  autoAccept?: boolean;
  json?: boolean;
  quiet?: boolean;
}

async function runRequestCommand(
  providerArg: string,
  amount: string,
  options: RequestOptionsRaw,
  output: Output
): Promise<void> {
  // Resolve agirails.app slug to an address, mirroring `actp pay` UX.
  // Capture the slug (if any) so the receipt can show a human-readable
  // counterparty name instead of just the truncated address.
  const slugMatch = providerArg.match(
    /^(?:https?:\/\/)?(?:www\.)?agirails\.app\/a\/([a-z0-9_-]+)$/i
  );
  const counterpartySlug = slugMatch ? slugMatch[1].toLowerCase() : undefined;
  const provider = await resolveProvider(providerArg, output);

  const network = parseNetwork(options.network);
  const quoteTimeoutMs = parsePositiveInt(options.quoteTimeout, 30_000, '--quote-timeout');
  const deliveryTimeoutMs = parsePositiveInt(options.deliveryTimeout, 300_000, '--delivery-timeout');

  output.print(`→ Requesting ${options.service} from ${provider}`);
  output.print(`  amount: ${amount}, network: ${network}, quote-timeout: ${quoteTimeoutMs}ms`);
  output.blank();

  // AIP-16 wire-up (parity with `actp test`): give runRequest the delivery
  // channel, kernel address, and chainId so it can post a setup envelope
  // and pick up the provider's response envelope. Without these
  // `deliveryEnabled` stays false and the channel path is skipped —
  // identical to the pre-AIP-16 SDK. Public privacy by default; encrypted
  // requires a buyer ephemeral keypair we don't surface on the CLI yet.
  // Only wire on real networks; mock has no relay to talk to.
  let deliveryChannel: RelayDeliveryChannel | undefined;
  let expectedKernelAddress: `0x${string}` | undefined;
  let expectedChainId: number | undefined;
  if (network === 'testnet' || network === 'mainnet') {
    const networkName = network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
    const cfg = getNetwork(networkName);
    deliveryChannel = new RelayDeliveryChannel({
      baseUrl: process.env.AGIRAILS_RELAY_URL || 'https://www.agirails.app',
    });
    expectedKernelAddress = cfg.contracts.actpKernel as `0x${string}`;
    expectedChainId = cfg.chainId;
  }

  const result = await runRequest({
    provider,
    amount,
    service: options.service,
    deadline: options.deadline || undefined,
    network,
    quoteTimeoutMs,
    deliveryTimeoutMs,
    autoAccept: options.autoAccept ?? true,
    deliveryChannel,
    expectedKernelAddress,
    expectedChainId,
    deliveryPrivacy: 'public',
    onTransition: (state, txId, ts) => {
      // Human mode shows the live log line; quiet/json modes suppress it
      // (they only emit the final structured result).
      output.print(`  [${ts.toISOString()}] ${state.padEnd(12)} ${txId}`);
    },
  });

  output.blank();
  output.result(
    {
      txId: result.txId,
      finalState: result.finalState,
      elapsedMs: result.elapsedMs,
      settled: result.settled,
      payload: result.payload,
      receiptUrl: result.receiptUrl,
    },
    { quietKey: 'txId' }
  );

  // Extract a one-line "reflection / payload preview" string for the V3
  // receipt's payload block. Falls back to JSON-stringified payload (max
  // ~280 chars) when there is no `reflection` field, mirroring the
  // human-friendly intent of `actp test`'s payload row.
  let payloadPreview: string | undefined;
  if (result.payload && typeof result.payload === 'object') {
    const obj = result.payload as Record<string, unknown>;
    if (typeof obj.reflection === 'string' && obj.reflection.length > 0) {
      payloadPreview = obj.reflection;
    } else {
      try {
        const json = JSON.stringify(obj);
        payloadPreview = json.length > 280 ? json.slice(0, 277) + '...' : json;
      } catch {
        // Non-serializable payload — leave preview unset.
      }
    }
  }

  // V3 framed receipt — buyer perspective. We always render the ceremonial
  // receipt for a settled request, regardless of whether the agent's own
  // intent is buy / earn / both: in `actp request` the local agent is by
  // definition the requester paying the provider for a service.
  // Unsettled outcomes (DELIVERED-but-no-settle, timeouts) skip the frame
  // and fall back to the legacy success/warning lines below.
  if (output.mode === 'human' && result.settled && network !== 'mock') {
    output.blank();
    const networkLabel = network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
    // amount is the human-readable USDC string ("0.05", "10"); convert to
    // 6-decimal wei. Strip leading $ if a user passed "$10".
    const amountNum = Number(amount.replace(/^\$/, ''));
    const amountWei = Number.isFinite(amountNum)
      ? BigInt(Math.round(amountNum * 1_000_000))
      : 0n;
    renderReceiptV3(
      {
        agent: 'your-agent',
        // Only pass `counterparty` when we have a human-readable slug —
        // a raw 42-char hex address overflows the inner card width and
        // breaks the frame. When unset, the renderer falls back to
        // shortAddr(requester) which always fits.
        counterparty: counterpartySlug,
        perspective: 'buyer',
        service: options.service,
        amountWei,
        network: networkLabel,
        txId: result.txId,
        timing: { totalMs: result.elapsedMs, escrowLockMs: 0, settlementMs: 0 },
        reflection: payloadPreview,
        receiptUrl: result.receiptUrl,
        // `requester` here is the on-chain counterparty for shortAddr —
        // the field name is provider-perspective-centric ("the requester
        // from the receipt-author's POV"); for buyer perspective the
        // counterparty IS the provider we paid.
        requester: provider,
      },
      output
    );
  }

  // Legacy success line — still useful in non-human modes and as a
  // backstop when the V3 frame is suppressed (mock / unsettled).
  if (payloadPreview) {
    output.blank();
    output.success(`Service delivered: ${payloadPreview.slice(0, 120)}`);
  } else if (!result.settled || network === 'mock') {
    output.blank();
    output.success(`Settled in ${result.elapsedMs} ms`);
  }
}

async function resolveProvider(input: string, output: Output): Promise<string> {
  const slugMatch = input.match(/^(?:https?:\/\/)?(?:www\.)?agirails\.app\/a\/([a-z0-9_-]+)$/i);
  if (!slugMatch) return input;

  const slug = slugMatch[1].toLowerCase();
  const spinner = output.spinner(`Resolving ${slug}...`);
  try {
    const result = await discoverAgents({ search: slug, limit: 10 });
    const agent = result.agents.find((a) => a.slug.toLowerCase() === slug);
    if (!agent?.wallet_address) {
      spinner.stop(false);
      throw new Error(`Agent "${slug}" not found or has no wallet address.`);
    }
    spinner.stop(true);
    output.print(`Resolved ${slug} → ${agent.wallet_address}`);
    return agent.wallet_address;
  } catch (err) {
    spinner.stop(false);
    throw err;
  }
}

function parseNetwork(raw?: string): RequestNetwork {
  const value = (raw ?? 'testnet').toLowerCase();
  if (value === 'mock' || value === 'testnet' || value === 'mainnet') return value;
  throw new Error(`Invalid --network: "${raw}". Expected mock, testnet, or mainnet.`);
}

// Exported for unit testing — the CLI surface is a thin commander wrapper,
// so we cover the parser behavior directly rather than via process spawning.
export function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined || raw === '') return fallback;
  // Strict integer parse: parseInt silently truncates "30.5" to 30 and
  // accepts numeric separators ("30_000", "30,000") in surprising ways.
  // Demand a clean digits-only string so callers get an error instead of
  // an off-by-orders-of-magnitude timeout.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid ${flag}: "${raw}". Expected a positive integer in milliseconds — ` +
      `decimals, separators, and scientific notation are not accepted.`
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${flag}: "${raw}". Expected a positive integer (milliseconds).`);
  }
  return n;
}
