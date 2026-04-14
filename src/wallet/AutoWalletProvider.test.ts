import { AutoWalletProvider } from './AutoWalletProvider';
import { computeTransactionId } from './aa/TransactionBatcher';

describe('AutoWalletProvider.payACTPBatched()', () => {
  it('retries with incremented ACTP nonce on escrow-id collision revert', async () => {
    const enqueue = jest.fn(async (fn: Function) => {
      const out = await fn({ entryPointNonce: 3n, actpNonce: 0n });
      return out.result;
    });

    const setCachedActpNonce = jest.fn();

    const submitUserOp = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Bundler reverted: 0x08c379a0...457363726f7720494420616c72656164792075736564'
        )
      )
      .mockResolvedValueOnce({ hash: '0xreceipt', success: true });

    // After first UserOp consumes EP nonce 3, retry must re-read and get 4
    const readEntryPointNonce = jest.fn().mockResolvedValue(4n);

    const provider: any = Object.create(AutoWalletProvider.prototype);

    provider.nonceManager = {
      enqueue,
      setCachedActpNonce,
      readEntryPointNonce,
    };
    provider.submitUserOp = submitUserOp;

    const params = {
      provider: '0x' + '11'.repeat(20),
      requester: '0x' + '22'.repeat(20),
      amount: '1000000',
      deadline: 1_900_000_000,
      disputeWindow: 172800,
      serviceHash: '0x' + '00'.repeat(32),
      agentId: '0',
      contracts: {
        usdc: '0x' + '33'.repeat(20),
        actpKernel: '0x' + '44'.repeat(20),
        escrowVault: '0x' + '55'.repeat(20),
      },
    };

    const result = await provider.payACTPBatched(params);

    expect(enqueue).toHaveBeenCalledWith(expect.any(Function), false);
    expect(submitUserOp).toHaveBeenCalledTimes(2);
    // First call uses original EP nonce 3, second uses re-read EP nonce 4
    expect(submitUserOp).toHaveBeenNthCalledWith(1, expect.any(Array), 3n);
    expect(submitUserOp).toHaveBeenNthCalledWith(2, expect.any(Array), 4n);
    expect(readEntryPointNonce).toHaveBeenCalledTimes(1);
    expect(setCachedActpNonce).toHaveBeenCalledWith(2n);

    const expectedTxId = computeTransactionId(
      params.requester,
      params.provider,
      params.amount,
      params.serviceHash,
      1n
    );

    expect(result.txId).toBe(expectedTxId);
    expect(result.success).toBe(true);
  });

  it('does not advance cached ACTP nonce when UserOp receipt is unsuccessful', async () => {
    const enqueue = jest.fn(async (fn: Function) => {
      const out = await fn({ entryPointNonce: 3n, actpNonce: 7n });
      return out.result;
    });

    const setCachedActpNonce = jest.fn();

    const submitUserOp = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xfailedreceipt', success: false });

    const readEntryPointNonce = jest.fn();

    const provider: any = Object.create(AutoWalletProvider.prototype);
    provider.nonceManager = {
      enqueue,
      setCachedActpNonce,
      readEntryPointNonce,
    };
    provider.submitUserOp = submitUserOp;

    const params = {
      provider: '0x' + '11'.repeat(20),
      requester: '0x' + '22'.repeat(20),
      amount: '1000000',
      deadline: 1_900_000_000,
      disputeWindow: 172800,
      serviceHash: '0x' + '00'.repeat(32),
      agentId: '0',
      contracts: {
        usdc: '0x' + '33'.repeat(20),
        actpKernel: '0x' + '44'.repeat(20),
        escrowVault: '0x' + '55'.repeat(20),
      },
    };

    const result = await provider.payACTPBatched(params);

    expect(enqueue).toHaveBeenCalledWith(expect.any(Function), false);
    expect(submitUserOp).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.hash).toBe('0xfailedreceipt');
    expect(setCachedActpNonce).not.toHaveBeenCalled();
  });
});
