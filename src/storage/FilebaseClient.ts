/**
 * FilebaseClient - IPFS Storage via Filebase S3 API (AIP-7 §4.2)
 *
 * Provides S3-compatible IPFS pinning via Filebase.
 * Used for hot storage of request metadata and delivery proofs.
 *
 * Security Features (Post-Audit):
 * - Gateway URL whitelist (SSRF protection)
 * - Download size limits (DoS protection)
 * - Credential sanitization in errors
 * - Retry with exponential backoff
 * - Circuit breaker for gateway health tracking
 *
 * @module storage/FilebaseClient
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  StorageError,
  StorageAuthenticationError,
  StorageRateLimitError,
  UploadTimeoutError,
  DownloadTimeoutError,
  ContentNotFoundError,
  FileSizeLimitExceededError,
  ValidationError
} from '../errors';
import {
  FilebaseConfig,
  IPFSUploadResult,
  DownloadResult
} from './types';
import {
  validateCID,
  validateGatewayURL,
  sanitizeErrorMessage,
  ALLOWED_IPFS_GATEWAYS
} from '../utils/validation';
import { withRetry, RetryOptions } from '../utils/retry';
import {
  GatewayCircuitBreaker,
} from '../utils/circuitBreaker';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ENDPOINT = 'https://s3.filebase.com';
const DEFAULT_GATEWAY = 'https://ipfs.filebase.io/ipfs/';
const DEFAULT_BUCKET = 'agirails-storage';
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50MB (P1-1: DoS protection)
const DEFAULT_REGION = 'us-east-1';

// ============================================================================
// FilebaseClient Class
// ============================================================================

/**
 * FilebaseClient - IPFS storage via Filebase S3 API
 *
 * Provides hot storage for:
 * - AIP-1 request metadata
 * - AIP-4 delivery proofs
 * - Service descriptors
 *
 * @example
 * ```typescript
 * const client = new FilebaseClient({
 *   accessKey: process.env.FILEBASE_ACCESS_KEY!,
 *   secretKey: process.env.FILEBASE_SECRET_KEY!,
 *   bucket: 'my-agirails-bucket'
 * });
 *
 * // Upload JSON
 * const result = await client.uploadJSON({ message: 'Hello IPFS!' });
 * console.log('CID:', result.cid);
 *
 * // Download JSON
 * const data = await client.downloadJSON(result.cid);
 * ```
 */
export class FilebaseClient {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly gatewayUrl: string;
  private readonly timeout: number;
  private readonly maxFileSize: number;
  private readonly maxDownloadSize: number;
  private readonly retryOptions: RetryOptions;
  private readonly circuitBreaker: GatewayCircuitBreaker | null;
  private readonly circuitBreakerEnabled: boolean;

  /**
   * Create a new FilebaseClient
   *
   * @param config - Filebase configuration
   * @throws {ValidationError} If required config is missing or gateway URL not whitelisted
   */
  constructor(config: FilebaseConfig) {
    // Validate required config
    if (!config.accessKey) {
      throw new ValidationError('accessKey', 'Filebase access key is required');
    }
    if (!config.secretKey) {
      throw new ValidationError('secretKey', 'Filebase secret key is required');
    }

    // P0-1: Validate gateway URL against whitelist (SSRF protection)
    const gatewayUrl = config.gatewayUrl || DEFAULT_GATEWAY;
    validateGatewayURL(gatewayUrl, ALLOWED_IPFS_GATEWAYS, 'gatewayUrl');

    // Initialize S3 client
    this.s3 = new S3Client({
      endpoint: config.endpoint || DEFAULT_ENDPOINT,
      region: DEFAULT_REGION,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey
      },
      forcePathStyle: true // Required for S3-compatible services
    });

    this.bucket = config.bucket || DEFAULT_BUCKET;
    this.gatewayUrl = gatewayUrl;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxFileSize = config.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this.maxDownloadSize = config.maxDownloadSize || DEFAULT_MAX_DOWNLOAD_SIZE;

    // P1-2: Default retry options
    this.retryOptions = {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
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

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Upload JSON to IPFS via Filebase (automatic pinning)
   *
   * @param data - JSON-serializable data to upload
   * @param options - Upload options
   * @returns Upload result with CID
   * @throws {FileSizeLimitExceededError} If data exceeds max size
   * @throws {StorageAuthenticationError} If credentials are invalid
   * @throws {UploadTimeoutError} If upload times out
   * @throws {StorageError} If upload fails
   *
   * @example
   * ```typescript
   * const result = await client.uploadJSON({
   *   version: '1.0.0',
   *   serviceType: 'text-generation',
   *   inputData: { prompt: 'Hello!' }
   * });
   * console.log('Uploaded to IPFS:', result.cid);
   * ```
   */
  async uploadJSON(
    data: unknown,
    options?: { key?: string; metadata?: Record<string, string> }
  ): Promise<IPFSUploadResult> {
    // Serialize to JSON
    const jsonString = JSON.stringify(data);
    const buffer = Buffer.from(jsonString, 'utf-8');

    // Check file size
    if (buffer.length > this.maxFileSize) {
      throw new FileSizeLimitExceededError(buffer.length, this.maxFileSize);
    }

    // Generate unique key if not provided
    const key = options?.key || this.generateKey('.json');

    try {
      // Upload to Filebase (auto-pins to IPFS)
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/json',
        Metadata: options?.metadata
      });

      const response = await this.withTimeout(
        this.s3.send(command),
        this.timeout,
        'upload'
      );

      // Extract CID from response headers
      // Filebase returns CID in x-amz-meta-cid header
      const cid = (response as any).$metadata?.httpStatusCode === 200
        ? await this.getCIDFromKey(key)
        : undefined;

      if (!cid) {
        throw new StorageError('upload', 'Failed to retrieve CID after upload');
      }

      return {
        cid,
        size: buffer.length,
        uploadedAt: new Date()
      };
    } catch (error: any) {
      // Handle specific errors
      if (error instanceof FileSizeLimitExceededError) throw error;
      if (error instanceof UploadTimeoutError) throw error;

      if (error.name === 'CredentialsProviderError' || error.Code === 'InvalidAccessKeyId') {
        throw new StorageAuthenticationError('Filebase');
      }

      if (error.Code === 'SlowDown' || error.statusCode === 429) {
        const retryAfter = error.$metadata?.httpHeaders?.['retry-after'];
        throw new StorageRateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
      }

      // P0-2: Sanitize error message (may contain AWS credentials)
      throw new StorageError('upload', sanitizeErrorMessage(error), {
        originalError: error.name,
        key
      });
    }
  }

  /**
   * Download JSON from IPFS via gateway
   *
   * Security Features:
   * - Size limit enforcement (P1-1: DoS protection)
   * - Retry with exponential backoff (P1-2)
   * - Centralized CID validation (P1-3)
   * - Credential sanitization in errors (P0-2)
   *
   * @param cid - IPFS CID to download
   * @returns Downloaded and parsed JSON data
   * @throws {InvalidCIDError} If CID format is invalid
   * @throws {ContentNotFoundError} If content not found
   * @throws {FileSizeLimitExceededError} If content exceeds size limit
   * @throws {DownloadTimeoutError} If download times out
   * @throws {StorageError} If download fails
   *
   * @example
   * ```typescript
   * const data = await client.downloadJSON('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
   * console.log('Downloaded:', data);
   * ```
   */
  async downloadJSON<T = unknown>(cid: string): Promise<DownloadResult<T>> {
    // P1-3: Use centralized CID validation
    validateCID(cid);

    const url = `${this.gatewayUrl}${cid}`;

    // Circuit breaker: check gateway health before attempting download
    if (this.circuitBreaker && !this.circuitBreaker.isHealthy(this.gatewayUrl)) {
      const state = this.circuitBreaker.getState(this.gatewayUrl);
      const failures = this.circuitBreaker.getFailureCount(this.gatewayUrl);
      throw new StorageError(
        'download',
        `Gateway circuit breaker OPEN for ${this.gatewayUrl}. ` +
        `State: ${state}, Failures: ${failures}. ` +
        `Please wait for cooldown period before retrying.`,
        { cid, circuitState: state }
      );
    }

    // P1-2: Wrap in retry logic
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'Accept': 'application/json'
            }
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            if (response.status === 404) {
              throw new ContentNotFoundError(cid);
            }
            throw new StorageError('download', `HTTP ${response.status}: ${response.statusText}`, { cid });
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
            throw new StorageError('download', 'No response body', { cid });
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
          if (this.circuitBreaker) {
            this.circuitBreaker.recordSuccess(this.gatewayUrl);
          }

          return {
            data,
            size: totalSize,
            downloadedAt: new Date()
          };
        } catch (error: any) {
          clearTimeout(timeoutId);

          // Circuit breaker: record failure for retryable errors
          // (non-retryable errors like 404 shouldn't count as gateway failures)
          if (this.circuitBreaker && this.isGatewayFailure(error)) {
            this.circuitBreaker.recordFailure(this.gatewayUrl);
          }

          if (error instanceof ContentNotFoundError) throw error;
          if (error instanceof FileSizeLimitExceededError) throw error;

          if (error.name === 'AbortError') {
            throw new DownloadTimeoutError(cid, this.timeout);
          }

          if (error instanceof SyntaxError) {
            throw new StorageError('download', `Invalid JSON content for CID: ${cid}`, { cid });
          }

          // P0-2: Sanitize error message
          throw new StorageError('download', sanitizeErrorMessage(error), {
            cid,
            originalError: error.name
          });
        }
      },
      this.retryOptions
    );
  }

  /**
   * Upload binary data to IPFS
   *
   * @param data - Binary data to upload
   * @param contentType - MIME type of the content
   * @param options - Upload options
   * @returns Upload result with CID
   */
  async uploadBinary(
    data: Buffer | Uint8Array,
    contentType: string,
    options?: { key?: string; metadata?: Record<string, string> }
  ): Promise<IPFSUploadResult> {
    const buffer = Buffer.from(data);

    // Check file size
    if (buffer.length > this.maxFileSize) {
      throw new FileSizeLimitExceededError(buffer.length, this.maxFileSize);
    }

    // Generate key with appropriate extension
    const extension = this.getExtensionFromContentType(contentType);
    const key = options?.key || this.generateKey(extension);

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        Metadata: options?.metadata
      });

      await this.withTimeout(this.s3.send(command), this.timeout, 'upload');

      const cid = await this.getCIDFromKey(key);
      if (!cid) {
        throw new StorageError('upload', 'Failed to retrieve CID after upload');
      }

      return {
        cid,
        size: buffer.length,
        uploadedAt: new Date()
      };
    } catch (error: any) {
      if (error instanceof FileSizeLimitExceededError) throw error;
      if (error instanceof UploadTimeoutError) throw error;
      if (error instanceof StorageError) throw error;

      // P0-2: Sanitize error message (may contain AWS credentials)
      throw new StorageError('upload', sanitizeErrorMessage(error), {
        originalError: error.name,
        key
      });
    }
  }

  /**
   * Download binary data from IPFS
   *
   * Security Features:
   * - Size limit enforcement (P1-1: DoS protection)
   * - Retry with exponential backoff (P1-2)
   * - Centralized CID validation (P1-3)
   *
   * @param cid - IPFS CID to download
   * @returns Downloaded binary data
   */
  async downloadBinary(cid: string): Promise<DownloadResult<Buffer>> {
    // P1-3: Use centralized CID validation
    validateCID(cid);

    const url = `${this.gatewayUrl}${cid}`;

    // Circuit breaker: check gateway health before attempting download
    if (this.circuitBreaker && !this.circuitBreaker.isHealthy(this.gatewayUrl)) {
      const state = this.circuitBreaker.getState(this.gatewayUrl);
      const failures = this.circuitBreaker.getFailureCount(this.gatewayUrl);
      throw new StorageError(
        'download',
        `Gateway circuit breaker OPEN for ${this.gatewayUrl}. ` +
        `State: ${state}, Failures: ${failures}. ` +
        `Please wait for cooldown period before retrying.`,
        { cid, circuitState: state }
      );
    }

    // P1-2: Wrap in retry logic
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(url, { signal: controller.signal });

          clearTimeout(timeoutId);

          if (!response.ok) {
            if (response.status === 404) {
              throw new ContentNotFoundError(cid);
            }
            throw new StorageError('download', `HTTP ${response.status}: ${response.statusText}`, { cid });
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
            throw new StorageError('download', 'No response body', { cid });
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

          // Combine chunks into Buffer
          const buffer = Buffer.concat(chunks);

          // Circuit breaker: record success
          if (this.circuitBreaker) {
            this.circuitBreaker.recordSuccess(this.gatewayUrl);
          }

          return {
            data: buffer,
            size: buffer.length,
            downloadedAt: new Date()
          };
        } catch (error: any) {
          clearTimeout(timeoutId);

          // Circuit breaker: record failure for retryable errors
          if (this.circuitBreaker && this.isGatewayFailure(error)) {
            this.circuitBreaker.recordFailure(this.gatewayUrl);
          }

          if (error instanceof ContentNotFoundError) throw error;
          if (error instanceof FileSizeLimitExceededError) throw error;

          if (error.name === 'AbortError') {
            throw new DownloadTimeoutError(cid, this.timeout);
          }

          // P0-2: Sanitize error message
          throw new StorageError('download', sanitizeErrorMessage(error), {
            cid,
            originalError: error.name
          });
        }
      },
      this.retryOptions
    );
  }

  /**
   * Check if content exists on IPFS
   *
   * @param cid - IPFS CID to check
   * @returns True if content exists
   */
  async exists(cid: string): Promise<boolean> {
    // P1-3: Use centralized CID validation
    validateCID(cid);

    const url = `${this.gatewayUrl}${cid}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

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

  /**
   * Get the bucket name
   */
  getBucket(): string {
    return this.bucket;
  }

  /**
   * Get the gateway URL
   */
  getGatewayUrl(): string {
    return this.gatewayUrl;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Generate unique key for S3 object
   */
  private generateKey(extension: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}-${random}${extension}`;
  }

  /**
   * Get CID from uploaded object via HeadObject
   * Filebase returns CID in x-amz-meta-cid header
   */
  private async getCIDFromKey(key: string): Promise<string | undefined> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key
      });

      const response = await this.s3.send(command);

      // Filebase stores CID in metadata
      return response.Metadata?.cid;
    } catch {
      return undefined;
    }
  }


  /**
   * Get file extension from content type
   */
  private getExtensionFromContentType(contentType: string): string {
    const types: Record<string, string> = {
      'application/json': '.json',
      'text/plain': '.txt',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'application/pdf': '.pdf',
      'application/octet-stream': '.bin'
    };

    return types[contentType] || '.bin';
  }

  /**
   * Wrap promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: 'upload' | 'download'
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        if (operation === 'upload') {
          reject(new UploadTimeoutError(timeoutMs));
        } else {
          reject(new DownloadTimeoutError('unknown', timeoutMs));
        }
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  /**
   * Determine if an error represents a gateway failure
   * (should be counted by circuit breaker)
   *
   * Gateway failures are network/server errors that indicate
   * the gateway is unhealthy. Content-specific errors (404, invalid JSON)
   * are NOT gateway failures.
   *
   * @param error - Error to check
   * @returns true if error is a gateway failure
   */
  private isGatewayFailure(error: unknown): boolean {
    if (!error) return false;

    const e = error as any;

    // 404 Not Found - content doesn't exist, not a gateway failure
    if (error instanceof ContentNotFoundError) return false;

    // File size exceeded - content too large, not a gateway failure
    if (error instanceof FileSizeLimitExceededError) return false;

    // Invalid JSON - content is corrupted, not a gateway failure
    if (error instanceof SyntaxError) return false;

    // Timeout - gateway is slow/unresponsive, IS a failure
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;

    // 5xx server errors - gateway issue
    if (e.status >= 500 && e.status < 600) return true;
    if (e.statusCode >= 500 && e.statusCode < 600) return true;

    // Network errors - gateway unreachable
    const networkErrors = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];
    if (e.code && networkErrors.includes(e.code)) return true;

    // Rate limiting - gateway overloaded
    if (e.status === 429 || e.statusCode === 429) return true;

    // Generic StorageError from network issues or HTTP errors
    if (error instanceof StorageError) {
      const message = e.message?.toLowerCase() || '';
      // Network-related errors
      if (message.includes('timeout') ||
          message.includes('network') ||
          message.includes('connection')) {
        return true;
      }
      // HTTP 5xx errors in message (e.g., "HTTP 500: Internal Server Error")
      if (/http 5\d{2}/.test(message)) {
        return true;
      }
      // HTTP 429 rate limiting in message
      if (/http 429/.test(message)) {
        return true;
      }
    }

    return false;
  }

  // ==========================================================================
  // Circuit Breaker Status (Public API)
  // ==========================================================================

  /**
   * Get circuit breaker status for the gateway
   *
   * @returns Circuit breaker status or null if disabled
   */
  getCircuitBreakerStatus(): {
    enabled: boolean;
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    failures: number;
    isHealthy: boolean;
  } | null {
    if (!this.circuitBreaker) {
      return null;
    }

    return {
      enabled: true,
      state: this.circuitBreaker.getState(this.gatewayUrl),
      failures: this.circuitBreaker.getFailureCount(this.gatewayUrl),
      isHealthy: this.circuitBreaker.isHealthy(this.gatewayUrl)
    };
  }

  /**
   * Reset circuit breaker for the gateway
   * Use this to manually reset after a known temporary outage
   */
  resetCircuitBreaker(): void {
    if (this.circuitBreaker) {
      this.circuitBreaker.reset(this.gatewayUrl);
    }
  }
}
