/**
 * DualNonceManager — Manages both EntryPoint and ACTP nonces.
 *
 * ERC-4337 UserOps need two independent nonces:
 *   1. EntryPoint nonce — anti-replay for the UserOp itself
 *   2. ACTP nonce — used to compute deterministic txId
 *
 * This manager uses a sequential mutex queue to ensure:
 *   - Only one UserOp is in-flight at a time
 *   - ACTP nonce increments only on confirmed receipt
 *   - On failure, next call re-reads from chain
 *
 * @module wallet/aa/DualNonceManager
 */

import { ethers } from 'ethers';
import { ENTRYPOINT_V06 } from './constants';
import { sdkLogger } from '../../utils/Logger';

// ============================================================================
// ABI fragments
// ============================================================================

const ENTRYPOINT_NONCE_ABI = [
  'function getNonce(address sender, uint192 key) view returns (uint256)',
];

const ACTP_KERNEL_NONCE_ABI = [
  'function requesterNonces(address requester) view returns (uint256)',
];

// ============================================================================
// Mutex
// ============================================================================

class Mutex {
  private locked = false;
  private queue: (() => void)[] = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

// ============================================================================
// DualNonceManager
// ============================================================================

export class DualNonceManager {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly senderAddress: string;
  private readonly actpKernelAddress: string;
  private readonly mutex = new Mutex();

  /** Locally cached ACTP nonce — undefined means "re-read from chain" */
  private cachedActpNonce: bigint | undefined;

  constructor(
    provider: ethers.JsonRpcProvider,
    senderAddress: string,
    actpKernelAddress: string
  ) {
    this.provider = provider;
    this.senderAddress = senderAddress;
    this.actpKernelAddress = actpKernelAddress;
  }

  /**
   * Execute a callback while holding the nonce mutex.
   *
   * The callback receives current nonces and must return whether
   * the operation succeeded (to decide ACTP nonce increment).
   *
   * @param fn Callback receiving { entryPointNonce, actpNonce }
   * @param incrementsActpNonce Whether success increments the ACTP nonce
   */
  async enqueue<T>(
    fn: (nonces: { entryPointNonce: bigint; actpNonce: bigint }) => Promise<{
      result: T;
      success: boolean;
    }>,
    incrementsActpNonce: boolean = true
  ): Promise<T> {
    await this.mutex.acquire();
    try {
      // Read nonces
      const entryPointNonce = await this.readEntryPointNonce();
      const actpNonce = this.cachedActpNonce ?? await this.readActpNonce();

      sdkLogger.info('Nonces acquired', {
        entryPointNonce: entryPointNonce.toString(),
        actpNonce: actpNonce.toString(),
      });

      const { result, success } = await fn({ entryPointNonce, actpNonce });

      if (success && incrementsActpNonce) {
        this.cachedActpNonce = actpNonce + 1n;
      } else if (!success) {
        // Reset cache on failure — next call re-reads from chain
        this.cachedActpNonce = undefined;
      }

      return result;
    } catch (error) {
      // Reset on error
      this.cachedActpNonce = undefined;
      throw error;
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Read current EntryPoint nonce for the sender.
   * Key 0 is the default key for CoinbaseSmartWallet.
   */
  private async readEntryPointNonce(): Promise<bigint> {
    const entryPoint = new ethers.Contract(
      ENTRYPOINT_V06,
      ENTRYPOINT_NONCE_ABI,
      this.provider
    );
    return await entryPoint.getNonce(this.senderAddress, 0);
  }

  /**
   * Read current ACTP nonce for the requester.
   * requesterNonces is public on ACTPKernel.
   */
  private async readActpNonce(): Promise<bigint> {
    const kernel = new ethers.Contract(
      this.actpKernelAddress,
      ACTP_KERNEL_NONCE_ABI,
      this.provider
    );
    const nonce = await kernel.requesterNonces(this.senderAddress);
    this.cachedActpNonce = nonce;
    return nonce;
  }

  /**
   * Invalidate cached ACTP nonce (forces re-read on next operation).
   */
  invalidateCache(): void {
    this.cachedActpNonce = undefined;
  }
}
