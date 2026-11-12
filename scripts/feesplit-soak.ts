#!/usr/bin/env ts-node
/**
 * FeeSplitVault soak runner: creates one day's batch of soak escrows through the public
 * SDK API and writes a run file in the format of actp-kernel's acceptance scripts, so that
 * `script/AcceptFeeSplitExec.s.sol` executes the time-gated halves and
 * `deployments/scripts/reconcile_feesplit.py` reconciles every job.
 *
 * Two integrator configurations alternate: PI's (100 bps, BOTH_AFTER_DISPUTE) and a third-party one
 * (300 bps, PAYOUT_ONLY). One day is 8 escrows: two settlements, one settlement under 5 USDC, one
 * milestone job, two disputes (the rulings 0, 1 and 2 rotate with the day), one pre-dispute refund
 * (provider cancel, requester cancel after the deadline and stalled recovery rotate with the day)
 * and one plain-vault control, all from the requester EOA. With SOAK_PAYMASTERS set, each named
 * paymaster adds two escrows from its own smart wallet (feesplit-soak-requesters.ts): a settlement,
 * and a milestone job, a dispute or a provider cancel in rotation; every UserOp of those wallets is
 * sponsored. Amounts are non-round and derived from the day, so a day can be recognized in the
 * reports.
 *
 * The requester key and the smart wallets must be dedicated to the soak: the reconciler fails on any
 * escrow of those addresses that no run file names. Their addresses are printed at the start and
 * written to the run file as `requesters`; pass each to the reconciler with --requester. Every funded escrow is appended to soak-d<day>.journal.jsonl as
 * soon as it is known to be linked, also when the link call itself failed after the kernel accepted
 * it; the run file is written from those entries even when a job fails part-way, and the journal is
 * removed only then. A journal left behind means the run file was not written: recover from it.
 *
 * Env:
 *   SOAK_RPC, FEE_SPLIT_KERNEL, FEE_SPLIT_VAULT, PLAIN_VAULT, BOND_ESCALATION
 *   REQUESTER_KEY, PROVIDER_KEY, KEEPER_KEY
 *   PI_INTEGRATOR, THIRD_INTEGRATOR       integrator addresses of the two configurations
 *   SOAK_PAYMASTERS                       comma list of cdp, pimlico; empty: EOA jobs only
 *   SOAK_AA_CDP_KEY, SOAK_AA_PIMLICO_KEY  owner key of the smart wallet of each named paymaster; the
 *                                         wallet holds no ETH, and its USDC when SOAK_NO_MINT=true
 *   CDP_API_KEY or CDP_BUNDLER_URL + CDP_PAYMASTER_URL, PIMLICO_API_KEY or PIMLICO_BUNDLER_URL +
 *   PIMLICO_PAYMASTER_URL, PIMLICO_SPONSORSHIP_POLICY_ID   the SDK's own endpoint variables
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
import { EoaRequester, OpenError, SmartWalletRequester } from './feesplit-soak-requesters';
import type { PaymasterName, RequesterSide, SoakContracts } from './feesplit-soak-requesters';

const ONE = 1_000_000n;
const TOKEN = new Interface([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const KERNEL_VIEWS = new Interface([
  'function USDC() view returns (address)',
  'function recoveryGrace() view returns (uint256)',
]);
const RULINGS: (0 | 1 | 2)[] = [0, 1, 2];
const REFUND_KINDS = ['providerCancel', 'requesterCancel', 'stalled'] as const;
const PAYMASTER_KEYS: Record<PaymasterName, string> = { cdp: 'SOAK_AA_CDP_KEY', pimlico: 'SOAK_AA_PIMLICO_KEY' };

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
  paymaster?: PaymasterName;
  sponsor?: string;
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
  providerWallet: Wallet;
  keeperWallet: Wallet;
  eoa: RequesterSide;
  sponsored: RequesterSide[];
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
  const requesterRuntime = await runtimeFor(requesterWallet);
  const requesterKernel = new ACTPKernel(kernel, requesterWallet, undefined, confirmations);
  const soakContracts: SoakContracts = { kernel, token, plainVault, feeSplitVault };
  const eoa: RequesterSide = new EoaRequester(requesterWallet, requesterRuntime, requesterKernel, soakContracts, confirmations);
  const sponsored: RequesterSide[] = [];
  for (const name of paymasterNames()) {
    sponsored.push(await SmartWalletRequester.create(name, env(PAYMASTER_KEYS[name]), provider, soakContracts, requesterRuntime));
  }
  for (const side of [eoa, ...sponsored]) console.log(`requester (${side.paymaster ?? 'eoa'}) ${side.address}`);
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
    providerWallet,
    keeperWallet,
    eoa,
    sponsored,
    providerRuntime: await runtimeFor(providerWallet),
    requesterKernel,
    bond: new BondEscalationClient({ address: getAddress(env('BOND_ESCALATION')), signer: keeperWallet, confirmations }),
    configurations: [
      { name: 'pi', profile: 'B', terms: { address: getAddress(env('PI_INTEGRATOR')), bps: 100, profile: 'BOTH_AFTER_DISPUTE' } },
      { name: 'third', profile: 'D', terms: { address: getAddress(env('THIRD_INTEGRATOR')), bps: 300, profile: 'PAYOUT_ONLY' } },
    ],
  };
}

function paymasterNames(): PaymasterName[] {
  const names: PaymasterName[] = [];
  for (const name of (process.env.SOAK_PAYMASTERS ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
    if (name !== 'cdp' && name !== 'pimlico') throw new Error(`SOAK_PAYMASTERS: unknown paymaster ${name}`);
    if (names.includes(name)) throw new Error(`SOAK_PAYMASTERS: ${name} is named twice`);
    names.push(name);
  }
  return names;
}

class SoakDay {
  readonly entries: Entry[] = [];

  constructor(private readonly stack: Stack) {}

  private async sendToken(signer: Wallet, name: string, args: unknown[]): Promise<void> {
    const response = await signer.sendTransaction({ to: this.stack.token, data: TOKEN.encodeFunctionData(name, args) });
    await response.wait(this.stack.confirmations);
  }

  private async mint(to: string, amount: bigint): Promise<void> {
    if (!this.stack.noMint) await this.sendToken(this.stack.keeperWallet, 'mint', [to, amount]);
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
    side: RequesterSide,
    kind: string,
    amount: bigint,
    configuration: Configuration | undefined,
    deadlineIn: number,
    expectation: Pick<Entry, 'outcome' | 'exec'>
  ): Promise<Entry> {
    const { providerWallet, feeSplitVault, plainVault, day } = this.stack;
    await this.mint(side.address, amount);
    const entryFor = (txId: string, sponsor?: string): Entry => ({
      label: `soak-d${day}-${this.entries.length + 1}-${kind}${configuration ? `-${configuration.name}` : ''}${side.paymaster ? `-${side.paymaster}` : ''}`,
      row: '',
      variant: kind,
      profile: configuration?.profile ?? '-',
      txId,
      vault: configuration ? feeSplitVault : plainVault,
      requester: side.address,
      provider: providerWallet.address,
      amount: Number(amount),
      integrator: configuration?.terms.address ?? ZeroAddress,
      bps: configuration?.terms.bps ?? 0,
      ...expectation,
      earliestExec: 0,
      adminResolved: false,
      ...(side.paymaster ? { paymaster: side.paymaster, sponsor } : {}),
    });
    try {
      const opened = await side.open({
        provider: providerWallet.address,
        amount,
        deadline: (await this.chainTime()) + deadlineIn,
        funding: configuration ? { integrator: configuration.terms, acknowledgeDisputeFee: configuration.profile === 'B' } : undefined,
      });
      const entry = entryFor(opened.txId, opened.sponsor);
      this.record(entry);
      return entry;
    } catch (error) {
      if (error instanceof OpenError && error.linkedTxId) this.record(entryFor(error.linkedTxId));
      throw error;
    }
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

  async settlement(side: RequesterSide, kind: string, amount: bigint, configuration: Configuration | undefined): Promise<void> {
    const entry = await this.openEscrowAndRecordEntry(side, kind, amount, configuration, 7 * 86_400, { outcome: 'SETTLED', exec: 'none' });
    await this.deliver(entry.txId);
    await side.settle(entry.txId);
  }

  async milestones(side: RequesterSide, amount: bigint, configuration: Configuration): Promise<void> {
    const { providerRuntime } = this.stack;
    const entry = await this.openEscrowAndRecordEntry(side, 'milestone', amount, configuration, 7 * 86_400, { outcome: 'SETTLED', exec: 'none' });
    await providerRuntime.transitionState(entry.txId, 'IN_PROGRESS');
    await side.releaseMilestone(entry.txId, amount / 4n);
    await side.releaseMilestone(entry.txId, amount / 3n);
    await providerRuntime.transitionState(entry.txId, 'DELIVERED', deliveryProof());
    await side.settle(entry.txId);
  }

  async requesterDisputeWithDirectProposal(side: RequesterSide, ruling: 0 | 1 | 2, amount: bigint, configuration: Configuration): Promise<void> {
    const { keeperWallet, requesterKernel, bond } = this.stack;
    const entry = await this.openEscrowAndRecordEntry(side, `ruling${ruling}`, amount, configuration, 7 * 86_400, {
      outcome: ruling === 2 ? 'CANCELLED' : 'SETTLED',
      exec: 'finalize',
    });
    await this.deliver(entry.txId);
    const entryBondCeiling = amount > ONE ? amount : ONE;
    await this.mint(side.address, entryBondCeiling);
    await side.dispute(entry.txId, entryBondCeiling);

    const principal = await requesterKernel.getEscrowPrincipal(entry.txId);
    const escalationBond = BondEscalationClient.quoteInitialBond(principal);
    await this.mint(keeperWallet.address, escalationBond);
    await this.sendToken(keeperWallet, 'approve', [bond.getAddress(), escalationBond]);
    const { disputeId } = await bond.openDispute(entry.txId);
    await bond.proposeDirectly(disputeId, ruling, ruling === 2 ? 4000 : 0);
    entry.earliestExec = (await this.chainTime()) + tier1LivenessSeconds(principal) + 600;
  }

  async preDisputeRefund(side: RequesterSide, kind: (typeof REFUND_KINDS)[number], amount: bigint, configuration: Configuration): Promise<void> {
    if (kind === 'providerCancel') {
      const entry = await this.openEscrowAndRecordEntry(side, kind, amount, configuration, 7 * 86_400, { outcome: 'CANCELLED', exec: 'none' });
      await this.stack.providerRuntime.transitionState(entry.txId, 'CANCELLED');
      return;
    }
    if (side.paymaster) throw new Error(`${kind}: the time-gated half is executed by the requester key, not by a smart wallet`);
    const stalled = kind === 'stalled';
    const entry = await this.openEscrowAndRecordEntry(side, kind, amount, configuration, 70 * 60, {
      outcome: 'CANCELLED',
      exec: stalled ? 'recover' : 'requesterCancel',
    });
    if (stalled) await this.stack.providerRuntime.transitionState(entry.txId, 'IN_PROGRESS');
    entry.earliestExec = (await this.chainTime()) + 71 * 60 + (stalled ? this.stack.recoveryGrace : 0);
  }

  async run(): Promise<void> {
    const { day, eoa, sponsored } = this.stack;
    const [pi, third] = this.stack.configurations;
    const odd = BigInt(day) * 1_111n;
    await this.settlement(eoa, 'settle', 25n * ONE + odd, pi);
    await this.settlement(eoa, 'settle', 137n * ONE + 654_321n + odd, third);
    await this.settlement(eoa, 'small', 3n * ONE + 333_333n + odd, day % 2 === 0 ? pi : third);
    await this.milestones(eoa, 60n * ONE + 7n + odd, day % 2 === 0 ? third : pi);
    await this.requesterDisputeWithDirectProposal(eoa, RULINGS[day % 3] ?? 0, 40n * ONE + 123_457n + odd, pi);
    await this.requesterDisputeWithDirectProposal(eoa, RULINGS[(day + 1) % 3] ?? 1, 12n * ONE + 1n + odd, third);
    await this.preDisputeRefund(eoa, REFUND_KINDS[day % 3] ?? 'providerCancel', 18n * ONE + 999_999n + odd, pi);
    await this.settlement(eoa, 'plain', 9n * ONE + 500_001n + odd, undefined);
    for (const [index, side] of sponsored.entries()) await this.sponsoredJobs(side, index, odd);
  }

  private async sponsoredJobs(side: RequesterSide, index: number, odd: bigint): Promise<void> {
    const { day } = this.stack;
    const [pi, third] = this.stack.configurations;
    const turn = day + index;
    const [first, second] = turn % 2 === 0 ? [pi, third] : [third, pi];
    const base = BigInt(21 + 10 * index) * ONE + odd;
    await this.settlement(side, 'settle', base + 404_040n, first);
    if (turn % 3 === 0) await this.milestones(side, base + 70_707n, second);
    else if (turn % 3 === 1) await this.requesterDisputeWithDirectProposal(side, RULINGS[Math.floor(day / 3) % 3] ?? 0, base + 90_909n, second);
    else await this.preDisputeRefund(side, 'providerCancel', base + 10_101n, second);
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
    requesters: [stack.eoa, ...stack.sponsored].map(side => side.address),
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
