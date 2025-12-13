/**
 * Mint Command - Mint test USDC tokens (mock mode only)
 *
 * Useful for testing scenarios where you need to fund accounts.
 *
 * @module cli/commands/mint
 */

import { Command } from 'commander';
import { Output, ExitCode } from '../utils/output';
import { createClient, mapError } from '../utils/client';
import { loadConfig } from '../utils/config';

// ============================================================================
// Command Definition
// ============================================================================

export function createMintCommand(): Command {
  const cmd = new Command('mint')
    .description('Mint test USDC tokens (mock mode only)')
    .argument('<address>', 'Address to mint tokens to')
    .argument('<amount>', 'Amount to mint (in USDC, e.g., "1000")')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (address, amount, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runMint(address, amount, output);
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

async function runMint(
  address: string,
  amount: string,
  output: Output
): Promise<void> {
  // Check we're in mock mode
  const config = loadConfig();
  if (config.mode !== 'mock') {
    throw new Error(
      'Mint command only available in mock mode.\n' +
        'You cannot mint real USDC on testnet/mainnet.'
    );
  }

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(
      `Invalid address format: "${address}"\n` +
        'Expected 0x-prefixed 40-character hex string.'
    );
  }

  // Parse amount (user enters USDC, we convert to wei)
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    throw new Error(
      `Invalid amount: "${amount}"\n` +
        'Expected positive number (e.g., "1000" for 1000 USDC).'
    );
  }

  // Convert to wei (USDC has 6 decimals)
  const amountWei = Math.floor(amountNum * 1_000_000).toString();

  // Create client and mint
  const client = await createClient();
  await client.mintTokens(address.toLowerCase(), amountWei);

  // Get new balance
  const newBalance = await client.getBalance(address.toLowerCase());

  output.result(
    {
      address,
      minted: `${amountNum} USDC`,
      mintedWei: amountWei,
      newBalance: `${formatUsdc(newBalance)} USDC`,
    },
    { quietKey: 'newBalance' }
  );

  output.success(`Minted ${amountNum} USDC to ${address}`);
}

/**
 * Format USDC amount from wei to decimal
 */
function formatUsdc(weiAmount: string): string {
  const amount = BigInt(weiAmount);
  const whole = amount / 1_000_000n;
  const decimal = amount % 1_000_000n;
  const decimalStr = decimal.toString().padStart(6, '0').slice(0, 2);
  const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${wholeFormatted}.${decimalStr}`;
}

export { runMint };
