/**
 * SmartWalletRouter - Shared utility for routing state transitions through Smart Wallet.
 *
 * Centralizes the logic for encoding ACTPKernel contract calls as TransactionRequests,
 * validating release preconditions, and verifying attestations. Used by BasicAdapter,
 * StandardAdapter, and ACTPClient to avoid code triplication.
 *
 * @module wallet/SmartWalletRouter
 */

import { ethers } from 'ethers';
import { IWalletProvider, TransactionRequest, TransactionReceipt } from './IWalletProvider';
import { IACTPRuntime } from '../runtime/IACTPRuntime';
import { EASHelper } from '../protocol/EASHelper';
import { TransactionStateValue } from '../runtime/types/MockState';
import type { MockTransaction } from '../runtime/types/MockState';

/**
 * Pre-compiled ABI interface for ACTPKernel.transitionState().
 * Module-level constant to avoid re-instantiation on every call.
 */
const ACTP_KERNEL_IFACE = new ethers.Interface([
  'function transitionState(bytes32 transactionId, uint8 newState, bytes proof)',
  'function linkEscrow(bytes32 txId, address escrowVault, bytes32 escrowId)',
]);

const ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount)',
]);

/**
 * Threshold to distinguish absolute timestamps from durations.
 * Dispute window durations max at 30 days (~2.6M seconds).
 * Absolute timestamps (post-2001) are > 1 billion.
 * There's no overlap between these ranges.
 */
const ABSOLUTE_TIMESTAMP_THRESHOLD = 1_000_000_000;

/**
 * Contract addresses needed for encoding Smart Wallet calls.
 */
export interface SmartWalletContractAddresses {
  usdc: string;
  actpKernel: string;
  escrowVault: string;
}

/**
 * SmartWalletRouter centralizes Smart Wallet routing logic.
 *
 * When a wallet provider with batched support is available (ERC-4337 Smart Wallet),
 * state transitions must be sent as UserOps through the wallet provider so that
 * msg.sender equals the Smart Wallet address (not the EOA signer).
 */
export class SmartWalletRouter {
  constructor(
    private readonly walletProvider: IWalletProvider,
    private readonly contractAddresses: SmartWalletContractAddresses,
    private readonly runtime: IACTPRuntime,
    private readonly easHelper?: EASHelper,
  ) {}

  /**
   * Check if state transitions should route through the wallet provider.
   * True when walletProvider supports batching (i.e., is a Smart Wallet).
   */
  shouldRoute(): boolean {
    return !!this.walletProvider.payACTPBatched;
  }

  /**
   * Encode a transitionState call as a TransactionRequest.
   */
  encodeTransitionStateTx(txId: string, stateValue: number, proof: string = '0x'): TransactionRequest {
    return {
      to: this.contractAddresses.actpKernel,
      data: ACTP_KERNEL_IFACE.encodeFunctionData('transitionState', [txId, stateValue, proof]),
    };
  }

  /**
   * Encode a SETTLED state transition as a TransactionRequest.
   * Mirrors BlockchainRuntime.releaseEscrow() secure settlement flow.
   */
  encodeSettleTx(txId: string): TransactionRequest {
    return this.encodeTransitionStateTx(txId, TransactionStateValue.SETTLED, '0x');
  }

  /**
   * Send a state transition through the wallet provider and check the receipt.
   *
   * @param txId - Transaction ID
   * @param stateValue - Target state value (from TransactionStateValue enum)
   * @param proof - Optional proof data
   * @param label - Human-readable label for error messages (e.g., "startWork", "deliver")
   * @returns Transaction receipt
   */
  async sendTransition(txId: string, stateValue: number, proof: string = '0x', label: string = 'transitionState'): Promise<TransactionReceipt> {
    const tx = this.encodeTransitionStateTx(txId, stateValue, proof);
    const receipt = await this.walletProvider.sendTransaction(tx);
    if (!receipt.success) {
      throw new Error(`${label} UserOp failed: ${receipt.hash}`);
    }
    return receipt;
  }

  /**
   * Send a SETTLED transition through the wallet provider.
   *
   * @param txId - Transaction ID
   * @returns Transaction receipt
   */
  async sendSettle(txId: string): Promise<TransactionReceipt> {
    const tx = this.encodeSettleTx(txId);
    const receipt = await this.walletProvider.sendTransaction(tx);
    if (!receipt.success) {
      throw new Error(`release UserOp failed: ${receipt.hash}`);
    }
    return receipt;
  }

  /**
   * Send a linkEscrow call through the wallet provider as a batched UserOp.
   *
   * Encodes USDC.approve(escrowVault, amount) + ACTPKernel.linkEscrow(txId, escrowVault, txId)
   * and submits them as a single atomic batch.
   *
   * @param txId - Transaction ID (bytes32)
   * @param amount - Amount in USDC wei (string)
   * @param usdcAddress - USDC contract address
   * @returns Transaction receipt
   */
  async sendLinkEscrow(txId: string, amount: string, usdcAddress: string): Promise<TransactionReceipt> {
    const amountBn = BigInt(amount);

    const approveData = ERC20_IFACE.encodeFunctionData('approve', [
      this.contractAddresses.escrowVault,
      amountBn,
    ]);

    const linkEscrowData = ACTP_KERNEL_IFACE.encodeFunctionData('linkEscrow', [
      txId,
      this.contractAddresses.escrowVault,
      txId, // escrowId = txId (ACTP standard)
    ]);

    const txs: TransactionRequest[] = [
      { to: usdcAddress, data: approveData },
      { to: this.contractAddresses.actpKernel, data: linkEscrowData },
    ];

    const receipt = await this.walletProvider.sendBatchTransaction(txs);
    if (!receipt.success) {
      throw new Error(`linkEscrow UserOp failed: ${receipt.hash}`);
    }
    return receipt;
  }

  /**
   * Validate release preconditions (state + dispute window).
   *
   * Handles both mock mode (disputeWindow = duration in seconds) and
   * blockchain mode (disputeWindow = absolute timestamp). Uses a heuristic:
   * values > 1 billion are absolute timestamps, smaller values are durations.
   *
   * @param txOrId - Transaction object or transaction ID to fetch
   * @returns The validated transaction object (avoids double-fetch)
   */
  async validateReleasePreconditions(txOrId: string | MockTransaction): Promise<MockTransaction> {
    const tx = typeof txOrId === 'string'
      ? await this.runtime.getTransaction(txOrId)
      : txOrId;

    const txId = typeof txOrId === 'string' ? txOrId : txOrId.id;

    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    if (tx.state !== 'DELIVERED') {
      throw new Error(
        `Cannot release escrow: transaction ${txId} is in state ${tx.state}, expected DELIVERED.`
      );
    }

    // Dispute window check.
    // Requester is allowed to approve early release before dispute window end.
    // Mock mode: completedAt = delivery timestamp, disputeWindow = duration in seconds.
    // Blockchain mode: completedAt = 0 (V1), disputeWindow = absolute timestamp from chain.
    // Heuristic: if disputeWindow > 1 billion, it's an absolute timestamp (post-2001).
    // Skip dispute window check when completedAt is 0 (blockchain V1 limitation — not yet populated).
    // On-chain contract still enforces dispute window via _validateSettlementConditions().
    if (tx.completedAt && tx.completedAt !== 0) {
      const disputeWindowEnds = computeDisputeWindowEnds(tx.completedAt, tx.disputeWindow);
      const now = this.runtime.time.now();
      if (now < disputeWindowEnds) {
        const caller = this.walletProvider.getAddress().toLowerCase();
        const requester = tx.requester.toLowerCase();
        const isRequester = caller === requester;

        if (!isRequester) {
          const remaining = disputeWindowEnds - now;
          throw new Error(
            `Cannot release escrow: dispute window still active for transaction ${txId}. ` +
              `Window expires in ${remaining} seconds.`
          );
        }
      }
    }

    return tx;
  }

  /**
   * Verify/require attestation for wallet-routed release calls.
   *
   * Includes txId cross-check to prevent attestation replay attacks:
   * ensures the provided attestation belongs to the transaction being released.
   *
   * @param txId - Transaction ID being released
   * @param attestationUID - Optional attestation UID
   */
  async verifyReleaseAttestation(txId: string, attestationUID?: string): Promise<void> {
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

  /**
   * Extract txId from escrowId, handling legacy format.
   *
   * @param escrowId - Escrow ID (may be txId or legacy "escrow-{txId}-{timestamp}" format)
   * @returns The txId
   */
  static extractTxId(escrowId: string): string {
    const legacyMatch = escrowId.match(/^escrow-(.+)-\d+$/);
    return legacyMatch ? legacyMatch[1] : escrowId;
  }
}

/**
 * Compute the absolute end-time of the dispute window.
 *
 * Handles both representations transparently:
 * - **Mock mode**: `disputeWindow` is a duration in seconds → `completedAt + disputeWindow`
 * - **Blockchain mode**: `disputeWindow` is an absolute timestamp from on-chain → used as-is
 *
 * Heuristic: values > 1 billion are absolute timestamps (post-2001 epoch).
 * Dispute window durations max at 30 days (~2.6M seconds). No overlap.
 *
 * @param completedAt - Delivery timestamp (0 in blockchain V1, real value in mock/V2)
 * @param disputeWindow - Duration in seconds (mock) or absolute timestamp (blockchain)
 * @returns Absolute timestamp when dispute window ends
 */
export function computeDisputeWindowEnds(completedAt: number, disputeWindow: number): number {
  if (disputeWindow > ABSOLUTE_TIMESTAMP_THRESHOLD) {
    // Blockchain mode: disputeWindow IS the absolute end timestamp
    return disputeWindow;
  }
  // Mock mode: disputeWindow is a duration relative to completedAt
  return completedAt + disputeWindow;
}

/**
 * Factory function to create a SmartWalletRouter if wallet provider supports batching.
 *
 * @returns SmartWalletRouter instance if Smart Wallet is available, undefined otherwise
 */
export function createSmartWalletRouter(
  walletProvider?: IWalletProvider,
  contractAddresses?: SmartWalletContractAddresses,
  runtime?: IACTPRuntime,
  easHelper?: EASHelper,
): SmartWalletRouter | undefined {
  if (walletProvider?.payACTPBatched && contractAddresses && runtime) {
    return new SmartWalletRouter(walletProvider, contractAddresses, runtime, easHelper);
  }
  return undefined;
}
