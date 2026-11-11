/**
 * The FeeSplitVault list of a network.
 *
 * @module feesplit/vaults
 */

import type { FeeSplitVaultEntry } from './types';

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The vault that funds new escrows, if the network has one. */
export function fundingFeeSplitVault(vaults: readonly FeeSplitVaultEntry[]): string | undefined {
  return vaults.find(entry => entry.funding)?.address;
}

/** True for every listed FeeSplitVault, funding or retired. */
export function isRecognizedFeeSplitVault(vaults: readonly FeeSplitVaultEntry[], address: string): boolean {
  return vaults.some(entry => sameAddress(entry.address, address));
}

/** Problems of a vault list: more than one funding entry, a duplicate, or the plain escrow vault. */
export function feeSplitVaultListErrors(vaults: readonly FeeSplitVaultEntry[], escrowVault: string): string[] {
  const errors: string[] = [];
  if (vaults.filter(entry => entry.funding).length > 1) {
    errors.push('feeSplitVaults has more than one entry with funding: true');
  }
  vaults.forEach((entry, index) => {
    if (sameAddress(entry.address, escrowVault)) {
      errors.push(`feeSplitVaults entry ${entry.address} is the plain EscrowVault`);
    }
    if (vaults.findIndex(other => sameAddress(other.address, entry.address)) !== index) {
      errors.push(`feeSplitVaults lists ${entry.address} twice`);
    }
  });
  return errors;
}
