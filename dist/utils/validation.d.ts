/**
 * Input validation utilities
 */
/**
 * Validate Ethereum address
 */
export declare function validateAddress(address: string, fieldName?: string): void;
/**
 * Validate amount (must be > 0)
 */
export declare function validateAmount(amount: bigint, _fieldName?: string): void;
/**
 * Validate deadline (must be future timestamp)
 */
export declare function validateDeadline(deadline: number, fieldName?: string): void;
/**
 * Validate dispute window (max 30 days per spec)
 */
export declare function validateDisputeWindow(disputeWindow: number, fieldName?: string): void;
/**
 * Validate transaction ID format
 */
export declare function validateTxId(txId: string, fieldName?: string): void;
/**
 * Validate endpoint URL (for AgentRegistry)
 *
 * Security checks:
 * - Valid URL format
 * - HTTPS or IPFS protocols only
 * - No private/local IP addresses (SSRF protection)
 * - Maximum length 256 characters
 */
export declare function validateEndpointURL(endpoint: string, fieldName?: string): void;
//# sourceMappingURL=validation.d.ts.map