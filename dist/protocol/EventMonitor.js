"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventMonitor = void 0;
const types_1 = require("../types");
/**
 * EventMonitor - Listen to blockchain events
 */
class EventMonitor {
    constructor(kernelContract, _escrowContract) {
        this.kernelContract = kernelContract;
    }
    /**
     * Watch transaction state changes
     * Returns cleanup function to stop watching
     */
    watchTransaction(txId, callback) {
        const filter = this.kernelContract.filters.StateTransitioned(txId);
        const listener = (_eventTxId, _from, to) => {
            callback(to);
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
    async waitForState(txId, targetState, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timeout waiting for state ${types_1.State[targetState]}`));
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
    async getTransactionHistory(address, role = 'requester') {
        // TransactionCreated event signature: (bytes32 indexed txId, address indexed provider, address indexed requester, uint256 amount)
        // Filter format: TransactionCreated(txId, provider, requester)
        const filter = role === 'requester'
            ? this.kernelContract.filters.TransactionCreated(null, null, address) // Match requester
            : this.kernelContract.filters.TransactionCreated(null, address, null); // Match provider
        const events = await this.kernelContract.queryFilter(filter);
        return Promise.all(events.map(async (event) => {
            // ethers v6: EventLog has args, Log does not
            if (!('args' in event)) {
                throw new Error('Event does not contain args (not an EventLog)');
            }
            const txId = event.args?.transactionId;
            const txData = await this.kernelContract.transactions(txId);
            return {
                txId: txData.transactionId,
                requester: txData.requester,
                provider: txData.provider,
                amount: txData.amount,
                state: txData.state,
                createdAt: Number(txData.createdAt),
                updatedAt: Number(txData.updatedAt),
                deadline: Number(txData.deadline),
                disputeWindow: Number(txData.disputeWindow),
                escrowContract: txData.escrowContract,
                escrowId: txData.escrowId,
                serviceHash: txData.serviceHash,
                attestationUID: txData.attestationUID,
                metadata: txData.serviceHash,
                platformFeeBpsLocked: Number(txData.platformFeeBpsLocked)
            };
        }));
    }
    /**
     * Subscribe to transaction creation events
     * Fixed: Correct event parameter order (txId, provider, requester, amount)
     */
    onTransactionCreated(callback) {
        const filter = this.kernelContract.filters.TransactionCreated();
        // Event signature: TransactionCreated(bytes32 indexed txId, address indexed provider, address indexed requester, uint256 amount)
        const listener = async (txId, provider, requester, amount) => {
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
    onStateChanged(callback) {
        const filter = this.kernelContract.filters.StateTransitioned();
        const listener = (txId, from, to) => {
            callback(txId, from, to);
        };
        this.kernelContract.on(filter, listener);
        return () => {
            this.kernelContract.off(filter, listener);
        };
    }
    /**
     * Subscribe to escrow release events
     */
    onEscrowReleased(callback) {
        const filter = this.kernelContract.filters.EscrowReleased();
        const listener = (txId, amount) => {
            callback(txId, amount);
        };
        this.kernelContract.on(filter, listener);
        return () => {
            this.kernelContract.off(filter, listener);
        };
    }
}
exports.EventMonitor = EventMonitor;
//# sourceMappingURL=EventMonitor.js.map