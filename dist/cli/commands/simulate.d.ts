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
import { Output } from '../utils/output';
export declare function createSimulateCommand(): Command;
interface SimulatePayOptions {
    deadline: string;
    json?: boolean;
}
declare function runSimulatePay(to: string, amount: string, options: SimulatePayOptions, output: Output): Promise<void>;
/**
 * Calculate platform fee based on AGIRAILS fee model:
 * - 1% of transaction amount
 * - $0.05 minimum
 */
declare function calculateFee(amountWei: bigint): {
    fee: bigint;
    providerReceives: bigint;
    effectiveRate: string;
    minimumApplied: boolean;
};
export { runSimulatePay, calculateFee };
//# sourceMappingURL=simulate.d.ts.map