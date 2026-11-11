/**
 * Amounts for the `tx` and receipt displays.
 *
 * For an escrow in a recognized FeeSplitVault, funding or retired, every amount comes from the
 * payout breakdown: the kernel's amounts are before the vault's fees. For an escrow in a vault the
 * configuration does not know, the kernel amounts are shown and labelled as not verified. For the
 * plain EscrowVault nothing changes.
 *
 * @module feesplit/display
 */

import type { MockTransaction } from '../runtime/types/MockState';
import type { FeeSplitSupport } from './FeeSplitSupport';
import type { PayoutBreakdown, PayoutMovement } from './breakdown';

/** Label of amounts taken from kernel data for a vault the configuration does not list. */
export const UNRECOGNIZED_VAULT_NOTE = 'unrecognized vault, amounts not verified';

/** Amounts of one escrow as the parties received them, in USDC wei. */
export interface VerifiedAmounts {
  providerReceived: bigint;
  /** Kernel fee on the provider side. */
  providerSideProtocolFee: bigint;
  /** Integrator share on the provider side, paid or credited. */
  providerSidePlatformFee: bigint;
  /** What the kernel refunded, before the vault's fees. */
  refunded: bigint;
  requesterReceived: bigint;
  refundSideProtocolFee: bigint;
  refundSidePlatformFee: bigint;
}

/** How the amounts of a transaction are to be shown. */
export type EscrowAmountsView =
  | { kind: 'plain' }
  | { kind: 'unrecognized'; note: string }
  | { kind: 'feeSplit'; breakdown: PayoutBreakdown; amounts: VerifiedAmounts };

function sum(movements: PayoutMovement[], kind: PayoutMovement['kind'], fields: (keyof Omit<PayoutMovement, 'kind'>)[]): bigint {
  return movements
    .filter(movement => movement.kind === kind)
    .reduce((total, movement) => fields.reduce((inner, field) => inner + BigInt(movement[field]), total), 0n);
}

/** The amounts each party received, from a payout breakdown. */
export function verifiedAmounts(breakdown: PayoutBreakdown): VerifiedAmounts {
  const { movements, totals } = breakdown;
  return {
    providerReceived: BigInt(totals.providerReceived),
    providerSideProtocolFee: BigInt(totals.kernelFee),
    providerSidePlatformFee: sum(movements, 'released', ['integratorPaid', 'integratorCredited']),
    refunded: sum(movements, 'refunded', ['kernelAmount']),
    requesterReceived: BigInt(totals.requesterReceived),
    refundSideProtocolFee: sum(movements, 'refunded', ['vaultProtocolFee']),
    refundSidePlatformFee: sum(movements, 'refunded', ['integratorPaid', 'integratorCredited']),
  };
}

/**
 * Decide how to show the amounts of `tx`. The vault is read from `tx.escrowContract` only; a linked
 * escrow without it is unrecognized.
 */
export async function escrowAmountsView(
  support: FeeSplitSupport | undefined,
  tx: Pick<MockTransaction, 'id' | 'escrowId' | 'escrowContract'>
): Promise<EscrowAmountsView> {
  if (!support || tx.escrowId === null || tx.escrowId === undefined) return { kind: 'plain' };
  const kind = support.vaultKind(tx.escrowContract);
  if (kind === 'plain') return { kind: 'plain' };
  if (kind === 'unrecognized' || tx.escrowContract === undefined) {
    return { kind: 'unrecognized', note: UNRECOGNIZED_VAULT_NOTE };
  }
  const breakdown = await support.payoutBreakdown(tx.escrowContract, tx.id);
  return { kind: 'feeSplit', breakdown, amounts: verifiedAmounts(breakdown) };
}

/**
 * One line for the `tx` display, or undefined while nothing was paid out. `format` renders USDC wei.
 * Example: "980.00 USDC to provider (1000.00 committed, 10.00 protocol fee, 10.00 platform fee)".
 */
export function breakdownSummary(amounts: VerifiedAmounts, committedWei: string, format: (wei: string) => string): string | undefined {
  const f = (value: bigint): string => format(value.toString());
  const parts: string[] = [];
  if (amounts.providerReceived > 0n || amounts.providerSideProtocolFee > 0n) {
    parts.push(
      `${f(amounts.providerReceived)} USDC to provider (${format(committedWei)} committed, ` +
        `${f(amounts.providerSideProtocolFee)} protocol fee, ${f(amounts.providerSidePlatformFee)} platform fee)`
    );
  }
  if (amounts.refunded > 0n) {
    parts.push(
      `refunded ${f(amounts.refunded)}, received ${f(amounts.requesterReceived)}, ` +
        `protocol ${f(amounts.refundSideProtocolFee)}, platform ${f(amounts.refundSidePlatformFee)}`
    );
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** Amounts for the framed receipt of a settled job; undefined for an escrow in the plain vault. */
export interface ReceiptAmounts {
  netWei?: bigint;
  feeWei?: bigint;
  platformFeeWei?: bigint;
  note?: string;
}

/** Receipt amounts of `txId`, read through `runtime`. */
export async function receiptAmountsFor(
  runtime: { getTransaction(txId: string): Promise<MockTransaction | null>; feeSplit?: FeeSplitSupport } | undefined,
  txId: string
): Promise<ReceiptAmounts | undefined> {
  const tx = await runtime?.getTransaction(txId);
  if (!runtime || !tx) return undefined;
  const view = await escrowAmountsView(runtime.feeSplit, tx);
  if (view.kind === 'plain') return undefined;
  if (view.kind === 'unrecognized') return { note: view.note };
  return {
    netWei: view.amounts.providerReceived,
    feeWei: view.amounts.providerSideProtocolFee,
    platformFeeWei: view.amounts.providerSidePlatformFee,
  };
}

/**
 * Receipt amounts for a display that must not fail after a settled job: when the breakdown cannot
 * be read, the receipt says that its amounts are not verified, and why.
 */
export async function receiptAmountsOrNote(
  runtime: Parameters<typeof receiptAmountsFor>[0],
  txId: string
): Promise<ReceiptAmounts | undefined> {
  try {
    return await receiptAmountsFor(runtime, txId);
  } catch (error) {
    return { note: `amounts not verified: ${error instanceof Error ? error.message : String(error)}` };
  }
}
