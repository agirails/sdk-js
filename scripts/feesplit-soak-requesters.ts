/**
 * Requester sides of the FeeSplitVault soak runner: an EOA that pays its own gas, and a
 * CoinbaseSmartWallet whose every UserOp is sponsored by one named paymaster.
 *
 * A smart-wallet requester is bound to a single provider (`cdp` or `pimlico`) with no backup, so
 * the plan's "through each paymaster" is a fact of the configuration and not of a failover; the
 * endpoints are the SDK's own for Base Sepolia (`CDP_*` / `PIMLICO_*` variables as for any SDK
 * user). It funds through `AutoWalletProvider.payACTPBatched`, one UserOp that approves, registers
 * the terms, creates and links, and the paymaster that paid is read back from the EntryPoint event
 * of that UserOp. The wallet must hold no ETH: then no UserOp of it can be mined unsponsored.
 *
 * Each smart wallet has its own owner key, because the SDK caches the kernel nonce per wallet
 * instance.
 */

import { Interface, Wallet, ZeroAddress, getAddress, zeroPadValue, type JsonRpcProvider } from 'ethers';
import { AutoWalletProvider, getNetwork } from '../src';
import type { ACTPKernel, BlockchainRuntime, FeeSplitFundingOptions, WalletTransactionRequest } from '../src';

const SERVICE = '0x' + '50'.repeat(32);
const STATE = { SETTLED: 5, DISPUTED: 6 };
const TOKEN = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const KERNEL = new Interface([
  'function transitionState(bytes32 transactionId, uint8 newState, bytes proof)',
  'function releaseMilestone(bytes32 transactionId, uint256 amount)',
  'event TransactionCreated(bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash, uint256 deadline, uint256 timestamp, uint256 agentId, bytes32 agreementHash)',
]);
const ENTRY_POINT = new Interface([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

export type PaymasterName = 'cdp' | 'pimlico';

export interface SoakContracts {
  kernel: string;
  token: string;
  plainVault: string;
  feeSplitVault: string;
}

export interface OpenParams {
  provider: string;
  amount: bigint;
  deadline: number;
  /** Absent for a plain-vault escrow. */
  funding?: FeeSplitFundingOptions;
}

export interface Opened {
  txId: string;
  /** Paymaster address the EntryPoint charged for the funding UserOp. */
  sponsor?: string;
}

/** Funding failed; `linkedTxId` is set when the kernel nevertheless holds a linked escrow. */
export class OpenError extends Error {
  constructor(
    readonly reason: unknown,
    readonly linkedTxId?: string
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

export interface RequesterSide {
  readonly address: string;
  readonly paymaster?: PaymasterName;
  open(params: OpenParams): Promise<Opened>;
  settle(txId: string): Promise<void>;
  releaseMilestone(txId: string, amount: bigint): Promise<void>;
  /** Approves the entry bond to the FeeSplitVault and opens the dispute. */
  dispute(txId: string, bondCeiling: bigint): Promise<void>;
}

export class EoaRequester implements RequesterSide {
  readonly address: string;

  constructor(
    private readonly wallet: Wallet,
    private readonly runtime: BlockchainRuntime,
    private readonly kernel: ACTPKernel,
    private readonly contracts: SoakContracts,
    private readonly confirmations: number
  ) {
    this.address = wallet.address;
  }

  async open({ provider, amount, deadline, funding }: OpenParams): Promise<Opened> {
    const txId = await this.runtime.createTransaction({
      provider,
      requester: this.address,
      amount: amount.toString(),
      deadline,
      disputeWindow: 3600,
      serviceDescription: SERVICE,
    });
    try {
      await this.runtime.linkEscrow(txId, amount.toString(), funding);
    } catch (error) {
      const linked = (await this.runtime.getTransaction(txId))?.escrowContract !== undefined;
      throw new OpenError(error, linked ? txId : undefined);
    }
    return { txId };
  }

  settle(txId: string): Promise<void> {
    return this.runtime.transitionState(txId, 'SETTLED');
  }

  async releaseMilestone(txId: string, amount: bigint): Promise<void> {
    await this.kernel.releaseMilestone(txId, amount);
  }

  async dispute(txId: string, bondCeiling: bigint): Promise<void> {
    const approval = await this.wallet.sendTransaction({
      to: this.contracts.token,
      data: TOKEN.encodeFunctionData('approve', [this.contracts.feeSplitVault, bondCeiling]),
    });
    await approval.wait(this.confirmations);
    await this.runtime.transitionState(txId, 'DISPUTED');
  }
}

function endpoints(name: PaymasterName): { bundler: string; paymaster: string } {
  const aa = getNetwork('base-sepolia').aa;
  const bundler = name === 'cdp' ? aa?.bundlerUrls.coinbase : aa?.bundlerUrls.pimlico;
  const paymaster = name === 'cdp' ? aa?.paymasterUrls.coinbase : aa?.paymasterUrls.pimlico;
  if (!bundler || !paymaster) throw new Error(`paymaster ${name}: the SDK has no bundler and paymaster endpoint configured for Base Sepolia`);
  return { bundler, paymaster };
}

export class SmartWalletRequester implements RequesterSide {
  readonly address: string;

  private constructor(
    readonly paymaster: PaymasterName,
    private readonly wallet: AutoWalletProvider,
    private readonly provider: JsonRpcProvider,
    private readonly contracts: SoakContracts,
    private readonly reader: BlockchainRuntime
  ) {
    this.address = getAddress(wallet.getAddress());
  }

  static async create(
    paymaster: PaymasterName,
    ownerKey: string,
    provider: JsonRpcProvider,
    contracts: SoakContracts,
    reader: BlockchainRuntime
  ): Promise<SmartWalletRequester> {
    const urls = endpoints(paymaster);
    const wallet = await AutoWalletProvider.create({
      signer: new Wallet(ownerKey, provider),
      provider,
      chainId: 84_532,
      actpKernelAddress: contracts.kernel,
      bundler: { primaryUrl: urls.bundler },
      paymaster: {
        primaryUrl: urls.paymaster,
        sponsorshipPolicyId: paymaster === 'pimlico' ? process.env.PIMLICO_SPONSORSHIP_POLICY_ID?.trim() || undefined : undefined,
      },
    });
    if ((await provider.getBalance(wallet.getAddress())) !== 0n) {
      throw new Error(`paymaster ${paymaster}: smart wallet ${wallet.getAddress()} holds ETH; it must hold none, so that every UserOp of it is sponsored`);
    }
    return new SmartWalletRequester(paymaster, wallet, provider, contracts, reader);
  }

  async open({ provider, amount, deadline, funding }: OpenParams): Promise<Opened> {
    const { kernel, token, plainVault, feeSplitVault } = this.contracts;
    const fromBlock = await this.provider.getBlockNumber();
    try {
      const paid = await this.wallet.payACTPBatched({
        provider,
        requester: this.address,
        amount: amount.toString(),
        deadline,
        disputeWindow: 3600,
        serviceHash: SERVICE,
        agentId: '0',
        contracts: { usdc: token, actpKernel: kernel, escrowVault: plainVault, feeSplitVaults: [{ address: feeSplitVault, funding: true }] },
        feeSplit: funding,
      });
      if (!paid.success) throw new Error(`funding UserOp failed: ${paid.hash}`);
      return { txId: paid.txId, sponsor: await this.sponsorOf(paid.hash) };
    } catch (error) {
      throw new OpenError(error, await this.linkedSince(fromBlock));
    }
  }

  settle(txId: string): Promise<void> {
    return this.send('settle', [this.kernelCall('transitionState', [txId, STATE.SETTLED, '0x'])]);
  }

  releaseMilestone(txId: string, amount: bigint): Promise<void> {
    return this.send('releaseMilestone', [this.kernelCall('releaseMilestone', [txId, amount])]);
  }

  dispute(txId: string, bondCeiling: bigint): Promise<void> {
    const approval = { to: this.contracts.token, data: TOKEN.encodeFunctionData('approve', [this.contracts.feeSplitVault, bondCeiling]) };
    return this.send('dispute', [approval, this.kernelCall('transitionState', [txId, STATE.DISPUTED, '0x'])]);
  }

  private kernelCall(name: string, args: unknown[]): WalletTransactionRequest {
    return { to: this.contracts.kernel, data: KERNEL.encodeFunctionData(name, args) };
  }

  private async send(label: string, calls: WalletTransactionRequest[]): Promise<void> {
    const receipt = await this.wallet.sendBatchTransaction(calls);
    if (!receipt.success) throw new Error(`${label} UserOp failed: ${receipt.hash}`);
    await this.sponsorOf(receipt.hash);
  }

  private async sponsorOf(txHash: string): Promise<string> {
    const entryPoint = getNetwork('base-sepolia').aa?.entryPoint;
    const receipt = await this.provider.getTransactionReceipt(txHash);
    for (const log of receipt?.logs ?? []) {
      const parsed = entryPoint && getAddress(log.address) === getAddress(entryPoint) ? ENTRY_POINT.parseLog(log) : null;
      if (parsed?.name !== 'UserOperationEvent') continue;
      const [, sender, sponsor]: unknown[] = parsed.args;
      if (typeof sender !== 'string' || typeof sponsor !== 'string' || getAddress(sender) !== this.address) continue;
      if (sponsor === ZeroAddress) throw new Error(`UserOp in ${txHash} was not sponsored`);
      return getAddress(sponsor);
    }
    throw new Error(`${txHash} carries no UserOperationEvent of ${this.address}`);
  }

  private async linkedSince(fromBlock: number): Promise<string | undefined> {
    const created = KERNEL.getEvent('TransactionCreated');
    if (!created) return undefined;
    const logs = await this.provider.getLogs({
      address: this.contracts.kernel,
      topics: [created.topicHash, null, zeroPadValue(this.address, 32)],
      fromBlock,
    });
    for (const log of logs) {
      const txId = log.topics[1];
      if (txId && (await this.reader.getTransaction(txId))?.escrowContract !== undefined) return txId;
    }
    return undefined;
  }
}
