/**
 * Escrow creation parameters
 */
export interface CreateEscrowParams {
    kernelAddress: string;
    txId: string;
    token: string;
    amount: bigint;
    beneficiary: string;
}
/**
 * Escrow state
 */
export interface Escrow {
    escrowId: string;
    kernel: string;
    txId: string;
    token: string;
    amount: bigint;
    beneficiary: string;
    createdAt: number;
    released: boolean;
}
//# sourceMappingURL=escrow.d.ts.map