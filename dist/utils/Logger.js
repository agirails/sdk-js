"use strict";
/**
 * Logger - Structured Logging Framework for ACTP SDK
 *
 * SECURITY FIX (M-6): Comprehensive logging with:
 * - Log levels (debug, info, warn, error)
 * - Structured metadata
 * - Sensitive data filtering
 * - Configurable output
 *
 * @module utils/Logger
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sdkMetrics = exports.MetricsCollector = exports.sdkLogger = exports.Logger = void 0;
/**
 * Sensitive key name patterns (for checking object keys)
 *
 * SECURITY FIX (NEW-HIGH-3): NO GLOBAL FLAG on patterns used with .test()
 * Global regex maintains lastIndex state, causing alternating match/no-match
 * on consecutive calls, potentially leaking sensitive data intermittently.
 */
const SENSITIVE_KEY_PATTERNS = [
    /privateKey/i,
    /secret/i,
    /password/i,
    /apiKey/i,
    /authorization/i,
    /mnemonic/i,
    /seed/i,
];
/**
 * Sensitive value patterns (for redacting from string values)
 *
 * SECURITY FIX (NEW-HIGH-3): These are PATTERN STRINGS that get converted
 * to fresh RegExp instances with /g flag for each replace() call.
 * This avoids lastIndex state pollution between calls.
 */
const SENSITIVE_VALUE_PATTERNS = [
    'bearer\\s+[a-zA-Z0-9\\-_.]+', // Bearer tokens
    '0x[a-fA-F0-9]{64}', // Private keys (64 hex chars)
    '0x[a-fA-F0-9]{128}', // Extended private keys
];
/**
 * Log level priority (higher = more severe)
 */
const LOG_LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
/**
 * Structured Logger for ACTP SDK
 *
 * @example
 * ```typescript
 * const logger = new Logger({ source: 'BlockchainRuntime', minLevel: 'info' });
 *
 * logger.info('Transaction created', { txId: '0x...' });
 * logger.error('Transaction failed', { txId: '0x...' }, error);
 * ```
 */
class Logger {
    constructor(config = {}) {
        this.config = {
            minLevel: config.minLevel ?? 'info',
            source: config.source ?? 'ACTP-SDK',
            timestamps: config.timestamps ?? true,
            filterSensitive: config.filterSensitive ?? true,
            output: config.output ?? this.defaultOutput.bind(this),
            enabled: config.enabled ?? true,
        };
    }
    /**
     * Create child logger with inherited config
     */
    child(source) {
        return new Logger({
            ...this.config,
            source: `${this.config.source}:${source}`,
        });
    }
    /**
     * Log debug message
     */
    debug(message, metadata) {
        this.log('debug', message, metadata);
    }
    /**
     * Log info message
     */
    info(message, metadata) {
        this.log('info', message, metadata);
    }
    /**
     * Log warning message
     */
    warn(message, metadata) {
        this.log('warn', message, metadata);
    }
    /**
     * Log error message
     */
    error(message, metadata, error) {
        this.log('error', message, metadata, error);
    }
    /**
     * Core logging method
     */
    log(level, message, metadata, error) {
        if (!this.config.enabled) {
            return;
        }
        // Check log level
        if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) {
            return;
        }
        // Build log entry
        const entry = {
            timestamp: this.config.timestamps ? new Date().toISOString() : '',
            level,
            message,
            source: this.config.source,
        };
        // Add metadata (filtered for sensitive data)
        if (metadata) {
            entry.metadata = this.config.filterSensitive
                ? this.filterSensitiveData(metadata)
                : metadata;
        }
        // Add error details
        if (error) {
            entry.error = {
                name: error.name,
                message: error.message,
                stack: error.stack,
            };
        }
        // Output the log
        this.config.output(entry);
    }
    /**
     * Filter sensitive data from metadata
     *
     * SECURITY FIX (NEW-HIGH-3): Uses separate pattern arrays for keys and values.
     * Key patterns have no /g flag (used with .test()).
     * Value patterns are strings converted to fresh RegExp instances per call.
     */
    filterSensitiveData(obj) {
        const filtered = {};
        for (const [key, value] of Object.entries(obj)) {
            // SECURITY FIX (NEW-HIGH-3): Check if key matches sensitive pattern
            // Using patterns without /g flag - safe to use with .test()
            const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
            if (isSensitiveKey) {
                filtered[key] = '[REDACTED]';
                continue;
            }
            // Recursively filter nested objects
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                filtered[key] = this.filterSensitiveData(value);
            }
            else if (Array.isArray(value)) {
                // SECURITY FIX: Also filter arrays
                filtered[key] = value.map((item) => {
                    if (typeof item === 'string') {
                        return this.redactSensitiveValues(item);
                    }
                    else if (item && typeof item === 'object') {
                        return this.filterSensitiveData(item);
                    }
                    return item;
                });
            }
            else if (typeof value === 'string') {
                // SECURITY FIX (NEW-HIGH-3): Redact sensitive patterns from values
                filtered[key] = this.redactSensitiveValues(value);
            }
            else {
                filtered[key] = value;
            }
        }
        return filtered;
    }
    /**
     * Redact sensitive patterns from a string value
     *
     * SECURITY FIX (NEW-HIGH-3): Creates fresh RegExp instances with /gi flag
     * for each call, avoiding lastIndex state pollution.
     */
    redactSensitiveValues(value) {
        let result = value;
        for (const patternStr of SENSITIVE_VALUE_PATTERNS) {
            // Create fresh RegExp instance with global+case-insensitive flags
            // This avoids lastIndex state issues from reusing regex instances
            const pattern = new RegExp(patternStr, 'gi');
            result = result.replace(pattern, '[REDACTED]');
        }
        return result;
    }
    /**
     * Default console output handler
     */
    defaultOutput(entry) {
        const prefix = entry.timestamp ? `[${entry.timestamp}] ` : '';
        const source = entry.source ? `[${entry.source}] ` : '';
        const levelStr = entry.level.toUpperCase().padEnd(5);
        const baseMessage = `${prefix}${levelStr} ${source}${entry.message}`;
        switch (entry.level) {
            case 'debug':
                console.debug(baseMessage, entry.metadata || '');
                break;
            case 'info':
                console.info(baseMessage, entry.metadata || '');
                break;
            case 'warn':
                console.warn(baseMessage, entry.metadata || '');
                break;
            case 'error':
                console.error(baseMessage, entry.metadata || '', entry.error || '');
                break;
        }
    }
    /**
     * Enable logging
     */
    enable() {
        this.config.enabled = true;
    }
    /**
     * Disable logging
     */
    disable() {
        this.config.enabled = false;
    }
    /**
     * Set minimum log level
     */
    setLevel(level) {
        this.config.minLevel = level;
    }
}
exports.Logger = Logger;
/**
 * Global SDK logger instance
 */
exports.sdkLogger = new Logger({
    source: 'ACTP-SDK',
    minLevel: process.env.ACTP_LOG_LEVEL || 'info',
    enabled: process.env.ACTP_LOGGING !== 'false',
});
/**
 * Metrics collector for SDK operations
 */
class MetricsCollector {
    constructor(logger) {
        this.hooks = [];
        this.logger = logger ?? exports.sdkLogger.child('Metrics');
    }
    /**
     * Register a metrics hook
     */
    addHook(hook) {
        this.hooks.push(hook);
    }
    /**
     * Remove a metrics hook
     */
    removeHook(hook) {
        const index = this.hooks.indexOf(hook);
        if (index > -1) {
            this.hooks.splice(index, 1);
        }
    }
    /**
     * Emit transaction created event
     */
    transactionCreated(txId, metadata) {
        this.logger.info('Transaction created', { txId, ...metadata });
        for (const hook of this.hooks) {
            try {
                hook.onTransactionCreated?.(txId, metadata);
            }
            catch (error) {
                this.logger.error('Metrics hook error', { hook: 'onTransactionCreated' }, error);
            }
        }
    }
    /**
     * Emit escrow linked event
     */
    escrowLinked(txId, escrowId, amount) {
        this.logger.info('Escrow linked', { txId, escrowId, amount });
        for (const hook of this.hooks) {
            try {
                hook.onEscrowLinked?.(txId, escrowId, amount);
            }
            catch (error) {
                this.logger.error('Metrics hook error', { hook: 'onEscrowLinked' }, error);
            }
        }
    }
    /**
     * Emit state transition event
     */
    stateTransition(txId, fromState, toState) {
        this.logger.info('State transition', { txId, fromState, toState });
        for (const hook of this.hooks) {
            try {
                hook.onStateTransition?.(txId, fromState, toState);
            }
            catch (error) {
                this.logger.error('Metrics hook error', { hook: 'onStateTransition' }, error);
            }
        }
    }
    /**
     * Emit escrow released event
     */
    escrowReleased(escrowId, amount) {
        this.logger.info('Escrow released', { escrowId, amount });
        for (const hook of this.hooks) {
            try {
                hook.onEscrowReleased?.(escrowId, amount);
            }
            catch (error) {
                this.logger.error('Metrics hook error', { hook: 'onEscrowReleased' }, error);
            }
        }
    }
    /**
     * Emit error event
     */
    recordError(error, context) {
        this.logger.error('Error recorded', context, error);
        for (const hook of this.hooks) {
            try {
                hook.onError?.(error, context);
            }
            catch (hookError) {
                this.logger.error('Metrics hook error', { hook: 'onError' }, hookError);
            }
        }
    }
    /**
     * Emit performance metric
     */
    recordPerformance(operation, durationMs, metadata) {
        this.logger.debug('Performance', { operation, durationMs, ...metadata });
        for (const hook of this.hooks) {
            try {
                hook.onPerformance?.(operation, durationMs, metadata);
            }
            catch (error) {
                this.logger.error('Metrics hook error', { hook: 'onPerformance' }, error);
            }
        }
    }
    /**
     * Helper to time an operation
     */
    async timeOperation(operation, fn, metadata) {
        const startTime = Date.now();
        try {
            const result = await fn();
            const durationMs = Date.now() - startTime;
            this.recordPerformance(operation, durationMs, { ...metadata, success: true });
            return result;
        }
        catch (error) {
            const durationMs = Date.now() - startTime;
            this.recordPerformance(operation, durationMs, { ...metadata, success: false });
            throw error;
        }
    }
}
exports.MetricsCollector = MetricsCollector;
/**
 * Global metrics collector instance
 */
exports.sdkMetrics = new MetricsCollector();
//# sourceMappingURL=Logger.js.map