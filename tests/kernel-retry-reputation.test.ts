import { ethers } from 'ethers';
import { ACTPKernel } from '../src/protocol/ACTPKernel';

const KERNEL_ADDRESS = '0x' + '1'.repeat(40);
const TX_ID = '0x' + 'ab'.repeat(32);
const DEFAULT_GAS_BUFFER_BPS = 12_000n;
const RETRY_REPUTATION_GAS_FLOOR = 200_000n;
const withBuffer = (gas: bigint) => (gas * DEFAULT_GAS_BUFFER_BPS) / 10_000n;

function kernelWithRetry(estimate: bigint) {
  const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom());
  const wait = jest.fn().mockResolvedValue({});
  const retryFn: any = jest.fn().mockResolvedValue({ wait });
  retryFn.estimateGas = jest.fn().mockResolvedValue(estimate);
  const getFunction = jest.fn().mockReturnValue(retryFn);
  (kernel as any).contract = { getFunction };
  return { kernel, retryFn, getFunction, wait };
}

describe('ACTPKernel.retryReputation (b08c0c6)', () => {
  it('sends retryReputation for the transaction id with the buffered estimate and waits', async () => {
    const { kernel, retryFn, getFunction, wait } = kernelWithRetry(210_000n);

    await kernel.retryReputation(TX_ID);

    expect(getFunction).toHaveBeenCalledWith('retryReputation');
    expect(retryFn.estimateGas).toHaveBeenCalledWith(TX_ID);
    expect(retryFn.mock.calls[0][0]).toBe(TX_ID);
    expect(retryFn.mock.calls[0][1].gasLimit).toBe(withBuffer(210_000n));
    expect(wait).toHaveBeenCalled();
  });

  it('keeps a 200k floor so the fixed 150k registry call is never starved by a low estimate', async () => {
    const { kernel, retryFn } = kernelWithRetry(51_697n);

    await kernel.retryReputation(TX_ID);

    expect(retryFn.mock.calls[0][1].gasLimit).toBe(withBuffer(RETRY_REPUTATION_GAS_FLOOR));
  });

  it('rejects a malformed transaction id before touching the chain', async () => {
    const { kernel, getFunction } = kernelWithRetry(210_000n);

    await expect(kernel.retryReputation('0x1234')).rejects.toThrow();
    expect(getFunction).not.toHaveBeenCalled();
  });

  it('still routes retryPlatformFee to its own kernel function', async () => {
    const { kernel, getFunction, wait } = kernelWithRetry(90_000n);

    await kernel.retryPlatformFee(TX_ID);

    expect(getFunction).toHaveBeenCalledWith('retryPlatformFee');
    expect(wait).toHaveBeenCalled();
  });
});
