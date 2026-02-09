/**
 * BundlerClient — JSON-RPC client for ERC-4337 bundlers.
 *
 * Supports Coinbase (primary) and Pimlico (backup) bundlers.
 * Handles gas estimation, UserOp submission, and receipt polling.
 * Retry with exponential backoff on transient failures.
 *
 * @module wallet/aa/BundlerClient
 */

import { UserOperationV06 } from './constants';
import { serializeUserOp } from './UserOpBuilder';
import { ENTRYPOINT_V06 } from './constants';
import { sdkLogger } from '../../utils/Logger';

// ============================================================================
// Types
// ============================================================================

export interface BundlerConfig {
  /** Primary bundler URL (Coinbase CDP) */
  primaryUrl: string;
  /** Backup bundler URL (Pimlico) */
  backupUrl?: string;
  /** Max retry attempts per endpoint */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms) */
  baseDelayMs?: number;
  /** Timeout for individual requests (ms) */
  timeoutMs?: number;
}

export interface UserOpReceipt {
  /** UserOp hash */
  userOpHash: string;
  /** Transaction hash on-chain */
  transactionHash: string;
  /** Block number */
  blockNumber: number;
  /** Whether the UserOp execution succeeded */
  success: boolean;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================================================
// BundlerClient
// ============================================================================

export class BundlerClient {
  private readonly primaryUrl: string;
  private readonly backupUrl: string | undefined;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private requestId = 1;

  constructor(config: BundlerConfig) {
    this.primaryUrl = config.primaryUrl;
    this.backupUrl = config.backupUrl;
    this.maxRetries = config.maxRetries ?? 2;
    this.baseDelayMs = config.baseDelayMs ?? 1000;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /**
   * Estimate gas for a UserOp.
   */
  async estimateUserOperationGas(
    userOp: UserOperationV06
  ): Promise<{ callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint }> {
    const result = await this.callWithFallback<{
      callGasLimit: string;
      verificationGasLimit: string;
      preVerificationGas: string;
    }>('eth_estimateUserOperationGas', [
      serializeUserOp(userOp),
      ENTRYPOINT_V06,
    ]);

    return {
      callGasLimit: BigInt(result.callGasLimit),
      verificationGasLimit: BigInt(result.verificationGasLimit),
      preVerificationGas: BigInt(result.preVerificationGas),
    };
  }

  /**
   * Submit a signed UserOp to the bundler.
   * Returns the UserOp hash.
   */
  async sendUserOperation(userOp: UserOperationV06): Promise<string> {
    return this.callWithFallback<string>('eth_sendUserOperation', [
      serializeUserOp(userOp),
      ENTRYPOINT_V06,
    ]);
  }

  /**
   * Get the receipt for a submitted UserOp.
   * Returns null if not yet mined.
   */
  async getUserOperationReceipt(
    userOpHash: string
  ): Promise<UserOpReceipt | null> {
    const result = await this.callWithFallback<{
      userOpHash: string;
      receipt: {
        transactionHash: string;
        blockNumber: string;
        status: string;
      };
      success: boolean;
    } | null>('eth_getUserOperationReceipt', [userOpHash]);

    if (!result) return null;

    return {
      userOpHash: result.userOpHash,
      transactionHash: result.receipt.transactionHash,
      blockNumber: parseInt(result.receipt.blockNumber, 16),
      success: result.success,
    };
  }

  /**
   * Wait for UserOp receipt with polling.
   */
  async waitForReceipt(
    userOpHash: string,
    timeoutMs: number = 60_000,
    pollIntervalMs: number = 2_000
  ): Promise<UserOpReceipt> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const receipt = await this.getUserOperationReceipt(userOpHash);
      if (receipt) return receipt;
      await sleep(pollIntervalMs);
    }
    throw new Error(
      `UserOp ${userOpHash} not mined after ${timeoutMs}ms. ` +
        'The transaction may still be pending — check the bundler or block explorer.'
    );
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  /**
   * Call primary, fall back to backup, with retries and backoff.
   */
  private async callWithFallback<T>(
    method: string,
    params: unknown[]
  ): Promise<T> {
    // Try primary
    try {
      return await this.callWithRetry<T>(this.primaryUrl, method, params);
    } catch (primaryError) {
      if (!this.backupUrl) {
        throw primaryError;
      }
      sdkLogger.warn('Primary bundler failed, trying backup', {
        method,
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
      });
    }

    // Try backup
    return this.callWithRetry<T>(this.backupUrl!, method, params);
  }

  private async callWithRetry<T>(
    url: string,
    method: string,
    params: unknown[]
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.jsonRpc<T>(url, method, params);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Don't retry non-transient errors
        if (isNonTransient(lastError)) throw lastError;
        if (attempt < this.maxRetries) {
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          sdkLogger.warn('Bundler request failed, retrying', {
            attempt: attempt + 1,
            method,
            delayMs: delay,
          });
          await sleep(delay);
        }
      }
    }
    throw lastError!;
  }

  private async jsonRpc<T>(
    url: string,
    method: string,
    params: unknown[]
  ): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.requestId++,
      method,
      params,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as JsonRpcResponse<T>;

      if (json.error) {
        const err = new Error(
          `Bundler RPC error ${json.error.code}: ${json.error.message}`
        );
        (err as any).code = json.error.code;
        (err as any).data = json.error.data;
        throw err;
      }

      return json.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect non-transient errors that shouldn't be retried.
 */
function isNonTransient(error: Error): boolean {
  const code = (error as any).code;
  // AA errors from bundler (invalid signature, insufficient funds, etc.)
  if (typeof code === 'number' && code >= -32700 && code <= -32600) {
    return true; // JSON-RPC parse/invalid request errors
  }
  const msg = error.message.toLowerCase();
  if (msg.includes('aa') && (msg.includes('invalid') || msg.includes('rejected'))) {
    return true; // AA validation errors
  }
  return false;
}
