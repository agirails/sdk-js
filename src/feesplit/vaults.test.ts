import { getNetwork, validateNetworkConfig } from '../config/networks';
import { feeSplitVaultListErrors, fundingFeeSplitVault, isRecognizedFeeSplitVault } from './vaults';

const PLAIN = '0x00000000000000000000000000000000000000e1';
const OLD = '0x00000000000000000000000000000000000000a1';
const NEW = '0x00000000000000000000000000000000000000a2';

describe('the FeeSplitVault list of a network', () => {
  it('funding vault: the one entry with funding true', () => {
    expect(fundingFeeSplitVault([])).toBeUndefined();
    expect(fundingFeeSplitVault([{ address: OLD, funding: false }])).toBeUndefined();
    expect(
      fundingFeeSplitVault([
        { address: OLD, funding: false },
        { address: NEW, funding: true },
      ])
    ).toBe(NEW);
  });

  it('a retired vault stays recognized', () => {
    const vaults = [
      { address: OLD, funding: false },
      { address: NEW, funding: true },
    ];
    expect(isRecognizedFeeSplitVault(vaults, OLD.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isRecognizedFeeSplitVault(vaults, NEW)).toBe(true);
    expect(isRecognizedFeeSplitVault(vaults, PLAIN)).toBe(false);
  });

  it('rejects two funding entries, a duplicate, and the plain vault', () => {
    expect(feeSplitVaultListErrors([{ address: NEW, funding: true }], PLAIN)).toEqual([]);
    expect(
      feeSplitVaultListErrors(
        [
          { address: OLD, funding: true },
          { address: NEW, funding: true },
        ],
        PLAIN
      )
    ).toHaveLength(1);
    expect(
      feeSplitVaultListErrors(
        [
          { address: OLD, funding: false },
          { address: OLD, funding: true },
        ],
        PLAIN
      )
    ).toHaveLength(1);
    expect(feeSplitVaultListErrors([{ address: PLAIN, funding: true }], PLAIN)).toHaveLength(1);
  });

  it('network validation enforces the list rules, and getNetwork returns a copy of the list', () => {
    const network = getNetwork('base-sepolia');
    expect(network.contracts.feeSplitVaults).toEqual([]);
    network.contracts.feeSplitVaults.push({ address: NEW, funding: true });
    expect(getNetwork('base-sepolia').contracts.feeSplitVaults).toEqual([]);
    expect(() => validateNetworkConfig(network)).not.toThrow();
    network.contracts.feeSplitVaults.push({ address: OLD, funding: true });
    expect(() => validateNetworkConfig(network)).toThrow(/more than one entry with funding: true/);
    network.contracts.feeSplitVaults = [{ address: network.contracts.escrowVault, funding: true }];
    expect(() => validateNetworkConfig(network)).toThrow(/is the plain EscrowVault/);
  });
});
