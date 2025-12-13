"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EscrowVault = void 0;
const ethers_1 = require("ethers");
const EscrowVault_json_1 = __importDefault(require("../abi/EscrowVault.json"));
const ERC20_json_1 = __importDefault(require("../abi/ERC20.json"));
const errors_1 = require("../errors");
const validation_1 = require("../utils/validation");
/**
 * EscrowVault - Escrow contract wrapper
 *
 * IMPORTANT: Per AIP-3 specification, escrow creation happens atomically
 * inside ACTPKernel.linkEscrow(). This module provides read-only access
 * to escrow state and helper methods for USDC approvals.
 *
 * Workflow (per AIP-3):
 * 1. Consumer approves USDC to EscrowVault address (use approveToken)
 * 2. Consumer calls ACTPKernel.linkEscrow(txId, escrowVault, escrowId)
 * 3. Kernel internally calls EscrowVault.createEscrow() (onlyKernel modifier)
 * 4. Escrow pulls USDC from consumer and auto-transitions to COMMITTED
 *
 * Reference: AIP-3 §3.2 (Escrow Linking Workflow), lines 258-336
 */
class EscrowVault {
    constructor(address, signer, gasSettings) {
        this.address = address;
        this.signer = signer;
        this.contract = new ethers_1.Contract(address, EscrowVault_json_1.default, signer);
        this.gasSettings = gasSettings;
    }
    /**
     * Get gas buffer multiplier based on operation complexity
     * V6 Security Enhancement: Operation-specific gas buffers
     * Reference: SDK_SECURITY_ANALYSIS-Ultra-Think.md Lines 326-337
     */
    getGasBufferMultiplier(operation) {
        const buffers = {
            'releaseEscrow': 1.30, // 30% - Multi-recipient disbursement
            'approveToken': 1.20 // 20% - Standard ERC20 approval
        };
        return buffers[operation] || 1.20; // Default 20% for unknown operations
    }
    /**
     * Build transaction options with gas settings and estimated gas
     * V6 Enhancement: Dynamic buffer based on operation type
     *
     * SECURITY FIX (NEW-C-1): Gas estimation manipulation attack protection
     * - Enforces minimum gas floor regardless of estimate
     * - Uses safe BigInt arithmetic with overflow detection
     */
    buildTxOptions(estimatedGas, operation = 'default') {
        // SECURITY FIX (NEW-C-1): Minimum gas floor to prevent manipulation
        // Malicious contracts could return artificially low gas estimates
        const MIN_GAS_FLOOR = 100000n;
        const safeEstimate = estimatedGas > MIN_GAS_FLOOR ? estimatedGas : MIN_GAS_FLOOR;
        const bufferMultiplier = this.getGasBufferMultiplier(operation);
        // SECURITY FIX (NEW-H-1): Safe BigInt arithmetic with overflow check
        // Use 10000 denominator to avoid floating point precision issues
        const bufferNumerator = BigInt(Math.floor(bufferMultiplier * 10000));
        const bufferDenominator = 10000n;
        const gasLimit = (safeEstimate * bufferNumerator) / bufferDenominator;
        // Overflow detection: result should always be >= original estimate
        if (gasLimit < safeEstimate) {
            throw new Error(`Gas calculation overflow detected for operation ${operation}. ` +
                `Estimate: ${safeEstimate}, Buffer: ${bufferMultiplier}x, Result: ${gasLimit}`);
        }
        const options = {
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
    getAddress() {
        return this.address;
    }
    /**
     * Get the underlying ethers Contract instance.
     *
     * SECURITY FIX (C-3): Provides public access to contract for EventMonitor
     * instead of accessing private field via bracket notation.
     *
     * @returns ethers Contract instance
     */
    getContract() {
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
    async approveToken(tokenAddress, amount) {
        (0, validation_1.validateAddress)(tokenAddress, 'tokenAddress');
        (0, validation_1.validateAmount)(amount, 'amount');
        const tokenContract = new ethers_1.Contract(tokenAddress, ERC20_json_1.default, this.signer);
        try {
            // Check current allowance
            const currentAllowance = await tokenContract.allowance(await this.signer.getAddress(), this.address);
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
        }
        catch (error) {
            throw new errors_1.TransactionRevertedError(error.transactionHash, `Token approval failed: ${error.reason || error.message}`);
        }
    }
    /**
     * Get escrow details
     */
    async getEscrow(escrowId) {
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
    async getEscrowBalance(escrowId) {
        const escrow = await this.getEscrow(escrowId);
        return escrow.amount;
    }
    /**
     * Release escrow to recipients
     * Note: Only callable by authorized kernel
     */
    async releaseEscrow(escrowId, recipients, amounts) {
        // Input validation
        (0, validation_1.validateTxId)(escrowId, 'escrowId');
        if (recipients.length !== amounts.length) {
            throw new errors_1.ValidationError('recipients/amounts', 'Recipients and amounts length mismatch');
        }
        if (recipients.length === 0) {
            throw new errors_1.ValidationError('recipients', 'Must provide at least one recipient');
        }
        // Validate each recipient and amount
        recipients.forEach((recipient, i) => {
            (0, validation_1.validateAddress)(recipient, `recipients[${i}]`);
            (0, validation_1.validateAmount)(amounts[i], `amounts[${i}]`);
        });
        try {
            // ethers v6: use getFunction()
            const disburseFunc = this.contract.getFunction('disburse');
            // Estimate gas with safety buffer (30% for multi-recipient disbursement)
            const estimatedGas = await disburseFunc.estimateGas(escrowId, recipients, amounts);
            const txOptions = this.buildTxOptions(estimatedGas, 'releaseEscrow');
            const tx = await disburseFunc(escrowId, recipients, amounts, txOptions);
            await tx.wait();
        }
        catch (error) {
            throw new errors_1.TransactionRevertedError(error.transactionHash, error.reason || error.message);
        }
    }
    /**
     * Check token balance
     */
    async getTokenBalance(tokenAddress, account) {
        const tokenContract = new ethers_1.Contract(tokenAddress, ERC20_json_1.default, this.signer);
        return await tokenContract.balanceOf(account);
    }
    /**
     * Check token allowance
     */
    async getTokenAllowance(tokenAddress, owner, spender) {
        const tokenContract = new ethers_1.Contract(tokenAddress, ERC20_json_1.default, this.signer);
        return await tokenContract.allowance(owner, spender);
    }
}
exports.EscrowVault = EscrowVault;
//# sourceMappingURL=EscrowVault.js.map