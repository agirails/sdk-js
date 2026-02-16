/**
 * BasicAdapter - High-level, opinionated API for simple use cases
 *
 * Provides the simplest possible interface for creating and checking transactions.
 * Designed for developers who want to "just make it work" without deep protocol knowledge.
 *
 * Key Features:
 * - Smart defaults (24h deadline, 2-day dispute window)
 * - Inferred requester (from constructor)
 * - User-friendly input (strings, no BigInt)
 * - User-friendly output (formatted amounts, ISO dates)
 *
 * @module adapters/BasicAdapter
 */

import { BaseAdapter, ValidationError } from './BaseAdapter';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { EASHelper } from '../protocol/EASHelper';
import { IAdapter, TransactionStatus } from './IAdapter';
import {
  AdapterMetadata,
  UnifiedPayParams,
  UnifiedPayResult,
} from '../types/adapter';
import { IWalletProvider, TransactionRequest } from '../wallet/IWalletProvider';
import { SmartWalletCall } from '../wallet/aa/constants';
import { TransactionStateValue } from '../runtime/types/MockState';
import { ethers } from 'ethers';

/**
 * Interface for lazy publish activation call provider.
 * ACTPClient implements this to avoid circular dependency.
 */
export interface IActivationCallProvider {
  getActivationCalls(): { calls: SmartWalletCall[]; onSuccess: () => void };
}

/**
 * Parameters for creating a simple payment.
 *
 * This is the most user-friendly interface - minimal required fields.
 */
export interface BasicPayParams {
  /** Recipient address (provider) */
  to: string;

  /** Amount in user-friendly format ("100", "100.50", "100 USDC", "$100") */
  amount: string | number;

  /** Optional: Deadline as relative time ("+24h") or Unix timestamp. Defaults to +24h */
  deadline?: string | number;

  /** Optional: Dispute window in seconds. Defaults to 172800 (2 days) */
  disputeWindow?: number;
}

/**
 * Result of creating a payment.
 *
 * Provides user-friendly formatted data (not raw protocol types).
 */
export interface BasicPayResult {
  /** Transaction ID (bytes32 hex string) */
  txId: string;

  /** Provider address */
  provider: string;

  /** Requester address (caller) */
  requester: string;

  /** Amount in USDC (human-readable, e.g., "100.00 USDC") */
  amount: string;

  /** Deadline as ISO 8601 timestamp */
  deadline: string;

  /** Transaction state */
  state: string;
}

/**
 * BasicAdapter - High-level API for simple payment flows.
 *
 * This adapter provides the simplest possible interface:
 * - `pay()` - Create and fund a transaction in one call
 * - `checkStatus()` - Get transaction status with action hints
 *
 * All complexity is hidden behind smart defaults.
 *
 * Implements IAdapter for router integration.
 *
 * @example
 * ```typescript
 * const client = await ACTPClient.create({ mode: 'mock' });
 *
 * // Simple payment (all defaults)
 * const result = await client.basic.pay({
 *   to: '0xProvider123',
 *   amount: '100',
 * });
 * console.log('Transaction ID:', result.txId);
 * console.log('Amount:', result.amount); // "100.00 USDC"
 *
 * // Check status
 * const status = await client.basic.checkStatus(result.txId);
 * if (status.canAccept) {
 *   console.log('Provider can accept this transaction');
 * }
 * ```
 */
export class BasicAdapter extends BaseAdapter implements IAdapter {
  /**
   * Adapter metadata for router selection.
   */
  public readonly metadata: AdapterMetadata = {
    id: 'basic',
    name: 'Basic Adapter',
    usesEscrow: true,
    supportsDisputes: true,
    requiresIdentity: false,
    settlementMode: 'timed', // Auto-release after dispute window
    priority: 50, // Default priority
  };
  /**
   * Creates a new BasicAdapter instance.
   *
   * @param runtime - ACTP runtime implementation (MockRuntime or BlockchainRuntime)
   * @param requesterAddress - The requester's Ethereum address
   * @param easHelper - Optional EAS helper for attestation verification (SECURITY FIX C-4)
   * @param walletProvider - Optional wallet provider for AA batched payments
   * @param contractAddresses - Optional contract addresses for batched payment encoding
   */
  constructor(
    private runtime: IACTPRuntime,
    requesterAddress: string,
    private easHelper?: EASHelper,
    private walletProvider?: IWalletProvider,
    private contractAddresses?: { usdc: string; actpKernel: string; escrowVault: string },
    private activationProvider?: IActivationCallProvider,
  ) {
    super(requesterAddress);
  }

  /**
   * Create a payment transaction with smart defaults.
   *
   * This is the simplest way to create a transaction - just specify
   * recipient and amount. All other parameters use sensible defaults.
   *
   * Smart defaults:
   * - Requester: Inferred from constructor
   * - Deadline: 24 hours from now
   * - Dispute window: 2 days (172800 seconds)
   *
   * Validations performed:
   * - Address format (0x-prefixed hex)
   * - Amount format (positive number)
   * - Deadline in future
   * - Cannot pay yourself
   *
   * @param params - Payment parameters
   * @param agentId - Optional ERC-8004 agent ID (for reputation reporting)
   * @returns User-friendly payment result
   * @throws {ValidationError} If inputs are invalid
   *
   * @example
   * ```typescript
   * const result = await adapter.payBasic({
   *   to: '0xProvider123',
   *   amount: '100.50',
   *   deadline: '+7d', // Optional: 7 days from now
   * });
   * ```
   */
  async payBasic(params: BasicPayParams, agentId?: string): Promise<BasicPayResult> {
    // Validate and parse inputs
    const provider = this.validateAddress(params.to, 'to');
    const amount = this.parseAmount(params.amount);
    const currentTime = this.runtime.time.now();
    const deadline = this.parseDeadline(params.deadline, currentTime);
    // SECURITY FIX (L-1): Validate dispute window bounds
    const disputeWindow = this.validateDisputeWindow(params.disputeWindow);

    const requester = this.requesterAddress;

    // Additional validations
    if (requester.toLowerCase() === provider.toLowerCase()) {
      throw new ValidationError('Cannot pay yourself (requester equals provider)');
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

    // ====================================================================
    // AIP-12: Batched payment via AA wallet (1 UserOp = N on-chain calls)
    // With lazy publish: activation calls prepended to first payment.
    // ====================================================================
    if (this.walletProvider?.payACTPBatched && this.contractAddresses) {
      const serviceHash = ethers.ZeroHash;

      // Get lazy publish activation calls (if any)
      let prependCalls: SmartWalletCall[] = [];
      let onActivationSuccess: (() => void) | undefined;

      if (this.activationProvider) {
        const activation = this.activationProvider.getActivationCalls();
        prependCalls = activation.calls;
        if (prependCalls.length > 0) {
          onActivationSuccess = activation.onSuccess;
        }
      }

      const result = await this.walletProvider.payACTPBatched(
        {
          provider,
          requester,
          amount: amount.toString(),
          deadline,
          disputeWindow,
          serviceHash,
          agentId: agentId || '0',
          contracts: this.contractAddresses,
        },
        prependCalls.length > 0 ? prependCalls : undefined,
      );

      if (!result.success) {
        throw new Error(`Batched payment UserOp failed: ${result.hash}`);
      }

      // Delete pending-publish.json on successful activation (best-effort)
      if (onActivationSuccess) {
        try {
          onActivationSuccess();
        } catch {
          // Best-effort: activation succeeded, don't crash over cleanup
        }
      }

      return {
        txId: result.txId,
        provider,
        requester,
        amount: this.formatAmount(amount),
        deadline: new Date(deadline * 1000).toISOString(),
        state: 'COMMITTED',
      };
    }

    // ====================================================================
    // Legacy flow: sequential on-chain calls (EOA / mock)
    // ====================================================================

    // Create transaction
    const txId = await this.runtime.createTransaction({
      provider,
      requester,
      amount: amount.toString(),
      deadline,
      disputeWindow,
      agentId, // ERC-8004 agent ID for reputation reporting
    });

    // Link escrow (auto-transitions to COMMITTED)
    await this.runtime.linkEscrow(txId, amount.toString());

    // Fetch transaction details for user-friendly response
    const tx = await this.runtime.getTransaction(txId);

    if (!tx) {
      throw new Error(`Transaction ${txId} not found after creation`);
    }

    return {
      txId,
      provider,
      requester,
      amount: this.formatAmount(amount),
      deadline: new Date(deadline * 1000).toISOString(),
      state: tx.state,
    };
  }

  /**
   * Check payment status by transaction ID.
   *
   * Returns current state plus action hints (what can be done next).
   *
   * Action hints:
   * - `canAccept`: Provider can accept (INITIATED state, before deadline)
   * - `canComplete`: Provider can mark as delivered (COMMITTED state)
   * - `canDispute`: Requester can dispute (DELIVERED state, within dispute window)
   *
   * @param txId - Transaction ID to check
   * @returns Status with action hints
   * @throws {Error} If transaction not found
   *
   * @example
   * ```typescript
   * const status = await adapter.checkStatus(txId);
   * console.log('State:', status.state); // "COMMITTED"
   * if (status.canComplete) {
   *   // Provider can deliver now
   * }
   * ```
   */
  async checkStatus(txId: string): Promise<{
    state: string;
    canAccept: boolean;
    canComplete: boolean;
    canDispute: boolean;
  }> {
    const tx = await this.runtime.getTransaction(txId);

    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    const now = this.runtime.time.now();

    return {
      state: tx.state,
      canAccept: tx.state === 'INITIATED' && tx.deadline > now,
      canComplete: tx.state === 'COMMITTED' || tx.state === 'IN_PROGRESS',
      canDispute: tx.state === 'DELIVERED' && tx.completedAt !== null && tx.completedAt + tx.disputeWindow > now,
    };
  }

  // ==========================================================================
  // IAdapter Implementation
  // ==========================================================================

  /**
   * Execute payment through this adapter.
   *
   * This is the IAdapter-compatible pay() method that returns UnifiedPayResult.
   * For the legacy BasicPayResult API, use payBasic().
   *
   * @param params - Unified payment parameters
   * @returns Promise resolving to unified payment result
   */
  async pay(params: UnifiedPayParams): Promise<UnifiedPayResult> {
    // Validate using IAdapter validate()
    this.validate(params);

    // Map to BasicPayParams
    const basicParams: BasicPayParams = {
      to: params.to,
      amount: params.amount,
      deadline: params.deadline,
      disputeWindow: params.disputeWindow,
    };

    // Call existing payBasic() with optional agentId
    const result = await this.payBasic(basicParams, params.erc8004AgentId);

    // Map to UnifiedPayResult
    return {
      txId: result.txId,
      escrowId: result.txId, // In ACTP, escrowId === txId
      adapter: this.metadata.id,
      state: 'COMMITTED',
      success: true,
      amount: result.amount,
      releaseRequired: true, // ACTP requires explicit release()
      provider: result.provider,
      requester: result.requester,
      deadline: result.deadline,
      erc8004AgentId: params.erc8004AgentId,
    };
  }

  /**
   * Check if this adapter can handle the given parameters.
   *
   * BasicAdapter can handle any Ethereum address recipient.
   *
   * @param params - Payment parameters to check
   * @returns True if params have a valid Ethereum address
   */
  canHandle(params: UnifiedPayParams): boolean {
    // BasicAdapter handles Ethereum addresses only
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

    // Validate amount (will throw if invalid)
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
      ? tx.completedAt + tx.disputeWindow
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
  // Smart Wallet Routing Helpers
  // ==========================================================================

  /**
   * Check if state transitions should route through the wallet provider.
   * True when walletProvider exists and supports batching (i.e., Smart Wallet).
   */
  private shouldRouteViaWallet(): boolean {
    return !!(this.walletProvider?.payACTPBatched && this.contractAddresses);
  }

  /**
   * Encode a transitionState call as a TransactionRequest.
   * Used to route state transitions through Smart Wallet UserOps.
   */
  private encodeTransitionStateTx(txId: string, stateValue: number, proof: string = '0x'): TransactionRequest {
    const iface = new ethers.Interface([
      'function transitionState(bytes32 transactionId, uint8 newState, bytes proof)',
    ]);
    return {
      to: this.contractAddresses!.actpKernel,
      data: iface.encodeFunctionData('transitionState', [txId, stateValue, proof]),
    };
  }

  /**
   * Encode a SETTLED state transition as a TransactionRequest.
   * Mirrors BlockchainRuntime.releaseEscrow() secure settlement flow.
   */
  private encodeSettleTx(txId: string): TransactionRequest {
    return this.encodeTransitionStateTx(txId, TransactionStateValue.SETTLED, '0x');
  }

  /**
   * Validate release preconditions (state + dispute window).
   * Keeps Smart Wallet path aligned with runtime.releaseEscrow() checks.
   */
  private async validateReleasePreconditions(txId: string): Promise<void> {
    const tx = await this.runtime.getTransaction(txId);
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    if (tx.state !== 'DELIVERED') {
      throw new Error(
        `Cannot release escrow: transaction ${txId} is in state ${tx.state}, expected DELIVERED.`
      );
    }

    if (tx.completedAt !== null && tx.completedAt !== undefined) {
      const disputeWindowEnds = tx.completedAt + tx.disputeWindow;
      const now = this.runtime.time.now();
      if (now < disputeWindowEnds) {
        const remaining = disputeWindowEnds - now;
        throw new Error(
          `Cannot release escrow: dispute window still active for transaction ${txId}. ` +
            `Window expires in ${remaining} seconds.`
        );
      }
    }
  }

  /**
   * Verify/require attestation for wallet-routed release calls.
   */
  private async verifyReleaseAttestation(txId: string, attestationUID?: string): Promise<void> {
    const runtimeAny = this.runtime as any;
    const runtimeSupportsAttestationFlag =
      typeof runtimeAny?.isAttestationRequired === 'function';

    const attestationRequired: boolean = runtimeSupportsAttestationFlag
      ? Boolean(runtimeAny.isAttestationRequired())
      : Boolean(this.easHelper);

    if (attestationRequired && !attestationUID) {
      throw new Error(
        'Attestation verification is REQUIRED for escrow release. ' +
          'Provide attestationUID when using Smart Wallet release.'
      );
    }

    if (attestationRequired && !this.easHelper) {
      throw new Error(
        'Attestation verification is required but EAS helper is not initialized.'
      );
    }

    if (attestationUID && this.easHelper) {
      await this.easHelper.verifyAndRecordForRelease(txId, attestationUID);
    }
  }

  // ==========================================================================
  // State Transition Methods
  // ==========================================================================

  /**
   * Transition to IN_PROGRESS state (provider starts work).
   *
   * When Smart Wallet is active, routes through walletProvider.sendTransaction()
   * so the Smart Wallet address (msg.sender) matches the transaction party.
   *
   * @param txId - Transaction ID
   */
  async startWork(txId: string): Promise<void> {
    if (this.shouldRouteViaWallet()) {
      const tx = this.encodeTransitionStateTx(txId, TransactionStateValue.IN_PROGRESS);
      const receipt = await this.walletProvider!.sendTransaction(tx);
      if (!receipt.success) {
        throw new Error(`startWork UserOp failed: ${receipt.hash}`);
      }
      return;
    }
    await this.runtime.transitionState(txId, 'IN_PROGRESS');
  }

  /**
   * Transition to DELIVERED state (provider completes work).
   *
   * When no proof is provided, fetches the transaction's actual disputeWindow
   * and encodes it as proof. This ensures consistency with the dispute window
   * specified at transaction creation time.
   *
   * When Smart Wallet is active, routes through walletProvider.sendTransaction().
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

    if (this.shouldRouteViaWallet()) {
      const tx = this.encodeTransitionStateTx(txId, TransactionStateValue.DELIVERED, deliveryProof);
      const receipt = await this.walletProvider!.sendTransaction(tx);
      if (!receipt.success) {
        throw new Error(`deliver UserOp failed: ${receipt.hash}`);
      }
      return;
    }
    await this.runtime.transitionState(txId, 'DELIVERED', deliveryProof);
  }

  /**
   * Release escrow funds (EXPLICIT settlement).
   *
   * When Smart Wallet is active, routes through walletProvider.sendTransaction().
   *
   * @param escrowId - Escrow ID (usually same as txId)
   * @param attestationUID - Optional attestation UID for verification
   */
  async release(escrowId: string, attestationUID?: string): Promise<void> {
    if (this.shouldRouteViaWallet()) {
      const legacyMatch = escrowId.match(/^escrow-(.+)-\d+$/);
      const txId = legacyMatch ? legacyMatch[1] : escrowId;

      await this.validateReleasePreconditions(txId);
      await this.verifyReleaseAttestation(txId, attestationUID);

      const tx = this.encodeSettleTx(txId);
      const receipt = await this.walletProvider!.sendTransaction(tx);
      if (!receipt.success) {
        throw new Error(`release UserOp failed: ${receipt.hash}`);
      }
      return;
    }
    await this.runtime.releaseEscrow(escrowId, attestationUID);
  }
}
