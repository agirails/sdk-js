"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorCode = void 0;
exports.createClient = createClient;
exports.mapError = mapError;
exports.isValidTxId = isValidTxId;
exports.formatAddress = formatAddress;
exports.formatTxId = formatTxId;
const os = __importStar(require("os"));
const ACTPClient_1 = require("../../ACTPClient");
const config_1 = require("./config");
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
function sanitizePath(fullPath) {
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
async function createClient(projectRoot = process.cwd()) {
    // Load configuration
    const config = (0, config_1.loadConfig)(projectRoot);
    // Validate config for the mode
    (0, config_1.validateConfigForMode)(config);
    // Build client config
    const clientConfig = {
        mode: config.mode,
        requesterAddress: config.address,
        stateDirectory: projectRoot,
    };
    // Create and return client
    return ACTPClient_1.ACTPClient.create(clientConfig);
}
// ============================================================================
// Error Mapping
// ============================================================================
/**
 * Error codes for CLI errors
 */
exports.ErrorCode = {
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
};
/**
 * Map SDK errors to CLI-friendly structured errors.
 *
 * SECURITY: Sanitizes paths and stack traces to prevent information disclosure.
 */
function mapError(error) {
    const err = error;
    // Sanitize the message to remove full paths
    const rawMessage = err?.message || String(error);
    const message = sanitizePath(rawMessage);
    // Configuration errors
    if (message.includes('not initialized') || message.includes('actp init')) {
        return {
            code: exports.ErrorCode.NOT_INITIALIZED,
            message: 'ACTP not initialized. Run "actp init" first.',
        };
    }
    if (message.includes('Config file corrupted')) {
        return {
            code: exports.ErrorCode.CONFIG_CORRUPTED,
            message: 'Configuration file is corrupted.',
            details: { suggestion: 'Run "actp init --force" to reinitialize.' },
        };
    }
    // Transaction errors (from SDK error classes)
    if (err?.name === 'TransactionNotFoundError' || message.includes('Transaction not found')) {
        const txIdMatch = message.match(/Transaction not found: (0x[a-fA-F0-9]+)/);
        return {
            code: exports.ErrorCode.TX_NOT_FOUND,
            message: 'Transaction not found.',
            details: txIdMatch ? { txId: txIdMatch[1] } : undefined,
        };
    }
    if (err?.name === 'InvalidStateTransitionError' || message.includes('Invalid state transition')) {
        return {
            code: exports.ErrorCode.INVALID_STATE_TRANSITION,
            message: 'Invalid state transition.',
            // SECURITY: Don't expose original message which may contain sensitive info
        };
    }
    if (err?.name === 'InsufficientBalanceError' || message.includes('Insufficient balance')) {
        return {
            code: exports.ErrorCode.INSUFFICIENT_BALANCE,
            message: 'Insufficient balance for this operation.',
            // SECURITY: Don't expose balance details
        };
    }
    if (err?.name === 'DeadlinePassedError' || message.includes('Deadline passed')) {
        return {
            code: exports.ErrorCode.DEADLINE_PASSED,
            message: 'Transaction deadline has passed.',
        };
    }
    if (err?.name === 'DisputeWindowActiveError' || message.includes('Dispute window')) {
        return {
            code: exports.ErrorCode.DISPUTE_WINDOW_ACTIVE,
            message: 'Dispute window is still active.',
            // SECURITY: Don't expose window timing details
        };
    }
    // Validation errors
    if (err?.name === 'ValidationError') {
        if (message.includes('address')) {
            return {
                code: exports.ErrorCode.INVALID_ADDRESS,
                message: sanitizePath(message),
            };
        }
        if (message.includes('amount') || message.includes('Amount')) {
            return {
                code: exports.ErrorCode.INVALID_AMOUNT,
                message: sanitizePath(message),
            };
        }
        if (message.includes('deadline') || message.includes('Deadline')) {
            return {
                code: exports.ErrorCode.INVALID_DEADLINE,
                message: sanitizePath(message),
            };
        }
    }
    // Lock errors
    if (message.includes('lock') || message.includes('ELOCKED')) {
        return {
            code: exports.ErrorCode.FILE_LOCK_ERROR,
            message: 'Could not acquire lock. Another process may be using ACTP.',
            details: { suggestion: 'Wait a moment and try again.' },
        };
    }
    // Default: unknown error
    // SECURITY: Do NOT include stack traces in production - they reveal internal paths
    return {
        code: exports.ErrorCode.UNKNOWN_ERROR,
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
function isValidTxId(txId) {
    return /^0x[a-fA-F0-9]{64}$/.test(txId);
}
/**
 * Format address for display (truncate middle)
 */
function formatAddress(address, length = 10) {
    if (address.length <= length * 2 + 2) {
        return address;
    }
    return `${address.slice(0, length + 2)}...${address.slice(-length)}`;
}
/**
 * Format transaction ID for display (truncate)
 */
function formatTxId(txId, length = 8) {
    return `${txId.slice(0, length + 2)}...`;
}
//# sourceMappingURL=client.js.map