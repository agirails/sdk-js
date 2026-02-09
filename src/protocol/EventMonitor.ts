import { Contract, EventLog } from 'ethers';
import { State, Transaction } from '../types';

/**
 * EventMonitor - Listen to blockchain events
 *
 * ## Confirmation Policy
 *
 * Events received by EventMonitor are already confirmed. ACTPKernel waits
 * for N block confirmations (default 2, configurable via `confirmations`
 * parameter in BlockchainRuntimeConfig) before returning from state-changing
 * operations. On Base L2 (~2 s blocks), the default means events arrive
 * ~4-6 s after submission and are safe from reorgs.
 *
 * Confirmation flow:
 *   User calls ACTPKernel.createTransaction()
 *     → tx.wait(confirmations) blocks until N confirmations
 *     → Event emitted (already confirmed)
 *     → EventMonitor receives event (instant)
 *
 * SECURITY FIX (EVENT-MONITOR): Corrected event parameter order to match ABI.
 * Per ACTPKernel.json, TransactionCreated signature is:
 *   (bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
 *
 * Previous code had requester/provider swapped which caused wrong filter results.
 */
export class EventMonitor {
  constructor(
    private readonly kernelContract: Contract,
    _escrowContract: Contract
  ) {}

  /**
   * Watch transaction state changes
   * Returns cleanup function to stop watching
   */
  watchTransaction(txId: string, callback: (state: State) => void): () => void {
    const filter = this.kernelContract.filters.StateTransitioned(txId);

    const listener = (_eventTxId: string, _from: number, to: number) => {
      callback(to as State);
    };

    this.kernelContract.on(filter, listener);

    // Return cleanup function
    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  /**
   * Wait for specific state
   */
  async waitForState(
    txId: string,
    targetState: State,
    timeoutMs: number = 60000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for state ${State[targetState]}`));
      }, timeoutMs);

      const cleanup = this.watchTransaction(txId, (state) => {
        if (state === targetState) {
          clearTimeout(timer);
          cleanup();
          resolve();
        }
      });
    });
  }

  /**
   * Get all transactions for an address
   *
   * SECURITY FIX (EVENT-MONITOR): Corrected filter parameter order.
   * Per ACTPKernel.json ABI, TransactionCreated event signature is:
   *   (bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
   *
   * Filter order: TransactionCreated(txId, requester, provider)
   * - To filter by requester: (null, address, null)
   * - To filter by provider: (null, null, address)
   *
   * SECURITY FIX (EVENT-MONITOR): Use getTransaction() instead of transactions()
   * The kernel contract exposes getTransaction(bytes32) not transactions(bytes32).
   */
  async getTransactionHistory(
    address: string,
    role: 'requester' | 'provider' = 'requester'
  ): Promise<Transaction[]> {
    // TransactionCreated event signature per ABI:
    // (bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
    // Filter format: TransactionCreated(txId, requester, provider)
    const filter =
      role === 'requester'
        ? this.kernelContract.filters.TransactionCreated(null, address, null) // Match requester (2nd indexed param)
        : this.kernelContract.filters.TransactionCreated(null, null, address); // Match provider (3rd indexed param)

    const events = await this.kernelContract.queryFilter(filter);

    return Promise.all(
      events.map(async (event) => {
        // ethers v6: EventLog has args, Log does not
        if (!('args' in event)) {
          throw new Error('Event does not contain args (not an EventLog)');
        }
        const txId = (event as EventLog).args?.transactionId;

        // SECURITY FIX: Use getTransaction() - the actual ABI function
        // Previous code called transactions(txId) which doesn't exist in ABI
        const txData = await this.kernelContract.getTransaction(txId);

        return {
          txId: txData.transactionId || txId,
          requester: txData.requester,
          provider: txData.provider,
          amount: txData.amount,
          state: (typeof txData.state === 'bigint' ? Number(txData.state) : txData.state) as State,
          createdAt: Number(txData.createdAt),
          updatedAt: Number(txData.updatedAt),
          deadline: Number(txData.deadline),
          disputeWindow: Number(txData.disputeWindow),
          escrowContract: txData.escrowContract,
          escrowId: txData.escrowId,
          serviceHash: txData.serviceHash,
          attestationUID: txData.attestationUID,
          // Use metadata field (quote hash for QUOTED state) if available, fallback to serviceHash
          metadata: txData.metadata || txData.serviceHash,
          platformFeeBpsLocked: Number(txData.platformFeeBpsLocked)
        };
      })
    );
  }

  /**
   * Subscribe to transaction creation events
   *
   * SECURITY FIX (EVENT-MONITOR): Corrected event parameter order.
   * Per ACTPKernel.json ABI:
   *   TransactionCreated(bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
   */
  onTransactionCreated(
    callback: (tx: { txId: string; requester: string; provider: string; amount: bigint; serviceHash?: string }) => void
  ): () => void {
    const filter = this.kernelContract.filters.TransactionCreated();

    // Event signature per ABI: (txId, requester, provider, amount, serviceHash)
    const listener = async (
      txId: string,
      requester: string,
      provider: string,
      amount: bigint,
      serviceHash?: string
    ) => {
      callback({ txId, requester, provider, amount, serviceHash });
    };

    this.kernelContract.on(filter, listener);

    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  /**
   * Subscribe to state change events
   */
  onStateChanged(
    callback: (txId: string, from: State, to: State) => void
  ): () => void {
    const filter = this.kernelContract.filters.StateTransitioned();

    const listener = (txId: string, from: number, to: number) => {
      callback(txId, from as State, to as State);
    };

    this.kernelContract.on(filter, listener);

    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  /**
   * Subscribe to escrow release events
   */
  onEscrowReleased(callback: (txId: string, amount: bigint) => void): () => void {
    const filter = this.kernelContract.filters.EscrowReleased();

    const listener = (txId: string, amount: bigint) => {
      callback(txId, amount);
    };

    this.kernelContract.on(filter, listener);

    return () => {
      this.kernelContract.off(filter, listener);
    };
  }
}

