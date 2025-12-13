/**
 * Time Command - Manipulate mock blockchain time
 *
 * Mock mode only feature for testing time-dependent logic:
 * - Deadline expiration
 * - Dispute window progression
 * - Time-based state transitions
 *
 * @module cli/commands/time
 */
import { Command } from 'commander';
export declare function createTimeCommand(): Command;
/**
 * Parse duration string to seconds
 *
 * Supports:
 * - "30s" - 30 seconds
 * - "5m" - 5 minutes
 * - "2h" - 2 hours
 * - "7d" - 7 days
 * - "3600" - raw seconds
 */
declare function parseDuration(duration: string): number;
/**
 * Format seconds as human-readable duration
 */
declare function formatDuration(seconds: number): string;
export { parseDuration, formatDuration };
//# sourceMappingURL=time.d.ts.map