import { Interface } from 'ethers';
import EscrowVaultABI from '../abi/EscrowVault.json';

describe('EscrowVault ABI (Protocol compatibility)', () => {
  test('matches Protocol EscrowVault.sol / IEscrowValidator surface', () => {
    const iface = new Interface(EscrowVaultABI as any);

    // Protocol surface (Base Sepolia deploy)
    expect(iface.getFunction('kernel')).not.toBeNull();
    expect(iface.getFunction('token')).not.toBeNull();
    expect(iface.getFunction('escrows')).not.toBeNull();
    expect(iface.getFunction('remaining')).not.toBeNull();
    expect(iface.getFunction('verifyEscrow')).not.toBeNull();
    expect(iface.getFunction('payoutToProvider')).not.toBeNull();
    expect(iface.getFunction('refundToRequester')).not.toBeNull();
    expect(iface.getFunction('payout')).not.toBeNull();

    // Old/incorrect SDK ABI should NOT exist anymore
    expect(iface.getFunction('disburse')).toBeNull();
  });
});


