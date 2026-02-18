/**
 * AutoWalletProvider.createACTPTransaction() Tests
 *
 * Verifies nonce management, txId pre-computation, and UserOp submission
 * for the gasless createTransaction path.
 */

import { AutoWalletProvider } from './AutoWalletProvider';
import { computeTransactionId } from './aa/TransactionBatcher';
import { ethers } from 'ethers';

const PROVIDER_ADDR = '0x' + '11'.repeat(20);
const REQUESTER_ADDR = '0x' + '22'.repeat(20);
const KERNEL_ADDR = '0x' + '44'.repeat(20);

const BASE_PARAMS = {
  provider: PROVIDER_ADDR,
  requester: REQUESTER_ADDR,
  amount: '1000000',
  deadline: 1_900_000_000,
  disputeWindow: 172800,
  serviceHash: ethers.ZeroHash,
  agentId: '0',
  contracts: { actpKernel: KERNEL_ADDR },
};

function createMockProvider(): any {
  const provider: any = Object.create(AutoWalletProvider.prototype);

  provider.nonceManager = {
    enqueue: jest.fn(async (fn: Function, _incrementsActpNonce: boolean) => {
      const out = await fn({ entryPointNonce: 5n, actpNonce: 3n });
      return out.result;
    }),
    setCachedActpNonce: jest.fn(),
  };

  provider.submitUserOp = jest.fn().mockResolvedValue({
    hash: '0xreceipt',
    success: true,
  });

  return provider;
}

describe('AutoWalletProvider.createACTPTransaction()', () => {
  it('pre-computes txId using ACTP nonce from DualNonceManager', async () => {
    const provider = createMockProvider();
    const result = await provider.createACTPTransaction(BASE_PARAMS);

    const expectedTxId = computeTransactionId(
      REQUESTER_ADDR,
      PROVIDER_ADDR,
      '1000000',
      ethers.ZeroHash,
      3n, // actpNonce from enqueue mock
    );

    expect(result.txId).toBe(expectedTxId);
    expect(result.receipt.success).toBe(true);
    expect(result.receipt.hash).toBe('0xreceipt');
  });

  it('passes incrementsActpNonce=true to enqueue', async () => {
    const provider = createMockProvider();
    await provider.createACTPTransaction(BASE_PARAMS);

    expect(provider.nonceManager.enqueue).toHaveBeenCalledWith(
      expect.any(Function),
      true,
    );
  });

  it('submits a single-call UserOp (only createTransaction, no approve/linkEscrow)', async () => {
    const provider = createMockProvider();
    await provider.createACTPTransaction(BASE_PARAMS);

    expect(provider.submitUserOp).toHaveBeenCalledTimes(1);

    const [calls, entryPointNonce] = provider.submitUserOp.mock.calls[0];
    expect(calls).toHaveLength(1); // Single call, not batched 3
    expect(calls[0].target).toBe(KERNEL_ADDR);
    expect(calls[0].value).toBe(0n);
    expect(entryPointNonce).toBe(5n);
  });

  it('encodes correct createTransaction calldata', async () => {
    const provider = createMockProvider();
    await provider.createACTPTransaction({
      ...BASE_PARAMS,
      serviceHash: ethers.keccak256(ethers.toUtf8Bytes('test service')),
      agentId: '42',
    });

    const [calls] = provider.submitUserOp.mock.calls[0];
    const iface = new ethers.Interface([
      'function createTransaction(address provider, address requester, uint256 amount, uint256 deadline, uint256 disputeWindow, bytes32 serviceHash, uint256 agentId)',
    ]);
    const decoded = iface.decodeFunctionData('createTransaction', calls[0].data);

    expect(decoded[0]).toBe(PROVIDER_ADDR); // provider
    expect(decoded[1]).toBe(REQUESTER_ADDR); // requester
    expect(decoded[2]).toBe(BigInt('1000000')); // amount
    expect(decoded[3]).toBe(BigInt(1_900_000_000)); // deadline
    expect(decoded[4]).toBe(BigInt(172800)); // disputeWindow
    expect(decoded[5]).toBe(ethers.keccak256(ethers.toUtf8Bytes('test service'))); // serviceHash
    expect(decoded[6]).toBe(42n); // agentId
  });

  it('returns failure receipt without throwing when UserOp is unsuccessful', async () => {
    const provider = createMockProvider();
    provider.submitUserOp.mockResolvedValue({
      hash: '0xfailed',
      success: false,
    });

    const result = await provider.createACTPTransaction(BASE_PARAMS);

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.hash).toBe('0xfailed');
    // txId is still pre-computed even on failure
    expect(result.txId).toBeTruthy();
  });

  it('propagates submitUserOp errors', async () => {
    const provider = createMockProvider();
    provider.submitUserOp.mockRejectedValue(new Error('bundler unreachable'));

    // DualNonceManager.enqueue propagates errors
    provider.nonceManager.enqueue.mockImplementation(async (fn: Function) => {
      const out = await fn({ entryPointNonce: 5n, actpNonce: 3n });
      return out.result;
    });

    await expect(provider.createACTPTransaction(BASE_PARAMS))
      .rejects.toThrow('bundler unreachable');
  });
});
