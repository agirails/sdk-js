import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { sdkLogger } from '../utils/Logger';

const TAG = '[settle-on-interact]';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Background sweep for expired DELIVERED transactions.
 *
 * When an agent interacts with the SDK (pay, startWork, deliver),
 * this class checks for DELIVERED transactions where:
 * - The agent is the provider
 * - The dispute window has expired
 *
 * It then calls releaseEscrow on each, settling them permissionlessly.
 * All operations are fire-and-forget — never blocks the primary operation.
 *
 * @internal
 */
export class SettleOnInteract {
  private lastSweepAt = 0;

  constructor(
    private readonly runtime: IACTPRuntime,
    private readonly providerAddress: string,
    private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ) {}

  /**
   * Trigger a background sweep. Returns immediately — never throws.
   * Called from pay(), startWork(), deliver() in ACTPClient.
   */
  trigger(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < this.cooldownMs) return;
    this.lastSweepAt = now; // stamp before async to prevent burst
    this._doSweep().catch(() => {});
  }

  /**
   * Perform the sweep synchronously (awaited). Used in tests.
   */
  async sweepNow(): Promise<void> {
    await this._doSweep();
  }

  private async _doSweep(): Promise<void> {
    try {
      // BlockchainRuntime path: has getExpiredDeliveredTransactions
      if (typeof (this.runtime as any).getExpiredDeliveredTransactions === 'function') {
        const txs = await (this.runtime as any).getExpiredDeliveredTransactions(this.providerAddress);
        for (const tx of txs) {
          const txId = tx.txId || tx.transactionId;
          try {
            await this.runtime.releaseEscrow(txId);
            sdkLogger.info(`${TAG} Auto-settled expired transaction ${txId}`);
          } catch (err) {
            sdkLogger.warn(`${TAG} Failed to settle ${txId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return;
      }

      // MockRuntime path: has sweepExpiredDeliveredForProvider
      if (typeof (this.runtime as any).sweepExpiredDeliveredForProvider === 'function') {
        await (this.runtime as any).sweepExpiredDeliveredForProvider(this.providerAddress);
        return;
      }

      // Unknown runtime — no sweep capability
    } catch (err) {
      sdkLogger.warn(`${TAG} Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
