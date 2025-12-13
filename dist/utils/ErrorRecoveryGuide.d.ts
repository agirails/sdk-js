/**
 * ErrorRecoveryGuide - Structured Error Classification and Recovery Guidance
 *
 * SECURITY FIX (HIGH-6): Provides comprehensive error recovery documentation
 * to help developers handle errors appropriately and avoid security pitfalls.
 *
 * @module utils/ErrorRecoveryGuide
 */
/**
 * Error severity levels for prioritization
 */
export type ErrorSeverity = 'critical' | 'high' | 'medium' | 'low';
/**
 * Error categories for classification
 */
export type ErrorCategory = 'network' | 'authentication' | 'validation' | 'state' | 'escrow' | 'attestation' | 'permission' | 'timeout' | 'unknown';
/**
 * Structured error recovery information
 */
export interface ErrorRecoveryInfo {
    /** Error category */
    category: ErrorCategory;
    /** Severity level */
    severity: ErrorSeverity;
    /** Human-readable description */
    description: string;
    /** Recovery steps to attempt */
    recoverySteps: string[];
    /** Whether the operation can be safely retried */
    retryable: boolean;
    /** Suggested retry delay in milliseconds (if retryable) */
    retryDelayMs?: number;
    /** Maximum retry attempts (if retryable) */
    maxRetries?: number;
    /** Whether user intervention is required */
    requiresUserAction: boolean;
    /** Security implications to be aware of */
    securityNotes?: string[];
}
/**
 * ErrorRecoveryGuide - Utility for error classification and recovery guidance
 *
 * @example
 * ```typescript
 * try {
 *   await client.beginner.pay({ to: provider, amount: '100' });
 * } catch (error) {
 *   const recovery = ErrorRecoveryGuide.analyze(error);
 *   console.log('Category:', recovery.category);
 *   console.log('Steps:', recovery.recoverySteps.join('\n'));
 *
 *   if (recovery.retryable) {
 *     console.log(`Retrying in ${recovery.retryDelayMs}ms...`);
 *   }
 * }
 * ```
 */
export declare class ErrorRecoveryGuide {
    /**
     * Analyze an error and return recovery guidance
     *
     * @param error - The error to analyze
     * @returns Recovery information with steps and recommendations
     */
    static analyze(error: unknown): ErrorRecoveryInfo;
    /**
     * Get all known error patterns (for documentation/testing)
     */
    static getKnownPatterns(): string[];
    /**
     * Check if an error is retryable
     *
     * @param error - The error to check
     * @returns true if the error can be retried
     */
    static isRetryable(error: unknown): boolean;
    /**
     * Get retry parameters for an error
     *
     * @param error - The error to check
     * @returns Retry parameters or null if not retryable
     */
    static getRetryParams(error: unknown): {
        delayMs: number;
        maxRetries: number;
    } | null;
    /**
     * Check if an error requires user action
     *
     * @param error - The error to check
     * @returns true if user intervention is needed
     */
    static requiresUserAction(error: unknown): boolean;
    /**
     * Get security notes for an error (if any)
     *
     * @param error - The error to check
     * @returns Security notes or undefined
     */
    static getSecurityNotes(error: unknown): string[] | undefined;
    /**
     * Format recovery guidance as a string for logging
     *
     * @param error - The error to analyze
     * @returns Formatted recovery guidance string
     */
    static formatGuidance(error: unknown): string;
}
/**
 * Helper function for try-catch with automatic recovery guidance
 *
 * @example
 * ```typescript
 * const result = await withRecoveryGuidance(
 *   () => client.beginner.pay({ to: provider, amount: '100' }),
 *   { logGuidance: true, autoRetry: true }
 * );
 * ```
 */
export declare function withRecoveryGuidance<T>(operation: () => Promise<T>, options?: {
    logGuidance?: boolean;
    autoRetry?: boolean;
    onError?: (error: unknown, recovery: ErrorRecoveryInfo) => void;
}): Promise<T>;
//# sourceMappingURL=ErrorRecoveryGuide.d.ts.map