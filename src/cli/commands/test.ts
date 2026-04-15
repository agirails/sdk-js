/**
 * Test Command - Prove the earning loop works
 *
 * Always uses mock runtime, regardless of network in {slug}.md.
 * Simulates the full ACTP lifecycle (escrow → settlement) without
 * invoking handler code — proves the earning loop, not business logic.
 *
 * @module cli/commands/test
 */

import * as fs from 'fs';
import { Command } from 'commander';
import { ethers } from 'ethers';
import { Output, ExitCode, fmt } from '../utils/output';
import { mapError } from '../utils/client';
import { resolveIdentityPath, loadConfig } from '../utils/config';
import { parseAgirailsMdV4 } from '../../config/agirailsmdV4';
import { selectTestJob } from '../testjobs';
import { renderReceipt } from './receipt';
import { MockRuntime } from '../../runtime/MockRuntime';
import { inlineBanner } from '../utils/banner';
import { uploadReceipt } from '../receiptUpload';
import { computeDisplayFee } from '../../config/defaults';

// ============================================================================
// Command Definition
// ============================================================================

export function createTestCommand(): Command {
  const cmd = new Command('test')
    .description('Run a test job through the mock earning loop')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output only net earnings')
    .action(async (options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runTest(output);
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
          details: structuredError.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spinner frames (rotating Unicode circle) */
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

/**
 * Run a state transition with rotating spinner animation.
 *
 * On TTY (human mode): prints a spinning line, awaits the work, enforces a
 * minimum visible duration, then rewrites the line with the final icon + timing.
 *
 * On non-TTY / CI: executes the work without animation, emits a single line
 * with actual elapsed time.
 */
async function animateState(
  output: Output,
  label: string,
  message: string,
  work: () => Promise<void>,
  settled: boolean = false,
  minDurationMs: number = 450
): Promise<number> {
  const labelPad = label.padEnd(14);
  const msgPad = message.padEnd(40);

  if (output.mode !== 'human') {
    // Non-human (json/quiet): execute silently, no output
    await work();
    return 0;
  }

  if (!process.stdout.isTTY) {
    // Non-TTY: no animation, single line after work completes
    const start = performance.now();
    await work();
    const elapsed = Math.round(performance.now() - start);
    const icon = settled ? fmt.green('✓') : fmt.cyan('·');
    const lbl = settled ? fmt.green(fmt.bold(labelPad)) : fmt.bold(labelPad);
    console.log(`  ${icon} ${lbl} ${msgPad} ${fmt.dim(`[${elapsed}ms]`)}`);
    return elapsed;
  }

  // TTY: rotating spinner with min duration for visibility
  let frameIdx = 0;
  process.stdout.write(`  ${fmt.cyan(SPINNER_FRAMES[0])} ${fmt.bold(labelPad)} ${msgPad}`);

  const interval = setInterval(() => {
    frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
    process.stdout.write(`\r  ${fmt.cyan(SPINNER_FRAMES[frameIdx])} ${fmt.bold(labelPad)} ${msgPad}`);
  }, 90);

  const start = performance.now();
  await Promise.all([
    work(),
    sleep(minDurationMs),
  ]);
  const elapsed = Math.round(performance.now() - start);

  clearInterval(interval);
  const icon = settled ? fmt.green('✓') : fmt.cyan('·');
  const lbl = settled ? fmt.green(fmt.bold(labelPad)) : fmt.bold(labelPad);
  process.stdout.write(`\r  ${icon} ${lbl} ${msgPad} ${fmt.dim(`[${elapsed}ms]`)}\n`);
  return elapsed;
}

/** Demo amount for first-TX experience: $10 USDC (fee $0.10, net $9.90) */
const TEST_TX_AMOUNT_WEI = 10_000_000n;

async function runTest(output: Output): Promise<void> {
  // Step 1: Resolve identity file
  const identityPath = resolveIdentityPath();
  if (!identityPath) {
    throw new Error(
      'No agent identity file ({slug}.md) found in this directory.\n' +
      'Create one with a valid AGIRAILS.md v4 frontmatter (name, services, pricing).\n' +
      'Or let an AI assistant generate one: curl -sLO https://www.agirails.app/protocol/AGIRAILS.md'
    );
  }

  // Parse identity
  const content = fs.readFileSync(identityPath, 'utf-8');
  const config = parseAgirailsMdV4(content);
  const testJob = selectTestJob(config.services);

  // Render banner + section header (human mode only)
  if (output.mode === 'human') {
    output.print('');
    output.print(inlineBanner('ACTP Transaction Lifecycle'));
    output.print('');
  }

  const isTTY = process.stdout.isTTY && output.mode === 'human';

  const totalStart = performance.now();
  const runtime = new MockRuntime();

  // Create synthetic addresses
  const requesterWallet = ethers.Wallet.createRandom();
  let providerAddress: string;
  try {
    providerAddress = loadConfig().address || ethers.Wallet.createRandom().address;
  } catch {
    providerAddress = ethers.Wallet.createRandom().address;
  }

  // Hardcoded $10 demo amount — demonstrates fee math (fee $0.10, net $9.90)
  const amountWei = TEST_TX_AMOUNT_WEI;
  const amountStr = amountWei.toString();
  await runtime.mintTokens(requesterWallet.address, amountStr);

  const deadline = runtime.time.now() + 86400;
  const disputeWindow = parseDuration(config.sla.dispute_window);

  // Shared txId/escrowId across state closures
  let txId: string = '';
  let escrowId: string = '';
  let escrowLockMs = 0;
  let settlementMs = 0;

  // === INITIATED ===
  await animateState(output, 'INITIATED', 'Requester created transaction', async () => {
    txId = await runtime.createTransaction({
      provider: providerAddress,
      requester: requesterWallet.address,
      amount: amountStr,
      deadline,
      disputeWindow,
      serviceDescription: testJob.title,
    });
  });

  // === QUOTED === (educational: demonstrates full state machine)
  await animateState(output, 'QUOTED', `${config.name} quoted $10.00 USDC`, async () => {
    await runtime.transitionState(txId, 'QUOTED');
  });

  // === COMMITTED ===
  await animateState(output, 'COMMITTED', 'Escrow funded — $10.00 locked', async () => {
    const commitStart = performance.now();
    escrowId = await runtime.linkEscrow(txId, amountStr);
    escrowLockMs = performance.now() - commitStart;
  });

  // === IN_PROGRESS ===
  await animateState(output, 'IN_PROGRESS', `${config.name} working...`, async () => {
    await runtime.transitionState(txId, 'IN_PROGRESS');
  }, false, 700); // longer delay — simulates "doing work"

  // === DELIVERED ===
  await animateState(output, 'DELIVERED', 'Delivery proof submitted', async () => {
    await runtime.transitionState(txId, 'DELIVERED');
  });

  // Advance time past dispute window (silent — not a real state transition)
  await runtime.time.advanceTime(disputeWindow + 1);

  // === SETTLED ===
  await animateState(output, 'SETTLED', `Escrow released → ${config.name}`, async () => {
    const settlementStart = performance.now();
    await runtime.releaseEscrow(escrowId);
    settlementMs = performance.now() - settlementStart;
  }, true);

  const totalMs = performance.now() - totalStart;

  // Summary line
  if (output.mode === 'human') {
    output.print('');
    output.print(fmt.dim(`  ─── ${Math.round(totalMs)}ms total ${'─'.repeat(Math.max(0, 40 - String(Math.round(totalMs)).length))}`));
    output.print('');
  }

  // Receipt
  renderReceipt(
    {
      agent: config.name,
      service: config.services[0],
      amountWei,
      network: 'mock',
      txId,
      timing: {
        totalMs: Math.round(totalMs),
        escrowLockMs: Math.round(escrowLockMs),
        settlementMs: Math.round(settlementMs),
      },
    },
    output
  );

  // Best-effort publish to agirails.app/r/<id> — mock auth requires API key.
  // On failure, fall through silently; the CLI already printed a local receipt.
  // Fee math from canonical SDK helper (config/defaults.ts) — kept in sync
  // with the web copy at lib/receipts/fees.ts via the parity test on web.
  const feeWei = computeDisplayFee(amountWei);
  const netWei = amountWei - feeWei;
  const upload = await uploadReceipt(
    {
      agentAddress: providerAddress,
      service: testJob.title,
      amountWei: amountStr,
      feeWei: feeWei.toString(),
      netWei: netWei.toString(),
      txId,
      network: 'mock',
      requesterAddress: requesterWallet.address,
      durationMs: Math.round(totalMs),
    },
  );

  if (output.mode === 'human' && upload.ok) {
    output.print('');
    output.print(`  ${fmt.green('→')} Shareable receipt: ${fmt.bold(upload.url)}`);
    if (upload.milestone) {
      output.print(`  ${fmt.yellow('★')} Milestone: ${fmt.bold(upload.milestone)}`);
    }
    output.print('');
  }

  // Share prompt (TTY + human mode only — never in CI/piped/json/quiet)
  if (isTTY) {
    await promptShare(amountWei, 'mock', undefined, upload.ok ? upload.url : undefined);
  }
}

// ============================================================================
// Share prompt
// ============================================================================

async function promptShare(
  amountWei: bigint,
  network: 'mock' | 'testnet',
  ethTxHash?: string,
  receiptUrl?: string,
): Promise<void> {
  const readline = await import('readline');
  const {
    copyToClipboardOSC52,
    buildTwitterIntentUrl,
    openUrl,
    buildMockTweet,
    buildTestnetTweet,
  } = await import('../utils/share');

  // Compute net for tweet text
  const { computeDisplayFee } = await import('../../config/defaults');
  const fee = computeDisplayFee(amountWei);
  const net = amountWei - fee;
  const netUsd = `$${(Number(net) / 1_000_000).toFixed(2)}`;

  const baseTweet = network === 'testnet' && ethTxHash
    ? buildTestnetTweet(netUsd, ethTxHash)
    : buildMockTweet(netUsd);
  const tweetText = receiptUrl ? `${baseTweet}\n\n${receiptUrl}` : baseTweet;

  console.log('');
  console.log(fmt.bold('Share your first transaction?'));
  console.log('');
  console.log(`  ${fmt.cyan('1)')} Copy tweet text to clipboard`);
  console.log(`  ${fmt.cyan('2)')} Open Twitter with pre-filled tweet`);
  console.log(`  ${fmt.cyan('3)')} Skip`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('Choose [1-3, default 3]: ', resolve);
  });
  rl.close();

  const choice = answer.trim() || '3';

  if (choice === '1') {
    const copied = copyToClipboardOSC52(tweetText);
    console.log('');
    if (copied) {
      console.log(fmt.green('✓ Tweet copied to clipboard.'));
    } else {
      console.log(fmt.yellow('Clipboard not available — copy manually:'));
      console.log('');
      console.log(fmt.dim(tweetText));
    }
    console.log('');
  } else if (choice === '2') {
    const url = buildTwitterIntentUrl(tweetText);
    const opened = openUrl(url);
    console.log('');
    if (opened) {
      console.log(fmt.green('✓ Opening Twitter...'));
    } else {
      console.log(fmt.yellow('Could not open browser. Copy this URL:'));
      console.log('');
      console.log(fmt.dim(url));
    }
    console.log('');
  }
  // choice === '3' or anything else: silent skip
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a duration string like "48h", "2h", "24h" into seconds.
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 172800; // default: 48h

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 172800;
  }
}

export { runTest };
