/**
 * FeeSplitVault through BlockchainRuntime against the real contracts on a local anvil: funding
 * from an EOA, disclosure, payout breakdown and the printed amounts for rows A3 and A9 (profile
 * BOTH_AFTER_DISPUTE), and the FSV-V7-001 disclosure regression.
 *
 * Run: FEESPLIT_KERNEL_OUT=<actp-kernel>/out npx jest --runInBand \
 *        --testPathPattern='feesplit-local' --testPathIgnorePatterns=/node_modules/ --testTimeout=120000
 */

import { BlockchainRuntime } from '../../runtime/BlockchainRuntime';
import { DisputeFeeNotAcknowledgedError } from '../../feesplit/errors';
import { breakdownSummary, escrowAmountsView, receiptAmountsFor } from '../../feesplit/display';
import type { IntegratorTerms } from '../../feesplit/types';
import type { HDNodeWallet } from 'ethers';
import {
  KERNEL_CALLS,
  STATE,
  TOKEN_INTERFACE,
  VAULT_VIEWS,
  balanceOf,
  deliveryProof,
  feeSplitStackPrereqs,
  read,
  resolutionProof,
  send,
  startFeeSplitStack,
  type FeeSplitStack,
} from './helpers/feeSplitStack';

const ONE = 1_000_000n;
const K = 1000n * ONE;
const SERVICE = '0x' + '11'.repeat(32);
const missing = feeSplitStackPrereqs();
const suite = missing.length === 0 ? describe : describe.skip;
const usdc = (wei: string): string => (Number(wei) / 1_000_000).toFixed(2);

suite(`FeeSplitVault on a local candidate stack${missing.length ? `  [skipped: missing ${missing.join(', ')}]` : ''}`, () => {
  let stack: FeeSplitStack;
  let requester: BlockchainRuntime;
  let provider: BlockchainRuntime;
  let payoutOnly: IntegratorTerms;
  let bothAfterDispute: IntegratorTerms;

  function runtimeFor(signer: HDNodeWallet): BlockchainRuntime {
    return new BlockchainRuntime({
      network: 'base-sepolia',
      signer,
      provider: stack.provider,
      pollingInterval: 100,
      contracts: {
        actpKernel: stack.kernel,
        escrowVault: stack.plainVault,
        usdc: stack.token,
        feeSplitVaults: [{ address: stack.feeSplitVault, funding: true }],
      },
    });
  }

  async function create(): Promise<string> {
    await send(stack.admin, stack.token, TOKEN_INTERFACE, 'mint', [stack.requester.address, K]);
    return requester.createTransaction({
      provider: stack.providerAgent.address,
      requester: stack.requester.address,
      amount: K.toString(),
      deadline: Math.floor(Date.now() / 1000) + 7 * 86_400,
      disputeWindow: 3600,
      serviceDescription: SERVICE,
    });
  }

  const kernelCall = (signer: HDNodeWallet, name: string, args: unknown[]): Promise<void> =>
    send(signer, stack.kernel, KERNEL_CALLS, name, args);

  async function deliver(txId: string): Promise<void> {
    await kernelCall(stack.providerAgent, 'transitionState', [txId, STATE.IN_PROGRESS, '0x']);
    await kernelCall(stack.providerAgent, 'transitionState', [txId, STATE.DELIVERED, deliveryProof(3600)]);
  }

  async function disputeAndReadBond(txId: string): Promise<bigint> {
    await send(stack.admin, stack.token, TOKEN_INTERFACE, 'mint', [stack.requester.address, K]);
    await send(stack.requester, stack.token, TOKEN_INTERFACE, 'approve', [stack.feeSplitVault, K]);
    await kernelCall(stack.requester, 'transitionState', [txId, STATE.DISPUTED, '0x']);
    return read(stack.provider, stack.feeSplitVault, VAULT_VIEWS, 'bondBalance', [txId]);
  }

  async function balances(): Promise<Record<'requester' | 'provider' | 'integrator' | 'protocol', bigint>> {
    return {
      requester: await balanceOf(stack, stack.requester.address),
      provider: await balanceOf(stack, stack.providerAgent.address),
      integrator: await balanceOf(stack, stack.integrator),
      protocol: (await balanceOf(stack, stack.feeRecipient)) + (await balanceOf(stack, stack.archive)),
    };
  }

  async function summary(txId: string): Promise<string | undefined> {
    const tx = await requester.getTransaction(txId);
    if (!tx) throw new Error('transaction not found');
    const view = await escrowAmountsView(requester.feeSplit, tx);
    return view.kind === 'feeSplit' ? breakdownSummary(view.amounts, tx.amount, usdc) : view.kind;
  }

  beforeAll(async () => {
    stack = await startFeeSplitStack();
    requester = runtimeFor(stack.requester);
    provider = runtimeFor(stack.providerAgent);
    await requester.initialize();
    await provider.initialize();
    payoutOnly = { address: stack.integrator, bps: 100, profile: 'PAYOUT_ONLY' };
    bothAfterDispute = { address: stack.integrator, bps: 100, profile: 'BOTH_AFTER_DISPUTE' };
    await provider.feeSplit.setIntegratorApproval(stack.integrator, 100);
  }, 120_000);

  afterAll(() => {
    stack?.stop();
  });

  it('refuses BOTH_AFTER_DISPUTE without an acknowledgment and sends nothing', async () => {
    const txId = await create();
    const before = await balanceOf(stack, stack.requester.address);
    const nonce = await stack.provider.getTransactionCount(stack.requester.address);
    await expect(requester.linkEscrow(txId, K.toString(), { integrator: bothAfterDispute })).rejects.toBeInstanceOf(
      DisputeFeeNotAcknowledgedError
    );
    expect(await stack.provider.getTransactionCount(stack.requester.address)).toBe(nonce);
    expect(await balanceOf(stack, stack.requester.address)).toBe(before);
    expect((await requester.getTransaction(txId))?.state).toBe('INITIATED');
  });

  it('A3: settle pays provider 980, protocol 10, platform 10; breakdown and receipt amounts agree', async () => {
    const txId = await create();
    await requester.linkEscrow(txId, K.toString(), { integrator: payoutOnly });
    expect((await requester.getTransaction(txId))?.escrowContract?.toLowerCase()).toBe(stack.feeSplitVault.toLowerCase());
    expect(await requester.feeSplit.lockedTerms(stack.feeSplitVault, txId)).toMatchObject({
      integrator: stack.integrator,
      bps: 100,
      profile: 'PAYOUT_ONLY',
    });

    const before = await balances();
    await deliver(txId);
    await kernelCall(stack.requester, 'transitionState', [txId, STATE.SETTLED, '0x']);
    const after = await balances();
    expect(after.provider - before.provider).toBe(980n * ONE);
    expect(after.integrator - before.integrator).toBe(10n * ONE);
    expect(after.protocol - before.protocol).toBe(10n * ONE);

    expect(await summary(txId)).toBe('980.00 USDC to provider (1000.00 committed, 10.00 protocol fee, 10.00 platform fee)');
    expect(await receiptAmountsFor(requester, txId)).toEqual({
      netWei: 980n * ONE,
      feeWei: 10n * ONE,
      platformFeeWei: 10n * ONE,
    });
  });

  it('A9 (B): the pre-dispute preview equals what the refund pays: refunded 1,000, received 980, protocol 10, platform 10', async () => {
    const txId = await create();
    await requester.linkEscrow(txId, K.toString(), { integrator: bothAfterDispute, acknowledgeDisputeFee: true });
    await deliver(txId);

    const quotes = await requester.feeSplit.refundQuotes(stack.feeSplitVault, txId);
    expect(quotes.actualRefundQuote).toMatchObject({ requesterAmount: K.toString(), protocolFee: '0', integratorFee: '0' });
    expect(quotes.ifDisputedRefundQuote).toEqual({
      refundAmount: K.toString(),
      requesterAmount: (980n * ONE).toString(),
      protocolFee: (10n * ONE).toString(),
      integratorFee: (10n * ONE).toString(),
    });

    const bond = await disputeAndReadBond(txId);
    expect(bond).toBeGreaterThan(0n);
    expect((await requester.feeSplit.refundQuotes(stack.feeSplitVault, txId)).actualRefundQuote).toEqual(
      quotes.ifDisputedRefundQuote
    );

    const before = await balances();
    await kernelCall(stack.admin, 'transitionState', [txId, STATE.SETTLED, resolutionProof(K, 0n)]);
    const after = await balances();
    expect(after.requester - before.requester - bond).toBe(BigInt(quotes.ifDisputedRefundQuote.requesterAmount));
    expect(after.integrator - before.integrator).toBe(10n * ONE);
    expect(after.protocol - before.protocol).toBe(10n * ONE);
    expect(after.provider - before.provider).toBe(0n);

    expect(await summary(txId)).toBe('refunded 1000.00, received 980.00, protocol 10.00, platform 10.00');
  });

  it('a split award: the hypothetical quote is an upper bound of both fees', async () => {
    const txId = await create();
    await requester.linkEscrow(txId, K.toString(), { integrator: bothAfterDispute, acknowledgeDisputeFee: true });
    await deliver(txId);
    const { ifDisputedRefundQuote } = await requester.feeSplit.refundQuotes(stack.feeSplitVault, txId);
    await disputeAndReadBond(txId);
    const before = await balances();
    await kernelCall(stack.admin, 'transitionState', [txId, STATE.SETTLED, resolutionProof(400n * ONE, 600n * ONE)]);
    const after = await balances();
    const refundSideIntegrator = 4n * ONE;
    const providerSideIntegrator = 6n * ONE;
    expect(after.integrator - before.integrator).toBe(refundSideIntegrator + providerSideIntegrator);
    expect(refundSideIntegrator).toBeLessThan(BigInt(ifDisputedRefundQuote.integratorFee));
    expect(await summary(txId)).toBe(
      '588.00 USDC to provider (1000.00 committed, 6.00 protocol fee, 6.00 platform fee); ' +
        'refunded 400.00, received 392.00, protocol 4.00, platform 4.00'
    );
  });

  it('FSV-V7-001: after a milestone with a blocked fee recipient the preview is 735 / 7.5 / 7.5, before and after the fee is retried, and equals the refund', async () => {
    const txId = await create();
    await requester.linkEscrow(txId, K.toString(), { integrator: bothAfterDispute, acknowledgeDisputeFee: true });
    await kernelCall(stack.providerAgent, 'transitionState', [txId, STATE.IN_PROGRESS, '0x']);

    await send(stack.admin, stack.token, TOKEN_INTERFACE, 'setBlocked', [stack.feeRecipient, true]);
    await kernelCall(stack.requester, 'releaseMilestone', [txId, 250n * ONE]);

    const rawRemaining = await read(stack.provider, stack.feeSplitVault, VAULT_VIEWS, 'remaining', [txId]);
    expect(rawRemaining).toBe(752_497_500n);
    expect(await requester.getEscrowBalance(txId)).toBe('752497500');

    const expected = {
      refundAmount: '750000000',
      requesterAmount: '735000000',
      protocolFee: '7500000',
      integratorFee: '7500000',
    };
    const reserved = await requester.feeSplit.refundQuotes(stack.feeSplitVault, txId);
    expect(reserved.ifDisputedRefundQuote).toEqual(expected);
    expect(reserved.ifDisputedRefundQuote.requesterAmount).not.toBe('737447550');

    await send(stack.admin, stack.token, TOKEN_INTERFACE, 'setBlocked', [stack.feeRecipient, false]);
    await kernelCall(stack.admin, 'retryPlatformFee', [txId]);
    expect(await read(stack.provider, stack.feeSplitVault, VAULT_VIEWS, 'remaining', [txId])).toBe(750n * ONE);
    expect((await requester.feeSplit.refundQuotes(stack.feeSplitVault, txId)).ifDisputedRefundQuote).toEqual(expected);

    await kernelCall(stack.providerAgent, 'transitionState', [txId, STATE.DELIVERED, deliveryProof(3600)]);
    const bond = await disputeAndReadBond(txId);
    const before = await balances();
    await kernelCall(stack.admin, 'transitionState', [txId, STATE.SETTLED, resolutionProof(750n * ONE, 0n)]);
    const after = await balances();
    expect(after.requester - before.requester - bond).toBe(735n * ONE);
    expect(after.protocol - before.protocol).toBe(7_500_000n);
    expect(after.integrator - before.integrator).toBe(7_500_000n);
  });

  it('plain funding is unchanged: the escrow is in the plain vault and no fee split is reported', async () => {
    const txId = await create();
    await requester.linkEscrow(txId, K.toString());
    expect((await requester.getTransaction(txId))?.escrowContract?.toLowerCase()).toBe(stack.plainVault.toLowerCase());
    const before = await balances();
    await deliver(txId);
    await kernelCall(stack.requester, 'transitionState', [txId, STATE.SETTLED, '0x']);
    const after = await balances();
    expect(after.provider - before.provider).toBe(990n * ONE);
    expect(after.integrator - before.integrator).toBe(0n);
    expect(await summary(txId)).toBe('plain');
    expect(await receiptAmountsFor(requester, txId)).toBeUndefined();
  });
});
