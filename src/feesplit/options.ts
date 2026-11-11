/**
 * Helpers the pay and link entry points share.
 *
 * @module feesplit/options
 */

import type { MockTransaction } from '../runtime/types/MockState';
import type { IACTPRuntime } from '../runtime/IACTPRuntime';
import { FeeSplitVaultUnavailableError } from './errors';
import type { FeeSplitSupport } from './FeeSplitSupport';
import type { DisputeFeeQuote, FeeSplitFundingOptions, IntegratorTerms, ResolvedFeeSplitFunding } from './types';

/** The integrator options of a pay call, or undefined when it names none. */
export function feeSplitOptionsOf(params: {
  integrator?: IntegratorTerms;
  acknowledgeDisputeFee?: boolean;
}): FeeSplitFundingOptions | undefined {
  if (params.integrator === undefined && params.acknowledgeDisputeFee === undefined) return undefined;
  return { integrator: params.integrator, acknowledgeDisputeFee: params.acknowledgeDisputeFee };
}

/**
 * Run the funding preflight of `runtime` before anything is built or sent. Resolves to undefined
 * for plain funding.
 *
 * @throws FeeSplitVaultUnavailableError when terms are requested and the runtime has no vault support
 */
export async function preflightFeeSplitFunding(
  runtime: IACTPRuntime,
  provider: string,
  amount: bigint,
  options?: FeeSplitFundingOptions,
  txId?: string
): Promise<ResolvedFeeSplitFunding | undefined> {
  if (runtime.feeSplit) return runtime.feeSplit.resolve(provider, amount, options, txId);
  if (options?.integrator) throw new FeeSplitVaultUnavailableError();
  return undefined;
}

/** The options to hand to a lower funding path after a preflight: the resolved terms, the caller's acknowledgment. */
export function fundingOptionsAfterPreflight(
  funding: ResolvedFeeSplitFunding | undefined,
  options?: FeeSplitFundingOptions
): FeeSplitFundingOptions | undefined {
  return funding ? { integrator: funding.terms, acknowledgeDisputeFee: options?.acknowledgeDisputeFee } : undefined;
}

/**
 * What a refund of the whole remaining principal would pay once `txId` is disputed, read before the
 * dispute is opened. Undefined for an escrow outside a recognized FeeSplitVault.
 */
export async function disputeFeePreview(
  runtime: { getTransaction(txId: string): Promise<MockTransaction | null>; feeSplit?: FeeSplitSupport },
  txId: string
): Promise<DisputeFeeQuote | undefined> {
  if (!runtime.feeSplit) return undefined;
  const vault = (await runtime.getTransaction(txId))?.escrowContract;
  const kind = runtime.feeSplit.vaultKind(vault);
  if (vault === undefined || (kind !== 'funding' && kind !== 'retired')) return undefined;
  return (await runtime.feeSplit.refundQuotes(vault, txId)).ifDisputedRefundQuote;
}
