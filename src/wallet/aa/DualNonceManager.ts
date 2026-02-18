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

const TX_CREATED_EVENT_TOPIC = ethers.id(
  'TransactionCreated(bytes32,address,address,uint256,bytes32,uint256,uint256,uint256)'
);
const INITIAL_LOG_CHUNK_SIZE = 10_000;
const MIN_LOG_CHUNK_SIZE = 1_000;

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
  /** Cached deployment block for ACTPKernel address */
  private cachedKernelDeploymentBlock: number | undefined;
  /** Whether the cached deployment block hint has been validated against the chain */
  private deploymentBlockValidated = false;

  constructor(
    provider: ethers.JsonRpcProvider,
    senderAddress: string,
    actpKernelAddress: string,
    knownDeploymentBlock?: number
  ) {
    this.provider = provider;
    this.senderAddress = senderAddress;
    this.actpKernelAddress = actpKernelAddress;
    if (knownDeploymentBlock !== undefined) {
      this.cachedKernelDeploymentBlock = knownDeploymentBlock;
    }
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
   * requesterNonces is public on ACTPKernel (added in v2).
   * Older deployments may not expose this — fall back to 0n.
   */
  private async readActpNonce(): Promise<bigint> {
    try {
      const kernel = new ethers.Contract(
        this.actpKernelAddress,
        ACTP_KERNEL_NONCE_ABI,
        this.provider
      );
      const nonce = await kernel.requesterNonces(this.senderAddress);
      this.cachedActpNonce = nonce;
      return nonce;
    } catch {
      // Older ACTPKernel deployments don't expose requesterNonces.
      // Derive nonce from TransactionCreated events for this requester.
      // Uses deployment-block binary search + chunked logs (avoids block-0 scans).
      sdkLogger.warn(
        'requesterNonces not available on ACTPKernel — deriving nonce from events (older deployment?)'
      );

      try {
        const latestBlock = await this.provider.getBlockNumber();
        const deploymentBlock = await this.findContractDeploymentBlock(latestBlock);
        const events = await this.countRequesterTransactionCreatedEvents(
          deploymentBlock,
          latestBlock
        );
        const derivedNonce = BigInt(events.length);

        sdkLogger.info('Derived ACTP nonce from TransactionCreated events', {
          requester: this.senderAddress,
          events: events.length,
          fromBlock: deploymentBlock,
          toBlock: latestBlock,
          derivedNonce: derivedNonce.toString(),
        });

        this.cachedActpNonce = derivedNonce;
        return derivedNonce;
      } catch (deriveError) {
        // Last-resort fallback for very old/limited RPCs.
        sdkLogger.warn('Could not derive ACTP nonce from events — using 0 as last resort', {
          error: deriveError instanceof Error ? deriveError.message : String(deriveError),
        });
        this.cachedActpNonce = 0n;
        return 0n;
      }
    }
  }

  /**
   * Invalidate cached ACTP nonce (forces re-read on next operation).
   */
  invalidateCache(): void {
    this.cachedActpNonce = undefined;
  }

  /**
   * Override cached ACTP nonce.
   *
   * Used when caller deterministically advances nonce (e.g. retrying batched
   * creation after "Escrow ID already used" simulation failures).
   */
  setCachedActpNonce(nonce: bigint): void {
    this.cachedActpNonce = nonce;
  }

  /**
   * Find contract deployment block using binary search on getCode().
   *
   * If a knownDeploymentBlock was provided at construction, it is validated
   * once by checking getCode() at that block. On mismatch the cache is
   * discarded and the full binary search runs as fallback.
   */
  private async findContractDeploymentBlock(latestBlock: number): Promise<number> {
    if (this.cachedKernelDeploymentBlock !== undefined) {
      // Validate hint on first use: contract must have code at the claimed block.
      if (!this.deploymentBlockValidated) {
        this.deploymentBlockValidated = true;
        const code = await this.provider.getCode(
          this.actpKernelAddress,
          this.cachedKernelDeploymentBlock
        );
        if (code === '0x') {
          sdkLogger.warn(
            'knownDeploymentBlock is invalid (no code at that block) — falling back to binary search',
            { knownDeploymentBlock: this.cachedKernelDeploymentBlock }
          );
          this.cachedKernelDeploymentBlock = undefined;
          // Fall through to binary search below
        } else {
          return this.cachedKernelDeploymentBlock;
        }
      } else {
        return this.cachedKernelDeploymentBlock;
      }
    }

    const codeAtLatest = await this.provider.getCode(this.actpKernelAddress, latestBlock);
    if (codeAtLatest === '0x') {
      throw new Error(`ACTPKernel has no code at latest block ${latestBlock}`);
    }

    let low = 0;
    let high = latestBlock;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const codeAtMid = await this.provider.getCode(this.actpKernelAddress, mid);
      if (codeAtMid === '0x') {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.cachedKernelDeploymentBlock = low;
    this.deploymentBlockValidated = true; // binary search result is inherently valid
    return low;
  }

  /**
   * Count TransactionCreated logs for requester in chunks.
   *
   * Chunking avoids RPC range limits on providers that reject very large log windows.
   */
  private async countRequesterTransactionCreatedEvents(
    fromBlock: number,
    toBlock: number
  ): Promise<ethers.Log[]> {
    const requesterTopic = ethers.zeroPadValue(this.senderAddress, 32).toLowerCase();
    const logs: ethers.Log[] = [];

    let cursor = fromBlock;
    let chunkSize = INITIAL_LOG_CHUNK_SIZE;

    while (cursor <= toBlock) {
      const chunkEnd = Math.min(cursor + chunkSize - 1, toBlock);

      try {
        const chunkLogs = await this.provider.getLogs({
          address: this.actpKernelAddress,
          topics: [TX_CREATED_EVENT_TOPIC, null, requesterTopic],
          fromBlock: cursor,
          toBlock: chunkEnd,
        });

        logs.push(...chunkLogs);
        cursor = chunkEnd + 1;
      } catch (error) {
        if (chunkSize <= MIN_LOG_CHUNK_SIZE) {
          throw error;
        }

        chunkSize = Math.max(MIN_LOG_CHUNK_SIZE, Math.floor(chunkSize / 2));
        sdkLogger.warn(
          'TransactionCreated log scan range too large; reducing chunk size while deriving ACTP nonce',
          {
            nextChunkSize: chunkSize,
            fromBlock: cursor,
            attemptedToBlock: chunkEnd,
          }
        );
      }
    }

    return logs;
  }
}
