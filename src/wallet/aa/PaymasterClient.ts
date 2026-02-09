/**
 * PaymasterClient — Gas sponsorship via ERC-7677 paymasters.
 *
 * Fallback chain: Coinbase CDP (primary) → Pimlico (backup).
 * Both implement ERC-7677 pm_getPaymasterStubData / pm_getPaymasterData.
 *
 * The paymaster fills the `paymasterAndData` field of the UserOp,
 * which the EntryPoint uses to debit gas from the paymaster instead
 * of the sender's ETH balance.
 *
 * @module wallet/aa/PaymasterClient
 */

import { UserOperationV06 } from './constants';
import { serializeUserOp } from './UserOpBuilder';
import { ENTRYPOINT_V06 } from './constants';
import { sdkLogger } from '../../utils/Logger';

// ============================================================================
// Types
// ============================================================================

export interface PaymasterConfig {
  /** Primary paymaster URL (Coinbase CDP) */
  primaryUrl: string;
  /** Backup paymaster URL (Pimlico) */
  backupUrl?: string;
  /** Chain ID (8453 for Base Mainnet, 84532 for Sepolia) */
  chainId: number;
  /** Request timeout (ms) */
  timeoutMs?: number;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

// ============================================================================
// PaymasterClient
// ============================================================================

export class PaymasterClient {
  private readonly primaryUrl: string;
  private readonly backupUrl: string | undefined;
  private readonly chainId: number;
  private readonly timeoutMs: number;
  private requestId = 1;

  constructor(config: PaymasterConfig) {
    this.primaryUrl = config.primaryUrl;
    this.backupUrl = config.backupUrl;
    this.chainId = config.chainId;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /**
   * Get stub paymaster data for gas estimation.
   *
   * Returns approximate paymasterAndData that the bundler can use
   * for gas estimation (exact values come from getPaymasterData).
   */
  async getPaymasterStubData(
    userOp: UserOperationV06
  ): Promise<{ paymasterAndData: string }> {
    return this.callWithFallback<{ paymasterAndData: string }>(
      'pm_getPaymasterStubData',
      [
        serializeUserOp(userOp),
        ENTRYPOINT_V06,
        '0x' + this.chainId.toString(16),
        {}, // context
      ]
    );
  }

  /**
   * Get final paymaster data for the signed UserOp.
   *
   * This is called after gas estimation with final gas values.
   * Returns the paymaster signature that goes into paymasterAndData.
   */
  async getPaymasterData(
    userOp: UserOperationV06
  ): Promise<{ paymasterAndData: string }> {
    return this.callWithFallback<{ paymasterAndData: string }>(
      'pm_getPaymasterData',
      [
        serializeUserOp(userOp),
        ENTRYPOINT_V06,
        '0x' + this.chainId.toString(16),
        {}, // context
      ]
    );
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async callWithFallback<T>(
    method: string,
    params: unknown[]
  ): Promise<T> {
    try {
      return await this.jsonRpc<T>(this.primaryUrl, method, params);
    } catch (primaryError) {
      if (!this.backupUrl) {
        throw new Error(
          `Gas sponsorship unavailable: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}. ` +
            'No backup paymaster configured.'
        );
      }
      sdkLogger.warn('Primary paymaster failed, trying backup', {
        method,
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
      });
    }

    try {
      return await this.jsonRpc<T>(this.backupUrl!, method, params);
    } catch (backupError) {
      throw new Error(
        'Gas sponsorship temporarily unavailable — both Coinbase and Pimlico paymasters failed. ' +
          'Please retry later. ' +
          `Primary: ${backupError instanceof Error ? backupError.message : String(backupError)}`
      );
    }
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
        throw new Error(
          `Paymaster RPC error ${json.error.code}: ${json.error.message}`
        );
      }

      return json.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
