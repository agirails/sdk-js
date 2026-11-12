/**
 * FeeSplitVault funded from a smart wallet through a paymaster, against the real contracts on a
 * local anvil: the real EntryPoint v0.6 and CoinbaseSmartWallet validate and execute the UserOps
 * the SDK builds, and a local bundler and accept-all paymaster (helpers/localAA) stand in for the
 * hosted ones. Two endpoints are served, as the SDK has two providers; each has its own paymaster,
 * so the sponsor of a UserOp is read from the chain. The smart wallets never hold ETH.
 *
 * Not covered: the policy or allowlist of a hosted paymaster.
 *
 * Run: FEESPLIT_KERNEL_OUT=<actp-kernel>/out npx jest --runInBand \
 *        --testPathPattern='feesplit-aa-local' --testPathIgnorePatterns=/node_modules/ --testTimeout=120000
 */

import { Wallet, id } from 'ethers';
import { AutoWalletProvider } from '../../wallet/AutoWalletProvider';
import { BlockchainRuntime } from '../../runtime/BlockchainRuntime';
import { DisputeFeeNotAcknowledgedError } from '../../feesplit/errors';
import type { IntegratorTerms } from '../../feesplit/types';
import type { BatchedPayResult } from '../../wallet/IWalletProvider';
import {
  KERNEL_CALLS,
  STATE,
  TOKEN_INTERFACE,
  balanceOf,
  deliveryProof,
  feeSplitStackPrereqs,
  read,
  resolutionProof,
  send,
  startFeeSplitStack,
  type FeeSplitStack,
} from './helpers/feeSplitStack';
import { ENTRY_POINT, ENTRY_POINT_INTERFACE, LocalAA, installAAContracts, sponsorOf } from './helpers/localAA';

const ONE = 1_000_000n;
const K = 1000n * ONE;
const SERVICE = '0x' + '11'.repeat(32);
const ENDPOINTS = [
  { name: 'first', port: 18_931, paymaster: '0x00000000000000000000000000000000000aa001', bundlerIndex: 8 },
  { name: 'second', port: 18_932, paymaster: '0x00000000000000000000000000000000000aa002', bundlerIndex: 9 },
];
const missing = feeSplitStackPrereqs();
const suite = missing.length === 0 ? describe : describe.skip;

suite(`FeeSplitVault through a smart wallet and a paymaster${missing.length ? `  [skipped: missing ${missing.join(', ')}]` : ''}`, () => {
  let stack: FeeSplitStack;
  let reader: BlockchainRuntime;
  let endpoints: LocalAA[];
  let wallets: AutoWalletProvider[];
  let payoutOnly: IntegratorTerms;
  let bothAfterDispute: IntegratorTerms;
  let thirdParty: IntegratorTerms;

  const mint = (wallet: AutoWalletProvider, amount: bigint): Promise<void> =>
    send(stack.admin, stack.token, TOKEN_INTERFACE, 'mint', [wallet.getAddress(), amount]);

  async function pay(wallet: AutoWalletProvider, integrator: IntegratorTerms, acknowledgeDisputeFee?: boolean): Promise<BatchedPayResult> {
    await mint(wallet, K);
    return submit(wallet, integrator, acknowledgeDisputeFee);
  }

  function submit(wallet: AutoWalletProvider, integrator: IntegratorTerms, acknowledgeDisputeFee?: boolean): Promise<BatchedPayResult> {
    return wallet.payACTPBatched({
      provider: stack.providerAgent.address,
      requester: wallet.getAddress(),
      amount: K.toString(),
      deadline: Math.floor(Date.now() / 1000) + 7 * 86_400,
      disputeWindow: 3600,
      serviceHash: SERVICE,
      agentId: '0',
      contracts: {
        usdc: stack.token,
        actpKernel: stack.kernel,
        escrowVault: stack.plainVault,
        feeSplitVaults: [{ address: stack.feeSplitVault, funding: true }],
      },
      feeSplit: { integrator, acknowledgeDisputeFee },
    });
  }

  const kernelTx = (name: string, args: unknown[]): { to: string; data: string } => ({
    to: stack.kernel,
    data: KERNEL_CALLS.encodeFunctionData(name, args),
  });

  async function deliver(txId: string): Promise<void> {
    await send(stack.providerAgent, stack.kernel, KERNEL_CALLS, 'transitionState', [txId, STATE.IN_PROGRESS, '0x']);
    await send(stack.providerAgent, stack.kernel, KERNEL_CALLS, 'transitionState', [txId, STATE.DELIVERED, deliveryProof(3600)]);
  }

  async function balances(wallet: AutoWalletProvider): Promise<Record<'requester' | 'provider' | 'integrator' | 'protocol', bigint>> {
    return {
      requester: await balanceOf(stack, wallet.getAddress()),
      provider: await balanceOf(stack, stack.providerAgent.address),
      integrator: await balanceOf(stack, stack.integrator),
      protocol: (await balanceOf(stack, stack.feeRecipient)) + (await balanceOf(stack, stack.archive)),
    };
  }

  const deposit = (paymaster: string): Promise<bigint> => read(stack.provider, ENTRY_POINT, ENTRY_POINT_INTERFACE, 'balanceOf', [paymaster]);
  const entryPointNonce = (wallet: AutoWalletProvider): Promise<bigint> => wallet.getNonceManager().readEntryPointNonce();

  beforeAll(async () => {
    stack = await startFeeSplitStack();
    await installAAContracts(stack.provider);
    endpoints = [];
    wallets = [];
    for (const { name, port, paymaster, bundlerIndex } of ENDPOINTS) {
      const endpoint = await LocalAA.start({ provider: stack.provider, bundler: stack.wallet(bundlerIndex), paymaster, port });
      endpoints.push(endpoint);
      wallets.push(
        await AutoWalletProvider.create({
          signer: new Wallet(id(`feesplit aa owner ${name}`), stack.provider),
          provider: stack.provider,
          chainId: 84_532,
          actpKernelAddress: stack.kernel,
          bundler: { primaryUrl: endpoint.url },
          paymaster: { primaryUrl: endpoint.url },
        })
      );
    }
    reader = new BlockchainRuntime({
      network: 'base-sepolia',
      signer: stack.providerAgent,
      provider: stack.provider,
      pollingInterval: 100,
      contracts: {
        actpKernel: stack.kernel,
        escrowVault: stack.plainVault,
        usdc: stack.token,
        feeSplitVaults: [{ address: stack.feeSplitVault, funding: true }],
      },
    });
    await reader.initialize();
    payoutOnly = { address: stack.integrator, bps: 100, profile: 'PAYOUT_ONLY' };
    bothAfterDispute = { address: stack.integrator, bps: 100, profile: 'BOTH_AFTER_DISPUTE' };
    thirdParty = { address: stack.wallet(7).address, bps: 300, profile: 'PAYOUT_ONLY' };
    await reader.feeSplit.setIntegratorApproval(stack.integrator, 100);
    await reader.feeSplit.setIntegratorApproval(thirdParty.address, 300);
  }, 120_000);

  afterAll(async () => {
    for (const endpoint of endpoints ?? []) await endpoint.stop();
    stack?.stop();
  });

  it.each([0, 1])('A3 through paymaster %i: one sponsored UserOp funds with terms, a second settles; 980 / 10 / 10', async index => {
    const wallet = wallets[index];
    const endpoint = endpoints[index];
    const depositBefore = await deposit(endpoint.paymaster);
    expect(await stack.provider.getBalance(wallet.getAddress())).toBe(0n);

    const paid = await pay(wallet, payoutOnly);
    expect(paid.success).toBe(true);
    expect(await sponsorOf(stack.provider, paid.hash, wallet.getAddress())).toBe(endpoint.paymaster);
    expect((await reader.getTransaction(paid.txId))?.escrowContract?.toLowerCase()).toBe(stack.feeSplitVault.toLowerCase());
    expect(await reader.feeSplit.lockedTerms(stack.feeSplitVault, paid.txId)).toMatchObject({
      integrator: stack.integrator,
      bps: 100,
      profile: 'PAYOUT_ONLY',
    });

    const before = await balances(wallet);
    await deliver(paid.txId);
    const settled = await wallet.sendTransaction(kernelTx('transitionState', [paid.txId, STATE.SETTLED, '0x']));
    expect(settled.success).toBe(true);
    expect(await sponsorOf(stack.provider, settled.hash, wallet.getAddress())).toBe(endpoint.paymaster);
    const after = await balances(wallet);
    expect(after.provider - before.provider).toBe(980n * ONE);
    expect(after.integrator - before.integrator).toBe(10n * ONE);
    expect(after.protocol - before.protocol).toBe(10n * ONE);

    expect(await stack.provider.getBalance(wallet.getAddress())).toBe(0n);
    expect(await deposit(endpoint.paymaster)).toBeLessThan(depositBefore);
  });

  it('two concurrent payments with different integrator, rate and profile: each id locks its own terms', async () => {
    const wallet = wallets[0];
    const nonce = await entryPointNonce(wallet);
    await mint(wallet, 2n * K);
    const [first, second] = await Promise.all([submit(wallet, bothAfterDispute, true), submit(wallet, thirdParty)]);
    expect(first.txId).not.toBe(second.txId);
    expect(await entryPointNonce(wallet)).toBe(nonce + 2n);
    expect(await reader.feeSplit.lockedTerms(stack.feeSplitVault, first.txId)).toMatchObject({
      integrator: stack.integrator,
      bps: 100,
      profile: 'BOTH_AFTER_DISPUTE',
    });
    expect(await reader.feeSplit.lockedTerms(stack.feeSplitVault, second.txId)).toMatchObject({
      integrator: thirdParty.address,
      bps: 300,
      profile: 'PAYOUT_ONLY',
    });
  });

  it('BOTH_AFTER_DISPUTE without an acknowledgment is refused and no UserOp is submitted', async () => {
    const wallet = wallets[1];
    const nonce = await entryPointNonce(wallet);
    const funds = await balanceOf(stack, wallet.getAddress());
    await expect(pay(wallet, bothAfterDispute)).rejects.toBeInstanceOf(DisputeFeeNotAcknowledgedError);
    expect(await entryPointNonce(wallet)).toBe(nonce);
    expect(await balanceOf(stack, wallet.getAddress())).toBe(funds + K);
  });

  it('A9 (B): the quote returned at funding equals what a won dispute pays: received 980, protocol 10, platform 10', async () => {
    const wallet = wallets[1];
    const paid = await pay(wallet, bothAfterDispute, true);
    expect(paid.ifDisputedRefundQuote).toEqual({
      refundAmount: K.toString(),
      requesterAmount: (980n * ONE).toString(),
      protocolFee: (10n * ONE).toString(),
      integratorFee: (10n * ONE).toString(),
    });
    await deliver(paid.txId);

    await mint(wallet, K);
    const held = await balanceOf(stack, wallet.getAddress());
    const disputed = await wallet.sendBatchTransaction([
      { to: stack.token, data: TOKEN_INTERFACE.encodeFunctionData('approve', [stack.feeSplitVault, K]) },
      kernelTx('transitionState', [paid.txId, STATE.DISPUTED, '0x']),
    ]);
    expect(disputed.success).toBe(true);
    const bond = held - (await balanceOf(stack, wallet.getAddress()));
    expect(bond).toBeGreaterThan(0n);

    const before = await balances(wallet);
    await send(stack.admin, stack.kernel, KERNEL_CALLS, 'transitionState', [paid.txId, STATE.SETTLED, resolutionProof(K, 0n)]);
    const after = await balances(wallet);
    expect(after.requester - before.requester - bond).toBe(980n * ONE);
    expect(after.integrator - before.integrator).toBe(10n * ONE);
    expect(after.protocol - before.protocol).toBe(10n * ONE);
    expect(after.provider - before.provider).toBe(0n);
  });
});
