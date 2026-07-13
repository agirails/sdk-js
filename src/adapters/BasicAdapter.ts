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
import { IWalletProvider } from '../wallet/IWalletProvider';
import { SmartWalletCall } from '../wallet/aa/constants';
import { TransactionStateValue } from '../runtime/types/MockState';
import { SmartWalletRouter, createSmartWalletRouter, computeDisputeWindowEnds } from '../wallet/SmartWalletRouter';
import { ethers } from 'ethers';

/**
 * Interface for lazy publish activation call provider.
 * ACTPClient implements this to avoid circular dependency.
 */
export interface IActivationCallProvider {
  getActivationCalls(): { calls: SmartWalletCall[]; onSuccess: () => void };
  routeUrlPayment?(params: UnifiedPayParams): Promise<UnifiedPayResult>;
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
    settlementMode: 'explicit', // Requires explicit release() after dispute window
    priority: 50, // Default priority
  };
  /**
   * Smart Wallet router for encoding and sending state transitions via UserOps.
   * Undefined when wallet provider doesn't support batching (EOA / mock).
   */
  private readonly smartWalletRouter?: SmartWalletRouter;

  /**
   * Creates a new BasicAdapter instance.
   *
   * @param runtime - ACTP runtime implementation (MockRuntime or BlockchainRuntime)
   * @param requesterAddress - The requester's Ethereum address
   * @param easHelper - Optional EAS helper for attestation verification
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
    this.smartWalletRouter = createSmartWalletRouter(walletProvider, contractAddresses, runtime, easHelper);
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
    // Security: Validate dispute window bounds
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
    amount: string;
    provider: string;
    requester: string;
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
      canDispute: tx.state === 'DELIVERED' && tx.completedAt !== null && computeDisputeWindowEnds(tx.completedAt, tx.disputeWindow) > now,
      amount: this.formatAmount(tx.amount),
      provider: tx.provider,
      requester: tx.requester,
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
    // URL recipients (x402/custom HTTP adapters) must be routed via ACTPClient router.
    if (this.isHttpEndpoint(params.to)) {
      return this.routeUrlPayment(params);
    }

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

  private isHttpEndpoint(to: string): boolean {
    try {
      const url = new URL(to);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private async routeUrlPayment(params: UnifiedPayParams): Promise<UnifiedPayResult> {
    if (!this.activationProvider?.routeUrlPayment) {
      throw new ValidationError(
        'HTTP(S) recipients require router-based payment flow. ' +
        'Use client.pay(...) and register X402Adapter for URL payments.'
      );
    }
    return this.activationProvider.routeUrlPayment(params);
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
   * When Smart Wallet is active, routes through walletProvider.sendTransaction()
   * so the Smart Wallet address (msg.sender) matches the transaction party.
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
   * and encodes it as proof. This ensures consistency with the dispute window
   * specified at transaction creation time.
   *
   * When Smart Wallet is active, routes through walletProvider.sendTransaction().
   *
   * @param txId - Transaction ID
   * @param proof - Optional pre-encoded delivery proof (AIP-14c 64-byte
   *                `abi.encode(window, resultHash)`). If not provided, one is
   *                built from the transaction's disputeWindow + `resultHash`.
   * @param resultHash - Optional bytes32 commitment to the delivered result,
   *                     used only when `proof` is not supplied.
   */
  async deliver(txId: string, proof?: string, resultHash?: string): Promise<void> {
    let deliveryProof = proof;

    if (!deliveryProof) {
      const tx = await this.runtime.getTransaction(txId);
      if (!tx) {
        throw new Error(`Transaction ${txId} not found`);
      }
      // AIP-14c 64-byte (window, resultHash) proof — the v2 kernel rejects the
      // legacy 32-byte window-only form. Fails closed without a real resultHash.
      deliveryProof = this.encodeDeliveryProof(tx.disputeWindow, resultHash);
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
   * When Smart Wallet is active, routes through walletProvider.sendTransaction().
   *
   * @param escrowId - Escrow ID (usually same as txId)
   * @param attestationUID - Optional attestation UID for verification
   */
  async release(escrowId: string, attestationUID?: string): Promise<void> {
    if (this.smartWalletRouter?.shouldRoute()) {
      const txId = SmartWalletRouter.extractTxId(escrowId);
      await this.smartWalletRouter.validateReleasePreconditions(txId);
      await this.smartWalletRouter.verifyReleaseAttestation(txId, attestationUID);
      await this.smartWalletRouter.sendSettle(txId);
      return;
    }
    await this.runtime.releaseEscrow(escrowId, attestationUID);
  }
}
