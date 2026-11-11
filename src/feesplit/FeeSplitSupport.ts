/**
 * What a runtime offers for FeeSplitVault escrows: the funding preflight with the client's default
 * terms, funding of an existing transaction, the provider's approval, disclosure and breakdown.
 *
 * @module feesplit/FeeSplitSupport
 */

import { assertFeeSplitTermsLocked, resolveFeeSplitFunding } from './funding';
import type { PayoutBreakdown } from './breakdown';
import type {
  DisputeFeeQuote,
  FeeSplitFundingOptions,
  FeeSplitReader,
  FeeSplitVaultEntry,
  IntegratorTerms,
  LockedTerms,
  ResolvedFeeSplitFunding,
} from './types';

/** Refund quotes of one escrow. The two are never interchangeable. */
export interface RefundQuotes {
  /** What a refund of the remaining principal would pay now: fee-free while the escrow is undisputed. */
  actualRefundQuote: DisputeFeeQuote;
  /**
   * What a full refund of the remaining principal would pay if the escrow were disputed now: the
   * largest refund-side fee the job can incur. A split ruling refunds less and both fees scale down.
   */
  ifDisputedRefundQuote: DisputeFeeQuote;
}

/** The part of a wallet provider that FeeSplitVault support sends through. */
export interface FeeSplitWallet {
  sendTransaction(tx: { to: string; data: string }): Promise<{ hash: string; success: boolean }>;
}

/**
 * What the vault of an escrow is to this network: the plain EscrowVault, the FeeSplitVault that
 * funds new escrows, a retired FeeSplitVault, or an address the configuration does not know. A
 * missing vault address is unrecognized; nothing falls back to "the configured vault".
 */
export type EscrowVaultKind = 'plain' | 'funding' | 'retired' | 'unrecognized';

/** FeeSplitVault support of one runtime. */
export abstract class FeeSplitSupport {
  private defaults?: IntegratorTerms;
  protected wallet?: FeeSplitWallet;

  constructor(
    private readonly vaultList: readonly FeeSplitVaultEntry[],
    private readonly plainVault: string
  ) {}

  /** Classify the vault a transaction is linked to (`tx.escrowContract`). */
  vaultKind(escrowContract: string | undefined): EscrowVaultKind {
    if (escrowContract === undefined) return 'unrecognized';
    const address = escrowContract.toLowerCase();
    if (address === this.plainVault.toLowerCase()) return 'plain';
    const entry = this.vaults().find(vault => vault.address.toLowerCase() === address);
    if (!entry) return 'unrecognized';
    return entry.funding ? 'funding' : 'retired';
  }

  /** The wallet whose address is the client's identity; provider approvals are sent from it. */
  useWallet(wallet: FeeSplitWallet | undefined): void {
    this.wallet = wallet;
  }

  /** Client-level default terms; a per-call `integrator` replaces them. */
  setDefaults(terms: IntegratorTerms | undefined): void {
    this.defaults = terms;
  }

  /** The network's FeeSplitVault list. */
  vaults(): readonly FeeSplitVaultEntry[] {
    return this.vaultList;
  }

  abstract reader(): FeeSplitReader;

  /** The funding preflight for a job of `amount` with `provider`; undefined means plain funding. */
  resolve(
    provider: string,
    amount: bigint,
    options?: FeeSplitFundingOptions,
    txId?: string
  ): Promise<ResolvedFeeSplitFunding | undefined> {
    return resolveFeeSplitFunding({
      defaults: this.defaults,
      integrator: options?.integrator,
      acknowledgeDisputeFee: options?.acknowledgeDisputeFee,
      provider,
      amount,
      txId,
      vaults: this.vaults(),
      reader: this.reader(),
    });
  }

  /**
   * After funding: the vault must have locked exactly the requested terms.
   *
   * @throws FeeSplitTermsNotLockedError when the escrow carries other terms or none
   */
  assertLocked(txId: string, funding: ResolvedFeeSplitFunding): Promise<LockedTerms> {
    return assertFeeSplitTermsLocked(this.reader(), txId, funding);
  }

  /** Fund an existing transaction through the FeeSplitVault: approve, register terms, link. */
  abstract link(txId: string, amount: string, funding: ResolvedFeeSplitFunding): Promise<string>;

  /**
   * Provider side: approve `integrator` up to `maxBps` in the funding vault; 0 revokes. On chain
   * the signer is the provider; the mock, which has no signer, needs `provider`.
   */
  abstract setIntegratorApproval(integrator: string, maxBps: number, provider?: string): Promise<void>;

  /** Terms the vault at `vault` locked for `txId`. */
  lockedTerms(vault: string, txId: string): Promise<LockedTerms> {
    return this.reader().lockedTerms(vault, txId);
  }

  /** Actual and hypothetical refund quotes of a funded escrow in `vault`. */
  abstract refundQuotes(vault: string, txId: string): Promise<RefundQuotes>;

  /** Who received what from the escrow of `txId` in `vault`. */
  abstract payoutBreakdown(vault: string, txId: string): Promise<PayoutBreakdown>;
}
