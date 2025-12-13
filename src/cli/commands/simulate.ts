/**
 * Simulate Command - Dry-run commands without executing
 *
 * Agent-first feature: Preview what a command would do
 * without actually executing it. Perfect for:
 * - Testing scripts before running on mainnet
 * - Understanding fee calculations
 * - Validating input parameters
 *
 * @module cli/commands/simulate
 */

import { Command } from 'commander';
import { Output, ExitCode, fmt } from '../utils/output';
import { loadConfig } from '../utils/config';
import { mapError } from '../utils/client';
import { BaseAdapter, ValidationError, MIN_AMOUNT_WEI } from '../../adapters/BaseAdapter';

// ============================================================================
// Command Definition
// ============================================================================

export function createSimulateCommand(): Command {
  const cmd = new Command('simulate')
    .description('Dry-run a command without executing (agent-first feature)');

  cmd.addCommand(createSimulatePayCommand());
  cmd.addCommand(createSimulateFeeCommand());

  return cmd;
}

// ============================================================================
// simulate pay
// ============================================================================

function createSimulatePayCommand(): Command {
  return new Command('pay')
    .description('Simulate a payment transaction')
    .argument('<to>', 'Provider address')
    .argument('<amount>', 'Amount to pay')
    .option('-d, --deadline <deadline>', 'Deadline (+24h, +7d, or Unix timestamp)', '+24h')
    .option('--json', 'Output as JSON')
    .action(async (to, amount, options) => {
      const output = new Output(options.json ? 'json' : 'human');

      try {
        await runSimulatePay(to, amount, options, output);
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
        });
        process.exit(ExitCode.ERROR);
      }
    });
}

interface SimulatePayOptions {
  deadline: string;
  json?: boolean;
}

async function runSimulatePay(
  to: string,
  amount: string,
  options: SimulatePayOptions,
  output: Output
): Promise<void> {
  const config = loadConfig();

  // Create a mock adapter just for parsing
  const adapter = new SimulationAdapter(config.address);

  // Validate and parse inputs
  const validation = adapter.validatePayment(to, amount, options.deadline);

  if (!validation.valid) {
    output.result({
      valid: false,
      errors: validation.errors,
    });
    process.exit(ExitCode.INVALID_INPUT);
  }

  // Calculate fee
  const amountWei = validation.parsedAmount!;
  const feeCalculation = calculateFee(amountWei);

  const result = {
    valid: true,
    simulation: {
      action: 'CREATE_AND_FUND_TRANSACTION',
      provider: to.toLowerCase(),
      requester: config.address.toLowerCase(),
      amount: formatUsdc(amountWei.toString()) + ' USDC',
      amountWei: amountWei.toString(),
      deadline: new Date(validation.parsedDeadline! * 1000).toISOString(),
      deadlineUnix: validation.parsedDeadline,
    },
    fees: {
      platformFee: formatUsdc(feeCalculation.fee.toString()) + ' USDC',
      platformFeeWei: feeCalculation.fee.toString(),
      feeRate: feeCalculation.effectiveRate,
      providerReceives: formatUsdc(feeCalculation.providerReceives.toString()) + ' USDC',
      minimumApplied: feeCalculation.minimumApplied,
    },
    requirements: {
      requiredBalance: formatUsdc((amountWei + feeCalculation.fee).toString()) + ' USDC',
      mode: config.mode,
    },
    warnings: validation.warnings,
  };

  if (options.json) {
    output.result(result);
  } else {
    output.section('Simulation Results');
    output.print('');
    output.print(fmt.bold('Transaction Details:'));
    output.keyValue('  Action', 'Create and fund transaction');
    output.keyValue('  Provider', to);
    output.keyValue('  Amount', result.simulation.amount);
    output.keyValue('  Deadline', result.simulation.deadline);
    output.print('');
    output.print(fmt.bold('Fee Breakdown (1% + $0.05 min):'));
    output.keyValue('  Platform Fee', result.fees.platformFee);
    output.keyValue('  Effective Rate', result.fees.feeRate);
    output.keyValue('  Provider Receives', result.fees.providerReceives);
    if (feeCalculation.minimumApplied) {
      output.print(fmt.yellow('  (Minimum fee applied - amount < $5)'));
    }
    output.print('');
    output.print(fmt.bold('Requirements:'));
    output.keyValue('  Required Balance', result.requirements.requiredBalance);
    output.keyValue('  Mode', result.requirements.mode);

    if (validation.warnings && validation.warnings.length > 0) {
      output.print('');
      output.print(fmt.yellow('Warnings:'));
      for (const warning of validation.warnings) {
        output.print(fmt.yellow(`  - ${warning}`));
      }
    }

    output.print('');
    output.success('Simulation complete - no transaction created');
  }
}

// ============================================================================
// simulate fee
// ============================================================================

function createSimulateFeeCommand(): Command {
  return new Command('fee')
    .description('Calculate fee for a given amount')
    .argument('<amount>', 'Amount to calculate fee for')
    .option('--json', 'Output as JSON')
    .action(async (amount, options) => {
      const output = new Output(options.json ? 'json' : 'human');

      try {
        // Parse amount
        const adapter = new SimulationAdapter('0x0000000000000000000000000000000000000000');
        const parsedAmount = adapter.parseAmountPublic(amount);

        const feeCalc = calculateFee(parsedAmount);

        const result = {
          amount: formatUsdc(parsedAmount.toString()) + ' USDC',
          amountWei: parsedAmount.toString(),
          fee: formatUsdc(feeCalc.fee.toString()) + ' USDC',
          feeWei: feeCalc.fee.toString(),
          effectiveRate: feeCalc.effectiveRate,
          providerReceives: formatUsdc(feeCalc.providerReceives.toString()) + ' USDC',
          totalRequired: formatUsdc((parsedAmount + feeCalc.fee).toString()) + ' USDC',
          minimumApplied: feeCalc.minimumApplied,
        };

        if (options.json) {
          output.result(result);
        } else {
          output.section('Fee Calculation');
          output.keyValue('Amount', result.amount);
          output.keyValue('Platform Fee', result.fee);
          output.keyValue('Effective Rate', result.effectiveRate);
          output.keyValue('Provider Receives', result.providerReceives);
          output.keyValue('Total Required', result.totalRequired);
          if (feeCalc.minimumApplied) {
            output.print('');
            output.info('Minimum fee ($0.05) applied because amount < $5');
          }
        }
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
        });
        process.exit(ExitCode.ERROR);
      }
    });
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extended adapter for simulation purposes
 */
class SimulationAdapter extends BaseAdapter {
  constructor(requesterAddress: string) {
    super(requesterAddress);
  }

  /**
   * Validate payment parameters without executing
   */
  validatePayment(
    to: string,
    amount: string | number,
    deadline?: string | number
  ): {
    valid: boolean;
    errors: string[];
    warnings: string[];
    parsedAmount?: bigint;
    parsedDeadline?: number;
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    let parsedAmount: bigint | undefined;
    let parsedDeadline: number | undefined;

    // Validate address
    try {
      this.validateAddress(to, 'to');
    } catch (e) {
      errors.push((e as Error).message);
    }

    // Validate amount
    try {
      parsedAmount = this.parseAmount(amount);

      // Check for small amount warning
      if (parsedAmount < 5_000_000n) {
        // Less than $5
        warnings.push('Amount is below $5 - minimum fee ($0.05) will apply');
      }
    } catch (e) {
      errors.push((e as Error).message);
    }

    // Validate deadline
    try {
      const currentTime = Math.floor(Date.now() / 1000);
      parsedDeadline = this.parseDeadline(deadline, currentTime);

      if (parsedDeadline <= currentTime) {
        errors.push('Deadline must be in the future');
      }

      // Check for short deadline warning
      const hoursUntilDeadline = (parsedDeadline - currentTime) / 3600;
      if (hoursUntilDeadline < 1) {
        warnings.push('Deadline is less than 1 hour from now');
      }
    } catch (e) {
      errors.push((e as Error).message);
    }

    // Check self-payment
    if (to.toLowerCase() === this.requesterAddress.toLowerCase()) {
      errors.push('Cannot pay yourself');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      parsedAmount,
      parsedDeadline,
    };
  }

  /**
   * Public access to parseAmount for fee calculation
   */
  parseAmountPublic(amount: string | number): bigint {
    return this.parseAmount(amount);
  }
}

/**
 * Calculate platform fee based on AGIRAILS fee model:
 * - 1% of transaction amount
 * - $0.05 minimum
 */
function calculateFee(amountWei: bigint): {
  fee: bigint;
  providerReceives: bigint;
  effectiveRate: string;
  minimumApplied: boolean;
} {
  // 1% fee
  const percentFee = amountWei / 100n;

  // $0.05 minimum in wei (6 decimals)
  const minimumFeeWei = 50_000n;

  // Apply minimum
  const fee = percentFee > minimumFeeWei ? percentFee : minimumFeeWei;
  const minimumApplied = percentFee < minimumFeeWei;

  // Calculate what provider receives (amount minus fee)
  const providerReceives = amountWei - fee;

  // Calculate effective rate
  const effectiveRatePercent = (Number(fee) / Number(amountWei)) * 100;
  const effectiveRate = effectiveRatePercent.toFixed(2) + '%';

  return {
    fee,
    providerReceives,
    effectiveRate,
    minimumApplied,
  };
}

/**
 * Format USDC amount from wei to decimal
 */
function formatUsdc(weiAmount: string): string {
  const amount = BigInt(weiAmount);
  const whole = amount / 1_000_000n;
  const decimal = amount % 1_000_000n;
  const decimalStr = decimal.toString().padStart(6, '0').slice(0, 2);
  return `${whole}.${decimalStr}`;
}

export { runSimulatePay, calculateFee };
