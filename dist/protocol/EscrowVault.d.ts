import { Contract, Signer } from 'ethers';
import { Escrow } from '../types';
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
export declare class EscrowVault {
    private readonly address;
    private readonly signer;
    private contract;
    private readonly gasSettings?;
    constructor(address: string, signer: Signer, gasSettings?: GasOptions);
    /**
     * Get gas buffer multiplier based on operation complexity
     * V6 Security Enhancement: Operation-specific gas buffers
     * Reference: SDK_SECURITY_ANALYSIS-Ultra-Think.md Lines 326-337
     */
    private getGasBufferMultiplier;
    /**
     * Build transaction options with gas settings and estimated gas
     * V6 Enhancement: Dynamic buffer based on operation type
     *
     * SECURITY FIX (NEW-C-1): Gas estimation manipulation attack protection
     * - Enforces minimum gas floor regardless of estimate
     * - Uses safe BigInt arithmetic with overflow detection
     */
    private buildTxOptions;
    /**
     * Get escrow vault address
     */
    getAddress(): string;
    /**
     * Get the underlying ethers Contract instance.
     *
     * SECURITY FIX (C-3): Provides public access to contract for EventMonitor
     * instead of accessing private field via bracket notation.
     *
     * @returns ethers Contract instance
     */
    getContract(): Contract;
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
    approveToken(tokenAddress: string, amount: bigint): Promise<void>;
    /**
     * Get escrow details
     */
    getEscrow(escrowId: string): Promise<Escrow>;
    /**
     * Get escrow balance
     */
    getEscrowBalance(escrowId: string): Promise<bigint>;
    /**
     * Release escrow to recipients
     * Note: Only callable by authorized kernel
     */
    releaseEscrow(escrowId: string, recipients: string[], amounts: bigint[]): Promise<void>;
    /**
     * Check token balance
     */
    getTokenBalance(tokenAddress: string, account: string): Promise<bigint>;
    /**
     * Check token allowance
     */
    getTokenAllowance(tokenAddress: string, owner: string, spender: string): Promise<bigint>;
}
export {};
//# sourceMappingURL=EscrowVault.d.ts.map