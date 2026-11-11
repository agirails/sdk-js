/**
 * Typed errors of the integrator fee vault paths.
 *
 * @module feesplit/errors
 */

import { ACTPError } from '../errors/ACTPError';
import type { DisputeFeeQuote, IntegratorTerms } from './types';

/**
 * @cause Integrator terms were requested and the network has no FeeSplitVault that funds new escrows.
 * @fix Use a network with a funding FeeSplitVault, or fund without integrator terms.
 * @recovery user-action
 */
export class FeeSplitVaultUnavailableError extends ACTPError {
  constructor() {
    super('No FeeSplitVault funds new escrows on this network', 'FEE_SPLIT_VAULT_UNAVAILABLE');
    this.name = 'FeeSplitVaultUnavailableError';
  }
}

/**
 * @cause The provider has not approved this integrator in the vault, or approved a lower maximum rate.
 * @fix The provider calls setIntegratorApproval(integrator, maxBps) with a maximum of at least the requested rate.
 * @recovery user-action
 */
export class IntegratorNotApprovedError extends ACTPError {
  constructor(provider: string, terms: IntegratorTerms, approvedBps: number) {
    super(
      `Provider ${provider} approved integrator ${terms.address} for at most ${approvedBps} bps, ${terms.bps} bps requested`,
      'INTEGRATOR_NOT_APPROVED',
      undefined,
      { provider, integrator: terms.address, requestedBps: terms.bps, approvedBps }
    );
    this.name = 'IntegratorNotApprovedError';
  }
}

/**
 * @cause Profile BOTH_AFTER_DISPUTE was requested without acknowledgeDisputeFee: true for this call.
 * @fix Show the requester `ifDisputedRefundQuote` and pass acknowledgeDisputeFee: true with the call. A client-level default does not count.
 * @recovery user-action
 */
export class DisputeFeeNotAcknowledgedError extends ACTPError {
  constructor(public readonly ifDisputedRefundQuote: DisputeFeeQuote) {
    super(
      'Profile BOTH_AFTER_DISPUTE needs acknowledgeDisputeFee: true for this call: a refund after a dispute pays ' +
        `${ifDisputedRefundQuote.protocolFee} protocol and ${ifDisputedRefundQuote.integratorFee} integrator fee (USDC wei) ` +
        `on a full refund of ${ifDisputedRefundQuote.refundAmount}`,
      'DISPUTE_FEE_NOT_ACKNOWLEDGED',
      undefined,
      { ifDisputedRefundQuote }
    );
    this.name = 'DisputeFeeNotAcknowledgedError';
  }
}

/**
 * @cause Integrator terms reached a batch or link builder without passing the funding preflight, or were changed after it.
 * @fix Obtain the funding through resolveFeeSplitFunding and pass its result unchanged.
 * @recovery must-investigate
 */
export class FeeSplitPreflightMissingError extends ACTPError {
  constructor() {
    super('Integrator terms did not pass the funding preflight', 'FEE_SPLIT_PREFLIGHT_MISSING');
    this.name = 'FeeSplitPreflightMissingError';
  }
}

/**
 * @cause The escrow was funded, and the terms the vault locked differ from the terms that were requested.
 * @fix The funds are in an escrow without the requested integrator terms. Inspect lockedTerms(txId) before continuing the job.
 * @recovery must-investigate
 */
export class FeeSplitTermsNotLockedError extends ACTPError {
  constructor(txId: string, requested: IntegratorTerms, locked: IntegratorTerms | undefined) {
    super(
      `Escrow ${txId} was funded without the requested integrator terms`,
      'FEE_SPLIT_TERMS_NOT_LOCKED',
      undefined,
      { txId, requested, locked }
    );
    this.name = 'FeeSplitTermsNotLockedError';
  }
}
