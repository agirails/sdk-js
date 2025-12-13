import { Contract } from 'ethers';
import { State, Transaction } from '../types';
/**
 * EventMonitor - Listen to blockchain events
 */
export declare class EventMonitor {
    private readonly kernelContract;
    constructor(kernelContract: Contract, _escrowContract: Contract);
    /**
     * Watch transaction state changes
     * Returns cleanup function to stop watching
     */
    watchTransaction(txId: string, callback: (state: State) => void): () => void;
    /**
     * Wait for specific state
     */
    waitForState(txId: string, targetState: State, timeoutMs?: number): Promise<void>;
    /**
     * Get all transactions for an address
     * Fixed: Correct filter parameters (txId, provider, requester, amount)
     */
    getTransactionHistory(address: string, role?: 'requester' | 'provider'): Promise<Transaction[]>;
    /**
     * Subscribe to transaction creation events
     * Fixed: Correct event parameter order (txId, provider, requester, amount)
     */
    onTransactionCreated(callback: (tx: {
        txId: string;
        provider: string;
        requester: string;
        amount: bigint;
    }) => void): () => void;
    /**
     * Subscribe to state change events
     */
    onStateChanged(callback: (txId: string, from: State, to: State) => void): () => void;
    /**
     * Subscribe to escrow release events
     */
    onEscrowReleased(callback: (txId: string, amount: bigint) => void): () => void;
}
//# sourceMappingURL=EventMonitor.d.ts.map