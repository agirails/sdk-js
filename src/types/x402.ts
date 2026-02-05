/**
 * X402 Protocol Types and Constants
 *
 * Defines types for the HTTP 402 Payment Required protocol implementation.
 * X402 enables atomic, instant API payments - NO escrow, NO state machine.
 *
 * Key difference from ACTP:
 * - ACTP: escrow → state machine → disputes → explicit release
 * - x402: atomic payment → instant settlement → done
 *
 * Flow:
 * 1. Client requests protected HTTPS endpoint → gets 402 response
 * 2. Parse X-Payment-* headers (address, amount, network, deadline)
 * 3. Execute atomic USDC transfer to provider (no escrow!)
 * 4. Retry request with tx hash as proof
 * 5. Return response - payment complete, no release needed
 *
 * Use x402 for: Simple API calls, instant delivery, low-value transactions
 * Use ACTP for: Complex services, dispute protection, high-value transactions
 *
 * @module types/x402
 */

// ============================================================================
// X402 Header Constants
// ============================================================================

/**
 * Standard X402 payment headers sent in 402 responses.
 *
 * These headers inform the client how to pay for the requested resource.
 */
export const X402_HEADERS = {
  /** Indicates payment is required (must be "true") */
  REQUIRED: 'x-payment-required',
  /** Provider's wallet address (0x-prefixed) */
  ADDRESS: 'x-payment-address',
  /** Amount in USDC wei (6 decimals) */
  AMOUNT: 'x-payment-amount',
  /** Network identifier (base-mainnet or base-sepolia) */
  NETWORK: 'x-payment-network',
  /** Token type (currently only USDC) */
  TOKEN: 'x-payment-token',
  /** Unix timestamp deadline for payment */
  DEADLINE: 'x-payment-deadline',
  /** Optional: Dispute window in seconds */
  DISPUTE_WINDOW: 'x-dispute-window',
  /** Optional: Service identifier for tracking */
  SERVICE_ID: 'x-service-id',
} as const;

/**
 * Proof headers sent when retrying with payment.
 *
 * After creating an ACTP transaction, the client includes these
 * headers to prove payment was made.
 */
export const X402_PROOF_HEADERS = {
  /** ACTP transaction ID (bytes32 hex) */
  TX_ID: 'x-payment-tx-id',
  /** ACTP escrow ID (bytes32 hex) */
  ESCROW_ID: 'x-payment-escrow-id',
} as const;

// ============================================================================
// X402 Types
// ============================================================================

/** Supported networks for x402 payments */
export type X402Network = 'base-mainnet' | 'base-sepolia';

/** Supported tokens (currently only USDC) */
export type X402Token = 'USDC';

/**
 * Parsed payment headers from HTTP 402 response.
 *
 * Contains all information needed to create an ACTP transaction
 * for the requested resource.
 */
export interface X402PaymentHeaders {
  /** Whether payment is required (always true for valid 402) */
  required: boolean;

  /** Provider's wallet address (0x-prefixed, 42 chars) */
  paymentAddress: string;

  /** Amount in USDC wei (6 decimals, as string) */
  amount: string;

  /** Target network */
  network: X402Network;

  /** Token type */
  token: X402Token;

  /** Unix timestamp deadline for accepting payment */
  deadline: number;

  /** Optional: Dispute window in seconds */
  disputeWindow?: number;

  /** Optional: Service identifier for tracking/debugging */
  serviceId?: string;
}

// ============================================================================
// X402 Error Handling
// ============================================================================

/**
 * Error codes for X402 protocol failures.
 *
 * Used to identify specific error types and enable proper error handling.
 */
export enum X402ErrorCode {
  /** Response status was not 402 */
  NOT_402_RESPONSE = 'NOT_402_RESPONSE',

  /** Required X-Payment-* headers are missing */
  MISSING_HEADERS = 'MISSING_HEADERS',

  /** X-Payment-Amount is invalid (not a number, negative, etc.) */
  INVALID_AMOUNT = 'INVALID_AMOUNT',

  /** X-Payment-Address is not a valid Ethereum address */
  INVALID_ADDRESS = 'INVALID_ADDRESS',

  /** X-Payment-Network is not a recognized network */
  INVALID_NETWORK = 'INVALID_NETWORK',

  /** Server's network doesn't match client's expected network */
  NETWORK_MISMATCH = 'NETWORK_MISMATCH',

  /** Failed to create ACTP transaction or link escrow */
  PAYMENT_FAILED = 'PAYMENT_FAILED',

  /** Retry request with proof headers failed */
  RETRY_FAILED = 'RETRY_FAILED',

  /** X-Payment-Deadline has already passed */
  DEADLINE_PASSED = 'DEADLINE_PASSED',

  /** HTTPS protocol required but HTTP used */
  INSECURE_PROTOCOL = 'INSECURE_PROTOCOL',
}

/**
 * Custom error for X402 protocol failures.
 *
 * Provides structured error information for debugging and error handling.
 *
 * @example
 * ```typescript
 * try {
 *   await x402Adapter.pay({ to: 'https://api.example.com', amount: '10' });
 * } catch (error) {
 *   if (error instanceof X402Error) {
 *     if (error.code === X402ErrorCode.NETWORK_MISMATCH) {
 *       console.error('Wrong network:', error.message);
 *     }
 *   }
 * }
 * ```
 */
export class X402Error extends Error {
  public readonly name = 'X402Error';

  /**
   * Creates a new X402Error.
   *
   * @param message - Human-readable error message
   * @param code - Error code for programmatic handling
   * @param response - Optional HTTP response that triggered the error
   */
  constructor(
    message: string,
    public readonly code: X402ErrorCode,
    public readonly response?: Response
  ) {
    super(message);

    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, X402Error);
    }
  }

  /**
   * Creates a detailed error message with code.
   */
  toString(): string {
    return `X402Error [${this.code}]: ${this.message}`;
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if an error is an X402Error.
 *
 * @param error - Error to check
 * @returns True if error is X402Error
 */
export function isX402Error(error: unknown): error is X402Error {
  return error instanceof X402Error;
}

/**
 * Validates that a network string is a valid X402Network.
 *
 * @param network - Network string to validate
 * @returns True if valid X402Network
 */
export function isValidX402Network(network: string): network is X402Network {
  return network === 'base-mainnet' || network === 'base-sepolia';
}
