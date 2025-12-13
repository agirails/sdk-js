/**
 * Init Command - Initialize ACTP in the current directory
 *
 * Creates .actp/ directory with configuration and initial state.
 * Supports interactive and non-interactive modes.
 *
 * @module cli/commands/init
 */
import { Command } from 'commander';
import { Output } from '../utils/output';
export declare function createInitCommand(): Command;
interface InitOptions {
    mode: string;
    address?: string;
    force?: boolean;
}
declare function runInit(options: InitOptions, output: Output): Promise<void>;
export { runInit };
//# sourceMappingURL=init.d.ts.map