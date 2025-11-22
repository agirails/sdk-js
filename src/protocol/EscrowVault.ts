import { Contract, Signer, BigNumber, ContractReceipt } from 'ethers';
import EscrowVaultABI from '../abi/EscrowVault.json';
import ERC20ABI from '../abi/ERC20.json';
import { CreateEscrowParams, Escrow } from '../types';
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
  maxFeePerGas?: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
}

/**
 * EscrowVault - Escrow contract wrapper
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
      'createEscrow': 1.30,      // 30% - External token transfer + storage
      'releaseEscrow': 1.30,     // 30% - Multi-recipient disbursement
      'approveToken': 1.20       // 20% - Standard ERC20 approval
    };

    return buffers[operation] || 1.20; // Default 20% for unknown operations
  }

  /**
   * Build transaction options with gas settings and estimated gas
   * V6 Enhancement: Dynamic buffer based on operation type
   */
  private buildTxOptions(estimatedGas: BigNumber, operation: string = 'default'): any {
    const bufferMultiplier = this.getGasBufferMultiplier(operation);

    const options: any = {
      gasLimit: estimatedGas.mul(Math.round(bufferMultiplier * 100)).div(100)
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
   * Create escrow
   * Note: Caller must approve token transfer first
   */
  async createEscrow(params: CreateEscrowParams): Promise<string> {
    const { kernelAddress, txId, token, amount, beneficiary } = params;

    // Input validation
    validateAddress(kernelAddress, 'kernelAddress');
    validateTxId(txId, 'txId');
    validateAddress(token, 'token');
    validateAmount(amount, 'amount');
    validateAddress(beneficiary, 'beneficiary');

    try {
      // Approve token transfer
      await this.approveToken(token, amount);

      // Estimate gas with safety buffer (30% for external token transfer + storage)
      const estimatedGas = await this.contract.estimateGas.createEscrow(
        kernelAddress,
        txId,
        token,
        amount,
        beneficiary
      );

      // Build tx options with gas settings
      const txOptions = this.buildTxOptions(estimatedGas, 'createEscrow');

      // Create escrow
      const tx = await this.contract.createEscrow(
        kernelAddress,
        txId,
        token,
        amount,
        beneficiary,
        txOptions
      );

      const receipt: ContractReceipt = await tx.wait();
      return this.extractEscrowId(receipt);
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Get escrow details
   */
  async getEscrow(escrowId: string): Promise<Escrow> {
    const escrowData = await this.contract.escrows(escrowId);

    return {
      escrowId,
      kernel: escrowData.kernel,
      txId: escrowData.txId,
      token: escrowData.token,
      amount: escrowData.amount,
      beneficiary: escrowData.beneficiary,
      createdAt: 0, // Not exposed in minimal ABI
      released: escrowData.released
    };
  }

  /**
   * Get escrow balance
   */
  async getEscrowBalance(escrowId: string): Promise<BigNumber> {
    const escrow = await this.getEscrow(escrowId);
    return escrow.amount;
  }

  /**
   * Release escrow to recipients
   * Note: Only callable by authorized kernel
   */
  async releaseEscrow(
    escrowId: string,
    recipients: string[],
    amounts: BigNumber[]
  ): Promise<void> {
    // Input validation
    validateTxId(escrowId, 'escrowId');

    if (recipients.length !== amounts.length) {
      throw new ValidationError('recipients/amounts', 'Recipients and amounts length mismatch');
    }

    if (recipients.length === 0) {
      throw new ValidationError('recipients', 'Must provide at least one recipient');
    }

    // Validate each recipient and amount
    recipients.forEach((recipient, i) => {
      validateAddress(recipient, `recipients[${i}]`);
      validateAmount(amounts[i], `amounts[${i}]`);
    });

    try {
      // Estimate gas with safety buffer (30% for multi-recipient disbursement)
      const estimatedGas = await this.contract.estimateGas.disburse(escrowId, recipients, amounts);
      const txOptions = this.buildTxOptions(estimatedGas, 'releaseEscrow');

      const tx = await this.contract.disburse(escrowId, recipients, amounts, txOptions);

      await tx.wait();
    } catch (error: any) {
      throw new TransactionRevertedError(error.transactionHash, error.reason || error.message);
    }
  }

  /**
   * Approve token for escrow creation
   * Implements USDC-compatible approval pattern (reset to zero before setting new value)
   */
  private async approveToken(tokenAddress: string, amount: BigNumber): Promise<void> {
    // Validation already done in createEscrow, but double-check
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
      if (currentAllowance.lt(amount)) {
        // USDC-compatible approval pattern:
        // If any residual allowance exists, reset to zero first
        if (currentAllowance.gt(0)) {
          const resetGas = await tokenContract.estimateGas.approve(this.address, 0);
          const resetTx = await tokenContract.approve(this.address, 0, this.buildTxOptions(resetGas, 'approveToken'));
          await resetTx.wait();
        }

        // Now set the new allowance
        const approveGas = await tokenContract.estimateGas.approve(this.address, amount);
        const approveTx = await tokenContract.approve(this.address, amount, this.buildTxOptions(approveGas, 'approveToken'));
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
   * Check token balance
   */
  async getTokenBalance(tokenAddress: string, account: string): Promise<BigNumber> {
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
  ): Promise<BigNumber> {
    const tokenContract = new Contract(tokenAddress, ERC20ABI, this.signer);
    return await tokenContract.allowance(owner, spender);
  }

  /**
   * Extract escrow ID from receipt
   */
  private extractEscrowId(receipt: ContractReceipt): string {
    const event = receipt.events?.find((e) => e.event === 'EscrowCreated');
    if (!event || !event.args) {
      throw new Error('EscrowCreated event not found in receipt');
    }
    return event.args.escrowId;
  }
}
