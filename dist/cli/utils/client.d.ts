/**
 * SDK Client Factory for CLI
 *
 * Creates and manages ACTPClient instances based on CLI configuration.
 * Handles mode-specific initialization and error mapping.
 *
 * SECURITY: Error messages are sanitized to prevent information disclosure.
 *
 * @module cli/utils/client
 */
import { ACTPClient } from '../../ACTPClient';
/**
 * Create an ACTPClient instance from CLI configuration
 *
 * Reads configuration from .actp/config.json and creates
 * an appropriate client instance for the configured mode.
 *
 * @param projectRoot - Project root directory (defaults to cwd)
 * @returns Initialized ACTPClient
 * @throws Error if config invalid or client creation fails
 */
export declare function createClient(projectRoot?: string): Promise<ACTPClient>;
/**
 * Error codes for CLI errors
 */
export declare const ErrorCode: {
    readonly NOT_INITIALIZED: "NOT_INITIALIZED";
    readonly CONFIG_CORRUPTED: "CONFIG_CORRUPTED";
    readonly INVALID_CONFIG: "INVALID_CONFIG";
    readonly INVALID_ADDRESS: "INVALID_ADDRESS";
    readonly INVALID_AMOUNT: "INVALID_AMOUNT";
    readonly INVALID_DEADLINE: "INVALID_DEADLINE";
    readonly INVALID_TX_ID: "INVALID_TX_ID";
    readonly TX_NOT_FOUND: "TX_NOT_FOUND";
    readonly INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION";
    readonly INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE";
    readonly DEADLINE_PASSED: "DEADLINE_PASSED";
    readonly DISPUTE_WINDOW_ACTIVE: "DISPUTE_WINDOW_ACTIVE";
    readonly FILE_LOCK_ERROR: "FILE_LOCK_ERROR";
    readonly NETWORK_ERROR: "NETWORK_ERROR";
    readonly UNKNOWN_ERROR: "UNKNOWN_ERROR";
};
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
/**
 * Structured CLI error with code and details
 */
export interface StructuredError {
    code: ErrorCodeValue;
    message: string;
    details?: Record<string, unknown>;
}
/**
 * Map SDK errors to CLI-friendly structured errors.
 *
 * SECURITY: Sanitizes paths and stack traces to prevent information disclosure.
 */
export declare function mapError(error: unknown): StructuredError;
/**
 * Validate transaction ID format
 */
export declare function isValidTxId(txId: string): boolean;
/**
 * Format address for display (truncate middle)
 */
export declare function formatAddress(address: string, length?: number): string;
/**
 * Format transaction ID for display (truncate)
 */
export declare function formatTxId(txId: string, length?: number): string;
//# sourceMappingURL=client.d.ts.map