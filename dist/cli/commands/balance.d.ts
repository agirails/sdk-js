/**
 * Balance Command - Check USDC balance
 *
 * Shows the USDC balance for the current user or a specified address.
 *
 * @module cli/commands/balance
 */
import { Command } from 'commander';
import { Output } from '../utils/output';
export declare function createBalanceCommand(): Command;
declare function runBalance(address: string | undefined, output: Output): Promise<void>;
export { runBalance };
//# sourceMappingURL=balance.d.ts.map