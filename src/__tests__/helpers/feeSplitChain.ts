/**
 * An in-memory chain for the FeeSplitVault funding paths: the kernel's nonce, id and escrow-id
 * rules, the vault's pending and locked terms, and the reads the SDK makes. Batches are atomic,
 * like a UserOp: a failing call throws and changes nothing.
 *
 * @module __tests__/helpers/feeSplitChain
 */

import { FeeData, Interface, JsonRpcProvider, Network, type Result } from 'ethers';
import kernelAbi from '../../abi/ACTPKernel.json';
import { FEE_SPLIT_VAULT_INTERFACE } from '../../feesplit/calls';
import { previewDisputeRefund } from '../../feesplit/rules';
import { ENTRYPOINT_V06, SMART_WALLET_FACTORY } from '../../wallet/aa/constants';
import { computeTransactionId } from '../../wallet/aa/TransactionBatcher';

const KERNEL_INTERFACE = new Interface(kernelAbi);
const ERC20_INTERFACE = new Interface(['function approve(address spender, uint256 amount)']);
const ENTRYPOINT_INTERFACE = new Interface(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const FACTORY_INTERFACE = new Interface(['function getAddress(bytes[] owners, uint256 nonce) view returns (address)']);
const BATCH_INTERFACE = new Interface(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = '0x' + '00'.repeat(32);

/** One call of a batch. */
export interface ChainCall {
  target: string;
  data: string;
}

interface TermsRecord {
  integrator: string;
  bps: number;
  profile: number;
}

interface TransactionRecord {
  requester: string;
  provider: string;
  amount: bigint;
  serviceHash: string;
  escrowContract: string;
  escrowId: string;
}

function text(args: Result, index: number): string {
  const value: unknown = args[index];
  if (typeof value !== 'string') throw new Error(`argument ${index} is not a string`);
  return value;
}

function integer(args: Result, index: number): bigint {
  const value: unknown = args[index];
  if (typeof value !== 'bigint') throw new Error(`argument ${index} is not an integer`);
  return value;
}

const key = (...parts: string[]): string => parts.map(part => part.toLowerCase()).join('|');

/** The fake chain. Addresses are fixed; tests read and seed its public state. */
export class FeeSplitChain {
  readonly kernel = '0x00000000000000000000000000000000000000c1';
  readonly usdc = '0x00000000000000000000000000000000000000c2';
  readonly plainVault = '0x00000000000000000000000000000000000000c3';
  readonly vault = '0x00000000000000000000000000000000000000c4';
  readonly smartWallet = '0x00000000000000000000000000000000000000c5';

  platformFeeBps = 100;
  /** Calls of every batch that was executed, in order. */
  readonly executed: ChainCall[][] = [];
  readonly approvals = new Map<string, number>();
  readonly pending = new Map<string, TermsRecord>();
  readonly locked = new Map<string, TermsRecord>();
  readonly transactions = new Map<string, TransactionRecord>();
  readonly nonces = new Map<string, bigint>();
  readonly usedEscrowIds = new Set<string>();
  readonly allowances = new Map<string, bigint>();
  /** What `kernel.escrowPrincipal` answers, by transaction id. */
  readonly principals = new Map<string, bigint>();
  readonly disputed = new Set<string>();
  /** Every `eth_call` answered, with the block it was pinned to. */
  readonly reads: { name: string; blockTag: unknown }[] = [];

  approveIntegrator(provider: string, integrator: string, maxBps: number): void {
    this.approvals.set(key(provider, integrator), maxBps);
  }

  /** Execute `calls` from `sender` atomically. */
  execute(sender: string, calls: ChainCall[]): void {
    const snapshot = {
      pending: new Map(this.pending),
      locked: new Map(this.locked),
      transactions: new Map(this.transactions),
      nonces: new Map(this.nonces),
      used: new Set(this.usedEscrowIds),
      allowances: new Map(this.allowances),
    };
    try {
      for (const call of calls) this.apply(sender, call);
      this.executed.push(calls);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  private restore(snapshot: {
    pending: Map<string, TermsRecord>;
    locked: Map<string, TermsRecord>;
    transactions: Map<string, TransactionRecord>;
    nonces: Map<string, bigint>;
    used: Set<string>;
    allowances: Map<string, bigint>;
  }): void {
    const refill = <V>(target: Map<string, V>, source: Map<string, V>): void => {
      target.clear();
      source.forEach((value, name) => target.set(name, value));
    };
    refill(this.pending, snapshot.pending);
    refill(this.locked, snapshot.locked);
    refill(this.transactions, snapshot.transactions);
    refill(this.nonces, snapshot.nonces);
    refill(this.allowances, snapshot.allowances);
    this.usedEscrowIds.clear();
    snapshot.used.forEach(id => this.usedEscrowIds.add(id));
  }

  private apply(sender: string, call: ChainCall): void {
    const target = call.target.toLowerCase();
    if (target === this.usdc) {
      const args = ERC20_INTERFACE.decodeFunctionData('approve', call.data);
      this.allowances.set(key(sender, text(args, 0)), integer(args, 1));
    } else if (target === this.vault) {
      const args = FEE_SPLIT_VAULT_INTERFACE.decodeFunctionData('setEscrowTerms', call.data);
      this.pending.set(key(sender, text(args, 0)), {
        integrator: text(args, 1),
        bps: Number(integer(args, 2)),
        profile: Number(integer(args, 3)),
      });
    } else if (target === this.kernel) {
      this.applyKernel(sender, call.data);
    } else {
      throw new Error(`fake chain: unknown target ${call.target}`);
    }
  }

  private applyKernel(sender: string, data: string): void {
    const parsed = KERNEL_INTERFACE.parseTransaction({ data });
    if (parsed?.name === 'createTransaction') {
      const provider = text(parsed.args, 0);
      const requester = text(parsed.args, 1);
      if (requester.toLowerCase() !== sender.toLowerCase()) throw new Error('Requester mismatch');
      const amount = integer(parsed.args, 2);
      const serviceHash = text(parsed.args, 5);
      const nonce = this.nonces.get(key(requester)) ?? 0n;
      const txId = computeTransactionId(requester, provider, amount.toString(), serviceHash, nonce);
      this.nonces.set(key(requester), nonce + 1n);
      this.transactions.set(txId, { requester, provider, amount, serviceHash, escrowContract: ZERO_ADDRESS, escrowId: ZERO_HASH });
    } else if (parsed?.name === 'linkEscrow') {
      this.link(sender, text(parsed.args, 0), text(parsed.args, 1), text(parsed.args, 2));
    } else {
      throw new Error('fake chain: unsupported kernel call');
    }
  }

  private link(sender: string, txId: string, vault: string, escrowId: string): void {
    if (this.usedEscrowIds.has(key(vault, escrowId))) throw new Error('execution reverted: Escrow ID already used');
    this.usedEscrowIds.add(key(vault, escrowId));
    const tx = this.transactions.get(txId);
    if (!tx) throw new Error('execution reverted: Tx missing');
    if (tx.requester.toLowerCase() !== sender.toLowerCase()) throw new Error('execution reverted: Only requester');
    if ((this.allowances.get(key(sender, vault)) ?? 0n) < tx.amount) throw new Error('execution reverted: Allowance');
    if (vault.toLowerCase() === this.vault) {
      const terms = this.pending.get(key(sender, escrowId));
      if (terms) {
        if (escrowId !== txId) throw new Error('execution reverted: Terms need txId escrowId');
        if ((this.approvals.get(key(tx.provider, terms.integrator)) ?? 0) < terms.bps) {
          throw new Error('execution reverted: Integrator not approved');
        }
        this.locked.set(escrowId, terms);
        this.pending.delete(key(sender, escrowId));
      }
    }
    tx.escrowContract = vault;
    tx.escrowId = escrowId;
  }

  /** Answer an `eth_call`. */
  call(to: string, data: string, blockTag?: unknown): string {
    const target = to.toLowerCase();
    if (target === this.vault) return this.callVault(data, blockTag);
    if (target === this.kernel) return this.callKernel(data, blockTag);
    if (target === ENTRYPOINT_V06.toLowerCase()) return ENTRYPOINT_INTERFACE.encodeFunctionResult('getNonce', [0n]);
    if (target === SMART_WALLET_FACTORY.toLowerCase()) {
      return FACTORY_INTERFACE.encodeFunctionResult('getAddress', [this.smartWallet]);
    }
    throw new Error(`fake chain: eth_call to unknown target ${to}`);
  }

  private refundSplit(escrowId: string, amount: bigint, asIfDisputed: boolean): bigint[] {
    const terms = this.locked.get(escrowId);
    if (!terms || terms.profile !== 1 || !(asIfDisputed || this.disputed.has(escrowId))) return [amount, 0n, 0n];
    const split = previewDisputeRefund(amount, this.platformFeeBps, terms.bps);
    return [split.requesterAmount, split.protocolFee, split.integratorFee];
  }

  private callVault(data: string, blockTag: unknown): string {
    const parsed = FEE_SPLIT_VAULT_INTERFACE.parseTransaction({ data });
    if (!parsed) throw new Error('fake chain: unknown vault call');
    this.reads.push({ name: parsed.name, blockTag });
    if (parsed.name === 'quoteRefundIfDisputed') {
      const split = this.refundSplit(text(parsed.args, 0), integer(parsed.args, 1), true);
      return FEE_SPLIT_VAULT_INTERFACE.encodeFunctionResult(parsed.name, [...split, true]);
    }
    if (parsed.name === 'quoteRefund') {
      const split = this.refundSplit(text(parsed.args, 0), integer(parsed.args, 1), false);
      return FEE_SPLIT_VAULT_INTERFACE.encodeFunctionResult(parsed.name, split);
    }
    const encode = (values: unknown[]): string => FEE_SPLIT_VAULT_INTERFACE.encodeFunctionResult(parsed.name, values);
    if (parsed.name === 'integratorMaxBps') {
      return encode([this.approvals.get(key(text(parsed.args, 0), text(parsed.args, 1))) ?? 0]);
    }
    if (parsed.name === 'previewDisputeRefund') {
      const split = previewDisputeRefund(integer(parsed.args, 0), Number(integer(parsed.args, 1)), Number(integer(parsed.args, 2)));
      return encode([split.requesterAmount, split.protocolFee, split.integratorFee]);
    }
    if (parsed.name === 'lockedTerms') {
      const escrowId = text(parsed.args, 0);
      const terms = this.locked.get(escrowId);
      const used = [...this.transactions.values()].some(tx => tx.escrowId === escrowId && tx.escrowContract.toLowerCase() === this.vault);
      return encode(terms ? [terms.integrator, terms.bps, terms.profile, 1, 0, false, true] : [ZERO_ADDRESS, 0, 0, 0, 0, false, used]);
    }
    throw new Error(`fake chain: unsupported vault view ${parsed.name}`);
  }

  private callKernel(data: string, blockTag: unknown): string {
    const parsed = KERNEL_INTERFACE.parseTransaction({ data });
    this.reads.push({ name: parsed?.name ?? 'unknown', blockTag });
    if (parsed?.name === 'escrowPrincipal') {
      return KERNEL_INTERFACE.encodeFunctionResult('escrowPrincipal', [this.principals.get(text(parsed.args, 0)) ?? 0n]);
    }
    if (parsed?.name === 'platformFeeBps') {
      return KERNEL_INTERFACE.encodeFunctionResult('platformFeeBps', [this.platformFeeBps]);
    }
    if (parsed?.name === 'requesterNonces') {
      return KERNEL_INTERFACE.encodeFunctionResult('requesterNonces', [this.nonces.get(key(text(parsed.args, 0))) ?? 0n]);
    }
    throw new Error('fake chain: unsupported kernel view');
  }

  /** The calls of a UserOp's `executeBatch` calldata. */
  static callsOf(callData: string): ChainCall[] {
    const decoded: unknown = BATCH_INTERFACE.decodeFunctionData('executeBatch', callData)[0];
    if (!Array.isArray(decoded)) throw new Error('not an executeBatch calldata');
    return decoded.map((entry: unknown) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[2] !== 'string') {
        throw new Error('malformed batch call');
      }
      return { target: entry[0], data: entry[2] };
    });
  }
}

/** A JSON-RPC provider that answers from a FeeSplitChain and never touches the network. */
export class FeeSplitChainProvider extends JsonRpcProvider {
  constructor(private readonly chain: FeeSplitChain) {
    super('http://fee-split-chain.invalid', 84532, { staticNetwork: Network.from(84532) });
  }

  override send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    if (method === 'eth_call' && Array.isArray(params)) {
      const request: unknown = params[0];
      if (typeof request === 'object' && request !== null && 'to' in request && 'data' in request) {
        const { to, data } = request;
        if (typeof to === 'string' && typeof data === 'string') return Promise.resolve(this.chain.call(to, data, params[1]));
      }
    }
    if (method === 'eth_getCode') return Promise.resolve('0x');
    if (method === 'eth_blockNumber') return Promise.resolve('0x64');
    if (method === 'eth_chainId') return Promise.resolve('0x14a34');
    return Promise.reject(new Error(`fake chain: unsupported method ${method}`));
  }

  override getFeeData(): Promise<FeeData> {
    return Promise.resolve(new FeeData(1n, 2n, 1n));
  }
}
