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
/**
 * Log levels in order of severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Log entry structure
 */
export interface LogEntry {
    /** Timestamp */
    timestamp: string;
    /** Log level */
    level: LogLevel;
    /** Log message */
    message: string;
    /** Source module/component */
    source?: string;
    /** Additional metadata */
    metadata?: Record<string, unknown>;
    /** Error details (if applicable) */
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
}
/**
 * Logger configuration
 */
export interface LoggerConfig {
    /** Minimum log level to output */
    minLevel?: LogLevel;
    /** Source identifier for this logger */
    source?: string;
    /** Whether to include timestamps */
    timestamps?: boolean;
    /** Whether to filter sensitive data */
    filterSensitive?: boolean;
    /** Custom output handler */
    output?: (entry: LogEntry) => void;
    /** Whether logging is enabled */
    enabled?: boolean;
}
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
export declare class Logger {
    private config;
    constructor(config?: LoggerConfig);
    /**
     * Create child logger with inherited config
     */
    child(source: string): Logger;
    /**
     * Log debug message
     */
    debug(message: string, metadata?: Record<string, unknown>): void;
    /**
     * Log info message
     */
    info(message: string, metadata?: Record<string, unknown>): void;
    /**
     * Log warning message
     */
    warn(message: string, metadata?: Record<string, unknown>): void;
    /**
     * Log error message
     */
    error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
    /**
     * Core logging method
     */
    private log;
    /**
     * Filter sensitive data from metadata
     *
     * SECURITY FIX (NEW-HIGH-3): Uses separate pattern arrays for keys and values.
     * Key patterns have no /g flag (used with .test()).
     * Value patterns are strings converted to fresh RegExp instances per call.
     */
    private filterSensitiveData;
    /**
     * Redact sensitive patterns from a string value
     *
     * SECURITY FIX (NEW-HIGH-3): Creates fresh RegExp instances with /gi flag
     * for each call, avoiding lastIndex state pollution.
     */
    private redactSensitiveValues;
    /**
     * Default console output handler
     */
    private defaultOutput;
    /**
     * Enable logging
     */
    enable(): void;
    /**
     * Disable logging
     */
    disable(): void;
    /**
     * Set minimum log level
     */
    setLevel(level: LogLevel): void;
}
/**
 * Global SDK logger instance
 */
export declare const sdkLogger: Logger;
/**
 * Metrics/monitoring hook interface
 *
 * SECURITY FIX (M-7): Metrics and monitoring hooks
 */
export interface MetricsHook {
    /** Called when a transaction is created */
    onTransactionCreated?: (txId: string, metadata: Record<string, unknown>) => void;
    /** Called when escrow is linked */
    onEscrowLinked?: (txId: string, escrowId: string, amount: string) => void;
    /** Called when state transitions */
    onStateTransition?: (txId: string, fromState: string, toState: string) => void;
    /** Called when escrow is released */
    onEscrowReleased?: (escrowId: string, amount: string) => void;
    /** Called on errors */
    onError?: (error: Error, context: Record<string, unknown>) => void;
    /** Called for performance metrics */
    onPerformance?: (operation: string, durationMs: number, metadata?: Record<string, unknown>) => void;
}
/**
 * Metrics collector for SDK operations
 */
export declare class MetricsCollector {
    private hooks;
    private readonly logger;
    constructor(logger?: Logger);
    /**
     * Register a metrics hook
     */
    addHook(hook: MetricsHook): void;
    /**
     * Remove a metrics hook
     */
    removeHook(hook: MetricsHook): void;
    /**
     * Emit transaction created event
     */
    transactionCreated(txId: string, metadata: Record<string, unknown>): void;
    /**
     * Emit escrow linked event
     */
    escrowLinked(txId: string, escrowId: string, amount: string): void;
    /**
     * Emit state transition event
     */
    stateTransition(txId: string, fromState: string, toState: string): void;
    /**
     * Emit escrow released event
     */
    escrowReleased(escrowId: string, amount: string): void;
    /**
     * Emit error event
     */
    recordError(error: Error, context: Record<string, unknown>): void;
    /**
     * Emit performance metric
     */
    recordPerformance(operation: string, durationMs: number, metadata?: Record<string, unknown>): void;
    /**
     * Helper to time an operation
     */
    timeOperation<T>(operation: string, fn: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T>;
}
/**
 * Global metrics collector instance
 */
export declare const sdkMetrics: MetricsCollector;
//# sourceMappingURL=Logger.d.ts.map