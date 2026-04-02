import { Contract, Signer } from 'ethers';
import EscrowVaultABI from '../abi/EscrowVault.json';
import ERC20ABI from '../abi/ERC20.json';
import { Escrow } from '../types';
import { TransactionRevertedError, ValidationError } from '../errors';
import {
  validateAddress,
  validateAmount,
  validateTxId
} from '../utils/validation';

/**
 * Gas options for transactions
 */
interface GasOptions {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * EscrowVault - Escrow contract wrapper
 *
 * IMPORTANT:
 * - Escrow creation happens atomically inside `ACTPKernel.linkEscrow()`.
 * - Payout/refund functions are `onlyKernel` on-chain and MUST NOT be called by users.
 *
 * This module provides:
 * - Helper methods for USDC approvals (requester → EscrowVault allowance)
 * - Read-only access to escrow state (`escrows()` / `remaining()`)
 *
 * Workflow (per AIP-3):
 * 1. Consumer approves USDC to EscrowVault address (use approveToken)
 * 2. Consumer calls ACTPKernel.linkEscrow(txId, escrowVault, escrowId)
 * 3. Kernel internally calls IEscrowValidator.createEscrow(escrowId, requester, provider, amount)
 * 4. Escrow pulls USDC from requester
 *
 * Reference: AIP-3 §3.2 (Escrow Linking Workflow), lines 258-336
 */
export class EscrowVault {
  private contract: Contract;
  private readonly gasSettings?: GasOptions;

  constructor(
    private readonly address: string,
    private readonly signer: Signer,
    gasSettings?: GasOptions
  ) {
    this.contract = new Contract(address, EscrowVaultABI, signer);
    this.gasSettings = gasSettings;
  }

  /**
   * Get gas buffer multiplier based on operation complexity
   * V6 Security Enhancement: Operation-specific gas buffers
   * Reference: SDK_SECURITY_ANALYSIS-Ultra-Think.md Lines 326-337
   */
  private getGasBufferMultiplier(operation: string): number {
    const buffers: Record<string, number> = {
      'approveToken': 1.20       // 20% - Standard ERC20 approval
    };

    return buffers[operation] || 1.20; // Default 20% for unknown operations
  }

  /**
   * Build transaction options with gas settings and estimated gas
   * V6 Enhancement: Dynamic buffer based on operation type
   *
   *Security: Gas estimation manipulation attack protection
   * - Enforces minimum gas floor regardless of estimate
   * - Uses safe BigInt arithmetic with overflow detection
   */
  private buildTxOptions(estimatedGas: bigint, operation: string = 'default'): any {
    // Security: Minimum gas floor to prevent manipulation
    // Malicious contracts could return artificially low gas estimates
    const MIN_GAS_FLOOR = 100000n;
    const safeEstimate = estimatedGas > MIN_GAS_FLOOR ? estimatedGas : MIN_GAS_FLOOR;

    const bufferMultiplier = this.getGasBufferMultiplier(operation);

    // Security: Safe BigInt arithmetic with overflow check
    // Use 10000 denominator to avoid floating point precision issues
    const bufferNumerator = BigInt(Math.floor(bufferMultiplier * 10000));
    const bufferDenominator = 10000n;
    const gasLimit = (safeEstimate * bufferNumerator) / bufferDenominator;

    // Overflow detection: result should always be >= original estimate
    if (gasLimit < safeEstimate) {
      throw new Error(
        `Gas calculation overflow detected for operation ${operation}. ` +
        `Estimate: ${safeEstimate}, Buffer: ${bufferMultiplier}x, Result: ${gasLimit}`
      );
    }

    const options: any = {
      gasLimit
    };

    if (this.gasSettings?.maxFeePerGas) {
      options.maxFeePerGas = this.gasSettings.maxFeePerGas;
    }
    if (this.gasSettings?.maxPriorityFeePerGas) {
      options.maxPriorityFeePerGas = this.gasSettings.maxPriorityFeePerGas;
    }

    return options;
  }

  /**
   * Get escrow vault address
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Get the underlying ethers Contract instance.
   *
   *Security: Provides public access to contract for EventMonitor
   * instead of accessing private field via bracket notation.
   *
   * @returns ethers Contract instance
   */
  getContract(): Contract {
    return this.contract;
  }

  /**
   * Approve USDC token for escrow creation
   *
   * IMPORTANT: Call this BEFORE ACTPKernel.linkEscrow()
   * The consumer must approve EscrowVault to pull USDC when linkEscrow() is called
   *
   * @param tokenAddress - USDC contract address
   * @param amount - Amount to approve (in USDC wei, 6 decimals)
   * @throws {ValidationError} If inputs are invalid
   * @throws {TransactionRevertedError} If approval fails
   *
   * @example
   * ```typescript
   * // Approve 100 USDC for escrow
   * const amount = ethers.parseUnits('100', 6);
   * await client.escrow.approveToken(BASE_SEPOLIA.contracts.usdc, amount);
   *
   * // Now call linkEscrow via Kernel
   * const escrowId = ethers.id(`escrow-${Date.now()}`);
   * await client.kernel.linkEscrow(txId, escrowVault, escrowId);
   * ```
   */
  async approveToken(tokenAddress: string, amount: bigint): Promise<void> {
    validateAddress(tokenAddress, 'tokenAddress');
    validateAmount(amount, 'amount');

    const tokenContract = new Contract(tokenAddress, ERC20ABI, this.signer);

    try {
      // Check current allowance
      const currentAllowance = await tokenContract.allowance(
        await this.signer.getAddress(),
        this.address
      );

      // Only approve if needed
      if (currentAllowance < amount) {
        const approveFunc = tokenContract.getFunction('approve');

        // USDC-compatible approval pattern:
        // If any residual allowance exists, reset to zero first
        if (currentAllowance > 0n) {
          const resetGas = await approveFunc.estimateGas(this.address, 0);
          const resetTx = await approveFunc(this.address, 0, this.buildTxOptions(resetGas, 'approveToken'));
          await resetTx.wait();
        }

        // Now set the new allowance
        const approveGas = await approveFunc.estimateGas(this.address, amount);
        const approveTx = await approveFunc(this.address, amount, this.buildTxOptions(approveGas, 'approveToken'));
        await approveTx.wait();
      }
    } catch (error: any) {
      throw new TransactionRevertedError(
        error.transactionHash,
        `Token approval failed: ${error.reason || error.message}`
      );
    }
  }

  /**
   * Get escrow details
   */
  async getEscrow(escrowId: string): Promise<Escrow> {
    validateTxId(escrowId, 'escrowId');
    const escrowData = await this.contract.escrows(escrowId);

    return {
      escrowId,
      requester: escrowData.requester,
      provider: escrowData.provider,
      amount: escrowData.amount,
      releasedAmount: escrowData.releasedAmount,
      active: escrowData.active
    };
  }

  /**
   * Get escrow remaining balance (amount - releasedAmount)
   */
  async getEscrowBalance(escrowId: string): Promise<bigint> {
    validateTxId(escrowId, 'escrowId');
    return await this.contract.remaining(escrowId);
  }

  /**
   * @deprecated
   *
   * Payouts/refunds are executed by ACTPKernel (on-chain) as part of state transitions.
   * EscrowVault disbursement methods are `onlyKernel` and cannot be called by EOAs.
   *
   * Use:
   * - `BlockchainRuntime.releaseEscrow(txId, attestationUID?)` (recommended)
   * - or `ACTPKernel.transitionState(txId, State.SETTLED, proof)` (advanced)
   */
  async releaseEscrow(
    escrowId: string,
    _recipients: string[],
    _amounts: bigint[]
  ): Promise<void> {
    validateTxId(escrowId, 'escrowId');
    throw new ValidationError(
      'EscrowVault.releaseEscrow',
      'Escrow payouts are performed by ACTPKernel (onlyKernel). ' +
        'Use BlockchainRuntime.releaseEscrow(txId, attestationUID?) or ACTPKernel.transitionState(txId, SETTLED).'
    );
  }

  /**
   * Check token balance
   */
  async getTokenBalance(tokenAddress: string, account: string): Promise<bigint> {
    const tokenContract = new Contract(tokenAddress, ERC20ABI, this.signer);
    return await tokenContract.balanceOf(account);
  }

  /**
   * Check token allowance
   */
  async getTokenAllowance(
    tokenAddress: string,
    owner: string,
    spender: string
  ): Promise<bigint> {
    const tokenContract = new Contract(tokenAddress, ERC20ABI, this.signer);
    return await tokenContract.allowance(owner, spender);
  }
}
