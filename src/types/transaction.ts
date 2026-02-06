import { State } from './state';

/**
 * ACTP Transaction
 * Reference: Yellow Paper §3.1
 */
export interface Transaction {
  txId: string;
  requester: string;
  provider: string;
  amount: bigint;
  state: State;
  createdAt: number;
  updatedAt: number;
  deadline: number;
  disputeWindow: number;
  escrowContract: string;
  escrowId: string;
  serviceHash: string;
  attestationUID: string;
  metadata: string;
  platformFeeBpsLocked: number;
  /**
   * ERC-8004 agent token ID (optional).
   * 0 or undefined = not an ERC-8004 agent.
   * See ADR-001 for architectural rationale.
   */
  agentId?: string;
}

/**
 * Parameters for creating a new transaction
 */
export interface CreateTransactionParams {
  provider: string;
  requester: string;
  amount: bigint;
  deadline: number;
  disputeWindow: number;
  metadata?: string;
  /**
   * ERC-8004 agent token ID (optional).
   * Set to 0 or omit if provider is not registered in ERC-8004 Identity Registry.
   * See ADR-001 for architectural rationale.
   */
  agentId?: string;
}

/**
 * Dispute resolution split
 */
export interface DisputeResolution {
  requesterAmount: bigint;
  providerAmount: bigint;
  mediatorAmount: bigint;
  mediator?: string;
}

/**
 * Economic parameters (fee structure)
 */
export interface EconomicParams {
  baseFeeNumerator: number;
  baseFeeDenominator: number;
  feeRecipient: string;
  requesterPenaltyBps: number;
  providerPenaltyBps: number;
}

