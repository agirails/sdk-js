import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { sdkLogger } from '../utils/Logger';

const TAG = '[settle-on-interact]';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Minimal surface SettleOnInteract needs from the StandardAdapter to
 * route releaseEscrow through SmartWalletRouter on AA-enabled agents.
 * Decoupled from the full adapter type so this module stays
 * test-friendly and free of import cycles.
 */
interface ReleaseRouter {
  releaseEscrow(escrowId: string): Promise<void>;
}

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
 * When the optional `releaseRouter` is provided (typically
 * `client.standard`), settlements route through SmartWalletRouter so
 * AGIRAILS Smart Wallet providers get Paymaster-sponsored UserOps
 * instead of raw EOA reverts. Without it, falls back to the runtime
 * which only works for EOA / mock setups.
 *
 * @internal
 */
export class SettleOnInteract {
  private lastSweepAt = 0;

  constructor(
    private readonly runtime: IACTPRuntime,
    private readonly providerAddress: string,
    private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS,
    private readonly releaseRouter?: ReleaseRouter,
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
            // Prefer the AA-aware adapter route when available so Smart
            // Wallet providers (0 ETH on the signer EOA) can settle via
            // Paymaster instead of reverting on intrinsic-gas cost.
            if (this.releaseRouter) {
              await this.releaseRouter.releaseEscrow(txId);
            } else {
              await this.runtime.releaseEscrow(txId);
            }
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
