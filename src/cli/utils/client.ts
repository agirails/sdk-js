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

import * as os from 'os';
import { ACTPClient, ACTPClientConfig } from '../../ACTPClient';
import { loadConfig } from './config';

// ============================================================================
// Security: Path Sanitization
// ============================================================================

/**
 * Sanitize a file path for safe display in error messages.
 *
 * SECURITY: Replaces home directory with ~ to prevent disclosure of:
 * - Full home directory paths
 * - Usernames embedded in paths
 * - System-specific directory structures
 *
 * @param fullPath - The full file path to sanitize
 * @returns Sanitized path safe for display
 */
function sanitizePath(fullPath: string): string {
  const home = os.homedir();
  // Replace home directory with ~ to avoid disclosing username/path
  return fullPath.replace(home, '~');
}

// ============================================================================
// Client Factory
// ============================================================================

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
export async function createClient(
  projectRoot: string = process.cwd()
): Promise<ACTPClient> {
  // Load configuration
  const config = loadConfig(projectRoot);

  // NOTE: We intentionally do NOT call validateConfigForMode() here.
  // ACTPClient.create() handles keystore resolution (AIP-13) and provides
  // proper error messages if no credentials are found. Premature validation
  // would block keystore/env-var-based auth flows.

  // Build client config
  const clientConfig: ACTPClientConfig = {
    mode: config.mode,
    requesterAddress: config.address,
    stateDirectory: projectRoot,
    wallet: config.wallet === 'auto' ? 'auto' : undefined,
  };

  // Create and return client
  return ACTPClient.create(clientConfig);
}

// ============================================================================
// Error Mapping
// ============================================================================

/**
 * Error codes for CLI errors
 */
export const ErrorCode = {
  // Configuration errors
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  CONFIG_CORRUPTED: 'CONFIG_CORRUPTED',
  INVALID_CONFIG: 'INVALID_CONFIG',

  // Input validation errors
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_DEADLINE: 'INVALID_DEADLINE',
  INVALID_TX_ID: 'INVALID_TX_ID',

  // Transaction errors
  TX_NOT_FOUND: 'TX_NOT_FOUND',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  DEADLINE_PASSED: 'DEADLINE_PASSED',
  DISPUTE_WINDOW_ACTIVE: 'DISPUTE_WINDOW_ACTIVE',

  // System errors
  FILE_LOCK_ERROR: 'FILE_LOCK_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

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
export function mapError(error: unknown): StructuredError {
  const err = error as Error;
  // Sanitize the message to remove full paths
  const rawMessage = err?.message || String(error);
  const message = sanitizePath(rawMessage);

  // Configuration errors
  if (message.includes('not initialized') || message.includes('actp init')) {
    return {
      code: ErrorCode.NOT_INITIALIZED,
      message: 'ACTP not initialized. Run "actp init" first.',
    };
  }

  if (message.includes('Config file corrupted')) {
    return {
      code: ErrorCode.CONFIG_CORRUPTED,
      message: 'Configuration file is corrupted.',
      details: { suggestion: 'Run "actp init --force" to reinitialize.' },
    };
  }

  // Transaction errors (from SDK error classes)
  if (err?.name === 'TransactionNotFoundError' || message.includes('Transaction not found')) {
    const txIdMatch = message.match(/Transaction not found: (0x[a-fA-F0-9]+)/);
    return {
      code: ErrorCode.TX_NOT_FOUND,
      message: 'Transaction not found.',
      details: txIdMatch ? { txId: txIdMatch[1] } : undefined,
    };
  }

  if (err?.name === 'InvalidStateTransitionError' || message.includes('Invalid state transition')) {
    return {
      code: ErrorCode.INVALID_STATE_TRANSITION,
      message: 'Invalid state transition.',
      // SECURITY: Don't expose original message which may contain sensitive info
    };
  }

  if (err?.name === 'InsufficientBalanceError' || message.includes('Insufficient balance')) {
    return {
      code: ErrorCode.INSUFFICIENT_BALANCE,
      message: 'Insufficient balance for this operation.',
      // SECURITY: Don't expose balance details
    };
  }

  if (err?.name === 'DeadlinePassedError' || message.includes('Deadline passed')) {
    return {
      code: ErrorCode.DEADLINE_PASSED,
      message: 'Transaction deadline has passed.',
    };
  }

  if (err?.name === 'DisputeWindowActiveError' || message.includes('Dispute window')) {
    return {
      code: ErrorCode.DISPUTE_WINDOW_ACTIVE,
      message: 'Dispute window is still active.',
      // SECURITY: Don't expose window timing details
    };
  }

  // Validation errors
  if (err?.name === 'ValidationError') {
    if (message.includes('address')) {
      return {
        code: ErrorCode.INVALID_ADDRESS,
        message: sanitizePath(message),
      };
    }
    if (message.includes('amount') || message.includes('Amount')) {
      return {
        code: ErrorCode.INVALID_AMOUNT,
        message: sanitizePath(message),
      };
    }
    if (message.includes('deadline') || message.includes('Deadline')) {
      return {
        code: ErrorCode.INVALID_DEADLINE,
        message: sanitizePath(message),
      };
    }
  }

  // Lock errors
  if (message.includes('lock') || message.includes('ELOCKED')) {
    return {
      code: ErrorCode.FILE_LOCK_ERROR,
      message: 'Could not acquire lock. Another process may be using ACTP.',
      details: { suggestion: 'Wait a moment and try again.' },
    };
  }

  // Default: unknown error
  // SECURITY: Do NOT include stack traces in production - they reveal internal paths
  return {
    code: ErrorCode.UNKNOWN_ERROR,
    message: sanitizePath(message) || 'An unknown error occurred.',
    // SECURITY FIX: Stack traces removed to prevent information disclosure
    // In development mode, errors can be logged separately if needed
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Validate transaction ID format
 */
export function isValidTxId(txId: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(txId);
}

/**
 * Format address for display (truncate middle)
 */
export function formatAddress(address: string, length: number = 10): string {
  if (address.length <= length * 2 + 2) {
    return address;
  }
  return `${address.slice(0, length + 2)}...${address.slice(-length)}`;
}

/**
 * Format transaction ID for display (truncate)
 */
export function formatTxId(txId: string, length: number = 8): string {
  return `${txId.slice(0, length + 2)}...`;
}
