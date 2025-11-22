import { BigNumber, Contract, Event } from 'ethers';
import { State, Transaction } from '../types';

/**
 * EventMonitor - Listen to blockchain events
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

    const listener = (_eventTxId: string, _from: number, to: number, _event: Event) => {
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
   * Fixed: Correct filter parameters (txId, provider, requester, amount)
   */
  async getTransactionHistory(
    address: string,
    role: 'requester' | 'provider' = 'requester'
  ): Promise<Transaction[]> {
    // TransactionCreated event signature: (bytes32 indexed txId, address indexed provider, address indexed requester, uint256 amount)
    // Filter format: TransactionCreated(txId, provider, requester)
    const filter =
      role === 'requester'
        ? this.kernelContract.filters.TransactionCreated(null, null, address) // Match requester
        : this.kernelContract.filters.TransactionCreated(null, address, null); // Match provider

    const events = await this.kernelContract.queryFilter(filter);

    return Promise.all(
      events.map(async (event) => {
        const txId = event.args?.transactionId;
        const txData = await this.kernelContract.transactions(txId);

        return {
          txId: txData.transactionId,
          requester: txData.requester,
          provider: txData.provider,
          amount: txData.amount,
          state: txData.state as State,
          createdAt: txData.createdAt.toNumber(),
          deadline: txData.deadline.toNumber(),
          disputeWindow: txData.disputeWindow.toNumber(),
          escrowContract: txData.escrowContract,
          escrowId: txData.escrowId,
          metadata: txData.serviceHash
        };
      })
    );
  }

  /**
   * Subscribe to transaction creation events
   * Fixed: Correct event parameter order (txId, provider, requester, amount)
   */
  onTransactionCreated(
    callback: (tx: { txId: string; provider: string; requester: string; amount: BigNumber }) => void
  ): () => void {
    const filter = this.kernelContract.filters.TransactionCreated();

    // Event signature: TransactionCreated(bytes32 indexed txId, address indexed provider, address indexed requester, uint256 amount)
    const listener = async (
      txId: string,
      provider: string,
      requester: string,
      amount: BigNumber,
      _event: Event
    ) => {
      callback({ txId, provider, requester, amount });
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
  onEscrowReleased(callback: (txId: string, amount: BigNumber) => void): () => void {
    const filter = this.kernelContract.filters.EscrowReleased();

    const listener = (txId: string, amount: BigNumber) => {
      callback(txId, amount);
    };

    this.kernelContract.on(filter, listener);

    return () => {
      this.kernelContract.off(filter, listener);
    };
  }
}

