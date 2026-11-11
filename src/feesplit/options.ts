/**
 * Helpers the pay and link entry points share.
 *
 * @module feesplit/options
 */

import type { IACTPRuntime } from '../runtime/IACTPRuntime';
import { FeeSplitVaultUnavailableError } from './errors';
import type { FeeSplitFundingOptions, IntegratorTerms, ResolvedFeeSplitFunding } from './types';

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
