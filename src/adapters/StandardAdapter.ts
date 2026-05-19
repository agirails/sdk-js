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

import { ethers } from 'ethers';
import { BaseAdapter, ValidationError } from './BaseAdapter';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { MockTransaction, TransactionState, TransactionStateValue } from '../runtime/types/MockState';
import { EASHelper } from '../protocol/EASHelper';
import { IAdapter, TransactionStatus } from './IAdapter';
import {
  AdapterMetadata,
  UnifiedPayParams,
  UnifiedPayResult,
} from '../types/adapter';
import { IWalletProvider } from '../wallet/IWalletProvider';
import { SmartWalletRouter, createSmartWalletRouter, computeDisputeWindowEnds } from '../wallet/SmartWalletRouter';
import { ServiceHash } from '../utils/Helpers';

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

  /** Optional: ERC-8004 agent ID (for reputation reporting) */
  agentId?: string;
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
export class StandardAdapter extends BaseAdapter implements IAdapter {
  /**
   * Adapter metadata for router selection.
   */
  public readonly metadata: AdapterMetadata = {
    id: 'standard',
    name: 'Standard Adapter',
    usesEscrow: true,
    supportsDisputes: true,
    requiresIdentity: false,
    settlementMode: 'explicit', // Requires explicit release() after dispute window
    priority: 60, // Higher priority than basic (preferred when escrow required)
  };

  /**
   * Smart Wallet router for encoding and sending state transitions via UserOps.
   * Undefined when wallet provider doesn't support batching (EOA / mock).
   */
  private readonly smartWalletRouter?: SmartWalletRouter;

  /**
   * Creates a new StandardAdapter instance.
   *
   * @param runtime - ACTP runtime implementation (MockRuntime or BlockchainRuntime)
   * @param requesterAddress - The requester's Ethereum address
   * @param easHelper - Optional EAS helper for attestation verification
   * @param walletProvider - Optional wallet provider for Smart Wallet routing
   * @param contractAddresses - Optional contract addresses for Smart Wallet call encoding
   */
  constructor(
    private runtime: IACTPRuntime,
    requesterAddress: string,
    private easHelper?: EASHelper,
    private walletProvider?: IWalletProvider,
    private contractAddresses?: { usdc: string; actpKernel: string; escrowVault: string },
  ) {
    super(requesterAddress);
    this.smartWalletRouter = createSmartWalletRouter(walletProvider, contractAddresses, runtime, easHelper);
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
    // Security: Validate dispute window bounds
    const disputeWindow = this.validateDisputeWindow(params.disputeWindow);

    const requester = this.requesterAddress;

    // Validation
    if (requester.toLowerCase() === provider.toLowerCase()) {
      throw new ValidationError('Cannot create transaction with yourself as provider');
    }

    if (deadline <= currentTime) {
      throw new ValidationError('Deadline must be in the future');
    }

    // SECURITY: Enforce transaction amount limit on unaudited mainnet contracts
    const maxAmount = this.runtime.maxTransactionAmount;
    const amountInUsdc = Number(amount) / 1_000_000; // Convert from wei to USDC
    if (maxAmount !== undefined && amountInUsdc > maxAmount) {
      throw new ValidationError(
        `Transaction amount $${amountInUsdc.toFixed(2)} exceeds maximum allowed $${maxAmount}. ` +
        `This limit exists because contracts have not been formally audited. ` +
        `For larger amounts, please contact support@agirails.io.`
      );
    }

    // Route through Smart Wallet when available (gasless)
    if (this.smartWalletRouter?.shouldRoute() && this.walletProvider?.createACTPTransaction && this.contractAddresses) {
      // Compute serviceHash from serviceDescription (matches BlockchainRuntime.validateServiceHash)
      const serviceHash = computeServiceHash(params.serviceDescription);
      const { txId, receipt } = await this.walletProvider.createACTPTransaction({
        provider,
        requester,
        amount: amount.toString(),
        deadline,
        disputeWindow,
        serviceHash,
        agentId: params.agentId || '0',
        contracts: { actpKernel: this.contractAddresses.actpKernel },
      });
      if (!receipt.success) {
        throw new Error(`createTransaction UserOp failed: ${receipt.hash}`);
      }
      return txId;
    }

    // Fallback: EOA / mock path
    return this.runtime.createTransaction({
      provider,
      requester,
      amount: amount.toString(),
      deadline,
      disputeWindow,
      serviceDescription: params.serviceDescription,
      agentId: params.agentId, // ERC-8004 agent ID for reputation reporting
    });
  }

  /**
   * Accept a provider's quote, updating the transaction amount.
   *
   * Does NOT change state (stays QUOTED). After acceptQuote, call linkEscrow.
   * Only the requester can accept a quote.
   *
   * @param txId - Transaction ID
   * @param newAmount - New amount in user-friendly format ("100", "100.50", "100 USDC")
   *
   * @example
   * ```typescript
   * // Provider submits quote -> QUOTED
   * await client.standard.transitionState(txId, 'QUOTED');
   *
   * // Requester accepts with new amount
   * await client.standard.acceptQuote(txId, '150');
   *
   * // Link escrow to commit
   * await client.standard.linkEscrow(txId);
   * ```
   */
  async acceptQuote(txId: string, newAmount: string | number): Promise<void> {
    const amount = this.parseAmount(newAmount);
    return this.runtime.acceptQuote(txId, amount.toString());
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
    // Retry-with-backoff for RPC propagation lag.
    //
    // Callers commonly invoke linkEscrow immediately after createTransaction.
    // The createTransaction UserOp has already been included in a block and
    // its receipt yielded the txId, but a load-balanced public RPC (e.g.
    // PublicNode) may route this follow-up `getTransaction` to a node that
    // hasn't yet ingested the inclusion block. Without a retry the call
    // surfaces a misleading "Transaction not found" — the tx exists, the
    // RPC just hasn't seen it yet. Three attempts at 500ms / 1s / 2s
    // cover the typical propagation window without changing semantics for
    // genuinely-missing txs (still throws after the last attempt).
    let tx: import('../runtime/types/MockState').MockTransaction | null = null;
    const backoffMs = [0, 500, 1000, 2000];
    for (const wait of backoffMs) {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      tx = await this.runtime.getTransaction(txId);
      if (tx) break;
    }

    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    // Route through Smart Wallet when available (gasless)
    if (this.smartWalletRouter?.shouldRoute() && this.contractAddresses) {
      await this.smartWalletRouter.sendLinkEscrow(
        txId, tx.amount, this.contractAddresses.usdc
      );
      return txId; // escrowId = txId (ACTP standard)
    }

    // Fallback: EOA / mock path
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
   * - COMMITTED → IN_PROGRESS, CANCELLED
   * - IN_PROGRESS → DELIVERED, CANCELLED
   * - DELIVERED → SETTLED, DISPUTED
   * - DISPUTED → SETTLED, CANCELLED (admin/pauser)
   *
   * @param txId - Transaction ID
   * @param newState - Target state
   * @param proof - Optional proof data (required for DELIVERED transition with dispute window)
   * @throws {Error} If transition is invalid
   *
   * @example
   * ```typescript
   * // Provider starts work
   * await adapter.transitionState(txId, 'IN_PROGRESS');
   *
   * // Provider marks work as delivered (with dispute window proof)
   * const disputeWindowProof = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [7200]);
   * await adapter.transitionState(txId, 'DELIVERED', disputeWindowProof);
   * ```
   */
  async transitionState(
    txId: string,
    newState: TransactionState,
    proof?: string
  ): Promise<void> {
    if (this.smartWalletRouter?.shouldRoute()) {
      const stateValue = TransactionStateValue[newState];
      await this.smartWalletRouter.sendTransition(txId, stateValue, proof ?? '0x', `transitionState(${newState})`);
      return;
    }
    return this.runtime.transitionState(txId, newState, proof);
  }

  /**
   * Release escrow funds to the provider.
   *
   * Can only be called when transaction is in DELIVERED state
   * and dispute window has expired.
   *
   *Security: MANDATORY attestation verification before release.
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
    let attestationVerifiedLocally = false;

    if (attestationRequired && !attestationParams) {
      throw new Error(
        'Attestation verification is REQUIRED for escrow release. ' +
          'Provide attestationParams: { txId: string, attestationUID: string }.'
      );
    }

    const txIdFromEscrowId = SmartWalletRouter.extractTxId(escrowId);

    // If caller provided attestation params, ensure they match the escrow/tx being released.
    if (attestationParams) {
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
        attestationVerifiedLocally = true;
      }
    }

    if (this.smartWalletRouter?.shouldRoute()) {
      if (attestationRequired && !this.easHelper) {
        throw new Error(
          'Attestation verification is required but EAS helper is not initialized.'
        );
      }
      await this.smartWalletRouter.validateReleasePreconditions(txIdFromEscrowId);
      if (attestationParams?.attestationUID && this.easHelper && !attestationVerifiedLocally) {
        await this.easHelper.verifyAndRecordForRelease(
          txIdFromEscrowId,
          attestationParams.attestationUID
        );
      }

      await this.smartWalletRouter.sendSettle(txIdFromEscrowId);
      return;
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

  // ==========================================================================
  // IAdapter Implementation
  // ==========================================================================

  /**
   * Unified pay method for IAdapter interface.
   *
   * Creates transaction AND links escrow in one call.
   *
   * @param params - Unified payment parameters
   * @returns Promise resolving to unified payment result
   */
  async pay(params: UnifiedPayParams): Promise<UnifiedPayResult> {
    // ACTP adapters require explicit amount (unlike x402 URL payments where
    // amount comes from the server's payment-required response).
    if (params.amount === undefined || params.amount === null || params.amount === '') {
      throw new ValidationError(
        'amount is required for ACTP payments (basic/standard adapters). ' +
          'Only x402 URL targets may omit amount (server specifies).'
      );
    }

    // Validate using IAdapter validate()
    this.validate(params);

    // Map to StandardTransactionParams
    const standardParams: StandardTransactionParams = {
      provider: params.to,
      amount: params.amount,
      deadline: params.deadline,
      disputeWindow: params.disputeWindow,
      serviceDescription: params.description,
      agentId: params.erc8004AgentId, // Pass ERC-8004 agent ID
    };

    // Create transaction
    const txId = await this.createTransaction(standardParams);

    // Link escrow (auto-transitions to COMMITTED)
    await this.linkEscrow(txId);

    // Fetch transaction for response
    const tx = await this.runtime.getTransaction(txId);
    if (!tx) {
      throw new Error(`Transaction ${txId} not found after creation`);
    }

    const provider = this.validateAddress(params.to, 'to');
    const deadline = tx.deadline;

    return {
      txId,
      escrowId: txId,
      adapter: this.metadata.id,
      state: 'COMMITTED',
      success: true,
      amount: this.formatAmount(tx.amount),
      releaseRequired: true, // ACTP requires explicit release()
      provider,
      requester: this.requesterAddress,
      deadline: new Date(deadline * 1000).toISOString(),
      erc8004AgentId: params.erc8004AgentId, // Return agent ID
    };
  }

  /**
   * Check if this adapter can handle the given parameters.
   *
   * StandardAdapter can handle any Ethereum address recipient.
   *
   * @param params - Payment parameters to check
   * @returns True if params have a valid Ethereum address
   */
  canHandle(params: UnifiedPayParams): boolean {
    // StandardAdapter handles Ethereum addresses only
    if (typeof params.to !== 'string') {
      return false;
    }

    // Check if it's an Ethereum address (0x-prefixed hex)
    return /^0x[a-fA-F0-9]{40}$/.test(params.to);
  }

  /**
   * Validate parameters before execution.
   *
   * @param params - Parameters to validate
   * @throws {ValidationError} If params are invalid
   */
  validate(params: UnifiedPayParams): void {
    // Validate address
    this.validateAddress(params.to, 'to');

    // Validate amount (required for ACTP adapters; optional only for x402 URLs)
    if (params.amount === undefined || params.amount === null || params.amount === '') {
      throw new ValidationError(
        'amount is required for ACTP payments (basic/standard adapters). ' +
          'Only x402 URL targets may omit amount (server specifies).'
      );
    }
    this.parseAmount(params.amount);

    // Validate deadline if provided
    if (params.deadline !== undefined) {
      this.parseDeadline(params.deadline);
    }

    // Validate dispute window if provided
    if (params.disputeWindow !== undefined) {
      this.validateDisputeWindow(params.disputeWindow);
    }
  }

  /**
   * Get transaction status by ID.
   *
   * Returns TransactionStatus with action hints.
   *
   * @param txId - Transaction ID
   * @returns Promise resolving to transaction status
   */
  async getStatus(txId: string): Promise<TransactionStatus> {
    const tx = await this.runtime.getTransaction(txId);

    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    const now = this.runtime.time.now();
    const disputeWindowEnds = tx.completedAt
      ? computeDisputeWindowEnds(tx.completedAt, tx.disputeWindow)
      : undefined;

    return {
      state: tx.state as TransactionStatus['state'],
      canStartWork: tx.state === 'COMMITTED',
      canDeliver: tx.state === 'IN_PROGRESS',
      canRelease:
        tx.state === 'DELIVERED' &&
        disputeWindowEnds !== undefined &&
        now >= disputeWindowEnds,
      canDispute:
        tx.state === 'DELIVERED' &&
        disputeWindowEnds !== undefined &&
        now < disputeWindowEnds,
      amount: this.formatAmount(tx.amount),
      deadline: new Date(tx.deadline * 1000).toISOString(),
      disputeWindowEnds: disputeWindowEnds
        ? new Date(disputeWindowEnds * 1000).toISOString()
        : undefined,
      provider: tx.provider,
      requester: tx.requester,
    };
  }

  // ==========================================================================
  // State Transition Methods
  // ==========================================================================

  /**
   * Transition to IN_PROGRESS state (provider starts work).
   *
   * When Smart Wallet is active, routes through walletProvider.sendTransaction().
   *
   * @param txId - Transaction ID
   */
  async startWork(txId: string): Promise<void> {
    if (this.smartWalletRouter?.shouldRoute()) {
      await this.smartWalletRouter.sendTransition(txId, TransactionStateValue.IN_PROGRESS, '0x', 'startWork');
      return;
    }
    await this.runtime.transitionState(txId, 'IN_PROGRESS');
  }

  /**
   * Transition to DELIVERED state (provider completes work).
   *
   * When no proof is provided, fetches the transaction's actual disputeWindow
   * and encodes it as proof. When Smart Wallet is active, routes through
   * walletProvider.sendTransaction().
   *
   * @param txId - Transaction ID
   * @param proof - Optional delivery proof (ABI-encoded dispute window).
   *                If not provided, uses transaction's disputeWindow.
   */
  async deliver(txId: string, proof?: string): Promise<void> {
    let deliveryProof = proof;

    if (!deliveryProof) {
      // Fetch transaction to get its actual disputeWindow
      const tx = await this.runtime.getTransaction(txId);
      if (!tx) {
        throw new Error(`Transaction ${txId} not found`);
      }
      // Use transaction's disputeWindow, not a default
      deliveryProof = this.encodeDisputeWindowProof(tx.disputeWindow);
    }

    if (this.smartWalletRouter?.shouldRoute()) {
      await this.smartWalletRouter.sendTransition(txId, TransactionStateValue.DELIVERED, deliveryProof, 'deliver');
      return;
    }
    await this.runtime.transitionState(txId, 'DELIVERED', deliveryProof);
  }

  /**
   * Release escrow funds (EXPLICIT settlement).
   *
   * Wrapper around releaseEscrow() for IAdapter interface.
   * When Smart Wallet is active, routes through walletProvider.sendTransaction().
   *
   * @param escrowId - Escrow ID (usually same as txId)
   * @param attestationUID - Optional attestation UID for verification
   */
  async release(escrowId: string, attestationUID?: string): Promise<void> {
    const txId = SmartWalletRouter.extractTxId(escrowId);

    if (attestationUID) {
      await this.releaseEscrow(escrowId, { txId, attestationUID });
    } else {
      await this.releaseEscrow(escrowId);
    }
  }
}

/**
 * Compute a bytes32 serviceHash from a serviceDescription string.
 *
 * Mirrors BlockchainRuntime.validateServiceHash() logic:
 * - undefined/empty → ZeroHash
 * - Already a valid bytes32 hash → pass through
 * - Raw string → keccak256(toUtf8Bytes(description))
 */
function computeServiceHash(serviceDescription?: string): string {
  if (!serviceDescription) {
    return ethers.ZeroHash;
  }
  if (ServiceHash.isValidHash(serviceDescription)) {
    return serviceDescription;
  }
  return ethers.keccak256(ethers.toUtf8Bytes(serviceDescription));
}
