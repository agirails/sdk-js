"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTimeCommand = createTimeCommand;
exports.parseDuration = parseDuration;
exports.formatDuration = formatDuration;
const commander_1 = require("commander");
const output_1 = require("../utils/output");
const config_1 = require("../utils/config");
const client_1 = require("../utils/client");
// ============================================================================
// Command Definition
// ============================================================================
function createTimeCommand() {
    const cmd = new commander_1.Command('time')
        .description('Manipulate mock blockchain time (mock mode only)');
    cmd.addCommand(createTimeShowCommand());
    cmd.addCommand(createTimeAdvanceCommand());
    cmd.addCommand(createTimeSetCommand());
    return cmd;
}
// ============================================================================
// time show
// ============================================================================
function createTimeShowCommand() {
    return new commander_1.Command('show')
        .description('Show current mock blockchain time')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Output only the timestamp')
        .action(async (options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            validateMockMode();
            const client = await (0, client_1.createClient)();
            const runtime = client.runtime;
            const currentTime = runtime.time.now();
            if (options.quiet) {
                console.log(currentTime);
                return;
            }
            output.result({
                timestamp: currentTime,
                iso: new Date(currentTime * 1000).toISOString(),
                readable: formatRelativeTime(currentTime),
            });
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// time advance
// ============================================================================
function createTimeAdvanceCommand() {
    return new commander_1.Command('advance')
        .description('Advance mock blockchain time')
        .argument('<duration>', 'Duration to advance (e.g., "1h", "30m", "7d", "3600")')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Minimal output')
        .action(async (duration, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            validateMockMode();
            const seconds = parseDuration(duration);
            if (seconds <= 0) {
                throw new Error('Duration must be positive');
            }
            const client = await (0, client_1.createClient)();
            const runtime = client.runtime;
            const beforeTime = runtime.time.now();
            await runtime.time.advanceTime(seconds);
            const afterTime = runtime.time.now();
            output.result({
                advanced: seconds,
                advancedReadable: formatDuration(seconds),
                beforeTimestamp: beforeTime,
                afterTimestamp: afterTime,
                afterIso: new Date(afterTime * 1000).toISOString(),
            });
            output.success(`Advanced time by ${formatDuration(seconds)}`);
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// time set
// ============================================================================
function createTimeSetCommand() {
    return new commander_1.Command('set')
        .description('Set mock blockchain time to specific timestamp')
        .argument('<timestamp>', 'Unix timestamp or ISO date')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Minimal output')
        .action(async (timestamp, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            validateMockMode();
            const targetTime = parseTimestamp(timestamp);
            const client = await (0, client_1.createClient)();
            const runtime = client.runtime;
            const beforeTime = runtime.time.now();
            if (targetTime < beforeTime) {
                throw new Error('Cannot set time in the past.\n' +
                    `Current time: ${beforeTime}\n` +
                    `Target time: ${targetTime}`);
            }
            await runtime.time.setTime(targetTime);
            output.result({
                beforeTimestamp: beforeTime,
                afterTimestamp: targetTime,
                afterIso: new Date(targetTime * 1000).toISOString(),
            });
            output.success(`Set time to ${new Date(targetTime * 1000).toISOString()}`);
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// Helpers
// ============================================================================
/**
 * Validate that we're in mock mode
 */
function validateMockMode() {
    const config = (0, config_1.loadConfig)();
    if (config.mode !== 'mock') {
        throw new Error('Time commands only available in mock mode.\n' +
            `Current mode: ${config.mode}`);
    }
}
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
function parseDuration(duration) {
    // Raw number (seconds)
    if (/^\d+$/.test(duration)) {
        return parseInt(duration, 10);
    }
    // Duration with unit
    const match = duration.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
    if (!match) {
        throw new Error(`Invalid duration format: "${duration}"\n` +
            'Expected format: "30s", "5m", "2h", "7d", or raw seconds');
    }
    const [, valueStr, unit] = match;
    const value = parseFloat(valueStr);
    switch (unit) {
        case 's':
            return Math.floor(value);
        case 'm':
            return Math.floor(value * 60);
        case 'h':
            return Math.floor(value * 3600);
        case 'd':
            return Math.floor(value * 86400);
        default:
            throw new Error(`Unknown unit: ${unit}`);
    }
}
/**
 * Parse timestamp string (Unix timestamp or ISO date)
 */
function parseTimestamp(timestamp) {
    // Unix timestamp (number)
    if (/^\d+$/.test(timestamp)) {
        return parseInt(timestamp, 10);
    }
    // ISO date string
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid timestamp: "${timestamp}"\n` +
            'Expected Unix timestamp or ISO date (e.g., "2025-12-31T23:59:59Z")');
    }
    return Math.floor(date.getTime() / 1000);
}
/**
 * Format seconds as human-readable duration
 */
function formatDuration(seconds) {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
    }
    if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
/**
 * Format timestamp as relative time
 */
function formatRelativeTime(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = timestamp - now;
    if (Math.abs(diff) < 60) {
        return diff >= 0 ? 'just now' : 'just now';
    }
    const absDiff = Math.abs(diff);
    const formatted = formatDuration(absDiff);
    if (diff > 0) {
        return `${formatted} in the future`;
    }
    else {
        return `${formatted} in the past`;
    }
}
//# sourceMappingURL=time.js.map