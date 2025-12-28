import { ethers } from 'ethers';
import { ACTPKernel } from './ACTPKernel';
import { TransactionNotFoundError } from '../errors';

describe('ACTPKernel.getTransaction()', () => {
  test('maps deployed-kernel missing-tx revert ("Tx missing") to TransactionNotFoundError', async () => {
    const kernel = new ACTPKernel(
      // address doesn't matter for this unit test; contract is stubbed
      ethers.ZeroAddress,
      ethers.Wallet.createRandom()
    );

    // Stub the underlying ethers Contract call
    (kernel as any).contract = {
      getTransaction: async () => {
        const err: any = new Error('execution reverted: "Tx missing"');
        err.reason = 'Tx missing';
        throw err;
      },
    };

    await expect(kernel.getTransaction(ethers.ZeroHash)).rejects.toBeInstanceOf(
      TransactionNotFoundError
    );
  });
});









