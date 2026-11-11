/**
 * The one funding preflight of every pay and link path.
 *
 * `resolveFeeSplitFunding` merges the client-level default with the per-call terms, checks the
 * provider's on-chain approval, produces the dispute-fee disclosure, and refuses profile
 * BOTH_AFTER_DISPUTE without a per-call acknowledgment. It returns the terms as data plus a token.
 * It never returns an encoded call: the escrow id is known only where the transaction id is derived,
 * and the terms are encoded there. A builder accepts terms only with the token of this preflight.
 *
 * @module feesplit/funding
 */

import { ethers } from 'ethers';
import { ValidationError } from '../errors';
import {
  DisputeFeeNotAcknowledgedError,
  FeeSplitPreflightMissingError,
  FeeSplitTermsNotLockedError,
  FeeSplitVaultUnavailableError,
  IntegratorNotApprovedError,
} from './errors';
import { fundingFeeSplitVault } from './vaults';
import type {
  FeeSplitPreflightToken,
  FeeSplitReader,
  FeeSplitVaultEntry,
  IntegratorTerms,
  LockedTerms,
  ResolvedFeeSplitFunding,
} from './types';

const MAX_INTEGRATOR_BPS = 1000;
const issued = new WeakMap<FeeSplitPreflightToken, string>();

function fingerprint(vault: string, terms: IntegratorTerms): string {
  return [vault.toLowerCase(), terms.address.toLowerCase(), terms.bps, terms.profile].join('|');
}

/** Input of the funding preflight. */
export interface FeeSplitFundingRequest {
  /** Client-level default terms. Never an acknowledgment. */
  defaults?: IntegratorTerms;
  /** Terms of this call; replaces the default. */
  integrator?: IntegratorTerms;
  /** Acknowledgment of this call. */
  acknowledgeDisputeFee?: boolean;
  provider: string;
  /** Job amount in USDC wei. */
  amount: bigint;
  /** The transaction, when it already exists; its locked protocol rate is used for the disclosure. */
  txId?: string;
  vaults: readonly FeeSplitVaultEntry[];
  reader: FeeSplitReader;
}

function validateTerms(terms: IntegratorTerms, provider: string): void {
  if (!ethers.isAddress(terms.address) || terms.address === ethers.ZeroAddress) {
    throw new ValidationError('integrator.address', `not an address: ${terms.address}`);
  }
  if (terms.address.toLowerCase() === provider.toLowerCase()) {
    throw new ValidationError('integrator.address', 'the provider cannot be its own integrator');
  }
  if (!Number.isInteger(terms.bps) || terms.bps < 1 || terms.bps > MAX_INTEGRATOR_BPS) {
    throw new ValidationError('integrator.bps', `must be an integer from 1 to ${MAX_INTEGRATOR_BPS}, got ${terms.bps}`);
  }
}

/**
 * Run the funding preflight. Resolves to undefined when no integrator terms apply: the escrow is
 * then funded through the plain EscrowVault exactly as before.
 *
 * @throws ValidationError, FeeSplitVaultUnavailableError, IntegratorNotApprovedError,
 *   DisputeFeeNotAcknowledgedError
 */
export async function resolveFeeSplitFunding(
  request: FeeSplitFundingRequest
): Promise<ResolvedFeeSplitFunding | undefined> {
  const requested = request.integrator ?? request.defaults;
  if (!requested) return undefined;
  const terms: IntegratorTerms = { address: requested.address, bps: requested.bps, profile: requested.profile };
  validateTerms(terms, request.provider);

  const vault = fundingFeeSplitVault(request.vaults);
  if (!vault) throw new FeeSplitVaultUnavailableError();

  const approvedBps = await request.reader.integratorMaxBps(vault, request.provider, terms.address);
  if (approvedBps < terms.bps) throw new IntegratorNotApprovedError(request.provider, terms, approvedBps);

  const resolved: ResolvedFeeSplitFunding = { vault, terms, token: Object.freeze({ kind: 'FeeSplitPreflightToken' }) };
  if (terms.profile === 'BOTH_AFTER_DISPUTE') {
    const protocolBps = await request.reader.protocolBps(request.txId);
    resolved.ifDisputedRefundQuote = await request.reader.previewDisputeRefund(
      vault,
      request.amount,
      protocolBps,
      terms.bps
    );
    if (request.acknowledgeDisputeFee !== true) {
      throw new DisputeFeeNotAcknowledgedError(resolved.ifDisputedRefundQuote);
    }
  }
  issued.set(resolved.token, fingerprint(vault, terms));
  return resolved;
}

/**
 * Fail closed unless `funding` came out of `resolveFeeSplitFunding` and still names the same vault
 * and terms.
 *
 * @throws FeeSplitPreflightMissingError
 */
export function assertFeeSplitPreflight(funding: ResolvedFeeSplitFunding): void {
  if (issued.get(funding.token) !== fingerprint(funding.vault, funding.terms)) {
    throw new FeeSplitPreflightMissingError();
  }
}

/**
 * After funding: the vault must have locked exactly the requested terms. Otherwise the funds are in
 * an escrow that behaves as a plain one, and the caller is told so.
 *
 * @throws FeeSplitTermsNotLockedError when the escrow carries other terms or none
 */
export async function assertFeeSplitTermsLocked(
  reader: FeeSplitReader,
  txId: string,
  funding: ResolvedFeeSplitFunding
): Promise<LockedTerms> {
  const locked = await reader.lockedTerms(funding.vault, txId);
  const same =
    locked.state !== 'NONE' &&
    locked.integrator.toLowerCase() === funding.terms.address.toLowerCase() &&
    locked.bps === funding.terms.bps &&
    locked.profile === funding.terms.profile;
  if (!same) {
    const found =
      locked.state === 'NONE' ? undefined : { address: locked.integrator, bps: locked.bps, profile: locked.profile };
    throw new FeeSplitTermsNotLockedError(txId, funding.terms, found);
  }
  return locked;
}
