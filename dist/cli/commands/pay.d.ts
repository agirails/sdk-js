/**
 * Pay Command - One-liner payment command (beginner API)
 *
 * The simplest way to create a payment transaction.
 * Creates transaction, links escrow, and returns immediately.
 *
 * @module cli/commands/pay
 */
import { Command } from 'commander';
import { Output } from '../utils/output';
export declare function createPayCommand(): Command;
interface PayOptions {
    deadline: string;
    disputeWindow: string;
}
declare function runPay(to: string, amount: string, options: PayOptions, output: Output): Promise<void>;
export { runPay };
//# sourceMappingURL=pay.d.ts.map