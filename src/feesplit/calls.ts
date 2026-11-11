/**
 * Calldata of the FeeSplitVault calls a requester or a provider sends.
 *
 * @module feesplit/calls
 */

import { Interface } from 'ethers';
import feeSplitVaultAbi from '../abi/FeeSplitVault.json';
import type { FeeProfile, IntegratorTerms } from './types';

/** ABI interface of FeeSplitVault. */
export const FEE_SPLIT_VAULT_INTERFACE = new Interface(feeSplitVaultAbi);

/** The contract's enum value of a profile. */
export function feeProfileValue(profile: FeeProfile): number {
  return profile === 'BOTH_AFTER_DISPUTE' ? 1 : 0;
}

/** The profile of a contract enum value. */
export function feeProfileOf(value: bigint): FeeProfile {
  return value === 1n ? 'BOTH_AFTER_DISPUTE' : 'PAYOUT_ONLY';
}

/** `setEscrowTerms(escrowId, integrator, bps, profile)`, sent by the requester before linkEscrow. */
export function encodeSetEscrowTerms(escrowId: string, terms: IntegratorTerms): string {
  return FEE_SPLIT_VAULT_INTERFACE.encodeFunctionData('setEscrowTerms', [
    escrowId,
    terms.address,
    terms.bps,
    feeProfileValue(terms.profile),
  ]);
}

/** `setIntegratorApproval(integrator, maxBps)`, sent by the provider; maxBps 0 revokes. */
export function encodeSetIntegratorApproval(integrator: string, maxBps: number): string {
  return FEE_SPLIT_VAULT_INTERFACE.encodeFunctionData('setIntegratorApproval', [integrator, maxBps]);
}

/** The escrow id a `setEscrowTerms` calldata names. */
export function escrowIdOfSetEscrowTerms(data: string): string {
  const decoded: unknown = FEE_SPLIT_VAULT_INTERFACE.decodeFunctionData('setEscrowTerms', data)[0];
  if (typeof decoded !== 'string') throw new Error('setEscrowTerms calldata has no escrow id');
  return decoded;
}
