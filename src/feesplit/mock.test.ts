import * as fs from 'fs';
import * as path from 'path';
import { ACTPClient } from '../ACTPClient';
import { BasicAdapter } from '../adapters/BasicAdapter';
import { StandardAdapter } from '../adapters/StandardAdapter';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import {
  DisputeFeeNotAcknowledgedError,
  FeeSplitVaultUnavailableError,
  IntegratorNotApprovedError,
} from './errors';
import { breakdownSummary, escrowAmountsView, UNRECOGNIZED_VAULT_NOTE } from './display';
import { checkEscrowIntake } from './intake';
import { MOCK_ESCROW_VAULT, MOCK_FEE_RECIPIENT, MOCK_FEE_SPLIT_VAULT } from './mockLedger';
import type { IntegratorTerms } from './types';

const REQUESTER = '0x1111111111111111111111111111111111111111';
const PROVIDER = '0x2222222222222222222222222222222222222222';
const INTEGRATOR = '0x3333333333333333333333333333333333333333';
const NEW_VAULT = '0x00000000000000000000000000000000000f5b02';
const K = '1000000000';

const payoutOnly: IntegratorTerms = { address: INTEGRATOR, bps: 100, profile: 'PAYOUT_ONLY' };
const bothAfterDispute: IntegratorTerms = { address: INTEGRATOR, bps: 100, profile: 'BOTH_AFTER_DISPUTE' };
const usdc = (wei: string): string => (Number(wei) / 1_000_000).toFixed(2);

describe('FeeSplitVault in MockRuntime', () => {
  let directory: string;
  let runtime: MockRuntime;
  let basic: BasicAdapter;
  let standard: StandardAdapter;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-feesplit-mock-'));
    runtime = new MockRuntime(new MockStateManager(directory));
    await runtime.reset();
    await runtime.mintTokens(REQUESTER, '100000000000');
    await runtime.feeSplit.setIntegratorApproval(INTEGRATOR, 100, PROVIDER);
    basic = new BasicAdapter(runtime, REQUESTER);
    standard = new StandardAdapter(runtime, REQUESTER);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function fund(terms: IntegratorTerms | undefined, acknowledge = false): Promise<string> {
    const txId = await runtime.createTransaction({
      provider: PROVIDER,
      requester: REQUESTER,
      amount: K,
      deadline: runtime.time.now() + 86_400,
      disputeWindow: 3600,
    });
    await runtime.linkEscrow(txId, K, terms ? { integrator: terms, acknowledgeDisputeFee: acknowledge } : undefined);
    return txId;
  }

  async function settle(txId: string): Promise<void> {
    if ((await runtime.getTransaction(txId))?.state === 'COMMITTED') {
      await runtime.transitionState(txId, 'IN_PROGRESS');
    }
    await runtime.transitionState(txId, 'DELIVERED');
    await runtime.time.advanceTime(3601);
    const tx = await runtime.getTransaction(txId);
    if (!tx?.escrowId) throw new Error('escrow not linked');
    if (tx.state !== 'SETTLED') await runtime.releaseEscrow(tx.escrowId);
  }

  async function disputeAndRefund(txId: string): Promise<void> {
    await runtime.transitionState(txId, 'IN_PROGRESS');
    await runtime.transitionState(txId, 'DELIVERED');
    await runtime.transitionState(txId, 'DISPUTED');
    await runtime.transitionState(txId, 'CANCELLED');
  }

  async function summary(txId: string): Promise<string | undefined> {
    const tx = await runtime.getTransaction(txId);
    if (!tx) throw new Error('missing transaction');
    const view = await escrowAmountsView(runtime.feeSplit, tx);
    return view.kind === 'feeSplit' ? breakdownSummary(view.amounts, tx.amount, usdc) : view.kind;
  }

  describe('plain funding is unchanged', () => {
    it('without terms the escrow is in the plain vault and the provider receives everything', async () => {
      const txId = await fund(undefined);
      const tx = await runtime.getTransaction(txId);
      expect(tx?.escrowContract).toBe(MOCK_ESCROW_VAULT);
      expect(tx?.feeSplit).toBeUndefined();
      await settle(txId);
      expect(await runtime.getBalance(PROVIDER)).toBe(K);
      expect(await runtime.getBalance(INTEGRATOR)).toBe('0');
      expect(await summary(txId)).toBe('plain');
    });
  });

  describe('profile PAYOUT_ONLY', () => {
    it('A3 shape: the integrator takes 1% of the amount out of the provider side', async () => {
      const txId = await fund(payoutOnly);
      const tx = await runtime.getTransaction(txId);
      expect(tx?.escrowContract).toBe(MOCK_FEE_SPLIT_VAULT);
      await expect(runtime.feeSplit.lockedTerms(MOCK_FEE_SPLIT_VAULT, txId)).resolves.toMatchObject({
        integrator: INTEGRATOR,
        bps: 100,
        profile: 'PAYOUT_ONLY',
        used: true,
      });
      await settle(txId);
      expect(await runtime.getBalance(INTEGRATOR)).toBe('10000000');
      expect(await runtime.getBalance(PROVIDER)).toBe('990000000');
      const breakdown = await runtime.feeSplit.payoutBreakdown(MOCK_FEE_SPLIT_VAULT, txId);
      expect(breakdown.totals).toMatchObject({ providerReceived: '990000000', integratorPaid: '10000000', kernelFee: '0' });
    });

    it('A9 (D) shape: a refund after a dispute is untouched', async () => {
      const txId = await fund(payoutOnly);
      const before = BigInt(await runtime.getBalance(REQUESTER));
      await disputeAndRefund(txId);
      expect(BigInt(await runtime.getBalance(REQUESTER)) - before).toBe(BigInt(K));
      expect(await runtime.getBalance(INTEGRATOR)).toBe('0');
      expect(await summary(txId)).toBe('refunded 1000.00, received 1000.00, protocol 0.00, platform 0.00');
    });
  });

  describe('profile BOTH_AFTER_DISPUTE', () => {
    it('A9 (B) shape: refunded 1,000, received 980, protocol 10, platform 10', async () => {
      const txId = await fund(bothAfterDispute, true);
      const before = BigInt(await runtime.getBalance(REQUESTER));
      await disputeAndRefund(txId);
      expect(BigInt(await runtime.getBalance(REQUESTER)) - before).toBe(980_000_000n);
      expect(await runtime.getBalance(MOCK_FEE_RECIPIENT)).toBe('10000000');
      expect(await runtime.getBalance(INTEGRATOR)).toBe('10000000');
      expect(await summary(txId)).toBe('refunded 1000.00, received 980.00, protocol 10.00, platform 10.00');
    });

    it('a refund without a dispute is free', async () => {
      const txId = await fund(bothAfterDispute, true);
      const before = BigInt(await runtime.getBalance(REQUESTER));
      await runtime.transitionState(txId, 'CANCELLED');
      expect(BigInt(await runtime.getBalance(REQUESTER)) - before).toBe(BigInt(K));
      expect(await runtime.getBalance(MOCK_FEE_RECIPIENT)).toBe('0');
      expect(await runtime.getBalance(INTEGRATOR)).toBe('0');
    });

    it('settlement pays the same provider-side share as PAYOUT_ONLY', async () => {
      const txId = await fund(bothAfterDispute, true);
      await settle(txId);
      expect(await runtime.getBalance(INTEGRATOR)).toBe('10000000');
      expect(await runtime.getBalance(PROVIDER)).toBe('990000000');
    });

    it('the actual quote is fee-free until the dispute; the hypothetical quote equals what the refund then pays', async () => {
      const txId = await fund(bothAfterDispute, true);
      await runtime.transitionState(txId, 'IN_PROGRESS');
      await runtime.transitionState(txId, 'DELIVERED');
      const quotes = await runtime.feeSplit.refundQuotes(MOCK_FEE_SPLIT_VAULT, txId);
      expect(quotes.actualRefundQuote).toMatchObject({ requesterAmount: K, protocolFee: '0', integratorFee: '0' });
      expect(quotes.ifDisputedRefundQuote).toMatchObject({
        requesterAmount: '980000000',
        protocolFee: '10000000',
        integratorFee: '10000000',
      });

      await runtime.transitionState(txId, 'DISPUTED');
      const disputed = await runtime.feeSplit.refundQuotes(MOCK_FEE_SPLIT_VAULT, txId);
      expect(disputed.actualRefundQuote).toEqual(quotes.ifDisputedRefundQuote);

      const before = BigInt(await runtime.getBalance(REQUESTER));
      await runtime.transitionState(txId, 'CANCELLED');
      expect((BigInt(await runtime.getBalance(REQUESTER)) - before).toString()).toBe(
        quotes.ifDisputedRefundQuote.requesterAmount
      );
    });
  });

  describe('every funding path refuses BOTH_AFTER_DISPUTE without a per-call acknowledgment', () => {
    async function nothingHappened(action: () => Promise<unknown>): Promise<void> {
      const balance = await runtime.getBalance(REQUESTER);
      const transactions = (await runtime.getAllTransactions()).length;
      await expect(action()).rejects.toBeInstanceOf(DisputeFeeNotAcknowledgedError);
      expect(await runtime.getBalance(REQUESTER)).toBe(balance);
      expect((await runtime.getAllTransactions()).length).toBe(transactions);
    }

    it('BasicAdapter.pay', async () => {
      await nothingHappened(() => basic.pay({ to: PROVIDER, amount: '1000', integrator: bothAfterDispute }));
    });

    it('StandardAdapter.pay', async () => {
      await nothingHappened(() => standard.pay({ to: PROVIDER, amount: '1000', integrator: bothAfterDispute }));
    });

    it('StandardAdapter.linkEscrow and runtime.linkEscrow leave the transaction unfunded', async () => {
      const txId = await runtime.createTransaction({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: K,
        deadline: runtime.time.now() + 86_400,
      });
      const balance = await runtime.getBalance(REQUESTER);
      await expect(standard.linkEscrow(txId, { integrator: bothAfterDispute })).rejects.toBeInstanceOf(
        DisputeFeeNotAcknowledgedError
      );
      await expect(runtime.linkEscrow(txId, K, { integrator: bothAfterDispute })).rejects.toBeInstanceOf(
        DisputeFeeNotAcknowledgedError
      );
      expect(await runtime.getBalance(REQUESTER)).toBe(balance);
      expect((await runtime.getTransaction(txId))?.state).toBe('INITIATED');
    });

    it('a client-level default of BOTH_AFTER_DISPUTE is refused the same way', async () => {
      runtime.feeSplit.setDefaults(bothAfterDispute);
      await nothingHappened(() => basic.pay({ to: PROVIDER, amount: '1000' }));
      await nothingHappened(() => standard.pay({ to: PROVIDER, amount: '1000' }));
    });

    it('with the acknowledgment the payment is funded and returns the hypothetical quote', async () => {
      runtime.feeSplit.setDefaults(bothAfterDispute);
      const result = await basic.pay({ to: PROVIDER, amount: '1000', acknowledgeDisputeFee: true });
      expect(result.ifDisputedRefundQuote).toEqual({
        refundAmount: K,
        requesterAmount: '980000000',
        protocolFee: '10000000',
        integratorFee: '10000000',
      });
      expect((await runtime.getTransaction(result.txId))?.escrowContract).toBe(MOCK_FEE_SPLIT_VAULT);
      const viaStandard = await standard.pay({ to: PROVIDER, amount: '1000', acknowledgeDisputeFee: true });
      expect(viaStandard.ifDisputedRefundQuote?.requesterAmount).toBe('980000000');
    });
  });

  describe('consent', () => {
    it('an integrator the provider did not approve, or a rate above the approved maximum, is refused', async () => {
      const unapproved: IntegratorTerms = { address: '0x4444444444444444444444444444444444444444', bps: 1, profile: 'PAYOUT_ONLY' };
      await expect(basic.pay({ to: PROVIDER, amount: '1000', integrator: unapproved })).rejects.toBeInstanceOf(
        IntegratorNotApprovedError
      );
      await expect(basic.pay({ to: PROVIDER, amount: '1000', integrator: { ...payoutOnly, bps: 101 } })).rejects.toBeInstanceOf(
        IntegratorNotApprovedError
      );
      await runtime.feeSplit.setIntegratorApproval(INTEGRATOR, 0, PROVIDER);
      await expect(basic.pay({ to: PROVIDER, amount: '1000', integrator: payoutOnly })).rejects.toBeInstanceOf(
        IntegratorNotApprovedError
      );
    });
  });

  describe('retiring a vault (funding: false), then adding a new one', () => {
    it('outputs of finished jobs are unchanged, in-flight jobs are served, new jobs in the retired vault are declined', async () => {
      const settled = await fund(payoutOnly);
      await settle(settled);
      const refunded = await fund(bothAfterDispute, true);
      await disputeAndRefund(refunded);
      const inFlight = await fund(payoutOnly);
      await runtime.transitionState(inFlight, 'IN_PROGRESS');
      const notStarted = await fund(payoutOnly);
      const before = { settled: await summary(settled), refunded: await summary(refunded) };
      expect(before.settled).toBe('990.00 USDC to provider (1000.00 committed, 0.00 protocol fee, 10.00 platform fee)');

      runtime.feeSplit.configureVaults([{ address: MOCK_FEE_SPLIT_VAULT, funding: false }]);
      await expect(fund(payoutOnly)).rejects.toBeInstanceOf(FeeSplitVaultUnavailableError);
      runtime.feeSplit.configureVaults([
        { address: MOCK_FEE_SPLIT_VAULT, funding: false },
        { address: NEW_VAULT, funding: true },
      ]);

      expect(await summary(settled)).toBe(before.settled);
      expect(await summary(refunded)).toBe(before.refunded);
      expect((await standard.getTransaction(settled))?.escrowContract).toBe(MOCK_FEE_SPLIT_VAULT);

      const startedJob = await standard.getTransaction(inFlight);
      const newJob = await standard.getTransaction(notStarted);
      if (!startedJob || !newJob) throw new Error('missing transaction');
      await expect(checkEscrowIntake(runtime.feeSplit, startedJob)).resolves.toEqual({ accept: true });
      await expect(checkEscrowIntake(runtime.feeSplit, newJob)).resolves.toEqual({
        accept: false,
        reason: 'escrow is in a retired vault',
      });
      await settle(inFlight);
      expect((await runtime.getTransaction(inFlight))?.state).toBe('SETTLED');

      const viaNewVault = await fund(payoutOnly);
      expect((await standard.getTransaction(viaNewVault))?.escrowContract).toBe(NEW_VAULT);
    });
  });

  describe('provider intake and transaction metadata', () => {
    it('reads the vault from tx.escrowContract through the adapter, for plain and funding vaults', async () => {
      const plain = await standard.getTransaction(await fund(undefined));
      const funded = await standard.getTransaction(await fund(payoutOnly));
      if (!plain || !funded) throw new Error('missing transaction');
      expect(plain.escrowContract).toBe(MOCK_ESCROW_VAULT);
      expect(funded.escrowContract).toBe(MOCK_FEE_SPLIT_VAULT);
      await expect(checkEscrowIntake(runtime.feeSplit, plain)).resolves.toEqual({ accept: true });
      await expect(checkEscrowIntake(runtime.feeSplit, funded)).resolves.toEqual({ accept: true });
    });

    it('a missing or unknown vault is unrecognized: declined at intake, labelled in displays', async () => {
      const funded = await standard.getTransaction(await fund(payoutOnly));
      if (!funded) throw new Error('missing transaction');
      const withoutVault = { ...funded, escrowContract: undefined };
      const unknownVault = { ...funded, escrowContract: '0x00000000000000000000000000000000000000ff' };
      for (const tx of [withoutVault, unknownVault]) {
        await expect(checkEscrowIntake(runtime.feeSplit, tx)).resolves.toEqual({
          accept: false,
          reason: 'escrow is in a unrecognized vault',
        });
        await expect(escrowAmountsView(runtime.feeSplit, tx)).resolves.toEqual({
          kind: 'unrecognized',
          note: UNRECOGNIZED_VAULT_NOTE,
        });
      }
    });

    it('applies the provider policy to the locked terms', async () => {
      const funded = await standard.getTransaction(await fund(payoutOnly));
      if (!funded) throw new Error('missing transaction');
      await expect(checkEscrowIntake(runtime.feeSplit, funded, terms => terms.bps <= 50)).resolves.toEqual({
        accept: false,
        reason: 'integrator terms rejected by the provider policy',
      });
      await expect(checkEscrowIntake(runtime.feeSplit, funded, terms => terms.profile === 'PAYOUT_ONLY')).resolves.toEqual({
        accept: true,
      });
    });
  });

  describe('ACTPClient in mock mode', () => {
    it('takes default terms from the config and funds through the mock FeeSplitVault', async () => {
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress: REQUESTER,
        stateDirectory: directory,
        integrator: payoutOnly,
      });
      const result = await client.pay({ to: PROVIDER, amount: '1000' });
      const tx = await client.standard.getTransaction(result.txId);
      expect(tx?.escrowContract).toBe(MOCK_FEE_SPLIT_VAULT);
      expect(tx?.feeSplit).toMatchObject({ integrator: INTEGRATOR, bps: 100, profile: 'PAYOUT_ONLY' });
    });
  });
});
