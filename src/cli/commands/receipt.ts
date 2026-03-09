/**
 * Earnings Receipt Renderer
 *
 * Renders the test earning receipt in human, json, and quiet modes.
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

// ============================================================================
// Renderer
// ============================================================================

/**
 * Render an earnings receipt.
 *
 * Human mode: box-drawing receipt matching PRD spec.
 * JSON mode: structured object.
 * Quiet mode: net earnings amount only.
 */
export function renderReceipt(data: ReceiptData, output: Output): void {
  const fee = computeDisplayFee(data.amountWei);
  const net = data.amountWei - fee;
  const feePercent = data.amountWei > 0n
    ? ((Number(fee) / Number(data.amountWei)) * 100).toFixed(0)
    : '0';

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
      ...(data.timing ? { timing: data.timing } : {}),
    });
    return;
  }

  // Quiet mode
  if (output.mode === 'quiet') {
    output.print(formatUsdc(net));
    return;
  }

  // Human mode: box-drawing receipt
  const w = 47; // inner width
  const pad = (s: string) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
  const line = (s: string) => output.print(`${fmt.dim('│')}  ${pad(s)}${fmt.dim('│')}`);
  const empty = () => line('');

  output.print(fmt.dim(`┌${'─'.repeat(w + 2)}┐`));
  line(fmt.green(fmt.bold('✓ EARNINGS RECEIPT')));
  empty();
  line(`Agent:      ${fmt.bold(data.agent)}`);
  line(`Service:    ${data.service}`);
  line(`Earned:     ${fmt.bold(formatUsdc(data.amountWei))}`);
  line(`Fee:        ${formatUsdc(fee)} (${feePercent}%)`);
  line(`Net:        ${fmt.green(fmt.bold(formatUsdc(net)))}`);
  line(`Network:    ${data.network}`);
  line(`Tx:         ${formatTxId(data.txId)}`);
  if (data.timing) {
    line(`Time:       ${data.timing.totalMs}ms (escrow ${data.timing.escrowLockMs}ms, settle ${data.timing.settlementMs}ms)`);
  }
  empty();
  line(fmt.bold("WHAT'S NEXT"));
  line('• Edit agent.ts with your logic');
  line('• Say "switch to testnet" when ready');
  line('• Say "publish" to go live');
  output.print(fmt.dim(`└${'─'.repeat(w + 2)}┘`));
}

/** Strip ANSI escape codes for length calculation */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
