/**
 * Fee rules of FeeSplitVault, recomputed with integer arithmetic.
 *
 * Provider side: the integrator's cumulative share is
 * min(floor(N * b / (10000 - p)), floor(D * b / 10000)). Refund side, profile BOTH_AFTER_DISPUTE on
 * a disputed escrow: protocol floor(R * p / 10000), integrator floor(R * min(b, p) / 10000).
 *
 * @module feesplit/rules
 */

const MAX_BPS = 10_000n;

/** Cumulative integrator share after the kernel paid `providerSide` in total to the provider side. */
export function integratorProviderTarget(providerSide: bigint, deposit: bigint, bps: number, protocolBps: number): bigint {
  const target = (providerSide * BigInt(bps)) / (MAX_BPS - BigInt(protocolBps));
  const cap = (deposit * BigInt(bps)) / MAX_BPS;
  return target < cap ? target : cap;
}

/** Cumulative refund-side state of one escrow. */
export interface RefundState {
  refundSide: bigint;
  protocolTaken: bigint;
  integratorTaken: bigint;
}

/** Fees of a post-dispute refund of `amount` on top of `state`; the integrator fee gives way first. */
export function refundFees(
  state: RefundState,
  amount: bigint,
  protocolBps: number,
  bps: number
): { protocolFee: bigint; integratorFee: bigint } {
  const total = state.refundSide + amount;
  const refundBps = BigInt(Math.min(bps, protocolBps));
  let protocolFee = (total * BigInt(protocolBps)) / MAX_BPS - state.protocolTaken;
  let integratorFee = (total * refundBps) / MAX_BPS - state.integratorTaken;
  if (protocolFee + integratorFee > amount) {
    const excess = protocolFee + integratorFee - amount;
    const fromIntegrator = excess < integratorFee ? excess : integratorFee;
    integratorFee -= fromIntegrator;
    protocolFee -= excess - fromIntegrator;
  }
  return { protocolFee, integratorFee };
}

/** Split of one post-dispute refund of `refundAmount` for proposed terms. */
export function previewDisputeRefund(
  refundAmount: bigint,
  protocolBps: number,
  bps: number
): { requesterAmount: bigint; protocolFee: bigint; integratorFee: bigint } {
  const fees = refundFees({ refundSide: 0n, protocolTaken: 0n, integratorTaken: 0n }, refundAmount, protocolBps, bps);
  return { requesterAmount: refundAmount - fees.protocolFee - fees.integratorFee, ...fees };
}
