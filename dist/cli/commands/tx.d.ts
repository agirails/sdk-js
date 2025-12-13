/**
 * Transaction Commands - tx subcommand group
 *
 * Commands for managing ACTP transactions:
 * - tx create: Create a new transaction (intermediate API)
 * - tx status: Check transaction status
 * - tx list: List all transactions
 * - tx deliver: Mark transaction as delivered
 * - tx settle: Release escrow funds
 * - tx cancel: Cancel a transaction
 *
 * @module cli/commands/tx
 */
import { Command } from 'commander';
export declare function createTxCommand(): Command;
//# sourceMappingURL=tx.d.ts.map