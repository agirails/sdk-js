/**
 * Earnings Receipt Renderer
 *
 * Renders the test earning receipt in human, json, and quiet modes.
 *
 * Three renderers:
 *   - renderReceiptV3() — FIX-5: wow-path framed ceremonial receipt. Adds
 *     reflection block + receipt URL block to V2, injectable nowFn for
 *     deterministic rendering, defensive against missing counterparty.
 *   - renderReceiptV2() — double-line box, "FIRST TRANSACTION RECEIPT",
 *     fee breakdown (Amount / Fee / Net), network variants (mock/testnet/mainnet).
 *   - renderReceipt() — backward-compatible wrapper around V2. Marked @deprecated.
 *
 * @module cli/commands/receipt
 */

import { Output, fmt } from '../utils/output';
import { computeDisplayFee } from '../../config/defaults';

// ============================================================================
// Types
// ============================================================================

export interface ReceiptTiming {
  totalMs: number;
  escrowLockMs: number;
  settlementMs: number;
}

export interface ReceiptData {
  agent: string;
  service: string;
  /** Amount in USDC wei (6 decimals) */
  amountWei: bigint;
  network: string;
  txId: string;
  timing?: ReceiptTiming;
  /** Optional: Ethereum on-chain tx hash (testnet/mainnet only) */
  ethTxHash?: string;
  /** Optional: requester address (falls back to "requester-agent" string) */
  requester?: string;
}

// ============================================================================
// Formatters
// ============================================================================

function formatUsdc(wei: bigint): string {
  const dollars = Number(wei) / 1_000_000;
  return `$${dollars.toFixed(2)} USDC`;
}

function formatTxId(txId: string): string {
  if (txId.length <= 14) return txId;
  return `${txId.slice(0, 8)}...${txId.slice(-4)}`;
}

function formatEthHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
}

/** Strip ANSI escape codes for length calculation */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ============================================================================
// V2 Renderer — new design
// ============================================================================

/**
 * Render an earnings receipt (V2 design).
 *
 * Human mode: double-line outer box, inner card with fee breakdown, network-aware variants.
 * JSON mode: structured object including fee breakdown.
 * Quiet mode: net earnings amount only.
 */
export function renderReceiptV2(data: ReceiptData, output: Output): void {
  const fee = computeDisplayFee(data.amountWei);
  const net = data.amountWei - fee;
  const feePercent = data.amountWei > 0n
    ? ((Number(fee) / Number(data.amountWei)) * 100).toFixed(0)
    : '0';
  const network = (data.network || 'mock').toLowerCase();
  const isTestnet = network.includes('testnet') || network.includes('sepolia');
  const isMainnet = network === 'mainnet' || network === 'base-mainnet';

  // JSON mode
  if (output.mode === 'json') {
    output.result({
      agent: data.agent,
      service: data.service,
      earned: formatUsdc(data.amountWei),
      fee: formatUsdc(fee),
      feePercent: `${feePercent}%`,
      net: formatUsdc(net),
      network: data.network,
      txId: data.txId,
      ...(data.ethTxHash ? { ethTxHash: data.ethTxHash } : {}),
      ...(data.timing ? { timing: data.timing } : {}),
    });
    return;
  }

  // Quiet mode
  if (output.mode === 'quiet') {
    output.print(formatUsdc(net));
    return;
  }

  // Human mode: double-line outer box with inner card
  // Alignment: outer frame total width = outerWidth + 4
  // Inner content line total width = innerWidth + 15 (║ +3sp +│ +2sp +content +│ +6sp +║)
  // For alignment: innerWidth = outerWidth - 11
  const outerWidth = 54;
  const innerWidth = outerWidth - 11; // = 43

  const outerPad = (s: string) => s + ' '.repeat(Math.max(0, outerWidth - stripAnsi(s).length));
  const innerPad = (s: string) => s + ' '.repeat(Math.max(0, innerWidth - stripAnsi(s).length));

  const outerLine = (s: string) => output.print(`${fmt.cyan('║')}  ${outerPad(s)}${fmt.cyan('║')}`);
  const outerEmpty = () => outerLine('');
  const innerLine = (s: string) =>
    output.print(`${fmt.cyan('║')}   ${fmt.dim('│')}  ${innerPad(s)}${fmt.dim('│')}      ${fmt.cyan('║')}`);

  const horiz = fmt.cyan('═'.repeat(outerWidth + 2));

  // Header — varies by network
  const headerText = isMainnet
    ? 'FIRST MAINNET SETTLEMENT'
    : 'FIRST TRANSACTION RECEIPT';

  // Tagline — varies by network
  const taglineLine1 = isMainnet
    ? 'This is real money. On a real blockchain.'
    : 'Your agent just earned its first payment.';
  const taglineLine2 = isMainnet
    ? 'Your agent is in the economy.'
    : 'Autonomously. Trustlessly. In under 60 seconds.';

  // Top frame
  output.print(`${fmt.cyan('╔')}${horiz}${fmt.cyan('╗')}`);
  outerEmpty();
  outerLine(`${fmt.cyan('◬')}  ${fmt.bold(headerText)}`);
  outerEmpty();
  outerLine(`${fmt.bold(data.agent)} earned ${fmt.green(fmt.bold(formatUsdc(net)))}`);
  outerEmpty();

  // Inner card top — ─ count = innerWidth + 2 to span full inside width
  output.print(
    `${fmt.cyan('║')}   ${fmt.dim('┌' + '─'.repeat(innerWidth + 2) + '┐')}      ${fmt.cyan('║')}`
  );

  // Inner card content
  const requesterLabel = data.requester
    ? formatEthHash(data.requester)
    : 'requester-agent';
  innerLine(`${fmt.label('From')}       ${requesterLabel}`);
  innerLine(`${fmt.label('To')}         ${data.agent}`);
  innerLine(`${fmt.label('Amount')}     ${formatUsdc(data.amountWei)}`);
  innerLine(`${fmt.label('Fee')}        ${formatUsdc(fee)} (${feePercent}%)`);
  innerLine(`${fmt.label('Net')}        ${fmt.green(formatUsdc(net))}`);
  innerLine(`${fmt.label('Service')}    ${data.service}`);
  innerLine(`${fmt.label('Status')}     ${fmt.green('SETTLED ✓')}`);
  if (data.timing) {
    innerLine(`${fmt.label('Duration')}   ${data.timing.totalMs}ms`);
  }
  innerLine(`${fmt.label('Network')}    ${data.network}`);

  // Testnet/mainnet: add on-chain proof lines
  if ((isTestnet || isMainnet) && data.ethTxHash) {
    innerLine(`${fmt.label('Eth Tx')}     ${formatEthHash(data.ethTxHash)}`);
    const scanBase = isMainnet ? 'basescan.org' : 'sepolia.basescan.org';
    innerLine(`${fmt.label('Verify')}     ${scanBase}/tx/${data.ethTxHash.slice(0, 8)}...`);
  }

  innerLine(`${fmt.label('Time')}       ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);

  // Inner card bottom
  output.print(
    `${fmt.cyan('║')}   ${fmt.dim('└' + '─'.repeat(innerWidth + 2) + '┘')}      ${fmt.cyan('║')}`
  );

  outerEmpty();
  outerLine(taglineLine1);
  outerLine(taglineLine2);
  outerEmpty();
  output.print(`${fmt.cyan('╚')}${horiz}${fmt.cyan('╝')}`);
}

// ============================================================================
// V1 Renderer — backward-compatible wrapper
// ============================================================================

/**
 * @deprecated Use renderReceiptV2 instead. Kept for backward compatibility.
 * Will be removed in the next major SDK version.
 */
export function renderReceipt(data: ReceiptData, output: Output): void {
  renderReceiptV2(data, output);
}

// ============================================================================
// V3 Renderer — FIX-5 wow-path framed ceremonial receipt
// ============================================================================

/**
 * Input shape for `renderReceiptV3`.
 *
 * Superset of `ReceiptData` with two new optional blocks (reflection,
 * receiptUrl) and an injectable `nowFn` for deterministic test rendering.
 *
 * @public
 */
export interface ReceiptDataV3 {
  /** Local agent name / slug (rendered on the "To" line by default). */
  agent: string;
  /**
   * Counterparty display label (e.g. "Sentinel"). Rendered on the "From"
   * line. When undefined, falls back to a truncated `requester` address;
   * when both are undefined, falls back to the sentinel string
   * `"requester-agent"`.
   */
  counterparty?: string;
  /** Service name (e.g. "onboarding"). */
  service: string;
  /** Amount in USDC wei (6 decimals). */
  amountWei: bigint;
  /** Network identifier: `'base-sepolia' | 'base-mainnet' | 'mock' | ...`. */
  network: string;
  /** ACTP transaction id (bytes32 hex). */
  txId: string;
  /** Per-stage timing. `totalMs` is rendered as the "Duration" row. */
  timing?: ReceiptTiming;
  /**
   * Reflection text (curated quote) to render inside a separate block.
   * Suppressed entirely when undefined OR empty string.
   */
  reflection?: string;
  /**
   * Absolute public receipt URL (e.g. `https://agirails.app/r/r_...`).
   * Suppressed when null or undefined — keeps the renderer silent when the
   * Platform push has not run yet (mock / push-failed paths).
   */
  receiptUrl?: string | null;
  /** Optional: requester wallet address (truncated when displayed). */
  requester?: string;
  /** Optional: Ethereum on-chain settlement tx hash. */
  ethTxHash?: string;
  /**
   * Injectable clock function. Defaults to `new Date()`. Tests pass a
   * fixed-clock function so the rendered "Time" row is byte-stable.
   */
  nowFn?: () => Date;
}

/** Short-form Ethereum address: `0x123456...abcd`. */
function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM:SS UTC` (ISO without milliseconds).
 * Used for the Time row so tests can assert against a fixed-clock fixture.
 */
function formatTimeUtc(d: Date): string {
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/**
 * Word-aware wrap: split `text` into lines that fit within `maxWidth`.
 * Words longer than `maxWidth` are hard-split so callers always get bounded
 * output (used for very long receipt URLs).
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (w.length > maxWidth) {
      // Flush current first
      if (current.length > 0) {
        lines.push(current);
        current = '';
      }
      // Hard-split the over-long word into chunks of maxWidth.
      for (let i = 0; i < w.length; i += maxWidth) {
        lines.push(w.slice(i, i + maxWidth));
      }
      continue;
    }
    if (current.length === 0) {
      current = w;
    } else if (current.length + 1 + w.length <= maxWidth) {
      current = `${current} ${w}`;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Render the FIX-5 ceremonial framed receipt.
 *
 * Behaviors:
 *   - JSON mode: emits a single structured object (V2 superset + reflection +
 *     receiptUrl). Reflection / receiptUrl keys are OMITTED when not present.
 *   - Quiet mode: emits only the net amount string (e.g. `"$9.90 USDC"`).
 *   - Human mode: renders a double-line outer frame with a nested inner
 *     card and optional reflection / receipt URL blocks below.
 *
 * The output is deterministic when `data.nowFn` is supplied — used by
 * snapshot-style tests and by reproducible CLI demos.
 *
 * @public
 */
export function renderReceiptV3(data: ReceiptDataV3, output: Output): void {
  const networkRaw = (data.network || 'mock').toLowerCase();
  const isTestnet = networkRaw.includes('testnet') || networkRaw.includes('sepolia');
  const isMainnet = networkRaw === 'mainnet' || networkRaw === 'base-mainnet';

  // Defensive zero-amount handling: keep fee at 0 so net is never negative.
  // (computeDisplayFee returns MIN_FEE_WEI for amount=0; that would render
  // as $0.05 fee on a $0 transaction, which is nonsensical and trips up
  // the V3 ceremonial framing.)
  const fee = data.amountWei === 0n ? 0n : computeDisplayFee(data.amountWei);
  const net = data.amountWei - fee;
  const feePercent = data.amountWei > 0n
    ? ((Number(fee) / Number(data.amountWei)) * 100).toFixed(0)
    : '0';

  // Resolve display labels for From/To. The From line shows the
  // counterparty (the other side of the trade). When the caller leaves it
  // unset, we fall back to a truncated requester address; when both are
  // missing we render the sentinel string "requester-agent" so the line
  // stays grammatical instead of empty.
  const fromLabel: string =
    data.counterparty ??
    (data.requester ? shortAddr(data.requester) : 'requester-agent');
  const toLabel = data.agent;

  // ----- JSON mode -----
  if (output.mode === 'json') {
    const payload: Record<string, unknown> = {
      agent: data.agent,
      counterparty: data.counterparty,
      service: data.service,
      earned: formatUsdc(data.amountWei),
      fee: formatUsdc(fee),
      feePercent: `${feePercent}%`,
      net: formatUsdc(net),
      network: data.network,
      txId: data.txId,
    };
    if (data.ethTxHash) payload.ethTxHash = data.ethTxHash;
    if (data.timing) payload.timing = data.timing;
    if (typeof data.reflection === 'string' && data.reflection.length > 0) {
      payload.reflection = data.reflection;
    }
    if (data.receiptUrl) payload.receiptUrl = data.receiptUrl;
    output.result(payload);
    return;
  }

  // ----- Quiet mode -----
  // Mirror V2: a single line containing the net USDC string. The test
  // mocks `output.print` to capture this call regardless of the inner
  // mode-gate inside Output#print, so we always go through print().
  if (output.mode === 'quiet') {
    output.print(formatUsdc(net));
    return;
  }

  // ----- Human mode: framed ceremonial receipt -----
  //
  // Geometry mirrors V2 to keep the visual rhythm consistent across the
  // earnings receipt family. The frame is two nested boxes:
  //   - outer  ╔═╗ / ╚═╝ at total width = outerWidth + 4 (= 58 by default)
  //   - inner  ┌─┐ / └─┘ centered inside, padded by 3 left + 6 right
  //
  // Inner content width (the usable text area inside the inner card) is
  // `innerWidth` chars, padded with one space on each side inside the │…│.
  const outerWidth = 54;
  const innerWidth = outerWidth - 11; // 43

  const outerPad = (s: string) =>
    s + ' '.repeat(Math.max(0, outerWidth - stripAnsi(s).length));
  const innerPad = (s: string) =>
    s + ' '.repeat(Math.max(0, innerWidth - stripAnsi(s).length));

  const outerLine = (s: string) =>
    output.print(`${fmt.cyan('║')}  ${outerPad(s)}${fmt.cyan('║')}`);
  const outerEmpty = () => outerLine('');
  const innerLine = (s: string) =>
    output.print(
      `${fmt.cyan('║')}   ${fmt.dim('│')}  ${innerPad(s)}${fmt.dim('│')}      ${fmt.cyan('║')}`
    );

  const horiz = fmt.cyan('═'.repeat(outerWidth + 2));

  // Header + tagline — variant by network.
  const headerText = isMainnet
    ? 'FIRST MAINNET SETTLEMENT'
    : 'FIRST TRANSACTION RECEIPT';
  const taglineLine1 = isMainnet
    ? 'This is real money. On a real blockchain.'
    : 'Your agent just earned its first payment.';
  const taglineLine2 = isMainnet
    ? 'Your agent is in the economy.'
    : 'Autonomously. Trustlessly. In under 60 seconds.';

  // Top frame
  output.print(`${fmt.cyan('╔')}${horiz}${fmt.cyan('╗')}`);
  outerEmpty();
  outerLine(`${fmt.cyan('◬')}  ${fmt.bold(headerText)}`);
  outerEmpty();
  outerLine(`${fmt.bold(data.agent)} earned ${fmt.green(fmt.bold(formatUsdc(net)))}`);
  outerEmpty();

  // Inner card top
  output.print(
    `${fmt.cyan('║')}   ${fmt.dim('┌' + '─'.repeat(innerWidth + 2) + '┐')}      ${fmt.cyan('║')}`
  );

  // Inner card content
  innerLine(`${fmt.label('From')}       ${fromLabel}`);
  innerLine(`${fmt.label('To')}         ${toLabel}`);
  innerLine(`${fmt.label('Amount')}     ${formatUsdc(data.amountWei)}`);
  innerLine(`${fmt.label('Fee')}        ${formatUsdc(fee)} (${feePercent}%)`);
  innerLine(`${fmt.label('Net')}        ${fmt.green(formatUsdc(net))}`);
  innerLine(`${fmt.label('Service')}    ${data.service}`);
  innerLine(`${fmt.label('Status')}     ${fmt.green('SETTLED ✓')}`);
  if (data.timing) {
    innerLine(`${fmt.label('Duration')}   ${data.timing.totalMs}ms`);
  }
  innerLine(`${fmt.label('Network')}    ${data.network}`);

  // On-chain proof rows (testnet + mainnet only).
  if ((isTestnet || isMainnet) && data.ethTxHash) {
    innerLine(`${fmt.label('Eth Tx')}     ${formatEthHash(data.ethTxHash)}`);
    const scanBase = isMainnet ? 'basescan.org' : 'sepolia.basescan.org';
    innerLine(`${fmt.label('Verify')}     ${scanBase}/tx/${data.ethTxHash.slice(0, 8)}...`);
  }

  // Time row — uses injected nowFn so tests can pin the clock.
  const now = (data.nowFn ?? (() => new Date()))();
  innerLine(`${fmt.label('Time')}       ${formatTimeUtc(now)}`);

  // Inner card bottom
  output.print(
    `${fmt.cyan('║')}   ${fmt.dim('└' + '─'.repeat(innerWidth + 2) + '┘')}      ${fmt.cyan('║')}`
  );

  // Reflection block — only when truthy non-empty string. Wrapping keeps
  // the line bounded by the outer frame.
  if (typeof data.reflection === 'string' && data.reflection.length > 0) {
    outerEmpty();
    outerLine(`${fmt.label('Reflection')}`);
    // Indent text two spaces inside the outer frame for readability; the
    // wrap target is outerWidth-2 so the indent never overflows.
    const reflectionLines = wrapText(data.reflection, outerWidth - 2);
    for (const ln of reflectionLines) {
      outerLine(`  ${ln}`);
    }
  }

  // Receipt URL block — only when present. We intentionally do NOT use the
  // "Receipt" label prefix on the same line as the URL: the framedReceipt
  // tests assert `not.toMatch(/Receipt\s+https/)` when the URL is absent,
  // and rendering "Receipt   https://..." on a single line would trip the
  // wrong assertion. Split label and URL across lines.
  if (data.receiptUrl) {
    outerEmpty();
    outerLine(`${fmt.label('Receipt URL')}`);
    const urlLines = wrapText(data.receiptUrl, outerWidth - 2);
    for (const ln of urlLines) {
      outerLine(`  ${ln}`);
    }
  }

  outerEmpty();
  outerLine(taglineLine1);
  outerLine(taglineLine2);
  outerEmpty();
  output.print(`${fmt.cyan('╚')}${horiz}${fmt.cyan('╝')}`);
}
