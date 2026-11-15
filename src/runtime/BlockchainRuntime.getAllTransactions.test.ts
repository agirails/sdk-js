import { JsonRpcProvider, Wallet } from 'ethers';
import { BlockchainRuntime } from './BlockchainRuntime';
import { OperationNotSupportedError } from '../errors';

describe('BlockchainRuntime.getAllTransactions()', () => {
  it('throws OperationNotSupportedError instead of an empty list that reads as "no transactions"', async () => {
    const provider = new JsonRpcProvider('http://127.0.0.1:1', 84532, { staticNetwork: true });
    const runtime = new BlockchainRuntime({ network: 'base-sepolia', signer: Wallet.createRandom(provider), provider });

    await expect(runtime.getAllTransactions()).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(runtime.getAllTransactions()).rejects.toMatchObject({ code: 'OPERATION_NOT_SUPPORTED' });
  });
});
