"use strict";
/**
 * IntermediateAdapter - Balanced API for developers with some protocol knowledge
 *
 * Provides more control than BeginnerAdapter while still offering convenience:
 * - Explicit transaction lifecycle methods
 * - Direct escrow operations
 * - State transition control
 *
 * Use this adapter when you need fine-grained control but still want
 * user-friendly input parsing and validation.
 *
 * @module adapters/IntermediateAdapter
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntermediateAdapter = void 0;
const BaseAdapter_1 = require("./BaseAdapter");
/**
 * IntermediateAdapter - Balanced API for transaction lifecycle control.
 *
 * Provides explicit methods for each stage of the ACTP lifecycle:
 * - `createTransaction()` - Create transaction without escrow
 * - `linkEscrow()` - Link escrow (auto-transitions to COMMITTED)
 * - `transitionState()` - Manually transition state
 * - `releaseEscrow()` - Release funds to provider
 * - `getEscrowBalance()` - Check escrow balance
 * - `getTransaction()` - Get transaction details
 *
 * @example
 * ```typescript
 * const client = await ACTPClient.create({ mode: 'mock' });
 *
 * // Create transaction (INITIATED state)
 * const txId = await client.intermediate.createTransaction({
 *   provider: '0xProvider123',
 *   amount: '100',
 *   deadline: '+7d',
 * });
 *
 * // Link escrow (auto-transitions to COMMITTED)
 * await client.intermediate.linkEscrow(txId, '100');
 *
 * // Provider delivers
 * await client.intermediate.transitionState(txId, 'DELIVERED');
 *
 * // Release funds after dispute window
 * await client.intermediate.releaseEscrow(escrowId);
 * ```
 */
class IntermediateAdapter extends BaseAdapter_1.BaseAdapter {
    /**
     * Creates a new IntermediateAdapter instance.
     *
     * @param runtime - ACTP runtime implementation (MockRuntime or BlockchainRuntime)
     * @param requesterAddress - The requester's Ethereum address
     * @param easHelper - Optional EAS helper for attestation verification (SECURITY FIX C-4)
     */
    constructor(runtime, requesterAddress, easHelper) {
        super(requesterAddress);
        this.runtime = runtime;
        this.easHelper = easHelper;
    }
    /**
     * Create a transaction (INITIATED state, no escrow yet).
     *
     * Unlike `beginner.pay()`, this only creates the transaction
     * without linking escrow. You must call `linkEscrow()` separately.
     *
     * @param params - Transaction parameters
     * @returns Transaction ID
     * @throws {ValidationError} If inputs are invalid
     *
     * @example
     * ```typescript
     * const txId = await adapter.createTransaction({
     *   provider: '0xProvider123',
     *   amount: '100',
     *   deadline: '+24h',
     * });
     * ```
     */
    async createTransaction(params) {
        const provider = this.validateAddress(params.provider, 'provider');
        const amount = this.parseAmount(params.amount);
        const currentTime = this.runtime.time.now();
        const deadline = this.parseDeadline(params.deadline, currentTime);
        // SECURITY FIX (L-1): Validate dispute window bounds
        const disputeWindow = this.validateDisputeWindow(params.disputeWindow);
        const requester = this.requesterAddress;
        // Validation
        if (requester.toLowerCase() === provider.toLowerCase()) {
            throw new BaseAdapter_1.ValidationError('Cannot create transaction with yourself as provider');
        }
        if (deadline <= currentTime) {
            throw new BaseAdapter_1.ValidationError('Deadline must be in the future');
        }
        return this.runtime.createTransaction({
            provider,
            requester,
            amount: amount.toString(),
            deadline,
            disputeWindow,
            serviceDescription: params.serviceDescription,
        });
    }
    /**
     * Link escrow to a transaction.
     *
     * Automatically transitions INITIATED or QUOTED → COMMITTED.
     * Deducts funds from requester and locks in escrow.
     *
     * @param txId - Transaction ID
     * @returns Escrow ID
     * @throws {Error} If transaction not found or in wrong state
     *
     * @example
     * ```typescript
     * const escrowId = await adapter.linkEscrow(txId);
     * ```
     */
    async linkEscrow(txId) {
        const tx = await this.runtime.getTransaction(txId);
        if (!tx) {
            throw new Error(`Transaction ${txId} not found`);
        }
        // Use the transaction's amount (already in correct format)
        return this.runtime.linkEscrow(txId, tx.amount);
    }
    /**
     * Transition transaction to a new state.
     *
     * Validates the transition against the ACTP 8-state machine.
     *
     * Valid transitions:
     * - INITIATED → QUOTED, COMMITTED, CANCELLED
     * - QUOTED → COMMITTED, CANCELLED
     * - COMMITTED → IN_PROGRESS, DELIVERED, CANCELLED
     * - IN_PROGRESS → DELIVERED, CANCELLED
     * - DELIVERED → SETTLED, DISPUTED
     * - DISPUTED → SETTLED
     *
     * @param txId - Transaction ID
     * @param newState - Target state
     * @throws {Error} If transition is invalid
     *
     * @example
     * ```typescript
     * // Provider marks work as delivered
     * await adapter.transitionState(txId, 'DELIVERED');
     * ```
     */
    async transitionState(txId, newState) {
        return this.runtime.transitionState(txId, newState);
    }
    /**
     * Release escrow funds to the provider.
     *
     * Can only be called when transaction is in DELIVERED state
     * and dispute window has expired.
     *
     * SECURITY FIX (C-4 + HIGH-5): MANDATORY attestation verification before release.
     * When EASHelper is available (testnet/mainnet modes), attestation verification
     * is REQUIRED - not optional. This prevents releasing funds without proper
     * delivery proof.
     *
     * Verifications performed:
     * - Attestation exists and is not revoked
     * - Attestation belongs to this transaction (prevents replay attacks)
     * - Attestation has not been used for a different transaction
     *
     * @param escrowId - Escrow ID
     * @param attestationParams - Attestation verification params (REQUIRED when EASHelper available)
     * @param attestationParams.txId - Transaction ID (bytes32)
     * @param attestationParams.attestationUID - Attestation UID (bytes32)
     * @throws {Error} If escrow not found or dispute window active
     * @throws {Error} If EASHelper is available but attestationParams not provided (HIGH-5)
     * @throws {Error} If attestation verification fails
     *
     * @example
     * ```typescript
     * // With attestation verification (REQUIRED in testnet/mainnet)
     * await adapter.releaseEscrow(escrowId, {
     *   txId: '0x...',
     *   attestationUID: '0x...'
     * });
     *
     * // Mock mode only (no attestation required)
     * await adapter.releaseEscrow(escrowId);
     * ```
     */
    async releaseEscrow(escrowId, attestationParams) {
        // SECURITY FIX (HIGH-5): Enforce attestation verification when EASHelper is available
        if (this.easHelper) {
            if (!attestationParams) {
                throw new Error('Attestation verification is REQUIRED for escrow release in testnet/mainnet modes. ' +
                    'Provide attestationParams: { txId: string, attestationUID: string }. ' +
                    'This ensures the provider has submitted valid delivery proof before receiving funds.');
            }
            // Verify attestation before release
            await this.easHelper.verifyAndRecordForRelease(attestationParams.txId, attestationParams.attestationUID);
        }
        return this.runtime.releaseEscrow(escrowId);
    }
    /**
     * Get escrow balance.
     *
     * Returns formatted balance string (e.g., "100.00 USDC").
     *
     * @param escrowId - Escrow ID
     * @returns Formatted balance
     * @throws {Error} If escrow not found
     *
     * @example
     * ```typescript
     * const balance = await adapter.getEscrowBalance(escrowId);
     * console.log(balance); // "100.00 USDC"
     * ```
     */
    async getEscrowBalance(escrowId) {
        const balance = await this.runtime.getEscrowBalance(escrowId);
        return this.formatAmount(balance);
    }
    /**
     * Get transaction details.
     *
     * Returns the full transaction object from the runtime.
     *
     * @param txId - Transaction ID
     * @returns Transaction object or null if not found
     *
     * @example
     * ```typescript
     * const tx = await adapter.getTransaction(txId);
     * console.log('State:', tx?.state);
     * console.log('Amount:', tx?.amount);
     * ```
     */
    async getTransaction(txId) {
        return this.runtime.getTransaction(txId);
    }
}
exports.IntermediateAdapter = IntermediateAdapter;
//# sourceMappingURL=IntermediateAdapter.js.map