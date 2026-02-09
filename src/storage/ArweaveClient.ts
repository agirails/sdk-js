/**
 * ArweaveClient - Permanent Storage via Irys (AIP-7 §4.3)
 *
 * Provides permanent storage on Arweave via Irys (formerly Bundlr).
 * Used for archiving settled transaction bundles for compliance.
 *
 * Security Features (Post-Audit):
 * - Gateway URL whitelist (SSRF protection)
 * - Download size limits (DoS protection)
 * - Credential sanitization in errors
 * - Retry with exponential backoff
 * - Circuit breaker for gateway health tracking
 *
 * @module storage/ArweaveClient
 *
 * Key Principle: Arweave-First Write Order
 * 1. Write to Arweave FIRST -> Get Arweave TX ID
 * 2. THEN anchor TX ID on-chain
 *
 * @see AIP-7 §4.1 for invariant explanation
 */

import Irys from '@irys/sdk';
import {
  ArweaveUploadError,
  ArweaveDownloadError,
  ArweaveTimeoutError,
  InsufficientBalanceError,
  ValidationError,
  StorageError,
  FileSizeLimitExceededError
} from '../errors';
import {
  ArweaveConfig,
  IrysCurrency,
  IrysNetwork,
  ArchiveBundle,
  ArweaveUploadResult,
  DownloadResult,
  ARCHIVE_BUNDLE_TYPE
} from './types';
import {
  validateArweaveTxId,
  validateGatewayURL,
  sanitizeErrorMessage,
  ALLOWED_ARWEAVE_GATEWAYS
} from '../utils/validation';
import { withRetry, RetryOptions } from '../utils/retry';
import {
  GatewayCircuitBreaker,
} from '../utils/circuitBreaker';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CURRENCY: IrysCurrency = 'base-eth';
const DEFAULT_NETWORK: IrysNetwork = 'mainnet';
const DEFAULT_TIMEOUT = 60000; // 60 seconds
const DEFAULT_MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10MB for archive bundles
const ARWEAVE_GATEWAY = 'https://arweave.net/';

// Minimum funding amount (to avoid dust)
const MIN_FUNDING_AMOUNT = 1000n; // 1000 wei minimum

// ============================================================================
// ArweaveClient Class
// ============================================================================

/**
 * ArweaveClient - Permanent storage on Arweave via Irys
 *
 * Used for:
 * - Archiving settled transaction bundles (compliance)
 * - 7-year retention requirement (Arweave guarantees 200+ years)
 *
 * IMPORTANT: Uses Base ETH for payments (no bridging required)
 *
 * @example
 * ```typescript
 * const client = await ArweaveClient.create({
 *   privateKey: process.env.ARCHIVE_UPLOADER_KEY!,
 *   rpcUrl: process.env.BASE_RPC_URL!
 * });
 *
 * // Check balance
 * const balance = await client.getBalance();
 * console.log('Irys balance:', balance);
 *
 * // Fund if needed
 * if (balance < 10000n) {
 *   await client.fund(100000n);
 * }
 *
 * // Upload archive bundle
 * const result = await client.uploadBundle(archiveBundle);
 * console.log('Arweave TX ID:', result.txId);
 *
 * // Download archive bundle
 * const downloaded = await client.downloadBundle(result.txId);
 * ```
 */
export class ArweaveClient {
  private _irys: Irys | null = null;
  private readonly config: Required<Omit<ArweaveConfig, 'circuitBreaker'>>;
  private readonly maxDownloadSize: number;
  private readonly retryOptions: RetryOptions;
  private readonly circuitBreaker: GatewayCircuitBreaker | null;
  private readonly circuitBreakerEnabled: boolean;
  private initialized = false;

  /**
   * Get initialized Irys instance (throws if not initialized)
   */
  private get irys(): Irys {
    if (!this.initialized || !this._irys) {
      throw new StorageError('operation', 'ArweaveClient not initialized. Call create() first.');
    }
    return this._irys;
  }

  /**
   * Private constructor - use ArweaveClient.create() factory
   */
  private constructor(config: ArweaveConfig) {
    // Validate required config
    if (!config.privateKey) {
      throw new ValidationError('privateKey', 'Private key is required for Arweave uploads');
    }
    if (!config.rpcUrl) {
      throw new ValidationError('rpcUrl', 'RPC URL is required for payment chain');
    }

    // P0-1: Validate default gateway URL against whitelist
    validateGatewayURL(ARWEAVE_GATEWAY, ALLOWED_ARWEAVE_GATEWAYS, 'gatewayUrl');

    this.config = {
      privateKey: config.privateKey,
      rpcUrl: config.rpcUrl,
      currency: config.currency || DEFAULT_CURRENCY,
      network: config.network || DEFAULT_NETWORK,
      timeout: config.timeout || DEFAULT_TIMEOUT
    };

    // P1-1: DoS protection
    this.maxDownloadSize = DEFAULT_MAX_DOWNLOAD_SIZE;

    // P1-2: Default retry options
    this.retryOptions = {
      maxAttempts: 3,
      initialDelayMs: 2000,
      maxDelayMs: 30000,
      backoffMultiplier: 2
    };

    // Circuit breaker for gateway health tracking
    this.circuitBreakerEnabled = config.circuitBreaker?.enabled !== false;
    if (this.circuitBreakerEnabled) {
      this.circuitBreaker = new GatewayCircuitBreaker({
        failureThreshold: config.circuitBreaker?.failureThreshold,
        resetTimeoutMs: config.circuitBreaker?.resetTimeoutMs,
        failureWindowMs: config.circuitBreaker?.failureWindowMs,
        successThreshold: config.circuitBreaker?.successThreshold
      });
    } else {
      this.circuitBreaker = null;
    }
  }

  /**
   * Create and initialize ArweaveClient
   *
   * @param config - Arweave configuration
   * @returns Initialized ArweaveClient
   *
   * @example
   * ```typescript
   * const client = await ArweaveClient.create({
   *   privateKey: process.env.ARCHIVE_UPLOADER_KEY!,
   *   rpcUrl: 'https://mainnet.base.org'
   * });
   * ```
   */
  static async create(config: ArweaveConfig): Promise<ArweaveClient> {
    const client = new ArweaveClient(config);
    await client.initialize();
    return client;
  }

  /**
   * Initialize Irys SDK connection
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this._irys = new Irys({
        network: this.config.network,
        token: this.config.currency,
        key: this.config.privateKey,
        config: {
          providerUrl: this.config.rpcUrl
        }
      });

      // Connect to Irys node
      await this._irys.ready();

      this.initialized = true;
    } catch (error: any) {
      // P0-2: Sanitize error message (may contain credentials)
      throw new StorageError(
        'initialization',
        `Failed to initialize Irys client: ${sanitizeErrorMessage(error)}`,
        { currency: this.config.currency, network: this.config.network }
      );
    }
  }

  // ==========================================================================
  // Funding Methods
  // ==========================================================================

  /**
   * Fund the Irys node (required before uploading)
   *
   * @param amount - Amount to fund in payment currency (wei for ETH)
   * @throws {ValidationError} If amount is invalid
   * @throws {StorageError} If funding fails
   *
   * @example
   * ```typescript
   * // Fund with 0.001 ETH (1e15 wei)
   * await client.fund(1000000000000000n);
   * ```
   */
  async fund(amount: bigint): Promise<void> {
    

    if (amount < MIN_FUNDING_AMOUNT) {
      throw new ValidationError(
        'amount',
        `Funding amount too small. Minimum: ${MIN_FUNDING_AMOUNT} wei`
      );
    }

    try {
      await this.withTimeout(
        this.irys.fund(amount),
        this.config.timeout,
        'fund'
      );
    } catch (error: any) {
      if (error instanceof ArweaveTimeoutError) throw error;

      // P0-2: Sanitize error message (may contain credentials)
      throw new StorageError('funding', `Failed to fund Irys: ${sanitizeErrorMessage(error)}`, {
        amount: amount.toString(),
        currency: this.config.currency
      });
    }
  }

  /**
   * Get current Irys balance
   *
   * @returns Balance in payment currency (wei for ETH)
   *
   * @example
   * ```typescript
   * const balance = await client.getBalance();
   * console.log('Balance:', balance, 'wei');
   * ```
   */
  async getBalance(): Promise<bigint> {
    

    try {
      const balance = await this.irys.getLoadedBalance();
      return BigInt(balance.toString());
    } catch (error: any) {
      // P0-2: Sanitize error message
      throw new StorageError('balance', `Failed to get Irys balance: ${sanitizeErrorMessage(error)}`);
    }
  }

  /**
   * Estimate cost of uploading data
   *
   * @param sizeBytes - Size of data to upload in bytes
   * @returns Cost in payment currency (wei for ETH)
   *
   * @example
   * ```typescript
   * const cost = await client.estimateCost(50 * 1024); // 50KB
   * console.log('Upload cost:', cost, 'wei');
   * ```
   */
  async estimateCost(sizeBytes: number): Promise<bigint> {
    

    if (sizeBytes <= 0) {
      throw new ValidationError('sizeBytes', 'Size must be positive');
    }

    try {
      const price = await this.irys.getPrice(sizeBytes);
      return BigInt(price.toString());
    } catch (error: any) {
      // P0-2: Sanitize error message
      throw new StorageError('estimate', `Failed to estimate cost: ${sanitizeErrorMessage(error)}`, {
        sizeBytes
      });
    }
  }

  // ==========================================================================
  // Upload Methods
  // ==========================================================================

  /**
   * Upload archive bundle to Arweave (permanent storage)
   *
   * IMPORTANT: This is the first step in the archive flow.
   * After getting the TX ID, anchor it on-chain via ArchiveTreasury.anchorArchive()
   *
   * @param bundle - Archive bundle to upload
   * @returns Upload result with Arweave TX ID
   * @throws {InsufficientBalanceError} If Irys balance is too low
   * @throws {ArweaveUploadError} If upload fails
   *
   * @example
   * ```typescript
   * const result = await client.uploadBundle(bundle);
   * console.log('Arweave TX ID:', result.txId);
   *
   * // Then anchor on-chain
   * await archiveTreasury.anchorArchive(bundle.txId, result.txId);
   * ```
   */
  async uploadBundle(bundle: ArchiveBundle): Promise<ArweaveUploadResult> {
    

    // Validate bundle
    this.validateBundle(bundle);

    // Serialize bundle
    const jsonString = JSON.stringify(bundle);
    const buffer = Buffer.from(jsonString, 'utf-8');

    // Check balance
    const cost = await this.estimateCost(buffer.length);
    const balance = await this.getBalance();

    if (balance < cost) {
      throw new InsufficientBalanceError(
        cost.toString(),
        balance.toString(),
        this.config.currency.toUpperCase()
      );
    }

    try {
      // Upload with tags for discoverability
      const tx = await this.withTimeout(
        this.irys.upload(buffer, {
          tags: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Protocol', value: 'AGIRAILS' },
            { name: 'Version', value: bundle.protocolVersion },
            { name: 'Schema', value: bundle.archiveSchemaVersion },
            { name: 'Type', value: bundle.type },
            { name: 'ChainId', value: bundle.chainId.toString() },
            { name: 'TxId', value: bundle.txId }
          ]
        }),
        this.config.timeout,
        'upload'
      );

      return {
        txId: tx.id,
        size: buffer.length,
        uploadedAt: new Date(),
        cost: cost.toString()
      };
    } catch (error: any) {
      if (error instanceof ArweaveTimeoutError) throw error;
      if (error instanceof InsufficientBalanceError) throw error;

      throw new ArweaveUploadError(error.message || 'Upload failed', {
        bundleTxId: bundle.txId,
        size: buffer.length
      });
    }
  }

  /**
   * Upload arbitrary JSON to Arweave
   *
   * For general-purpose permanent storage (not archive bundles).
   *
   * @param data - JSON data to upload
   * @param tags - Optional tags for discoverability
   * @returns Upload result with Arweave TX ID
   */
  async uploadJSON(
    data: unknown,
    tags?: Array<{ name: string; value: string }>
  ): Promise<ArweaveUploadResult> {
    

    const jsonString = JSON.stringify(data);
    const buffer = Buffer.from(jsonString, 'utf-8');

    // Check balance
    const cost = await this.estimateCost(buffer.length);
    const balance = await this.getBalance();

    if (balance < cost) {
      throw new InsufficientBalanceError(
        cost.toString(),
        balance.toString(),
        this.config.currency.toUpperCase()
      );
    }

    try {
      const defaultTags = [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Protocol', value: 'AGIRAILS' }
      ];

      const tx = await this.withTimeout(
        this.irys.upload(buffer, {
          tags: tags ? [...defaultTags, ...tags] : defaultTags
        }),
        this.config.timeout,
        'upload'
      );

      return {
        txId: tx.id,
        size: buffer.length,
        uploadedAt: new Date(),
        cost: cost.toString()
      };
    } catch (error: any) {
      if (error instanceof ArweaveTimeoutError) throw error;
      if (error instanceof InsufficientBalanceError) throw error;

      throw new ArweaveUploadError(error.message || 'JSON upload failed', {
        size: buffer.length
      });
    }
  }

  // ==========================================================================
  // Download Methods
  // ==========================================================================

  /**
   * Download archive bundle from Arweave
   *
   * Security Features:
   * - Size limit enforcement (P1-1: DoS protection)
   * - Retry with exponential backoff (P1-2)
   * - Centralized TX ID validation (P1-3)
   * - Credential sanitization in errors (P0-2)
   *
   * @param txId - Arweave transaction ID
   * @returns Downloaded archive bundle
   * @throws {InvalidArweaveTxIdError} If TX ID format is invalid
   * @throws {FileSizeLimitExceededError} If content exceeds size limit
   * @throws {ArweaveDownloadError} If download fails
   *
   * @example
   * ```typescript
   * const result = await client.downloadBundle('h7Xk2...');
   * console.log('Bundle:', result.data);
   * ```
   */
  async downloadBundle(txId: string): Promise<DownloadResult<ArchiveBundle>> {
    // P1-3: Use centralized TX ID validation
    validateArweaveTxId(txId);

    const url = `${ARWEAVE_GATEWAY}${txId}`;

    // Circuit breaker: check gateway health before attempting download
    if (this.circuitBreaker && !this.circuitBreaker.isHealthy(ARWEAVE_GATEWAY)) {
      const state = this.circuitBreaker.getState(ARWEAVE_GATEWAY);
      const failures = this.circuitBreaker.getFailureCount(ARWEAVE_GATEWAY);
      throw new ArweaveDownloadError(
        txId,
        `Gateway circuit breaker OPEN for ${ARWEAVE_GATEWAY}. ` +
        `State: ${state}, Failures: ${failures}. ` +
        `Please wait for cooldown period before retrying.`
      );
    }

    // P1-2: Wrap in retry logic
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new ArweaveDownloadError(
              txId,
              `HTTP ${response.status}: ${response.statusText}`
            );
          }

          // P1-1: Check Content-Length header before downloading
          const contentLength = response.headers.get('content-length');
          if (contentLength && parseInt(contentLength, 10) > this.maxDownloadSize) {
            throw new FileSizeLimitExceededError(
              parseInt(contentLength, 10),
              this.maxDownloadSize
            );
          }

          // P1-1: Stream response with size limit enforcement
          const reader = response.body?.getReader();
          if (!reader) {
            throw new ArweaveDownloadError(txId, 'No response body');
          }

          const chunks: Uint8Array[] = [];
          let totalSize = 0;

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalSize += value.length;

            // P1-1: Enforce size limit during streaming
            if (totalSize > this.maxDownloadSize) {
              reader.cancel();
              throw new FileSizeLimitExceededError(totalSize, this.maxDownloadSize);
            }

            chunks.push(value);
          }

          // Combine chunks into text
          const decoder = new TextDecoder();
          const text = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') +
            decoder.decode();

          const data = JSON.parse(text) as ArchiveBundle;

          // Validate it's actually an archive bundle
          if (data.type !== ARCHIVE_BUNDLE_TYPE) {
            throw new ArweaveDownloadError(
              txId,
              `Invalid bundle type: ${data.type}. Expected: ${ARCHIVE_BUNDLE_TYPE}`
            );
          }

          // Circuit breaker: record success
          this.circuitBreaker?.recordSuccess(ARWEAVE_GATEWAY);

          return {
            data,
            size: totalSize,
            downloadedAt: new Date()
          };
        } catch (error: any) {
          clearTimeout(timeoutId);

          // Circuit breaker: record failure only for gateway issues (not content errors)
          if (this.isGatewayFailure(error)) {
            this.circuitBreaker?.recordFailure(ARWEAVE_GATEWAY);
          }

          if (error instanceof ArweaveDownloadError) throw error;
          if (error instanceof FileSizeLimitExceededError) throw error;

          if (error.name === 'AbortError') {
            throw new ArweaveTimeoutError('download', this.config.timeout);
          }

          if (error instanceof SyntaxError) {
            throw new ArweaveDownloadError(txId, 'Invalid JSON content');
          }

          // P0-2: Sanitize error message
          throw new ArweaveDownloadError(txId, sanitizeErrorMessage(error));
        }
      },
      this.retryOptions
    );
  }

  /**
   * Download arbitrary JSON from Arweave
   *
   * Security Features:
   * - Size limit enforcement (P1-1: DoS protection)
   * - Retry with exponential backoff (P1-2)
   * - Centralized TX ID validation (P1-3)
   *
   * @param txId - Arweave transaction ID
   * @returns Downloaded JSON data
   */
  async downloadJSON<T = unknown>(txId: string): Promise<DownloadResult<T>> {
    // P1-3: Use centralized TX ID validation
    validateArweaveTxId(txId);

    const url = `${ARWEAVE_GATEWAY}${txId}`;

    // Circuit breaker: check gateway health before attempting download
    if (this.circuitBreaker && !this.circuitBreaker.isHealthy(ARWEAVE_GATEWAY)) {
      const state = this.circuitBreaker.getState(ARWEAVE_GATEWAY);
      const failures = this.circuitBreaker.getFailureCount(ARWEAVE_GATEWAY);
      throw new ArweaveDownloadError(
        txId,
        `Gateway circuit breaker OPEN for ${ARWEAVE_GATEWAY}. ` +
        `State: ${state}, Failures: ${failures}. ` +
        `Please wait for cooldown period before retrying.`
      );
    }

    // P1-2: Wrap in retry logic
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new ArweaveDownloadError(
              txId,
              `HTTP ${response.status}: ${response.statusText}`
            );
          }

          // P1-1: Check Content-Length header before downloading
          const contentLength = response.headers.get('content-length');
          if (contentLength && parseInt(contentLength, 10) > this.maxDownloadSize) {
            throw new FileSizeLimitExceededError(
              parseInt(contentLength, 10),
              this.maxDownloadSize
            );
          }

          // P1-1: Stream response with size limit enforcement
          const reader = response.body?.getReader();
          if (!reader) {
            throw new ArweaveDownloadError(txId, 'No response body');
          }

          const chunks: Uint8Array[] = [];
          let totalSize = 0;

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalSize += value.length;

            // P1-1: Enforce size limit during streaming
            if (totalSize > this.maxDownloadSize) {
              reader.cancel();
              throw new FileSizeLimitExceededError(totalSize, this.maxDownloadSize);
            }

            chunks.push(value);
          }

          // Combine chunks into text
          const decoder = new TextDecoder();
          const text = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') +
            decoder.decode();

          const data = JSON.parse(text) as T;

          // Circuit breaker: record success
          this.circuitBreaker?.recordSuccess(ARWEAVE_GATEWAY);

          return {
            data,
            size: totalSize,
            downloadedAt: new Date()
          };
        } catch (error: any) {
          clearTimeout(timeoutId);

          // Circuit breaker: record failure only for gateway issues (not content errors)
          if (this.isGatewayFailure(error)) {
            this.circuitBreaker?.recordFailure(ARWEAVE_GATEWAY);
          }

          if (error instanceof ArweaveDownloadError) throw error;
          if (error instanceof FileSizeLimitExceededError) throw error;

          if (error.name === 'AbortError') {
            throw new ArweaveTimeoutError('download', this.config.timeout);
          }

          if (error instanceof SyntaxError) {
            throw new ArweaveDownloadError(txId, 'Invalid JSON content');
          }

          // P0-2: Sanitize error message
          throw new ArweaveDownloadError(txId, sanitizeErrorMessage(error));
        }
      },
      this.retryOptions
    );
  }

  /**
   * Check if content exists on Arweave
   *
   * @param txId - Arweave transaction ID
   * @returns True if content exists
   */
  async exists(txId: string): Promise<boolean> {
    // P1-3: Use centralized TX ID validation
    validateArweaveTxId(txId);

    const url = `${ARWEAVE_GATEWAY}${txId}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      return response.ok;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /**
   * Get configured currency
   */
  getCurrency(): IrysCurrency {
    return this.config.currency;
  }

  /**
   * Get configured network
   */
  getNetwork(): IrysNetwork {
    return this.config.network;
  }

  /**
   * Get wallet address
   */
  async getAddress(): Promise<string> {
    
    return this.irys.address;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================


  /**
   * Validate archive bundle structure
   */
  private validateBundle(bundle: ArchiveBundle): void {
    if (!bundle) {
      throw new ValidationError('bundle', 'Archive bundle is required');
    }

    if (bundle.type !== ARCHIVE_BUNDLE_TYPE) {
      throw new ValidationError(
        'bundle.type',
        `Invalid bundle type: ${bundle.type}. Expected: ${ARCHIVE_BUNDLE_TYPE}`
      );
    }

    if (!bundle.txId || !/^0x[a-fA-F0-9]{64}$/.test(bundle.txId)) {
      throw new ValidationError('bundle.txId', 'Invalid transaction ID format');
    }

    if (![8453, 84532].includes(bundle.chainId)) {
      throw new ValidationError(
        'bundle.chainId',
        `Invalid chain ID: ${bundle.chainId}. Expected 8453 or 84532`
      );
    }

    if (!bundle.participants?.requester || !bundle.participants?.provider) {
      throw new ValidationError('bundle.participants', 'Both requester and provider required');
    }

    if (!bundle.references?.requestCID || !bundle.references?.deliveryCID) {
      throw new ValidationError('bundle.references', 'Both requestCID and deliveryCID required');
    }

    if (!bundle.hashes?.requestHash || !bundle.hashes?.deliveryHash || !bundle.hashes?.serviceHash) {
      throw new ValidationError('bundle.hashes', 'All hashes required');
    }

    if (!bundle.settlement) {
      throw new ValidationError('bundle.settlement', 'Settlement info required');
    }
  }

  /**
   * Wrap promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new ArweaveTimeoutError(operation, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  /**
   * Determine if an error represents a gateway failure vs content-specific error
   *
   * Gateway failures (should trigger circuit breaker):
   * - 5xx HTTP errors (server errors)
   * - Network timeouts
   * - Connection refused
   * - DNS resolution failures
   *
   * Content-specific errors (should NOT trigger circuit breaker):
   * - 404 (content not found - not gateway's fault)
   * - 400 (bad request - client's fault)
   * - SyntaxError (invalid JSON - content issue)
   * - Invalid bundle type (content validation failed)
   */
  private isGatewayFailure(error: any): boolean {
    // Network-level errors are always gateway failures
    if (error.name === 'AbortError') return true; // Timeout
    if (error.code === 'ECONNREFUSED') return true;
    if (error.code === 'ENOTFOUND') return true;
    if (error.code === 'ETIMEDOUT') return true;

    // ArweaveTimeoutError is a gateway failure
    if (error instanceof ArweaveTimeoutError) return true;

    // Content-specific errors are NOT gateway failures
    if (error instanceof SyntaxError) return false; // Invalid JSON
    if (error instanceof FileSizeLimitExceededError) return false;

    // Check for HTTP status codes in ArweaveDownloadError
    if (error instanceof ArweaveDownloadError) {
      const message = error.message || '';
      // 5xx errors are gateway failures
      if (/HTTP 5\d{2}/.test(message)) return true;
      // 4xx errors are NOT gateway failures (content/client issues)
      if (/HTTP 4\d{2}/.test(message)) return false;
      // "Invalid bundle type" is content validation failure
      if (message.includes('Invalid bundle type')) return false;
      // "Invalid JSON content" is content error
      if (message.includes('Invalid JSON')) return false;
      // Default: treat unknown ArweaveDownloadError as potential gateway issue
      return true;
    }

    // Generic errors (TypeError, etc.) could be network issues
    return true;
  }

  // ==========================================================================
  // Circuit Breaker Methods
  // ==========================================================================

  /**
   * Get circuit breaker status for Arweave gateway
   *
   * @returns Circuit breaker status or null if disabled
   *
   * @example
   * ```typescript
   * const status = client.getCircuitBreakerStatus();
   * if (status && status.state === 'OPEN') {
   *   console.log('Gateway unhealthy, failures:', status.failures);
   * }
   * ```
   */
  getCircuitBreakerStatus(): { state: string; failures: number } | null {
    if (!this.circuitBreaker) return null;

    return {
      state: this.circuitBreaker.getState(ARWEAVE_GATEWAY),
      failures: this.circuitBreaker.getFailureCount(ARWEAVE_GATEWAY)
    };
  }

  /**
   * Reset circuit breaker for Arweave gateway
   *
   * Use with caution - only reset when you're confident the gateway is healthy.
   * Useful for testing or after manual verification.
   *
   * @example
   * ```typescript
   * client.resetCircuitBreaker();
   * ```
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker?.reset(ARWEAVE_GATEWAY);
  }
}
