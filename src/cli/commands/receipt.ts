/**
 * Earnings Receipt Renderer
 *
 * Renders the test earning receipt in human, json, and quiet modes.
 *
 * Two renderers:
 *   - renderReceiptV2() — new design: double-line box, "FIRST TRANSACTION RECEIPT",
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
