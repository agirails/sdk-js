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
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { resolveIdentityPath, loadConfig } from '../utils/config';
import { parseAgirailsMdV4 } from '../../config/agirailsmdV4';
import { selectTestJob } from '../testjobs';
import { renderReceipt } from './receipt';
import { MockRuntime } from '../../runtime/MockRuntime';

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

async function runTest(output: Output): Promise<void> {
  // Step 1: Resolve identity file
  const identityPath = resolveIdentityPath();
  if (!identityPath) {
    throw new Error(
      'No agent identity file found.\n' +
      'Create a {slug}.md file and run "actp init" first.\n' +
      'Or use an AI assistant with AGIRAILS.md to generate one.'
    );
  }

  const spinner = output.spinner('Running test earning loop...');

  try {
    // Step 2: Parse identity
    const content = fs.readFileSync(identityPath, 'utf-8');
    const config = parseAgirailsMdV4(content);

    // Step 3: Select test job
    const testJob = selectTestJob(config.services);

    output.print(`Testing ${config.name} (${testJob.title})`);

    // Step 4: Run mock earning loop
    const runtime = new MockRuntime();

    // Create synthetic addresses
    const requesterWallet = ethers.Wallet.createRandom();
    const providerAddress = loadConfig().address || ethers.Wallet.createRandom().address;

    // Amount in USDC wei (6 decimals)
    const amountWei = BigInt(Math.round(config.pricing.base * 1_000_000));
    const amountStr = amountWei.toString();

    // Mint balance for requester
    await runtime.mintTokens(requesterWallet.address, amountStr);

    // Step 4a: createTransaction (INITIATED)
    const deadline = runtime.time.now() + 86400; // +24h
    const disputeWindow = parseDuration(config.sla.dispute_window);

    const txId = await runtime.createTransaction({
      provider: providerAddress,
      requester: requesterWallet.address,
      amount: amountStr,
      deadline,
      disputeWindow,
      serviceDescription: testJob.title,
    });

    // Step 4b: linkEscrow (INITIATED → COMMITTED)
    const escrowId = await runtime.linkEscrow(txId, amountStr);

    // Step 4c: transitionState (COMMITTED → IN_PROGRESS)
    await runtime.transitionState(txId, 'IN_PROGRESS');

    // Step 4d: transitionState (IN_PROGRESS → DELIVERED)
    await runtime.transitionState(txId, 'DELIVERED');

    // Step 4e: advanceTime past dispute window
    await runtime.time.advanceTime(disputeWindow + 1);

    // Step 4f: releaseEscrow (DELIVERED → SETTLED)
    await runtime.releaseEscrow(escrowId);

    spinner.stop(true);

    // Step 5: Display receipt
    renderReceipt(
      {
        agent: config.slug,
        service: config.services[0],
        amountWei,
        network: 'mock',
        txId,
      },
      output
    );
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
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
