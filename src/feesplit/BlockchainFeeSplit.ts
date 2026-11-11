/**
 * FeeSplitVault support of BlockchainRuntime: funding from an EOA, the provider's approval,
 * disclosure and breakdown, all against the deployed contracts.
 *
 * @module feesplit/BlockchainFeeSplit
 */

import { Interface, type Log, type Provider, type Result, type Signer } from 'ethers';
import kernelAbi from '../abi/ACTPKernel.json';
import { EscrowVault } from '../protocol/EscrowVault';
import type { ACTPKernel } from '../protocol/ACTPKernel';
import type { NetworkConfig } from '../config/networks';
import { FeeSplitVaultUnavailableError } from './errors';
import { assertFeeSplitPreflight } from './funding';
import { ChainFeeSplitReader } from './ChainFeeSplitReader';
import { FeeSplitSupport, type RefundQuotes } from './FeeSplitSupport';
import { FEE_SPLIT_VAULT_INTERFACE, encodeSetEscrowTerms, encodeSetIntegratorApproval } from './calls';
import { joinPayoutBreakdown, type KernelPayout, type PayoutBreakdown, type VaultSplit } from './breakdown';
import { fundingFeeSplitVault } from './vaults';
import type { FeeSplitVaultEntry, ResolvedFeeSplitFunding } from './types';

const KERNEL_INTERFACE = new Interface(kernelAbi);
const KERNEL_PAYOUTS: Readonly<Record<string, KernelPayout['kind']>> = {
  EscrowReleased: 'released',
  EscrowRefunded: 'refunded',
  EscrowMediatorPaid: 'mediator',
};

/** What BlockchainRuntime hands to its FeeSplitVault support. */
export interface BlockchainFeeSplitConfig {
  provider: Provider;
  signer: Signer;
  kernel: ACTPKernel;
  kernelAddress: string;
  usdc: string;
  /** The network's plain EscrowVault. */
  escrowVault: string;
  vaults: readonly FeeSplitVaultEntry[];
  /** First block to search for events; the kernel's deployment block when known. */
  fromBlock?: number;
  confirmations?: number;
  gasSettings?: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
}

function topicOf(iface: Interface, name: string): string {
  const fragment = iface.getEvent(name);
  if (!fragment) throw new Error(`ABI has no event ${name}`);
  return fragment.topicHash;
}

function bigintArg(args: Result, name: string): bigint {
  const value: unknown = args.getValue(name);
  if (typeof value !== 'bigint') throw new Error(`Event field ${name} is not an integer`);
  return value;
}

function booleanArg(args: Result, name: string): boolean {
  const value: unknown = args.getValue(name);
  if (typeof value !== 'boolean') throw new Error(`Event field ${name} is not a boolean`);
  return value;
}

function byPosition(a: Log, b: Log): number {
  return a.blockNumber === b.blockNumber ? a.index - b.index : a.blockNumber - b.blockNumber;
}

function vaultSplitOf(log: Log): VaultSplit | undefined {
  const parsed = FEE_SPLIT_VAULT_INTERFACE.parseLog(log);
  if (parsed?.name === 'IntegratorFeeSplit') {
    return {
      kind: 'released',
      kernelAmount: bigintArg(parsed.args, 'providerSideAmount'),
      received: bigintArg(parsed.args, 'providerAmount'),
      integratorAmount: bigintArg(parsed.args, 'integratorAmount'),
      integratorCredited: booleanArg(parsed.args, 'integratorCredited'),
      protocolFee: 0n,
      protocolCredited: false,
    };
  }
  if (parsed?.name === 'RefundFeeSplit') {
    return {
      kind: 'refunded',
      kernelAmount: bigintArg(parsed.args, 'refundSideAmount'),
      received: bigintArg(parsed.args, 'requesterAmount'),
      integratorAmount: bigintArg(parsed.args, 'integratorFee'),
      integratorCredited: booleanArg(parsed.args, 'integratorCredited'),
      protocolFee: bigintArg(parsed.args, 'protocolFee'),
      protocolCredited: booleanArg(parsed.args, 'protocolCredited'),
    };
  }
  return undefined;
}

/** FeeSplitVault support against deployed contracts. */
export class BlockchainFeeSplit extends FeeSplitSupport {
  private readonly chainReader: ChainFeeSplitReader;

  constructor(private readonly config: BlockchainFeeSplitConfig) {
    super(config.vaults, config.escrowVault);
    this.chainReader = new ChainFeeSplitReader(config.provider, config.kernelAddress);
  }

  /**
   * Support for a runtime on `network`. The network's kernel deployment block bounds the event
   * search only while the kernel address is the network's own, not an override.
   */
  static forRuntime(
    provider: Provider,
    signer: Signer,
    kernel: ACTPKernel,
    network: NetworkConfig,
    overrides: Pick<BlockchainFeeSplitConfig, 'confirmations' | 'gasSettings'> & { contracts?: { actpKernel?: string } }
  ): BlockchainFeeSplit {
    return new BlockchainFeeSplit({
      provider,
      signer,
      kernel,
      kernelAddress: network.contracts.actpKernel,
      usdc: network.contracts.usdc,
      escrowVault: network.contracts.escrowVault,
      vaults: network.contracts.feeSplitVaults,
      fromBlock: overrides.contracts?.actpKernel ? undefined : network.actpKernelDeploymentBlock,
      confirmations: overrides.confirmations,
      gasSettings: overrides.gasSettings,
    });
  }

  reader(): ChainFeeSplitReader {
    return this.chainReader;
  }

  private async send(to: string, data: string): Promise<void> {
    const response = await this.config.signer.sendTransaction({ to, data, ...this.config.gasSettings });
    await response.wait(this.config.confirmations);
  }

  async link(txId: string, amount: string, funding: ResolvedFeeSplitFunding): Promise<string> {
    assertFeeSplitPreflight(funding);
    const vault = new EscrowVault(funding.vault, this.config.signer, this.config.gasSettings);
    await vault.approveToken(this.config.usdc, BigInt(amount));
    await this.send(funding.vault, encodeSetEscrowTerms(txId, funding.terms));
    await this.config.kernel.linkEscrow(txId, funding.vault, txId);
    await this.assertLocked(txId, funding);
    return txId;
  }

  async setIntegratorApproval(integrator: string, maxBps: number): Promise<void> {
    const vault = fundingFeeSplitVault(this.vaults());
    if (!vault) throw new FeeSplitVaultUnavailableError();
    const data = encodeSetIntegratorApproval(integrator, maxBps);
    if (!this.wallet) return this.send(vault, data);
    const receipt = await this.wallet.sendTransaction({ to: vault, data });
    if (!receipt.success) throw new Error(`Integrator approval failed: ${receipt.hash}`);
  }

  async refundQuotes(vault: string, txId: string): Promise<RefundQuotes> {
    const ifDisputed = await this.chainReader.quoteRefundIfDisputed(vault, txId);
    const actual = await this.chainReader.quoteRefund(vault, txId, BigInt(ifDisputed.refundAmount));
    return {
      actualRefundQuote: actual,
      ifDisputedRefundQuote: {
        refundAmount: ifDisputed.refundAmount,
        requesterAmount: ifDisputed.requesterAmount,
        protocolFee: ifDisputed.protocolFee,
        integratorFee: ifDisputed.integratorFee,
      },
    };
  }

  private async logs(address: string, topics: (string | string[])[], fromBlock: number, toBlock: number): Promise<Log[]> {
    try {
      return await this.config.provider.getLogs({ address, topics, fromBlock, toBlock });
    } catch (error) {
      if (fromBlock >= toBlock) throw error;
      const middle = Math.floor((fromBlock + toBlock) / 2);
      const first = await this.logs(address, topics, fromBlock, middle);
      return first.concat(await this.logs(address, topics, middle + 1, toBlock));
    }
  }

  async payoutBreakdown(vault: string, txId: string): Promise<PayoutBreakdown> {
    const toBlock = await this.config.provider.getBlockNumber();
    const escrow = await this.chainReader.escrowAt(txId, toBlock);
    const fromBlock = this.config.fromBlock ?? 0;
    const kernelTopics = Object.keys(KERNEL_PAYOUTS).map(name => topicOf(KERNEL_INTERFACE, name));
    const vaultTopics = ['IntegratorFeeSplit', 'RefundFeeSplit'].map(name => topicOf(FEE_SPLIT_VAULT_INTERFACE, name));
    const kernelLogs = await this.logs(this.config.kernelAddress, [kernelTopics, txId], fromBlock, toBlock);
    const vaultLogs = await this.logs(vault, [vaultTopics, escrow.escrowId], fromBlock, toBlock);

    const kernel: KernelPayout[] = [];
    for (const log of [...kernelLogs].sort(byPosition)) {
      const parsed = KERNEL_INTERFACE.parseLog(log);
      const kind = parsed ? KERNEL_PAYOUTS[parsed.name] : undefined;
      if (parsed && kind) kernel.push({ kind, amount: bigintArg(parsed.args, 'amount') });
    }
    const splits: VaultSplit[] = [];
    for (const log of [...vaultLogs].sort(byPosition)) {
      const split = vaultSplitOf(log);
      if (split) splits.push(split);
    }
    return joinPayoutBreakdown({
      txId,
      vault,
      deposit: escrow.deposit,
      principal: escrow.principal,
      kernel,
      splits,
    });
  }
}
