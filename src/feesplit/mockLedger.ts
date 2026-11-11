/**
 * The fee rules of FeeSplitVault applied to MockRuntime state.
 *
 * The mock has no kernel fee, so the provider side is the whole released amount. The integrator
 * share and the post-dispute refund fees follow the same rules as the contract.
 *
 * @module feesplit/mockLedger
 */

import type { MockEvent, MockState, MockTransaction } from '../runtime/types/MockState';
import { integratorProviderTarget, refundFees } from './rules';
import type { ResolvedFeeSplitFunding } from './types';

/** `escrowContract` of an escrow in the mock's plain vault. */
export const MOCK_ESCROW_VAULT = '0x00000000000000000000000000000000000e5c01';
/** `escrowContract` of an escrow in the mock's FeeSplitVault. */
export const MOCK_FEE_SPLIT_VAULT = '0x00000000000000000000000000000000000f5b01';
/** Mock account that receives the refund-side protocol fee. */
export const MOCK_FEE_RECIPIENT = '0x00000000000000000000000000000000000fee01';

const DEFAULT_PROTOCOL_BPS = 100;

/** Add `amount` to a mock account, creating it when needed. */
export function creditMockAccount(state: MockState, address: string, amount: bigint): void {
  const account = state.accounts[address] ?? { address, usdcBalance: '0' };
  account.usdcBalance = (BigInt(account.usdcBalance) + amount).toString();
  state.accounts[address] = account;
}

/** Record the vault, and the terms when the escrow was funded through the FeeSplitVault. */
export function recordMockLink(tx: MockTransaction, funding: ResolvedFeeSplitFunding | undefined): void {
  tx.escrowContract = funding ? funding.vault : MOCK_ESCROW_VAULT;
  if (!funding) return;
  tx.feeSplit = {
    integrator: funding.terms.address,
    bps: funding.terms.bps,
    profile: funding.terms.profile,
    protocolBps: tx.platformFeeBpsLocked ?? DEFAULT_PROTOCOL_BPS,
    providerSide: '0',
    integratorProviderSide: '0',
    refundSide: '0',
    protocolRefundFee: '0',
    integratorRefundFee: '0',
  };
}

/** Pay `amount` to the provider side of `tx`: the integrator share comes out of it. */
export function payMockProviderSide(
  state: MockState,
  tx: MockTransaction,
  amount: bigint,
  at: { timestamp: number; blockNumber: number }
): MockEvent[] {
  const terms = tx.feeSplit;
  if (!terms) {
    creditMockAccount(state, tx.provider, amount);
    return [];
  }
  const providerSide = BigInt(terms.providerSide) + amount;
  const target = integratorProviderTarget(providerSide, BigInt(tx.amount), terms.bps, terms.protocolBps);
  const cut = target - BigInt(terms.integratorProviderSide);
  terms.providerSide = providerSide.toString();
  terms.integratorProviderSide = target.toString();
  creditMockAccount(state, tx.provider, amount - cut);
  creditMockAccount(state, terms.integrator, cut);
  return [
    {
      type: 'IntegratorFeeSplit',
      ...at,
      data: {
        txId: tx.id,
        kernelAmount: amount.toString(),
        received: (amount - cut).toString(),
        integratorAmount: cut.toString(),
      },
    },
  ];
}

/** Refund `amount` to the requester of `tx`; fees apply only after a dispute in BOTH_AFTER_DISPUTE. */
export function refundMockRequester(
  state: MockState,
  tx: MockTransaction,
  amount: bigint,
  afterDispute: boolean,
  at: { timestamp: number; blockNumber: number }
): MockEvent[] {
  const terms = tx.feeSplit;
  if (!terms || !afterDispute || terms.profile !== 'BOTH_AFTER_DISPUTE') {
    creditMockAccount(state, tx.requester, amount);
    return [];
  }
  const fees = refundFees(
    {
      refundSide: BigInt(terms.refundSide),
      protocolTaken: BigInt(terms.protocolRefundFee),
      integratorTaken: BigInt(terms.integratorRefundFee),
    },
    amount,
    terms.protocolBps,
    terms.bps
  );
  terms.refundSide = (BigInt(terms.refundSide) + amount).toString();
  terms.protocolRefundFee = (BigInt(terms.protocolRefundFee) + fees.protocolFee).toString();
  terms.integratorRefundFee = (BigInt(terms.integratorRefundFee) + fees.integratorFee).toString();
  const received = amount - fees.protocolFee - fees.integratorFee;
  creditMockAccount(state, tx.requester, received);
  creditMockAccount(state, MOCK_FEE_RECIPIENT, fees.protocolFee);
  creditMockAccount(state, terms.integrator, fees.integratorFee);
  return [
    {
      type: 'RefundFeeSplit',
      ...at,
      data: {
        txId: tx.id,
        kernelAmount: amount.toString(),
        received: received.toString(),
        protocolFee: fees.protocolFee.toString(),
        integratorAmount: fees.integratorFee.toString(),
      },
    },
  ];
}
