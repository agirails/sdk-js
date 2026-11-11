#!/usr/bin/env ts-node
/**
 * FeeSplitVault soak runner (EOA path): creates one day's batch of soak escrows through the public
 * SDK API and writes a run file in the format of actp-kernel's acceptance scripts, so that
 * `script/AcceptFeeSplitExec.s.sol` executes the time-gated halves and
 * `deployments/scripts/reconcile_feesplit.py` reconciles every job.
 *
 * Two integrator configurations alternate: PI's (100 bps, BOTH_AFTER_DISPUTE) and a third-party one
 * (300 bps, PAYOUT_ONLY). One day is 8 escrows: two settlements, one settlement under 5 USDC, one
 * milestone job, two disputes (the rulings 0, 1 and 2 rotate with the day), one pre-dispute refund
 * (provider cancel, requester cancel after the deadline and stalled recovery rotate with the day)
 * and one plain-vault control. Amounts are non-round and derived from the day, so a day can be
 * recognized in the reports.
 *
 * The requester key must be dedicated to the soak: the reconciler fails on any escrow of that
 * address that no run file names. Every funded escrow is appended to soak-d<day>.journal.jsonl as
 * soon as it is known to be linked, also when the link call itself failed after the kernel accepted
 * it; the run file is written from those entries even when a job fails part-way, and the journal is
 * removed only then. A journal left behind means the run file was not written: recover from it.
 *
 * Not covered here: jobs through a paymaster (smart-wallet path).
 *
 * Env:
 *   SOAK_RPC, FEE_SPLIT_KERNEL, FEE_SPLIT_VAULT, PLAIN_VAULT, BOND_ESCALATION
 *   REQUESTER_KEY, PROVIDER_KEY, KEEPER_KEY
 *   PI_INTEGRATOR, THIRD_INTEGRATOR       integrator addresses of the two configurations
 *   SOAK_OUT_DIR                          <actp-kernel>/deployments/feesplit-acceptance
 *   SOAK_DAY                              day number of the soak, from 1
 *   SOAK_NO_MINT=true                     the token is not mintable: the actors are funded already
 *   SOAK_CONFIRMATIONS                    confirmations per transaction (default 2; 1 on anvil)
 *   SOAK_PREFIX=local                     rehearsal on an anvil that reports chain id 84532: the run
 *                                         file is named local-*, which the kernel repository ignores
 *
 * Run: npx ts-node scripts/feesplit-soak.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { AbiCoder, Interface, JsonRpcProvider, Wallet, ZeroAddress, getAddress } from 'ethers';
import { ACTPKernel, BlockchainRuntime, BondEscalationClient } from '../src';
import type { IntegratorTerms } from '../src';

const ONE = 1_000_000n;
const SERVICE = '0x' + '50'.repeat(32);
const TOKEN = new Interface([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const KERNEL_VIEWS = new Interface([
  'function USDC() view returns (address)',
  'function recoveryGrace() view returns (uint256)',
]);
const REFUND_KINDS = ['providerCancel', 'requesterCancel', 'stalled'] as const;

type Profile = 'D' | 'B' | '-';

interface Entry {
  label: string;
  row: string;
  variant: string;
  profile: Profile;
  txId: string;
  vault: string;
  requester: string;
  provider: string;
  amount: number;
  integrator: string;
  bps: number;
  outcome: 'SETTLED' | 'CANCELLED';
  exec: 'none' | 'finalize' | 'requesterCancel' | 'recover';
  earliestExec: number;
  adminResolved: boolean;
}

interface Configuration {
  name: string;
  terms: IntegratorTerms;
  profile: Profile;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function tier1LivenessSeconds(principal: bigint): number {
  if (principal < 50n * ONE) return 3600;
  if (principal < 500n * ONE) return 7200;
  if (principal < 5000n * ONE) return 14_400;
  return 28_800;
}

const deliveryProof = (): string => AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [3600, '0x' + '5e'.repeat(32)]);

interface Stack {
  day: number;
  chainId: number;
  confirmations: number;
  noMint: boolean;
  provider: JsonRpcProvider;
  token: string;
  recoveryGrace: number;
  kernel: string;
  feeSplitVault: string;
  plainVault: string;
  requesterWallet: Wallet;
  providerWallet: Wallet;
  keeperWallet: Wallet;
  requester: BlockchainRuntime;
  providerRuntime: BlockchainRuntime;
  requesterKernel: ACTPKernel;
  bond: BondEscalationClient;
  configurations: [Configuration, Configuration];
  journal: string;
}

async function loadStack(outDir: string): Promise<Stack> {
  const day = Number(process.env.SOAK_DAY ?? '1');
  if (!Number.isInteger(day) || day < 1) throw new Error('SOAK_DAY must be a positive integer');
  const confirmations = Number(process.env.SOAK_CONFIRMATIONS ?? '2');
  const provider = new JsonRpcProvider(env('SOAK_RPC'), undefined, { cacheTimeout: -1 });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 84532) throw new Error('soak runner: Base Sepolia (or an anvil reporting its chain id) only');

  const kernel = getAddress(env('FEE_SPLIT_KERNEL'));
  const feeSplitVault = getAddress(env('FEE_SPLIT_VAULT'));
  const plainVault = getAddress(env('PLAIN_VAULT'));
  const requesterWallet = new Wallet(env('REQUESTER_KEY'), provider);
  const providerWallet = new Wallet(env('PROVIDER_KEY'), provider);
  const keeperWallet = new Wallet(env('KEEPER_KEY'), provider);

  const view = async (name: string): Promise<unknown> =>
    KERNEL_VIEWS.decodeFunctionResult(name, await provider.call({ to: kernel, data: KERNEL_VIEWS.encodeFunctionData(name) }))[0];
  const token: unknown = await view('USDC');
  const recoveryGrace: unknown = await view('recoveryGrace');
  if (typeof token !== 'string' || typeof recoveryGrace !== 'bigint') throw new Error('unexpected kernel view');

  const contracts = { actpKernel: kernel, escrowVault: plainVault, usdc: token, feeSplitVaults: [{ address: feeSplitVault, funding: true }] };
  const runtimeFor = async (signer: Wallet): Promise<BlockchainRuntime> => {
    const runtime = new BlockchainRuntime({ network: 'base-sepolia', signer, provider, contracts, confirmations });
    await runtime.initialize();
    return runtime;
  };
  const journal = path.join(outDir, `soak-d${day}.journal.jsonl`);
  if (fs.existsSync(journal)) throw new Error(`${journal} exists: an earlier run of this day did not finish; recover its entries first`);
  return {
    journal,
    day,
    chainId,
    confirmations,
    noMint: process.env.SOAK_NO_MINT === 'true',
    provider,
    token,
    recoveryGrace: Number(recoveryGrace),
    kernel,
    feeSplitVault,
    plainVault,
    requesterWallet,
    providerWallet,
    keeperWallet,
    requester: await runtimeFor(requesterWallet),
    providerRuntime: await runtimeFor(providerWallet),
    requesterKernel: new ACTPKernel(kernel, requesterWallet, undefined, confirmations),
    bond: new BondEscalationClient({ address: getAddress(env('BOND_ESCALATION')), signer: keeperWallet, confirmations }),
    configurations: [
      { name: 'pi', profile: 'B', terms: { address: getAddress(env('PI_INTEGRATOR')), bps: 100, profile: 'BOTH_AFTER_DISPUTE' } },
      { name: 'third', profile: 'D', terms: { address: getAddress(env('THIRD_INTEGRATOR')), bps: 300, profile: 'PAYOUT_ONLY' } },
    ],
  };
}

class SoakDay {
  readonly entries: Entry[] = [];

  constructor(private readonly stack: Stack) {}

  private async sendToken(signer: Wallet, name: string, args: unknown[]): Promise<void> {
    const response = await signer.sendTransaction({ to: this.stack.token, data: TOKEN.encodeFunctionData(name, args) });
    await response.wait(this.stack.confirmations);
  }

  private async mint(to: Wallet, amount: bigint): Promise<void> {
    if (!this.stack.noMint) await this.sendToken(to, 'mint', [to.address, amount]);
  }

  private async chainTime(): Promise<number> {
    const block = await this.stack.provider.getBlock('latest');
    if (!block) throw new Error('no latest block');
    return block.timestamp;
  }

  async approveIntegrators(): Promise<void> {
    const { providerRuntime, providerWallet, feeSplitVault } = this.stack;
    for (const { terms } of this.stack.configurations) {
      const approved = await providerRuntime.feeSplit.reader().integratorMaxBps(feeSplitVault, providerWallet.address, terms.address);
      if (approved < terms.bps) await providerRuntime.feeSplit.setIntegratorApproval(terms.address, terms.bps);
    }
  }

  private async openEscrowAndRecordEntry(
    kind: string,
    amount: bigint,
    configuration: Configuration | undefined,
    deadlineIn: number,
    expectation: Pick<Entry, 'outcome' | 'exec'>
  ): Promise<Entry> {
    const { requester, requesterWallet, providerWallet, feeSplitVault, plainVault, day } = this.stack;
    await this.mint(requesterWallet, amount);
    const txId = await requester.createTransaction({
      provider: providerWallet.address,
      requester: requesterWallet.address,
      amount: amount.toString(),
      deadline: (await this.chainTime()) + deadlineIn,
      disputeWindow: 3600,
      serviceDescription: SERVICE,
    });
    const entry: Entry = {
      label: `soak-d${day}-${this.entries.length + 1}-${kind}${configuration ? `-${configuration.name}` : ''}`,
      row: '',
      variant: kind,
      profile: configuration?.profile ?? '-',
      txId,
      vault: configuration ? feeSplitVault : plainVault,
      requester: requesterWallet.address,
      provider: providerWallet.address,
      amount: Number(amount),
      integrator: configuration?.terms.address ?? ZeroAddress,
      bps: configuration?.terms.bps ?? 0,
      ...expectation,
      earliestExec: 0,
      adminResolved: false,
    };
    try {
      await requester.linkEscrow(
        txId,
        amount.toString(),
        configuration ? { integrator: configuration.terms, acknowledgeDisputeFee: configuration.profile === 'B' } : undefined
      );
    } catch (error) {
      const linked = (await requester.getTransaction(txId))?.escrowContract !== undefined;
      if (linked) this.record(entry);
      throw error;
    }
    this.record(entry);
    return entry;
  }

  private record(entry: Entry): void {
    this.entries.push(entry);
    fs.appendFileSync(this.stack.journal, JSON.stringify(entry) + '\n');
    console.log(`armed ${entry.label} ${entry.txId}`);
  }

  private async deliver(txId: string): Promise<void> {
    await this.stack.providerRuntime.transitionState(txId, 'IN_PROGRESS');
    await this.stack.providerRuntime.transitionState(txId, 'DELIVERED', deliveryProof());
  }

  async settlement(kind: string, amount: bigint, configuration: Configuration | undefined): Promise<void> {
    const entry = await this.openEscrowAndRecordEntry(kind, amount, configuration, 7 * 86_400, { outcome: 'SETTLED', exec: 'none' });
    await this.deliver(entry.txId);
    await this.stack.requester.transitionState(entry.txId, 'SETTLED');
  }

  async milestones(amount: bigint, configuration: Configuration): Promise<void> {
    const { requesterKernel, providerRuntime, requester } = this.stack;
    const entry = await this.openEscrowAndRecordEntry('milestone', amount, configuration, 7 * 86_400, { outcome: 'SETTLED', exec: 'none' });
    await providerRuntime.transitionState(entry.txId, 'IN_PROGRESS');
    await requesterKernel.releaseMilestone(entry.txId, amount / 4n);
    await requesterKernel.releaseMilestone(entry.txId, amount / 3n);
    await providerRuntime.transitionState(entry.txId, 'DELIVERED', deliveryProof());
    await requester.transitionState(entry.txId, 'SETTLED');
  }

  async requesterDisputeWithDirectProposal(ruling: 0 | 1 | 2, amount: bigint, configuration: Configuration): Promise<void> {
    const { requester, requesterWallet, keeperWallet, requesterKernel, bond, feeSplitVault } = this.stack;
    const entry = await this.openEscrowAndRecordEntry(`ruling${ruling}`, amount, configuration, 7 * 86_400, {
      outcome: ruling === 2 ? 'CANCELLED' : 'SETTLED',
      exec: 'finalize',
    });
    await this.deliver(entry.txId);
    const entryBondCeiling = amount > ONE ? amount : ONE;
    await this.mint(requesterWallet, entryBondCeiling);
    await this.sendToken(requesterWallet, 'approve', [feeSplitVault, entryBondCeiling]);
    await requester.transitionState(entry.txId, 'DISPUTED');

    const principal = await requesterKernel.getEscrowPrincipal(entry.txId);
    const escalationBond = BondEscalationClient.quoteInitialBond(principal);
    await this.mint(keeperWallet, escalationBond);
    await this.sendToken(keeperWallet, 'approve', [bond.getAddress(), escalationBond]);
    const { disputeId } = await bond.openDispute(entry.txId);
    await bond.proposeDirectly(disputeId, ruling, ruling === 2 ? 4000 : 0);
    entry.earliestExec = (await this.chainTime()) + tier1LivenessSeconds(principal) + 600;
  }

  async preDisputeRefund(kind: (typeof REFUND_KINDS)[number], amount: bigint, configuration: Configuration): Promise<void> {
    if (kind === 'providerCancel') {
      const entry = await this.openEscrowAndRecordEntry(kind, amount, configuration, 7 * 86_400, { outcome: 'CANCELLED', exec: 'none' });
      await this.stack.providerRuntime.transitionState(entry.txId, 'CANCELLED');
      return;
    }
    const stalled = kind === 'stalled';
    const entry = await this.openEscrowAndRecordEntry(kind, amount, configuration, 70 * 60, {
      outcome: 'CANCELLED',
      exec: stalled ? 'recover' : 'requesterCancel',
    });
    if (stalled) await this.stack.providerRuntime.transitionState(entry.txId, 'IN_PROGRESS');
    entry.earliestExec = (await this.chainTime()) + 71 * 60 + (stalled ? this.stack.recoveryGrace : 0);
  }

  async run(): Promise<void> {
    const { day } = this.stack;
    const [pi, third] = this.stack.configurations;
    const odd = BigInt(day) * 1_111n;
    const rulings: (0 | 1 | 2)[] = [0, 1, 2];
    await this.settlement('settle', 25n * ONE + odd, pi);
    await this.settlement('settle', 137n * ONE + 654_321n + odd, third);
    await this.settlement('small', 3n * ONE + 333_333n + odd, day % 2 === 0 ? pi : third);
    await this.milestones(60n * ONE + 7n + odd, day % 2 === 0 ? third : pi);
    await this.requesterDisputeWithDirectProposal(rulings[day % 3] ?? 0, 40n * ONE + 123_457n + odd, pi);
    await this.requesterDisputeWithDirectProposal(rulings[(day + 1) % 3] ?? 1, 12n * ONE + 1n + odd, third);
    await this.preDisputeRefund(REFUND_KINDS[day % 3] ?? 'providerCancel', 18n * ONE + 999_999n + odd, pi);
    await this.settlement('plain', 9n * ONE + 500_001n + odd, undefined);
  }
}

async function writeRunFile(stack: Stack, entries: Entry[], outDir: string): Promise<void> {
  if (entries.length === 0) return;
  const block = await stack.provider.getBlock('latest');
  if (!block) throw new Error('no latest block');
  const set = `soak-d${stack.day}`;
  const file = path.join(outDir, `${process.env.SOAK_PREFIX === 'local' ? 'local' : 'sepolia'}-${set}-${block.number}.json`);
  const run = {
    version: 1,
    kind: 'run',
    set,
    chainId: stack.chainId,
    armBlock: block.number,
    armTime: block.timestamp,
    kernel: stack.kernel,
    feeSplitVault: stack.feeSplitVault,
    plainVault: stack.plainVault,
    token: stack.token,
    count: entries.length,
    entries,
  };
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' });
  fs.rmSync(stack.journal);
  console.log(`run file: ${file}`);
}

async function main(): Promise<void> {
  const outDir = env('SOAK_OUT_DIR');
  if (!fs.statSync(outDir).isDirectory()) throw new Error('SOAK_OUT_DIR is not a directory');
  const stack = await loadStack(outDir);
  const soak = new SoakDay(stack);
  try {
    await soak.approveIntegrators();
    await soak.run();
  } finally {
    await writeRunFile(stack, soak.entries, outDir);
    stack.provider.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
