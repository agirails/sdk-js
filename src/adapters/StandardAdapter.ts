/**
 * StandardAdapter - Balanced API for developers with some protocol knowledge
 *
 * Provides more control than BasicAdapter while still offering convenience:
 * - Explicit transaction lifecycle methods
 * - Direct escrow operations
 * - State transition control
 *
 * Use this adapter when you need fine-grained control but still want
 * user-friendly input parsing and validation.
 *
 * @module adapters/StandardAdapter
 */

import { BaseAdapter, ValidationError, DEFAULT_DISPUTE_WINDOW_SECONDS } from './BaseAdapter';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { MockTransaction, TransactionState } from '../runtime/types/MockState';
import { EASHelper } from '../protocol/EASHelper';

/**
 * Parameters for creating a transaction (standard level).
 *
 * More explicit than BasicPayParams but still with smart defaults.
 */
export interface StandardTransactionParams {
  /** Provider's Ethereum address */
  provider: string;

  /** Amount in user-friendly format ("100", "100.50", "100 USDC") */
  amount: string | number;

  /** Optional: Deadline as relative time ("+24h") or Unix timestamp. Defaults to +24h */
  deadline?: string | number;

  /** Optional: Dispute window in seconds. Defaults to 172800 (2 days) */
  disputeWindow?: number;

  /** Optional: Service description */
  serviceDescription?: string;
}

/**
 * StandardAdapter - Balanced API for transaction lifecycle control.
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
 * const txId = await client.standard.createTransaction({
 *   provider: '0xProvider123',
 *   amount: '100',
 *   deadline: '+7d',
 * });
 *
 * // Link escrow (auto-transitions to COMMITTED)
 * await client.standard.linkEscrow(txId, '100');
 *
 * // Provider delivers
 * await client.standard.transitionState(txId, 'DELIVERED');
 *
 * // Release funds after dispute window
 * await client.standard.releaseEscrow(escrowId);
 * ```
 */
export class StandardAdapter extends BaseAdapter {
  /**
   * Creates a new StandardAdapter instance.
   *
   * @param runtime - ACTP runtime implementation (MockRuntime or BlockchainRuntime)
   * @param requesterAddress - The requester's Ethereum address
   * @param easHelper - Optional EAS helper for attestation verification (SECURITY FIX C-4)
   */
  constructor(
    private runtime: IACTPRuntime,
    requesterAddress: string,
    private easHelper?: EASHelper
  ) {
    super(requesterAddress);
  }

  /**
   * Create a transaction (INITIATED state, no escrow yet).
   *
   * Unlike `basic.pay()`, this only creates the transaction
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
  async createTransaction(params: StandardTransactionParams): Promise<string> {
    const provider = this.validateAddress(params.provider, 'provider');
    const amount = this.parseAmount(params.amount);
    const currentTime = this.runtime.time.now();
    const deadline = this.parseDeadline(params.deadline, currentTime);
    // SECURITY FIX (L-1): Validate dispute window bounds
    const disputeWindow = this.validateDisputeWindow(params.disputeWindow);

    const requester = this.requesterAddress;

    // Validation
    if (requester.toLowerCase() === provider.toLowerCase()) {
      throw new ValidationError('Cannot create transaction with yourself as provider');
    }

    if (deadline <= currentTime) {
      throw new ValidationError('Deadline must be in the future');
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
  async linkEscrow(txId: string): Promise<string> {
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
  async transitionState(txId: string, newState: TransactionState): Promise<void> {
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
  async releaseEscrow(
    escrowId: string,
    attestationParams?: { txId: string; attestationUID: string }
  ): Promise<void> {
    // Determine whether the underlying runtime requires attestation.
    // BlockchainRuntime exposes isAttestationRequired(), but it's not part of the generic interface.
    const runtimeAny = this.runtime as any;
    const runtimeSupportsAttestationFlag =
      typeof runtimeAny?.isAttestationRequired === 'function';

    const attestationRequired: boolean = runtimeSupportsAttestationFlag
      ? Boolean(runtimeAny.isAttestationRequired())
      : Boolean(this.easHelper);

    if (attestationRequired && !attestationParams) {
      throw new Error(
        'Attestation verification is REQUIRED for escrow release. ' +
          'Provide attestationParams: { txId: string, attestationUID: string }.'
      );
    }

    // If caller provided attestation params, ensure they match the escrow/tx being released.
    if (attestationParams) {
      // Support legacy escrowId format "escrow-{txId}-{timestamp}".
      // Standard is escrowId === txId.
      const legacyMatch = escrowId.match(/^escrow-(.+)-\d+$/);
      const txIdFromEscrowId = legacyMatch ? legacyMatch[1] : escrowId;

      if (txIdFromEscrowId.toLowerCase() !== attestationParams.txId.toLowerCase()) {
        throw new Error(
          `Attestation txId (${attestationParams.txId}) does not match escrow/txId (${txIdFromEscrowId}). ` +
            `Refusing to release escrow with mismatched attestation.`
        );
      }

      // If runtime does NOT handle attestation internally but EASHelper exists, verify here.
      // Otherwise, pass attestationUID down so BlockchainRuntime can enforce/record.
      if (!runtimeSupportsAttestationFlag && this.easHelper) {
        await this.easHelper.verifyAndRecordForRelease(
          attestationParams.txId,
          attestationParams.attestationUID
        );
      }
    }

    return this.runtime.releaseEscrow(
      escrowId,
      attestationParams?.attestationUID
    );
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
  async getEscrowBalance(escrowId: string): Promise<string> {
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
  async getTransaction(txId: string): Promise<MockTransaction | null> {
    return this.runtime.getTransaction(txId);
  }
}
