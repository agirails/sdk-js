/**
 * FeeSplitVault and kernel reads over JSON-RPC.
 *
 * @module feesplit/ChainFeeSplitReader
 */

import { Interface, type Provider, type Result } from 'ethers';
import { FEE_SPLIT_VAULT_INTERFACE, feeProfileOf } from './calls';
import type { DisputeFeeQuote, FeeSplitReader, LockedTerms } from './types';

const KERNEL_INTERFACE = new Interface([
  'function platformFeeBps() view returns (uint16)',
  'function escrowPrincipal(bytes32 transactionId) view returns (uint256)',
  'function getTransaction(bytes32 transactionId) view returns (tuple(bytes32 transactionId, address requester, address provider, uint8 state, uint256 amount, uint256 createdAt, uint256 updatedAt, uint256 deadline, bytes32 serviceHash, address escrowContract, bytes32 escrowId, bytes32 attestationUID, uint256 disputeWindow, bytes32 metadata, uint16 platformFeeBpsLocked, uint16 requesterPenaltyBpsLocked, uint16 disputeBondBpsLocked, uint256 agentId, uint256 requesterAgentId, address disputeInitiator, uint256 disputeBond, bytes32 resultHash, bytes32 agreementHash))',
]);

const TERMS_STATES: readonly LockedTerms['state'][] = ['NONE', 'PENDING_CONFIRM', 'CONFIRMED', 'VOID'];

function bigintAt(result: Result, index: number): bigint {
  const value: unknown = result[index];
  if (typeof value !== 'bigint') throw new Error(`Expected an integer at return index ${index}`);
  return value;
}

function stringAt(result: Result, index: number): string {
  const value: unknown = result[index];
  if (typeof value !== 'string') throw new Error(`Expected a string at return index ${index}`);
  return value;
}

function booleanAt(result: Result, index: number): boolean {
  const value: unknown = result[index];
  if (typeof value !== 'boolean') throw new Error(`Expected a boolean at return index ${index}`);
  return value;
}

/** Split amounts of a refund quote returned by the vault. */
export function quoteOf(refundAmount: bigint, result: Result): DisputeFeeQuote {
  return {
    refundAmount: refundAmount.toString(),
    requesterAmount: bigintAt(result, 0).toString(),
    protocolFee: bigintAt(result, 1).toString(),
    integratorFee: bigintAt(result, 2).toString(),
  };
}

/** Reads of the funding preflight and the disclosure against one kernel. */
export class ChainFeeSplitReader implements FeeSplitReader {
  constructor(
    private readonly provider: Provider,
    private readonly kernel: string
  ) {}

  private async vaultCall(vault: string, name: string, args: unknown[], blockTag?: number): Promise<Result> {
    const data = FEE_SPLIT_VAULT_INTERFACE.encodeFunctionData(name, args);
    const raw = await this.provider.call({ to: vault, data, blockTag });
    return FEE_SPLIT_VAULT_INTERFACE.decodeFunctionResult(name, raw);
  }

  private async kernelCall(name: string, args: unknown[], blockTag?: number): Promise<Result> {
    const data = KERNEL_INTERFACE.encodeFunctionData(name, args);
    const raw = await this.provider.call({ to: this.kernel, data, blockTag });
    return KERNEL_INTERFACE.decodeFunctionResult(name, raw);
  }

  async integratorMaxBps(vault: string, provider: string, integrator: string): Promise<number> {
    return Number(bigintAt(await this.vaultCall(vault, 'integratorMaxBps', [provider, integrator]), 0));
  }

  async protocolBps(txId?: string): Promise<number> {
    if (txId === undefined) return Number(bigintAt(await this.kernelCall('platformFeeBps', []), 0));
    const view: unknown = (await this.kernelCall('getTransaction', [txId]))[0];
    if (!Array.isArray(view) || typeof view[14] !== 'bigint') throw new Error('Unexpected kernel transaction view');
    return Number(view[14]);
  }

  async previewDisputeRefund(vault: string, refundAmount: bigint, protocolBps: number, bps: number): Promise<DisputeFeeQuote> {
    return quoteOf(refundAmount, await this.vaultCall(vault, 'previewDisputeRefund', [refundAmount, protocolBps, bps]));
  }

  async lockedTerms(vault: string, escrowId: string): Promise<LockedTerms> {
    const result = await this.vaultCall(vault, 'lockedTerms', [escrowId]);
    const state = TERMS_STATES[Number(bigintAt(result, 3))];
    if (state === undefined) throw new Error('Unknown terms state');
    return {
      integrator: stringAt(result, 0),
      bps: Number(bigintAt(result, 1)),
      profile: feeProfileOf(bigintAt(result, 2)),
      state,
      protocolBps: Number(bigintAt(result, 4)),
      disputed: booleanAt(result, 5),
      used: booleanAt(result, 6),
    };
  }

  /**
   * What a refund of the whole remaining principal would pay if the escrow were disputed now. The
   * principal comes from the kernel (it excludes reserved protocol-fee debt), and both reads use one
   * block. It is the largest refund-side fee the job can incur, not a prediction of a split ruling.
   */
  async quoteRefundIfDisputed(vault: string, txId: string): Promise<DisputeFeeQuote & { rateConfirmed: boolean }> {
    const blockTag = await this.provider.getBlockNumber();
    const principal = bigintAt(await this.kernelCall('escrowPrincipal', [txId], blockTag), 0);
    const result = await this.vaultCall(vault, 'quoteRefundIfDisputed', [txId, principal], blockTag);
    return { ...quoteOf(principal, result), rateConfirmed: booleanAt(result, 3) };
  }

  /** The kernel's view of an escrow at one block: deposit, escrow id and remaining principal. */
  async escrowAt(txId: string, blockTag: number): Promise<{ deposit: bigint; escrowId: string; principal: bigint }> {
    const view: unknown = (await this.kernelCall('getTransaction', [txId], blockTag))[0];
    if (!Array.isArray(view) || typeof view[4] !== 'bigint' || typeof view[10] !== 'string') {
      throw new Error('Unexpected kernel transaction view');
    }
    const principal = bigintAt(await this.kernelCall('escrowPrincipal', [txId], blockTag), 0);
    return { deposit: view[4], escrowId: view[10], principal };
  }

  /** What a refund of `amount` would pay in the escrow's current state: fee-free while undisputed. */
  async quoteRefund(vault: string, txId: string, amount: bigint): Promise<DisputeFeeQuote> {
    return quoteOf(amount, await this.vaultCall(vault, 'quoteRefund', [txId, amount]));
  }
}
