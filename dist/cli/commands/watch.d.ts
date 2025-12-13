/**
 * Watch Command - Stream transaction state changes
 *
 * Agent-first feature: Real-time monitoring of transaction state.
 * Outputs state changes as they happen, perfect for scripts
 * that need to react to transaction lifecycle events.
 *
 * @module cli/commands/watch
 */
import { Command } from 'commander';
import { Output } from '../utils/output';
export declare function createWatchCommand(): Command;
interface WatchOptions {
    timeout: string;
    interval: string;
    until?: string;
}
declare function runWatch(txId: string, options: WatchOptions, output: Output): Promise<void>;
export { runWatch };
//# sourceMappingURL=watch.d.ts.map