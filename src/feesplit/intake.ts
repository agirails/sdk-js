/**
 * Provider intake: which funded jobs a provider agent takes on.
 *
 * A new COMMITTED job is accepted only when its escrow is in the plain EscrowVault or in the
 * FeeSplitVault that funds new escrows, and, in the latter, when the provider's policy accepts the
 * terms the vault locked. A job in a retired or unrecognized vault is declined. A job the provider
 * already started is served to completion wherever its escrow is.
 *
 * @module feesplit/intake
 */

import type { MockTransaction } from '../runtime/types/MockState';
import type { FeeSplitSupport } from './FeeSplitSupport';
import type { LockedTerms } from './types';

/** Provider policy over the terms a FeeSplitVault locked for a job. */
export type IntegratorTermsPolicy = (terms: LockedTerms) => boolean | Promise<boolean>;

/** Intake decision. */
export type EscrowIntake = { accept: true } | { accept: false; reason: string };

/**
 * Decide whether the provider takes on `tx`.
 *
 * @param support - the runtime's FeeSplitVault support; without it nothing is checked
 * @param policy - optional provider policy; by default the locked terms are accepted, because the
 *   vault locked them only within the provider's on-chain approval
 */
export async function checkEscrowIntake(
  support: FeeSplitSupport | undefined,
  tx: Pick<MockTransaction, 'id' | 'state' | 'escrowContract'>,
  policy?: IntegratorTermsPolicy
): Promise<EscrowIntake> {
  if (!support || tx.state !== 'COMMITTED') return { accept: true };
  const kind = support.vaultKind(tx.escrowContract);
  if (kind === 'plain') return { accept: true };
  if (kind !== 'funding' || tx.escrowContract === undefined) {
    return { accept: false, reason: `escrow is in a ${kind} vault` };
  }
  if (!policy) return { accept: true };
  const terms = await support.lockedTerms(tx.escrowContract, tx.id);
  return (await policy(terms)) ? { accept: true } : { accept: false, reason: 'integrator terms rejected by the provider policy' };
}
