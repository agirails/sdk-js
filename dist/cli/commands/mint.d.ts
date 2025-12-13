/**
 * Mint Command - Mint test USDC tokens (mock mode only)
 *
 * Useful for testing scenarios where you need to fund accounts.
 *
 * @module cli/commands/mint
 */
import { Command } from 'commander';
import { Output } from '../utils/output';
export declare function createMintCommand(): Command;
declare function runMint(address: string, amount: string, output: Output): Promise<void>;
export { runMint };
//# sourceMappingURL=mint.d.ts.map