/**
 * Escrow creation parameters
 */
export interface CreateEscrowParams {
  /** Escrow identifier (bytes32). In ACTP standard this is typically the txId. */
  escrowId: string;
  /** Consumer/requester who funds the escrow */
  requester: string;
  /** Provider who receives payout on settlement */
  provider: string;
  /** Amount locked in escrow (USDC wei, 6 decimals) */
  amount: bigint;
}

/**
 * Escrow state (matches on-chain EscrowVault.EscrowData struct)
 */
export interface Escrow {
  escrowId: string;
  requester: string;
  provider: string;
  amount: bigint;
  releasedAmount: bigint;
  active: boolean;
}


