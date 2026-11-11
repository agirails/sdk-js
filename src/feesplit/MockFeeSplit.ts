/**
 * FeeSplitVault support of MockRuntime, backed by the mock state file.
 *
 * @module feesplit/MockFeeSplit
 */

import { TransactionNotFoundError } from '../errors';
import type { MockStateManager } from '../runtime/MockStateManager';
import type { MockEvent, MockTransaction } from '../runtime/types/MockState';
import { FeeSplitSupport, type RefundQuotes } from './FeeSplitSupport';
import { assertFeeSplitPreflight } from './funding';
import { joinPayoutBreakdown, type KernelPayout, type PayoutBreakdown, type VaultSplit } from './breakdown';
import { MOCK_ESCROW_VAULT, MOCK_FEE_SPLIT_VAULT } from './mockLedger';
import { previewDisputeRefund, refundFees } from './rules';
import type {
  DisputeFeeQuote,
  FeeSplitFundingOptions,
  FeeSplitReader,
  FeeSplitVaultEntry,
  LockedTerms,
  ResolvedFeeSplitFunding,
} from './types';

const DEFAULT_PROTOCOL_BPS = 100;
const NO_TERMS: LockedTerms = {
  integrator: '0x0000000000000000000000000000000000000000',
  bps: 0,
  profile: 'PAYOUT_ONLY',
  state: 'NONE',
  protocolBps: 0,
  disputed: false,
  used: false,
};

function quote(refundAmount: bigint, protocolFee: bigint, integratorFee: bigint): DisputeFeeQuote {
  return {
    refundAmount: refundAmount.toString(),
    requesterAmount: (refundAmount - protocolFee - integratorFee).toString(),
    protocolFee: protocolFee.toString(),
    integratorFee: integratorFee.toString(),
  };
}

function amountOf(event: MockEvent, field: string): bigint {
  const value = event.data[field];
  if (typeof value !== 'string') throw new Error(`Mock event ${event.type} has no ${field}`);
  return BigInt(value);
}

/** FeeSplitVault support over mock state. */
export class MockFeeSplit extends FeeSplitSupport {
  private vaultOverride?: readonly FeeSplitVaultEntry[];

  /**
   * @param stateManager - the mock state
   * @param linkWith - MockRuntime's escrow link for an already resolved funding
   */
  constructor(
    private readonly stateManager: MockStateManager,
    private readonly linkWith: (txId: string, amount: string, funding: ResolvedFeeSplitFunding) => Promise<string>
  ) {
    super([{ address: MOCK_FEE_SPLIT_VAULT, funding: true }], MOCK_ESCROW_VAULT);
  }

  /** Replace the vault list, as a network configuration change would (retiring a vault). */
  configureVaults(vaults: readonly FeeSplitVaultEntry[]): void {
    this.vaultOverride = vaults;
  }

  override vaults(): readonly FeeSplitVaultEntry[] {
    return this.vaultOverride ?? super.vaults();
  }

  private transaction(txId: string): MockTransaction {
    const tx = this.stateManager.loadState().transactions[txId];
    if (!tx) throw new TransactionNotFoundError(txId);
    return tx;
  }

  reader(): FeeSplitReader {
    return {
      integratorMaxBps: (_vault, provider, integrator) =>
        Promise.resolve(this.stateManager.loadState().feeSplitApprovals?.[provider.toLowerCase()]?.[integrator.toLowerCase()] ?? 0),
      protocolBps: txId =>
        Promise.resolve(
          txId === undefined ? DEFAULT_PROTOCOL_BPS : this.transaction(txId).platformFeeBpsLocked ?? DEFAULT_PROTOCOL_BPS
        ),
      previewDisputeRefund: (_vault, refundAmount, protocolBps, bps) => {
        const split = previewDisputeRefund(refundAmount, protocolBps, bps);
        return Promise.resolve(quote(refundAmount, split.protocolFee, split.integratorFee));
      },
      lockedTerms: (_vault, escrowId) => Promise.resolve(this.locked(escrowId)),
    };
  }

  private locked(txId: string): LockedTerms {
    const tx = this.stateManager.loadState().transactions[txId];
    const terms = tx?.feeSplit;
    if (!tx || !terms) return { ...NO_TERMS, used: tx?.escrowId != null };
    return {
      integrator: terms.integrator,
      bps: terms.bps,
      profile: terms.profile,
      state: 'CONFIRMED',
      protocolBps: terms.protocolBps,
      disputed: tx.state === 'DISPUTED' || BigInt(terms.refundSide) > 0n,
      used: true,
    };
  }

  /** The funding preflight for an existing mock transaction; undefined when it is unknown. */
  async resolveFor(
    txId: string,
    amount: string,
    options?: FeeSplitFundingOptions
  ): Promise<ResolvedFeeSplitFunding | undefined> {
    const tx = this.stateManager.loadState().transactions[txId];
    return tx ? this.resolve(tx.provider, BigInt(amount), options, txId) : undefined;
  }

  async link(txId: string, amount: string, funding: ResolvedFeeSplitFunding): Promise<string> {
    assertFeeSplitPreflight(funding);
    const escrowId = await this.linkWith(txId, amount, funding);
    await this.assertLocked(txId, funding);
    return escrowId;
  }

  /** The mock has no signer: `provider` names the approving provider. */
  async setIntegratorApproval(integrator: string, maxBps: number, provider?: string): Promise<void> {
    if (provider === undefined) throw new Error('MockFeeSplit.setIntegratorApproval needs the provider address');
    await this.stateManager.withLock(state => {
      const approvals = state.feeSplitApprovals ?? {};
      const key = provider.toLowerCase();
      approvals[key] = { ...approvals[key], [integrator.toLowerCase()]: maxBps };
      state.feeSplitApprovals = approvals;
    });
  }

  refundQuotes(_vault: string, txId: string): Promise<RefundQuotes> {
    const state = this.stateManager.loadState();
    const tx = this.transaction(txId);
    const principal = BigInt((tx.escrowId != null ? state.escrows[tx.escrowId]?.balance : undefined) ?? '0');
    const terms = tx.feeSplit;
    const free = quote(principal, 0n, 0n);
    if (!terms || terms.profile !== 'BOTH_AFTER_DISPUTE') {
      return Promise.resolve({ actualRefundQuote: free, ifDisputedRefundQuote: free });
    }
    const fees = refundFees(
      {
        refundSide: BigInt(terms.refundSide),
        protocolTaken: BigInt(terms.protocolRefundFee),
        integratorTaken: BigInt(terms.integratorRefundFee),
      },
      principal,
      terms.protocolBps,
      terms.bps
    );
    const ifDisputed = quote(principal, fees.protocolFee, fees.integratorFee);
    return Promise.resolve({
      actualRefundQuote: tx.state === 'DISPUTED' ? ifDisputed : free,
      ifDisputedRefundQuote: ifDisputed,
    });
  }

  payoutBreakdown(vault: string, txId: string): Promise<PayoutBreakdown> {
    const state = this.stateManager.loadState();
    const tx = this.transaction(txId);
    const kernel: KernelPayout[] = [];
    const splits: VaultSplit[] = [];
    for (const event of tx.events) {
      if (event.type === 'EscrowReleased') kernel.push({ kind: 'released', amount: amountOf(event, 'amount') });
      if (event.type === 'EscrowRefunded') kernel.push({ kind: 'refunded', amount: amountOf(event, 'amount') });
      if (event.type === 'IntegratorFeeSplit' || event.type === 'RefundFeeSplit') {
        splits.push({
          kind: event.type === 'IntegratorFeeSplit' ? 'released' : 'refunded',
          kernelAmount: amountOf(event, 'kernelAmount'),
          received: amountOf(event, 'received'),
          integratorAmount: amountOf(event, 'integratorAmount'),
          integratorCredited: false,
          protocolFee: event.type === 'RefundFeeSplit' ? amountOf(event, 'protocolFee') : 0n,
          protocolCredited: false,
        });
      }
    }
    const principal = BigInt((tx.escrowId != null ? state.escrows[tx.escrowId]?.balance : undefined) ?? '0');
    return Promise.resolve(joinPayoutBreakdown({ txId, vault, deposit: BigInt(tx.amount), principal, kernel, splits }));
  }
}
