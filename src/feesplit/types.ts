/**
 * Types of the integrator fee vault (FeeSplitVault, AIP-20 draft).
 *
 * @module feesplit/types
 */

/** Fee profile of one escrow, chosen by the requester's registration. */
export type FeeProfile = 'PAYOUT_ONLY' | 'BOTH_AFTER_DISPUTE';

/** Integrator, rate and profile requested for one escrow. */
export interface IntegratorTerms {
  /** Address that receives the integrator share. */
  address: string;
  /** Integrator rate in basis points of the gross job amount, 1 to 1000. */
  bps: number;
  /** PAYOUT_ONLY, or BOTH_AFTER_DISPUTE: refunds that follow a dispute also pay fees. */
  profile: FeeProfile;
}

/** One FeeSplitVault of a network. The list is append-only; at most one entry funds new escrows. */
export interface FeeSplitVaultEntry {
  address: string;
  /** True for the vault new escrows are funded through; false for a retired vault. */
  funding: boolean;
}

/** Per-call funding options of every pay and link path. */
export interface FeeSplitFundingOptions {
  /** Terms for this call; overrides the client-level default. */
  integrator?: IntegratorTerms;
  /**
   * Required, for this call, when the profile is BOTH_AFTER_DISPUTE: the caller has shown the
   * requester the fees a refund pays after a dispute. A client-level default never counts.
   */
  acknowledgeDisputeFee?: boolean;
}

/** Split of a refund that follows a dispute, in USDC wei. */
export interface DisputeFeeQuote {
  refundAmount: string;
  requesterAmount: string;
  protocolFee: string;
  integratorFee: string;
}

/** Terms the vault locked for an escrow. */
export interface LockedTerms {
  integrator: string;
  bps: number;
  profile: FeeProfile;
  /** NONE, PENDING_CONFIRM, CONFIRMED or VOID. */
  state: 'NONE' | 'PENDING_CONFIRM' | 'CONFIRMED' | 'VOID';
  protocolBps: number;
  disputed: boolean;
  used: boolean;
}

/** Opaque proof that `resolveFeeSplitFunding` ran for exactly these terms. */
export interface FeeSplitPreflightToken {
  readonly kind: 'FeeSplitPreflightToken';
}

/** Outcome of the funding preflight: where to fund, with which terms. */
export interface ResolvedFeeSplitFunding {
  /** The funding FeeSplitVault. */
  vault: string;
  terms: IntegratorTerms;
  /**
   * BOTH_AFTER_DISPUTE only: the largest refund-side fees the job can incur, that is the split of a
   * full refund of the whole amount after a dispute. Not a prediction of a split ruling.
   */
  ifDisputedRefundQuote?: DisputeFeeQuote;
  token: FeeSplitPreflightToken;
}

/** On-chain reads the funding preflight and the disclosure need. */
export interface FeeSplitReader {
  /** Maximum rate `provider` approved for `integrator` in `vault`. */
  integratorMaxBps(vault: string, provider: string, integrator: string): Promise<number>;
  /** Locked protocol rate of `txId` when the transaction exists, else the kernel's live rate. */
  protocolBps(txId?: string): Promise<number>;
  /** The vault's hypothetical split of a post-dispute refund for proposed terms. */
  previewDisputeRefund(vault: string, refundAmount: bigint, protocolBps: number, bps: number): Promise<DisputeFeeQuote>;
  lockedTerms(vault: string, escrowId: string): Promise<LockedTerms>;
}
