import * as fs from 'fs';
import * as path from 'path';
import { AbiCoder, Interface, JsonRpcProvider, Network, Wallet } from 'ethers';
import kernelAbi from '../abi/ACTPKernel.json';
import { ACTPKernel } from '../protocol/ACTPKernel';
import { renderReceiptV3 } from '../cli/commands/receipt';
import { Output } from '../cli/utils/output';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import { BlockchainFeeSplit } from './BlockchainFeeSplit';
import { FEE_SPLIT_VAULT_INTERFACE } from './calls';
import { receiptAmountsFor } from './display';

const KERNEL = '0x' + '11'.repeat(20);
const VAULT = '0x' + '44'.repeat(20);
const INTEGRATOR = '0x' + '55'.repeat(20);
const TX = '0x' + 'ab'.repeat(32);
const K = 1_000_000_000n;
const KERNEL_INTERFACE = new Interface(kernelAbi);

class MovingChain extends JsonRpcProvider {
  tip = 100;
  readonly callTags: unknown[] = [];

  constructor() {
    super('http://moving-chain.invalid', 84532, { staticNetwork: Network.from(84532) });
  }

  private principalAt(block: unknown): bigint {
    return block === '0x64' ? K : 0n;
  }

  override send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    if (method === 'eth_blockNumber') return Promise.resolve('0x' + this.tip.toString(16));
    if (method === 'eth_getLogs') {
      this.tip = 101;
      return Promise.resolve([]);
    }
    if (method === 'eth_call' && Array.isArray(params)) {
      const request: unknown = params[0];
      this.callTags.push(params[1]);
      if (typeof request !== 'object' || request === null || !('data' in request) || typeof request.data !== 'string') {
        return Promise.reject(new Error('malformed call'));
      }
      const parsed = KERNEL_INTERFACE.parseTransaction({ data: request.data });
      if (parsed?.name === 'escrowPrincipal') {
        return Promise.resolve(KERNEL_INTERFACE.encodeFunctionResult('escrowPrincipal', [this.principalAt(params[1])]));
      }
      const words = Array.from({ length: 23 }, () => 0n);
      words[4] = K;
      words[10] = BigInt(TX);
      return Promise.resolve(AbiCoder.defaultAbiCoder().encode(Array.from({ length: 23 }, () => 'uint256'), words));
    }
    return Promise.reject(new Error(`unsupported method ${method}`));
  }
}

function support(provider: JsonRpcProvider, signer: Wallet): BlockchainFeeSplit {
  return new BlockchainFeeSplit({
    provider,
    signer,
    kernel: new ACTPKernel(KERNEL, signer),
    kernelAddress: KERNEL,
    usdc: '0x' + '22'.repeat(20),
    escrowVault: '0x' + '33'.repeat(20),
    vaults: [{ address: VAULT, funding: true }],
    fromBlock: 100,
  });
}

describe('BlockchainFeeSplit', () => {
  it('payoutBreakdown reads the deposit, the principal and both event scans at one block', async () => {
    const chain = new MovingChain();
    const report = await support(chain, new Wallet('0x' + '11'.repeat(32), chain)).payoutBreakdown(VAULT, TX);
    expect(chain.tip).toBe(101);
    expect(chain.callTags).toEqual(['0x64', '0x64']);
    expect(report.movements).toHaveLength(0);
    expect(report.totals.kernelFee).toBe('0');
  });

  it('setIntegratorApproval is sent from the wallet that is the client identity, not from its owner key', async () => {
    const chain = new MovingChain();
    const owner = new Wallet('0x' + '11'.repeat(32), chain);
    const ownerSend = jest.spyOn(owner, 'sendTransaction');
    const sent: { to: string; data: string }[] = [];
    const feeSplit = support(chain, owner);
    feeSplit.useWallet({
      sendTransaction: tx => {
        sent.push(tx);
        return Promise.resolve({ hash: '0xapproval', success: true });
      },
    });
    await feeSplit.setIntegratorApproval(INTEGRATOR, 100);
    expect(ownerSend).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(VAULT);
    const args = FEE_SPLIT_VAULT_INTERFACE.decodeFunctionData('setIntegratorApproval', sent[0]?.data ?? '0x');
    expect([String(args[0]).toLowerCase(), Number(args[1])]).toEqual([INTEGRATOR, 100]);

    feeSplit.useWallet({ sendTransaction: () => Promise.resolve({ hash: '0xfailed', success: false }) });
    await expect(feeSplit.setIntegratorApproval(INTEGRATOR, 100)).rejects.toThrow('Integrator approval failed: 0xfailed');
  });
});

describe('receipt of a refunded FeeSplitVault escrow', () => {
  const REQUESTER = '0x' + '0a'.repeat(20);
  const PROVIDER = '0x' + '0b'.repeat(20);
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-feesplit-chain-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('A9 (B): carries refunded 1,000, received 980, protocol 10, platform 10', async () => {
    const runtime = new MockRuntime(new MockStateManager(directory));
    await runtime.reset();
    await runtime.mintTokens(REQUESTER, K.toString());
    await runtime.feeSplit.setIntegratorApproval(INTEGRATOR, 100, PROVIDER);
    const txId = await runtime.createTransaction({
      provider: PROVIDER,
      requester: REQUESTER,
      amount: K.toString(),
      deadline: runtime.time.now() + 86_400,
      disputeWindow: 3600,
    });
    await runtime.linkEscrow(txId, K.toString(), {
      integrator: { address: INTEGRATOR, bps: 100, profile: 'BOTH_AFTER_DISPUTE' },
      acknowledgeDisputeFee: true,
    });
    for (const state of ['IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'CANCELLED'] as const) {
      await runtime.transitionState(txId, state);
    }

    const amounts = await receiptAmountsFor(runtime, txId);
    expect(amounts).toEqual({
      netWei: 0n,
      feeWei: 0n,
      platformFeeWei: 0n,
      refundedWei: K,
      requesterReceivedWei: 980_000_000n,
      refundProtocolFeeWei: 10_000_000n,
      refundPlatformFeeWei: 10_000_000n,
    });

    const results: unknown[] = [];
    const output = new Output('json');
    jest.spyOn(output, 'result').mockImplementation(value => {
      results.push(value);
    });
    renderReceiptV3(
      { agent: 'buyer', perspective: 'buyer', service: 'job', amountWei: K, network: 'base-sepolia', txId, settled: amounts },
      output
    );
    expect(results[0]).toMatchObject({
      refunded: '$1000.00 USDC',
      requesterReceived: '$980.00 USDC',
      refundProtocolFee: '$10.00 USDC',
      refundPlatformFee: '$10.00 USDC',
    });
  });
});
