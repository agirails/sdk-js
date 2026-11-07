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
  /**
   * ⚠️ **This field carries two different meanings depending on `state`.**
   *
   * - **before `DELIVERED`** — a **duration in seconds** (as requested at creation;
   *   kernel default 172800 = 2 days, min 3600 = 1 hour, max 30 days)
   * - **from `DELIVERED` onward** — an **absolute UNIX timestamp** at which the window
   *   closes. The kernel overwrites the field on delivery with `block.timestamp + window`
   *   (`ACTPKernel.sol`, DELIVERED transition; the provider may extend the window but
   *   never shorten it).
   *
   * Reading it without checking `state` produces nonsense — a duration interpreted as a
   * timestamp lands in 1970, a timestamp interpreted as a duration lands ~57 years out.
   *
   * Use {@link DisputeWindow.deadlineOf} / {@link DisputeWindow.remainingFor}, which
   * resolve this correctly from the transaction.
   *
   * *(Reported by an external integrator 2026-04-11; documented 2026-08-09.)*
   */
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
  /** AIP-14: Requester's ERC-8004 agent ID (0 = not an agent) */
  requesterAgentId?: string;
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
   * Canonical v2 `agreementHash` = keccak(request + input + SLA). Optional and
   * backward-compatible: omit (or pass `bytes32(0)`) to signal "no auto AI
   * ruling". Encoded as the 7th `createTransaction` arg (between serviceHash and
   * agentId) so the SDK targets the canonical 9-input function.
   */
  agreementHash?: string;
  /**
   * ERC-8004 agent token ID (optional).
   * Set to 0 or omit if provider is not registered in ERC-8004 Identity Registry.
   * See ADR-001 for architectural rationale.
   */
  agentId?: string;
  /** AIP-14: Requester's ERC-8004 agent ID (0 or omit if requester is not an agent) */
  requesterAgentId?: string;
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

