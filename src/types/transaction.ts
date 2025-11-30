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
  deadline: number;
  disputeWindow: number;
  escrowContract: string;
  escrowId: string;
  metadata: string;
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


