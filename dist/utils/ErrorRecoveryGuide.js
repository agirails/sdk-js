"use strict";
/**
 * ErrorRecoveryGuide - Structured Error Classification and Recovery Guidance
 *
 * SECURITY FIX (HIGH-6): Provides comprehensive error recovery documentation
 * to help developers handle errors appropriately and avoid security pitfalls.
 *
 * @module utils/ErrorRecoveryGuide
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorRecoveryGuide = void 0;
exports.withRecoveryGuidance = withRecoveryGuidance;
/**
 * Predefined error patterns and their recovery guidance
 */
const ERROR_PATTERNS = [
    // Network Errors
    {
        pattern: /provider connection lost/i,
        recovery: {
            category: 'network',
            severity: 'high',
            description: 'Lost connection to the blockchain RPC provider',
            recoverySteps: [
                '1. Check your internet connection',
                '2. Verify RPC endpoint is reachable',
                '3. SDK will automatically attempt reconnection with exponential backoff',
                '4. If persistent, try a different RPC provider',
                '5. Check RPC rate limits (may need paid tier)',
            ],
            retryable: true,
            retryDelayMs: 1000,
            maxRetries: 5,
            requiresUserAction: false,
            securityNotes: [
                'Do not expose RPC URLs with API keys in client-side code',
                'Consider using a fallback RPC provider',
            ],
        },
    },
    {
        pattern: /nonce too low/i,
        recovery: {
            category: 'network',
            severity: 'medium',
            description: 'Transaction nonce is out of sync with blockchain',
            recoverySteps: [
                '1. Wait for pending transactions to confirm',
                '2. Reset transaction nonce manually if needed',
                '3. Use getTransactionCount("pending") for accurate nonce',
            ],
            retryable: true,
            retryDelayMs: 5000,
            maxRetries: 3,
            requiresUserAction: false,
        },
    },
    {
        pattern: /replacement transaction underpriced/i,
        recovery: {
            category: 'network',
            severity: 'medium',
            description: 'Transaction fee too low for replacement',
            recoverySteps: [
                '1. Increase gas price by at least 10%',
                '2. Wait for original transaction to be mined',
                '3. Or wait for it to be dropped from mempool',
            ],
            retryable: true,
            retryDelayMs: 10000,
            maxRetries: 2,
            requiresUserAction: true,
        },
    },
    // Authentication Errors
    {
        pattern: /privateKey is required/i,
        recovery: {
            category: 'authentication',
            severity: 'critical',
            description: 'Missing private key for blockchain operations',
            recoverySteps: [
                '1. Provide privateKey in ACTPClient.create() config',
                '2. Use environment variables (process.env.PRIVATE_KEY)',
                '3. NEVER hardcode private keys in source code',
            ],
            retryable: false,
            requiresUserAction: true,
            securityNotes: [
                'Never log or expose private keys',
                'Use hardware wallets in production',
                'Store keys in secure environment variables',
            ],
        },
    },
    {
        pattern: /not initialized.*call initialize/i,
        recovery: {
            category: 'authentication',
            severity: 'high',
            description: 'BlockchainRuntime not properly initialized',
            recoverySteps: [
                '1. Ensure await runtime.initialize() is called after construction',
                '2. Use ACTPClient.create() factory which handles initialization',
                '3. Check for initialization errors in try/catch',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    // Validation Errors
    {
        pattern: /invalid.*address/i,
        recovery: {
            category: 'validation',
            severity: 'medium',
            description: 'Invalid Ethereum address format',
            recoverySteps: [
                '1. Verify address is 0x-prefixed',
                '2. Verify address is 40 hex characters (42 total)',
                '3. Use ethers.isAddress() to validate before passing',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    {
        pattern: /amount must be positive/i,
        recovery: {
            category: 'validation',
            severity: 'medium',
            description: 'Transaction amount must be greater than zero',
            recoverySteps: [
                '1. Verify amount is a positive number',
                '2. Check for unit conversion issues (USDC has 6 decimals)',
                '3. Use parseUnits("100", 6) for 100 USDC',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    {
        pattern: /deadline must be in the future/i,
        recovery: {
            category: 'validation',
            severity: 'medium',
            description: 'Transaction deadline has already passed',
            recoverySteps: [
                '1. Set deadline to a future timestamp',
                '2. Use relative format like "+24h" or "+7d"',
                '3. Account for block time variations',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    // State Errors
    {
        pattern: /invalid state transition/i,
        recovery: {
            category: 'state',
            severity: 'high',
            description: 'Cannot transition from current state to requested state',
            recoverySteps: [
                '1. Check current transaction state with getTransaction()',
                '2. Verify state transition is allowed (see ACTP state machine)',
                '3. Valid transitions: INITIATED->COMMITTED->DELIVERED->SETTLED',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    {
        pattern: /cannot link escrow.*state/i,
        recovery: {
            category: 'state',
            severity: 'high',
            description: 'Escrow can only be linked in INITIATED or QUOTED state',
            recoverySteps: [
                '1. Check transaction state with getTransaction()',
                '2. linkEscrow() only works in INITIATED or QUOTED state',
                '3. Create a new transaction if needed',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    {
        pattern: /unknown transaction state/i,
        recovery: {
            category: 'state',
            severity: 'critical',
            description: 'Contract returned unexpected state value',
            recoverySteps: [
                '1. Check SDK version matches contract version',
                '2. Verify contract address is correct',
                '3. Contact support - may indicate contract upgrade needed',
            ],
            retryable: false,
            requiresUserAction: true,
            securityNotes: [
                'Unknown states may indicate contract tampering',
                'Verify contract address against official deployment',
            ],
        },
    },
    // Escrow Errors
    {
        pattern: /insufficient.*balance/i,
        recovery: {
            category: 'escrow',
            severity: 'high',
            description: 'Insufficient token balance for escrow deposit',
            recoverySteps: [
                '1. Check USDC balance with getBalance()',
                '2. Ensure sufficient USDC to cover amount + gas',
                '3. In mock mode: use mintTokens() to add funds',
                '4. In testnet: get USDC from faucet',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    {
        pattern: /escrow.*not found/i,
        recovery: {
            category: 'escrow',
            severity: 'high',
            description: 'Referenced escrow does not exist',
            recoverySteps: [
                '1. Verify escrowId is correct',
                '2. Check if escrow was already released',
                '3. Use getTransaction() to find linked escrowId',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    // Attestation Errors
    {
        pattern: /attestation.*required.*escrow release/i,
        recovery: {
            category: 'attestation',
            severity: 'critical',
            description: 'Attestation verification required before escrow release',
            recoverySteps: [
                '1. Provider must submit delivery attestation via EAS',
                '2. Pass attestationParams to releaseEscrow()',
                '3. attestationParams: { txId, attestationUID }',
                '4. Verify attestation is not revoked before using',
            ],
            retryable: false,
            requiresUserAction: true,
            securityNotes: [
                'Never release escrow without valid attestation',
                'Attestation prevents fund theft',
            ],
        },
    },
    {
        pattern: /attestation.*already used/i,
        recovery: {
            category: 'attestation',
            severity: 'critical',
            description: 'Attestation has been used for a different transaction',
            recoverySteps: [
                '1. This may indicate a replay attack attempt',
                '2. Verify the attestation belongs to this transaction',
                '3. Provider must create new attestation for this transaction',
            ],
            retryable: false,
            requiresUserAction: true,
            securityNotes: [
                'Attestation replay is a security vulnerability',
                'Each transaction needs unique attestation',
            ],
        },
    },
    {
        pattern: /nonce replay detected/i,
        recovery: {
            category: 'attestation',
            severity: 'critical',
            description: 'Message nonce has been reused (replay attack prevention)',
            recoverySteps: [
                '1. Use NonceManager to generate fresh nonces',
                '2. Nonces must be monotonically increasing per sender',
                '3. Do not reuse nonces from previous messages',
            ],
            retryable: false,
            requiresUserAction: true,
            securityNotes: [
                'Nonce replay is a serious security vulnerability',
                'Indicates potential message replay attack',
            ],
        },
    },
    {
        pattern: /global nonce tracker limit reached/i,
        recovery: {
            category: 'attestation',
            severity: 'high',
            description: 'Nonce tracker memory limit reached (DoS protection)',
            recoverySteps: [
                '1. This may indicate a DoS attack with many sender addresses',
                '2. Clean up old nonce entries if legitimate traffic',
                '3. Increase maxTotalEntries limit if needed',
                '4. Consider using persistent storage for large deployments',
            ],
            retryable: false,
            requiresUserAction: true,
            securityNotes: [
                'Global limit prevents memory exhaustion attacks',
                'Monitor for unusual sender patterns',
            ],
        },
    },
    // Permission Errors
    {
        pattern: /only available in mock mode/i,
        recovery: {
            category: 'permission',
            severity: 'low',
            description: 'Method only available in local development mode',
            recoverySteps: [
                '1. This method (reset/mintTokens) is for testing only',
                '2. In testnet/mainnet, use actual faucets for tokens',
                '3. Consider switching to mock mode for local testing',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    {
        pattern: /cannot pay yourself/i,
        recovery: {
            category: 'permission',
            severity: 'medium',
            description: 'Requester and provider cannot be the same address',
            recoverySteps: [
                '1. Use different addresses for requester and provider',
                '2. Verify provider address is correct',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    // Timeout Errors
    {
        pattern: /deadline.*passed/i,
        recovery: {
            category: 'timeout',
            severity: 'high',
            description: 'Transaction deadline has expired',
            recoverySteps: [
                '1. Transaction can no longer be accepted after deadline',
                '2. Create a new transaction with longer deadline',
                '3. Consider using cancel if still in INITIATED state',
            ],
            retryable: false,
            requiresUserAction: true,
        },
    },
    {
        pattern: /dispute window.*active/i,
        recovery: {
            category: 'timeout',
            severity: 'medium',
            description: 'Cannot finalize during active dispute window',
            recoverySteps: [
                '1. Wait for dispute window to expire',
                '2. Check transaction.completedAt + disputeWindow',
                '3. Default dispute window is 48 hours',
            ],
            retryable: true,
            retryDelayMs: 60000, // Check every minute
            maxRetries: 1000,
            requiresUserAction: false,
        },
    },
];
/**
 * Default recovery info for unclassified errors
 */
const DEFAULT_RECOVERY = {
    category: 'unknown',
    severity: 'medium',
    description: 'An unexpected error occurred',
    recoverySteps: [
        '1. Check error message for specific details',
        '2. Verify all input parameters are correct',
        '3. Check network connectivity',
        '4. Review SDK documentation',
        '5. If persistent, report issue with full error details',
    ],
    retryable: false,
    requiresUserAction: true,
    securityNotes: [
        'Do not include sensitive data in error reports',
        'Never expose private keys or secrets',
    ],
};
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
class ErrorRecoveryGuide {
    /**
     * Analyze an error and return recovery guidance
     *
     * @param error - The error to analyze
     * @returns Recovery information with steps and recommendations
     */
    static analyze(error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Find matching pattern
        for (const pattern of ERROR_PATTERNS) {
            const matches = typeof pattern.pattern === 'string'
                ? errorMessage.toLowerCase().includes(pattern.pattern.toLowerCase())
                : pattern.pattern.test(errorMessage);
            if (matches) {
                return {
                    ...pattern.recovery,
                    description: `${pattern.recovery.description}: ${errorMessage}`,
                };
            }
        }
        // Return default recovery if no pattern matched
        return {
            ...DEFAULT_RECOVERY,
            description: `${DEFAULT_RECOVERY.description}: ${errorMessage}`,
        };
    }
    /**
     * Get all known error patterns (for documentation/testing)
     */
    static getKnownPatterns() {
        return ERROR_PATTERNS.map((p) => typeof p.pattern === 'string' ? p.pattern : p.pattern.source);
    }
    /**
     * Check if an error is retryable
     *
     * @param error - The error to check
     * @returns true if the error can be retried
     */
    static isRetryable(error) {
        const recovery = this.analyze(error);
        return recovery.retryable;
    }
    /**
     * Get retry parameters for an error
     *
     * @param error - The error to check
     * @returns Retry parameters or null if not retryable
     */
    static getRetryParams(error) {
        const recovery = this.analyze(error);
        if (!recovery.retryable) {
            return null;
        }
        return {
            delayMs: recovery.retryDelayMs || 1000,
            maxRetries: recovery.maxRetries || 3,
        };
    }
    /**
     * Check if an error requires user action
     *
     * @param error - The error to check
     * @returns true if user intervention is needed
     */
    static requiresUserAction(error) {
        const recovery = this.analyze(error);
        return recovery.requiresUserAction;
    }
    /**
     * Get security notes for an error (if any)
     *
     * @param error - The error to check
     * @returns Security notes or undefined
     */
    static getSecurityNotes(error) {
        const recovery = this.analyze(error);
        return recovery.securityNotes;
    }
    /**
     * Format recovery guidance as a string for logging
     *
     * @param error - The error to analyze
     * @returns Formatted recovery guidance string
     */
    static formatGuidance(error) {
        const recovery = this.analyze(error);
        let output = `
================================================================================
ERROR RECOVERY GUIDANCE
================================================================================
Category:    ${recovery.category.toUpperCase()}
Severity:    ${recovery.severity.toUpperCase()}
Description: ${recovery.description}

Recovery Steps:
${recovery.recoverySteps.join('\n')}

Retryable:   ${recovery.retryable ? 'Yes' : 'No'}`;
        if (recovery.retryable) {
            output += `
Retry Delay: ${recovery.retryDelayMs || 1000}ms
Max Retries: ${recovery.maxRetries || 3}`;
        }
        output += `
User Action: ${recovery.requiresUserAction ? 'Required' : 'Not Required'}`;
        if (recovery.securityNotes && recovery.securityNotes.length > 0) {
            output += `

Security Notes:
${recovery.securityNotes.map((n) => `  ! ${n}`).join('\n')}`;
        }
        output += '\n================================================================================';
        return output;
    }
}
exports.ErrorRecoveryGuide = ErrorRecoveryGuide;
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
async function withRecoveryGuidance(operation, options = {}) {
    const { logGuidance = false, autoRetry = false, onError } = options;
    let lastError;
    let attempts = 0;
    do {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            const recovery = ErrorRecoveryGuide.analyze(error);
            if (onError) {
                onError(error, recovery);
            }
            if (logGuidance) {
                console.error(ErrorRecoveryGuide.formatGuidance(error));
            }
            if (autoRetry && recovery.retryable) {
                const retryParams = ErrorRecoveryGuide.getRetryParams(error);
                if (retryParams && attempts < retryParams.maxRetries) {
                    attempts++;
                    console.log(`Retrying (${attempts}/${retryParams.maxRetries}) after ${retryParams.delayMs}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, retryParams.delayMs));
                    continue;
                }
            }
            throw error;
        }
    } while (true);
}
//# sourceMappingURL=ErrorRecoveryGuide.js.map