import { ethers } from 'ethers';
import { ACTPKernel } from './ACTPKernel';

const KERNEL_ADDRESS = '0x' + '1'.repeat(40);
const TX_ID = '0x' + 'ab'.repeat(32);

describe('ACTPKernel F-6 recovery helpers', () => {
  it('getRecoveryGrace reads the kernel immutable', async () => {
    const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom());
    (kernel as any).contract = { recoveryGrace: jest.fn().mockResolvedValue(604800n) }; // 7 days
    expect(await kernel.getRecoveryGrace()).toBe(604800n);
  });

  it('getRecoveryDeadline = deadline + recoveryGrace', async () => {
    const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom());
    (kernel as any).getTransaction = jest.fn().mockResolvedValue({ deadline: 1_000n });
    (kernel as any).contract = { recoveryGrace: jest.fn().mockResolvedValue(600n) };
    expect(await kernel.getRecoveryDeadline(TX_ID)).toBe(1_600n);
  });

  it('recoverStalledInProgress sends the recoverStalledInProgress transaction', async () => {
    const kernel = new ACTPKernel(KERNEL_ADDRESS, ethers.Wallet.createRandom());
    const wait = jest.fn().mockResolvedValue({});
    const recoverFn: any = jest.fn().mockResolvedValue({ wait });
    recoverFn.estimateGas = jest.fn().mockResolvedValue(100_000n);
    const getFunction = jest.fn().mockReturnValue(recoverFn);
    (kernel as any).contract = { getFunction };

    await kernel.recoverStalledInProgress(TX_ID);

    expect(getFunction).toHaveBeenCalledWith('recoverStalledInProgress');
    expect(recoverFn).toHaveBeenCalled();
    expect(wait).toHaveBeenCalled();
  });
});
