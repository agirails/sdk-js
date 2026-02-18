/**
 * X402Adapter - HTTP 402 Payment Required Protocol (Atomic Payments)
 *
 * Implements the x402 protocol for atomic, instant API payments.
 * NO escrow, NO state machine, NO disputes - just pay and receive.
 *
 * This is fundamentally different from ACTP:
 * - ACTP: escrow → state machine → disputes → explicit release
 * - x402: atomic payment → instant settlement → done
 *
 * Use x402 for:
 * - Simple API calls (pay-per-request)
 * - Instant delivery (response IS the delivery)
 * - Low-value, high-frequency transactions
 *
 * Use ACTP for:
 * - Complex services requiring verification
 * - High-value transactions needing dispute protection
 * - Multi-step deliveries
 *
 * @module adapters/X402Adapter
 */

import { BaseAdapter, ValidationError } from './BaseAdapter';
import { IAdapter, TransactionStatus, AdapterTransactionState } from './IAdapter';
import {
  AdapterMetadata,
  UnifiedPayParams,
  UnifiedPayResult,
} from '../types/adapter';
import {
  X402PaymentHeaders,
  X402_HEADERS,
  X402_PROOF_HEADERS,
  X402Error,
  X402ErrorCode,
  X402Network,
  X402FeeBreakdown,
  isValidX402Network,
} from '../types/x402';

// ============================================================================
// Types
// ============================================================================

/** Type for fetch function (cross-platform compatible) */
export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Transaction-like receipt returned by wallet abstractions.
 *
 * `success` is optional for backward compatibility with legacy transfer fns
 * that only return a hash string.
 */
export interface TransferReceiptLike {
  hash: string;
  success?: boolean;
}

/**
 * Transfer function for atomic payments (legacy direct transfer).
 *
 * @param to - Recipient address
 * @param amount - Amount in USDC wei (string)
 * @returns Transaction hash string OR receipt-like object with hash/success
 */
export type TransferFunction = (to: string, amount: string) => Promise<string | TransferReceiptLike>;

/**
 * Approve function for USDC allowance (used with X402Relay).
 *
 * @param spender - Spender address (relay contract)
 * @param amount - Amount in USDC wei (string)
 * @returns Transaction hash
 */
export type ApproveFunction = (spender: string, amount: string) => Promise<string>;

/**
 * Relay pay function — calls X402Relay.payWithFee().
 *
 * @param provider - Provider address
 * @param grossAmount - Gross USDC amount (string)
 * @param serviceId - Service identifier (bytes32 hex)
 * @returns Transaction hash
 */
export type RelayPayFunction = (provider: string, grossAmount: string, serviceId: string) => Promise<string>;

/** Supported HTTP methods for x402 requests */
export type X402HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Extended payment parameters for x402 with full HTTP support.
 */
export interface X402PayParams extends UnifiedPayParams {
  /** HTTP method (default: GET) */
  method?: X402HttpMethod;

  /** Custom request headers */
  headers?: Record<string, string>;

  /** Request body (string or object, will be JSON.stringify'd if object) */
  body?: string | Record<string, unknown>;

  /** Content-Type header (default: application/json for POST/PUT/PATCH with body) */
  contentType?: string;
}

/**
 * Configuration options for X402Adapter.
 *
 * For fee-enabled payments via X402Relay, provide relayAddress + approveFn + relayPayFn.
 * Without relay config, falls back to legacy direct transfer (no platform fee).
 */
export interface X402AdapterConfig {
  /** Expected network for validation (must match server's X-Payment-Network) */
  expectedNetwork: X402Network;

  /** Transfer function for direct atomic payments (legacy fallback) */
  transferFn: TransferFunction;

  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;

  /** Custom fetch function for testing (default: global fetch) */
  fetchFn?: FetchFunction;

  /** Default headers to include in all requests */
  defaultHeaders?: Record<string, string>;

  // --- X402Relay fee-splitting (optional, recommended) ---

  /** X402Relay contract address for on-chain fee splitting */
  relayAddress?: string;

  /** USDC approve function — required when relayAddress is set */
  approveFn?: ApproveFunction;

  /** Relay payWithFee function — required when relayAddress is set */
  relayPayFn?: RelayPayFunction;

  /** Platform fee in basis points (default: 100 = 1%). Read-only display hint. */
  platformFeeBps?: number;
}

/**
 * Atomic payment record (for getStatus lookups).
 */
interface AtomicPaymentRecord {
  txHash: string;
  provider: string;
  requester: string;
  amount: string;
  timestamp: number;
  endpoint: string;
  feeBreakdown?: X402FeeBreakdown;
}

// ============================================================================
// X402Adapter Implementation
// ============================================================================

/**
 * X402Adapter - Atomic HTTP payment protocol.
 *
 * Key characteristics:
 * - usesEscrow: false (direct payment)
 * - supportsDisputes: false (atomic = final)
 * - settlementMode: 'atomic' (instant)
 * - releaseRequired: false (no escrow to release)
 *
 * @example
 * ```typescript
 * const adapter = new X402Adapter(requesterAddress, {
 *   expectedNetwork: 'base-sepolia',
 *   transferFn: async (to, amount) => {
 *     const tx = await usdcContract.transfer(to, amount);
 *     return tx.hash;
 *   },
 * });
 *
 * const result = await adapter.pay({
 *   to: 'https://api.provider.com/service',
 *   amount: '10', // Hint only, actual amount from 402
 * });
 *
 * // That's it! No release() needed.
 * console.log(result.response?.status); // 200
 * console.log(result.releaseRequired);  // false
 * ```
 */
export class X402Adapter extends BaseAdapter implements IAdapter {
  /**
   * Adapter metadata - atomic, no escrow.
   */
  public readonly metadata: AdapterMetadata = {
    id: 'x402',
    name: 'X402 Atomic Payment Adapter',
    usesEscrow: false,
    supportsDisputes: false,
    requiresIdentity: false,
    settlementMode: 'atomic',
    priority: 70,
  };

  private readonly timeout: number;
  private readonly fetchFn: FetchFunction;
  private readonly defaultHeaders: Record<string, string>;
  private readonly transferFn: TransferFunction;

  /** Local cache of payments for status lookups */
  private readonly payments = new Map<string, AtomicPaymentRecord>();

  /**
   * Creates a new X402Adapter instance.
   *
   * @param requesterAddress - The requester's Ethereum address
   * @param config - X402-specific configuration
   */
  constructor(
    requesterAddress: string,
    private config: X402AdapterConfig
  ) {
    super(requesterAddress);
    this.timeout = config.requestTimeout ?? 30000;
    this.fetchFn = config.fetchFn ?? fetch;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.transferFn = config.transferFn;
  }

  // ==========================================================================
  // IAdapter Implementation
  // ==========================================================================

  /**
   * Check if this adapter can handle the given parameters.
   *
   * X402Adapter handles HTTPS URLs only (security requirement).
   */
  canHandle(params: UnifiedPayParams): boolean {
    if (typeof params.to !== 'string') {
      return false;
    }

    try {
      const url = new URL(params.to);
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Validate parameters before execution.
   */
  validate(params: UnifiedPayParams): void {
    if (!this.canHandle(params)) {
      throw new ValidationError(
        `X402 requires HTTPS URL, got: "${params.to}". ` +
        `HTTP endpoints are not supported for security reasons.`
      );
    }

    const url = new URL(params.to);

    if (url.username || url.password) {
      throw new ValidationError(
        'URL cannot contain embedded credentials (username:password).'
      );
    }
  }

  /**
   * Execute atomic x402 payment flow with full HTTP support.
   *
   * 1. Request endpoint → get 402
   * 2. Parse payment headers
   * 3. Execute atomic USDC transfer
   * 4. Retry with tx hash as proof (same method/headers/body)
   * 5. Return response (settlement complete!)
   *
   * @param params - Payment parameters with optional HTTP method, headers, body
   */
  async pay(params: UnifiedPayParams | X402PayParams): Promise<UnifiedPayResult> {
    this.validate(params);

    const endpoint = params.to;
    const x402Params = params as X402PayParams;
    
    // Extract HTTP options
    const method: X402HttpMethod = x402Params.method ?? 'GET';
    const requestHeaders = x402Params.headers ?? {};
    const requestBody = this.serializeBody(x402Params.body, x402Params.contentType);
    const contentType = x402Params.contentType ?? 
      (x402Params.body && method !== 'GET' ? 'application/json' : undefined);

    // Step 1: Initial request
    const initialResponse = await this.makeRequest(
      endpoint, 
      method, 
      requestHeaders, 
      requestBody,
      contentType
    );

    // Step 2: Check response status
    if (initialResponse.status !== 402) {
      if (initialResponse.ok) {
        return this.createFreeServiceResult(params, initialResponse);
      }
      throw new X402Error(
        `Expected 402 Payment Required, got ${initialResponse.status}`,
        X402ErrorCode.NOT_402_RESPONSE,
        initialResponse
      );
    }

    // Step 3: Parse payment headers
    const paymentHeaders = this.parsePaymentHeaders(initialResponse);

    // Step 4: Validate network
    if (paymentHeaders.network !== this.config.expectedNetwork) {
      throw new X402Error(
        `Network mismatch: expected ${this.config.expectedNetwork}, got ${paymentHeaders.network}`,
        X402ErrorCode.NETWORK_MISMATCH,
        initialResponse
      );
    }

    // Step 5: Validate deadline
    const now = Math.floor(Date.now() / 1000);
    if (paymentHeaders.deadline <= now) {
      throw new X402Error(
        `Payment deadline has passed: ${new Date(paymentHeaders.deadline * 1000).toISOString()}`,
        X402ErrorCode.DEADLINE_PASSED,
        initialResponse
      );
    }

    // Step 6: ATOMIC PAYMENT - via relay (with fee) or direct transfer (legacy)
    const { txHash, feeBreakdown } = await this.executeAtomicPayment(paymentHeaders);

    // Step 7: Retry with proof (same method/headers/body + payment proof)
    const serviceResponse = await this.retryWithProof(
      endpoint,
      txHash,
      method,
      requestHeaders,
      requestBody,
      contentType
    );

    // Step 8: Cache payment record for status lookups
    this.payments.set(txHash, {
      txHash,
      provider: paymentHeaders.paymentAddress.toLowerCase(),
      requester: this.requesterAddress.toLowerCase(),
      amount: paymentHeaders.amount,
      timestamp: now,
      endpoint,
      feeBreakdown,
    });

    // Step 9: Return result - DONE! No release needed.
    return {
      txId: txHash,
      escrowId: null, // No escrow!
      adapter: this.metadata.id,
      state: 'COMMITTED', // Atomic = immediately settled
      success: true,
      amount: this.formatAmount(paymentHeaders.amount),
      response: serviceResponse,
      releaseRequired: false, // KEY DIFFERENCE from ACTP
      provider: paymentHeaders.paymentAddress.toLowerCase(),
      requester: this.requesterAddress.toLowerCase(),
      deadline: new Date(paymentHeaders.deadline * 1000).toISOString(),
      feeBreakdown,
    };
  }

  /**
   * Serialize request body to string.
   */
  private serializeBody(
    body: string | Record<string, unknown> | undefined,
    _contentType?: string
  ): string | undefined {
    if (body === undefined) return undefined;
    if (typeof body === 'string') return body;
    return JSON.stringify(body);
  }

  /**
   * Get payment status by transaction hash.
   *
   * For atomic payments, status is simple:
   * - If tx exists → SETTLED (atomic = instant settlement)
   */
  async getStatus(txId: string): Promise<TransactionStatus> {
    const record = this.payments.get(txId);

    if (!record) {
      throw new Error(`Payment ${txId} not found. X402 payments are atomic and stateless.`);
    }

    return {
      state: 'SETTLED' as AdapterTransactionState,
      canStartWork: false,
      canDeliver: false,
      canRelease: false,
      canDispute: false,
      amount: this.formatAmount(record.amount),
      provider: record.provider,
      requester: record.requester,
    };
  }

  /**
   * Not applicable for atomic payments.
   * @throws {Error} Always - x402 has no lifecycle
   */
  async startWork(_txId: string): Promise<void> {
    throw new Error(
      'X402 is atomic - no lifecycle methods. ' +
      'Payment and delivery happen atomically. Use ACTP for stateful transactions.'
    );
  }

  /**
   * Not applicable for atomic payments.
   * @throws {Error} Always - x402 has no lifecycle
   */
  async deliver(_txId: string, _proof?: string): Promise<void> {
    throw new Error(
      'X402 is atomic - no lifecycle methods. ' +
      'The HTTP response IS the delivery. Use ACTP for stateful transactions.'
    );
  }

  /**
   * Not applicable for atomic payments.
   * @throws {Error} Always - x402 has no escrow
   */
  async release(_escrowId: string, _attestationUID?: string): Promise<void> {
    throw new Error(
      'X402 is atomic - no escrow to release. ' +
      'Payment settled instantly. Use ACTP for escrow-based transactions.'
    );
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Make an HTTP request with full options support.
   *
   * @param url - Request URL
   * @param method - HTTP method
   * @param customHeaders - Custom headers from request params
   * @param body - Request body (optional)
   * @param contentType - Content-Type header (optional)
   * @param proofHeaders - Payment proof headers for retry (optional)
   */
  private async makeRequest(
    url: string,
    method: X402HttpMethod,
    customHeaders: Record<string, string> = {},
    body?: string,
    contentType?: string,
    proofHeaders?: Record<string, string>
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Build headers: defaults + custom + content-type + proof
      const headers = new Headers(this.defaultHeaders);

      // Add custom headers from request
      for (const [key, value] of Object.entries(customHeaders)) {
        headers.set(key, value);
      }

      // Add content-type if provided
      if (contentType) {
        headers.set('Content-Type', contentType);
      }

      // Add proof headers for retry
      if (proofHeaders) {
        for (const [key, value] of Object.entries(proofHeaders)) {
          headers.set(key, value);
        }
      }

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      // Add body for non-GET requests
      if (body && method !== 'GET') {
        init.body = body;
      }

      return await this.fetchFn(url, init);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse X-Payment-* headers from 402 response.
   */
  private parsePaymentHeaders(response: Response): X402PaymentHeaders {
    const h = response.headers;

    const requiredHeader = h.get(X402_HEADERS.REQUIRED);
    if (requiredHeader?.toLowerCase() !== 'true') {
      throw new X402Error(
        `Missing or invalid ${X402_HEADERS.REQUIRED} header`,
        X402ErrorCode.MISSING_HEADERS,
        response
      );
    }

    const address = h.get(X402_HEADERS.ADDRESS);
    const amount = h.get(X402_HEADERS.AMOUNT);
    const network = h.get(X402_HEADERS.NETWORK);
    const token = h.get(X402_HEADERS.TOKEN);
    const deadline = h.get(X402_HEADERS.DEADLINE);

    if (!address) {
      throw new X402Error(`Missing ${X402_HEADERS.ADDRESS}`, X402ErrorCode.MISSING_HEADERS, response);
    }
    if (!amount) {
      throw new X402Error(`Missing ${X402_HEADERS.AMOUNT}`, X402ErrorCode.MISSING_HEADERS, response);
    }
    if (!network) {
      throw new X402Error(`Missing ${X402_HEADERS.NETWORK}`, X402ErrorCode.MISSING_HEADERS, response);
    }
    if (!token) {
      throw new X402Error(`Missing ${X402_HEADERS.TOKEN}`, X402ErrorCode.MISSING_HEADERS, response);
    }
    if (!deadline) {
      throw new X402Error(`Missing ${X402_HEADERS.DEADLINE}`, X402ErrorCode.MISSING_HEADERS, response);
    }

    // Validate address
    const validatedAddress = this.validatePaymentAddress(address, response);

    // Validate amount
    if (!/^\d+$/.test(amount)) {
      throw new X402Error(
        `Invalid ${X402_HEADERS.AMOUNT}: "${amount}"`,
        X402ErrorCode.INVALID_AMOUNT,
        response
      );
    }

    // Validate network
    if (!isValidX402Network(network)) {
      throw new X402Error(
        `Invalid ${X402_HEADERS.NETWORK}: "${network}"`,
        X402ErrorCode.INVALID_NETWORK,
        response
      );
    }

    // Validate token
    if (token.toUpperCase() !== 'USDC') {
      throw new X402Error(
        `Unsupported token: "${token}". Only USDC supported.`,
        X402ErrorCode.MISSING_HEADERS,
        response
      );
    }

    const deadlineNum = parseInt(deadline, 10);
    if (isNaN(deadlineNum) || deadlineNum <= 0) {
      throw new X402Error(
        `Invalid ${X402_HEADERS.DEADLINE}: "${deadline}"`,
        X402ErrorCode.MISSING_HEADERS,
        response
      );
    }

    return {
      required: true,
      paymentAddress: validatedAddress,
      amount,
      network,
      token: 'USDC',
      deadline: deadlineNum,
      serviceId: h.get(X402_HEADERS.SERVICE_ID) ?? undefined,
    };
  }

  /**
   * Validate payment address from header.
   */
  private validatePaymentAddress(address: string, response: Response): string {
    try {
      return this.validateAddress(address, X402_HEADERS.ADDRESS);
    } catch {
      throw new X402Error(
        `Invalid ${X402_HEADERS.ADDRESS}: "${address}"`,
        X402ErrorCode.INVALID_ADDRESS,
        response
      );
    }
  }

  /**
   * Execute atomic payment with fee splitting via X402Relay (if configured),
   * or direct transfer as legacy fallback.
   *
   * Relay flow: approve relay → relay.payWithFee(provider, gross, serviceId)
   * Legacy flow: transferFn(provider, amount) — no fee extraction
   */
  private async executeAtomicPayment(headers: X402PaymentHeaders): Promise<{
    txHash: string;
    feeBreakdown?: X402FeeBreakdown;
  }> {
    try {
      // Relay path: on-chain fee splitting
      if (this.config.relayAddress && this.config.approveFn && this.config.relayPayFn) {
        const grossAmount = headers.amount;
        const feeBps = this.config.platformFeeBps ?? 100;
        const MIN_FEE = 50_000n; // $0.05 USDC

        // Calculate fee: max(gross * bps / 10000, MIN_FEE)
        const grossBig = BigInt(grossAmount);
        const bpsFee = (grossBig * BigInt(feeBps)) / 10_000n;
        const fee = bpsFee > MIN_FEE ? bpsFee : MIN_FEE;
        const providerNet = grossBig - fee;

        // 1. Approve relay for gross amount
        await this.config.approveFn(this.config.relayAddress, grossAmount);

        // 2. Call relay.payWithFee
        const serviceId = headers.serviceId ?? '0x' + '0'.repeat(64);
        const txHash = await this.config.relayPayFn(
          headers.paymentAddress,
          grossAmount,
          serviceId
        );

        return {
          txHash,
          feeBreakdown: {
            grossAmount,
            providerNet: providerNet.toString(),
            platformFee: fee.toString(),
            feeBps,
            estimated: true,
          },
        };
      }

      // Legacy path: direct transfer, no fee
      const transferResult = await this.transferFn(
        headers.paymentAddress,
        headers.amount
      );

      const txHash = typeof transferResult === 'string'
        ? transferResult
        : transferResult.hash;

      const transferSuccess = typeof transferResult === 'string'
        ? true
        : transferResult.success !== false;

      if (!transferSuccess) {
        throw new Error(`transferFn returned unsuccessful receipt for tx ${txHash}`);
      }

      return { txHash };
    } catch (error) {
      throw new X402Error(
        `Atomic payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        X402ErrorCode.PAYMENT_FAILED
      );
    }
  }

  /**
   * Retry request with payment proof (tx hash).
   * Uses the same HTTP method, headers, and body as the original request.
   *
   * @param endpoint - Request URL
   * @param txHash - Payment transaction hash as proof
   * @param method - Original HTTP method
   * @param customHeaders - Original custom headers
   * @param body - Original request body
   * @param contentType - Original content-type
   */
  private async retryWithProof(
    endpoint: string,
    txHash: string,
    method: X402HttpMethod = 'GET',
    customHeaders: Record<string, string> = {},
    body?: string,
    contentType?: string
  ): Promise<Response> {
    // Add payment proof headers
    const proofHeaders: Record<string, string> = {
      [X402_PROOF_HEADERS.TX_ID]: txHash,
      // No escrow ID for atomic payments
    };

    const response = await this.makeRequest(
      endpoint,
      method,
      customHeaders,
      body,
      contentType,
      proofHeaders
    );

    if (!response.ok) {
      throw new X402Error(
        `Retry failed: ${response.status} ${response.statusText}`,
        X402ErrorCode.RETRY_FAILED,
        response
      );
    }

    return response;
  }

  /**
   * Create result for free services (200 on initial request).
   */
  private createFreeServiceResult(
    params: UnifiedPayParams,
    response: Response
  ): UnifiedPayResult {
    return {
      txId: '0x' + '0'.repeat(64),
      escrowId: null,
      adapter: this.metadata.id,
      state: 'COMMITTED',
      success: true,
      amount: '0.00 USDC',
      response,
      releaseRequired: false,
      provider: '0x' + '0'.repeat(40),
      requester: this.requesterAddress.toLowerCase(),
      deadline: new Date(Date.now() + 86400000).toISOString(),
    };
  }
}
