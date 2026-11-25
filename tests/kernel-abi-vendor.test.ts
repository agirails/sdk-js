/**
 * Vendored ACTPKernel ABI matches the deployed b08c0c6 kernel surface.
 *
 * b08c0c6 (Base Sepolia 0xAfDd8D972b2d95eEb044b4C8010E33EA60eBA1a8) adds `retryReputation(bytes32)`: a permissionless
 * retry of the reputation write for a SETTLED transaction, or a CANCELLED one that was disputed with no result
 * committed. The rest of the ABI is unchanged from the previous vendoring.
 */

import { Interface, id } from 'ethers';

import ACTPKernelABI from '../src/abi/ACTPKernel.json';

describe('ACTPKernel ABI vendored from b08c0c6', () => {
  const iface = new Interface(ACTPKernelABI as any);

  test('exposes retryReputation(bytes32) as a nonpayable call with no outputs', () => {
    const fn = iface.getFunction('retryReputation');
    expect(fn).not.toBeNull();
    expect(fn!.format('sighash')).toBe('retryReputation(bytes32)');
    expect(fn!.selector).toBe(id('retryReputation(bytes32)').slice(0, 10));
    expect(fn!.stateMutability).toBe('nonpayable');
    expect(fn!.outputs).toHaveLength(0);
  });

  test('encodes a retryReputation call for a transaction id', () => {
    const txId = '0x' + 'ab'.repeat(32);
    const data = iface.encodeFunctionData('retryReputation', [txId]);
    expect(data).toBe(id('retryReputation(bytes32)').slice(0, 10) + 'ab'.repeat(32));
  });

  test('keeps the sibling retry entry point', () => {
    expect(iface.getFunction('retryPlatformFee')?.format('sighash')).toBe('retryPlatformFee(bytes32)');
  });
});
