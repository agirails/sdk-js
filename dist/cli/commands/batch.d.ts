/**
 * Batch Command - Execute multiple commands from a file
 *
 * Agent-first feature: Process commands in bulk.
 * Perfect for:
 * - Scripted workflows
 * - Replaying transaction sequences
 * - Automated testing
 *
 * Security: Commands are validated against an allowlist and arguments
 * are passed as an array to avoid shell injection attacks.
 *
 * @module cli/commands/batch
 */
import { Command } from 'commander';
import { Output } from '../utils/output';
export declare function createBatchCommand(): Command;
interface BatchOptions {
    dryRun?: boolean;
    stopOnError?: boolean;
}
declare function runBatch(file: string | undefined, options: BatchOptions, output: Output): Promise<void>;
export { runBatch };
//# sourceMappingURL=batch.d.ts.map