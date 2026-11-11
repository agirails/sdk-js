import { Wallet, getAddress } from 'ethers';
import { BasicAdapter } from '../adapters/BasicAdapter';
import { StandardAdapter } from '../adapters/StandardAdapter';
import { MockRuntime } from '../runtime/MockRuntime';
import { MockStateManager } from '../runtime/MockStateManager';
import { AutoWalletProvider } from '../wallet/AutoWalletProvider';
import { BundlerClient } from '../wallet/aa/BundlerClient';
import { PaymasterClient } from '../wallet/aa/PaymasterClient';
import { buildACTPPayBatch, computeTransactionId } from '../wallet/aa/TransactionBatcher';
import type { BatchedPayParams } from '../wallet/IWalletProvider';
import { FeeSplitChain, FeeSplitChainProvider, type ChainCall } from '../__tests__/helpers/feeSplitChain';
import { FEE_SPLIT_VAULT_INTERFACE, escrowIdOfSetEscrowTerms } from './calls';
import { ChainFeeSplitReader } from './ChainFeeSplitReader';
import { DisputeFeeNotAcknowledgedError, FeeSplitPreflightMissingError, IntegratorNotApprovedError } from './errors';
import { resolveFeeSplitFunding } from './funding';
import type { IntegratorTerms, ResolvedFeeSplitFunding } from './types';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../wallet/aa/BundlerClient');
jest.mock('../wallet/aa/PaymasterClient');

const PROVIDER = '0x00000000000000000000000000000000000000b0';
const OTHER_PROVIDER = '0x00000000000000000000000000000000000000b1';
const INTEGRATOR = '0x00000000000000000000000000000000000000d0';
const OTHER_INTEGRATOR = getAddress('0x00000000000000000000000000000000000000d1');
const SERVICE = '0x' + '00'.repeat(32);
const K = '1000000000';

const payoutOnly: IntegratorTerms = { address: INTEGRATOR, bps: 100, profile: 'PAYOUT_ONLY' };
const bothAfterDispute: IntegratorTerms = { address: INTEGRATOR, bps: 100, profile: 'BOTH_AFTER_DISPUTE' };

const SELECTORS = {
  approve: '0x095ea7b3',
  setEscrowTerms: FEE_SPLIT_VAULT_INTERFACE.getFunction('setEscrowTerms')?.selector,
  createTransaction: '0xeb5003bc',
  linkEscrow: '0xb76f85ae',
};

function names(calls: ChainCall[]): string[] {
  return calls.map(call => {
    const selector = call.data.slice(0, 10);
    const found = Object.entries(SELECTORS).find(([, value]) => value === selector);
    return found ? found[0] : selector;
  });
}

describe('FeeSplitVault funding through a smart wallet', () => {
  let chain: FeeSplitChain;
  let provider: FeeSplitChainProvider;
  let wallet: AutoWalletProvider;
  let failNextSubmissions: number;

  function params(overrides: Partial<BatchedPayParams> = {}): BatchedPayParams {
    return {
      provider: PROVIDER,
      requester: chain.smartWallet,
      amount: K,
      deadline: 1_900_000_000,
      disputeWindow: 172_800,
      serviceHash: SERVICE,
      agentId: '0',
      contracts: {
        usdc: chain.usdc,
        actpKernel: chain.kernel,
        escrowVault: chain.plainVault,
        feeSplitVaults: [{ address: chain.vault, funding: true }],
      },
      ...overrides,
    };
  }

  async function funding(terms: IntegratorTerms, provider_ = PROVIDER): Promise<ResolvedFeeSplitFunding> {
    const resolved = await resolveFeeSplitFunding({
      integrator: terms,
      acknowledgeDisputeFee: true,
      provider: provider_,
      amount: BigInt(K),
      vaults: [{ address: chain.vault, funding: true }],
      reader: new ChainFeeSplitReader(provider, chain.kernel),
    });
    if (!resolved) throw new Error('expected funding');
    return resolved;
  }

  beforeEach(async () => {
    chain = new FeeSplitChain();
    chain.approveIntegrator(PROVIDER, INTEGRATOR, 100);
    chain.approveIntegrator(OTHER_PROVIDER, OTHER_INTEGRATOR, 300);
    provider = new FeeSplitChainProvider(chain);
    failNextSubmissions = 0;

    const bundler = jest.mocked(BundlerClient).prototype;
    bundler.estimateUserOperationGas.mockResolvedValue({ callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n });
    bundler.sendUserOperation.mockImplementation(userOp => {
      if (failNextSubmissions > 0) {
        failNextSubmissions -= 1;
        return Promise.reject(new Error('bundler unavailable'));
      }
      chain.execute(userOp.sender, FeeSplitChain.callsOf(userOp.callData));
      return Promise.resolve('0xuserop');
    });
    bundler.waitForReceipt.mockResolvedValue({ userOpHash: '0xuserop', transactionHash: '0xtx', blockNumber: 100, success: true });
    const paymaster = jest.mocked(PaymasterClient).prototype;
    paymaster.getPaymasterStubData.mockResolvedValue({ paymasterAndData: '0x' });
    paymaster.getPaymasterData.mockResolvedValue({ paymasterAndData: '0x' });

    wallet = await AutoWalletProvider.create({
      signer: new Wallet('0x' + '11'.repeat(32)),
      provider,
      chainId: 84532,
      actpKernelAddress: chain.kernel,
      bundler: { primaryUrl: 'http://bundler.invalid' },
      paymaster: { primaryUrl: 'http://paymaster.invalid' },
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('buildACTPPayBatch', () => {
    it('without terms is the same three calls as before, to the plain vault', () => {
      const batch = buildACTPPayBatch({ ...params(), actpNonce: 0n });
      expect(names(batch.calls.map(call => ({ target: call.target, data: call.data })))).toEqual([
        'approve',
        'createTransaction',
        'linkEscrow',
      ]);
      expect(batch.calls.map(call => call.target)).toEqual([chain.usdc, chain.kernel, chain.kernel]);
    });

    it('with terms is exactly create, approve, setEscrowTerms, link, all for the id derived in this build', async () => {
      const resolved = await funding(bothAfterDispute);
      for (const nonce of [0n, 1n, 7n]) {
        const batch = buildACTPPayBatch({ ...params(), actpNonce: nonce, funding: resolved });
        const calls = batch.calls.map(call => ({ target: call.target, data: call.data }));
        expect(names(calls)).toEqual(['createTransaction', 'approve', 'setEscrowTerms', 'linkEscrow']);
        expect(batch.calls.map(call => call.target)).toEqual([chain.kernel, chain.usdc, chain.vault, chain.kernel]);
        expect(batch.txId).toBe(computeTransactionId(chain.smartWallet, PROVIDER, K, SERVICE, nonce));
        expect(escrowIdOfSetEscrowTerms(batch.calls[2]?.data ?? '0x')).toBe(batch.txId);
      }
    });

    it('refuses terms that did not pass the preflight, in either profile', () => {
      for (const terms of [payoutOnly, bothAfterDispute]) {
        expect(() =>
          buildACTPPayBatch({
            ...params(),
            actpNonce: 0n,
            funding: { vault: chain.vault, terms, token: { kind: 'FeeSplitPreflightToken' } },
          })
        ).toThrow(FeeSplitPreflightMissingError);
      }
    });
  });

  describe('AutoWalletProvider.payACTPBatched', () => {
    it('plain payment: nothing about the batch changes and no vault is read', async () => {
      const result = await wallet.payACTPBatched(params());
      expect(result.success).toBe(true);
      expect(names(chain.executed[0] ?? [])).toEqual(['approve', 'createTransaction', 'linkEscrow']);
      expect(chain.transactions.get(result.txId)?.escrowContract.toLowerCase()).toBe(chain.plainVault);
      expect(chain.locked.size).toBe(0);
    });

    it('with terms: submits create, approve, setEscrowTerms, link, and the vault locks the requested terms', async () => {
      const result = await wallet.payACTPBatched(params({ feeSplit: { integrator: bothAfterDispute, acknowledgeDisputeFee: true } }));
      expect(names(chain.executed[0] ?? [])).toEqual(['createTransaction', 'approve', 'setEscrowTerms', 'linkEscrow']);
      expect(chain.transactions.get(result.txId)?.escrowContract.toLowerCase()).toBe(chain.vault);
      expect(chain.locked.get(result.txId)).toEqual({ integrator: INTEGRATOR, bps: 100, profile: 1 });
      expect(result.ifDisputedRefundQuote).toMatchObject({ requesterAmount: '980000000', protocolFee: '10000000' });
    });

    it('profile BOTH_AFTER_DISPUTE without acknowledgment: refused, no UserOp is submitted', async () => {
      await expect(wallet.payACTPBatched(params({ feeSplit: { integrator: bothAfterDispute } }))).rejects.toBeInstanceOf(
        DisputeFeeNotAcknowledgedError
      );
      expect(jest.mocked(BundlerClient).prototype.sendUserOperation).not.toHaveBeenCalled();
      expect(chain.executed).toHaveLength(0);
    });

    it('an unapproved integrator is refused before anything is submitted', async () => {
      const unapproved: IntegratorTerms = { address: OTHER_INTEGRATOR, bps: 100, profile: 'PAYOUT_ONLY' };
      await expect(wallet.payACTPBatched(params({ feeSplit: { integrator: unapproved } }))).rejects.toBeInstanceOf(
        IntegratorNotApprovedError
      );
      expect(jest.mocked(BundlerClient).prototype.sendUserOperation).not.toHaveBeenCalled();
    });

    it('two concurrent payments with different terms: each id carries its own terms (second built on nonce n + 1)', async () => {
      const second: IntegratorTerms = { address: OTHER_INTEGRATOR, bps: 300, profile: 'PAYOUT_ONLY' };
      const [a, b] = await Promise.all([
        wallet.payACTPBatched(params({ feeSplit: { integrator: bothAfterDispute, acknowledgeDisputeFee: true } })),
        wallet.payACTPBatched(params({ provider: OTHER_PROVIDER, feeSplit: { integrator: second } })),
      ]);
      const ids = (nonce: bigint): string[] => [
        computeTransactionId(chain.smartWallet, PROVIDER, K, SERVICE, nonce),
        computeTransactionId(chain.smartWallet, OTHER_PROVIDER, K, SERVICE, nonce),
      ];
      const aFirst = a.txId === ids(0n)[0];
      expect([a.txId, b.txId]).toEqual(aFirst ? [ids(0n)[0], ids(1n)[1]] : [ids(1n)[0], ids(0n)[1]]);
      const order = aFirst ? [a, b] : [b, a];
      expect(chain.locked.get(a.txId)).toEqual({ integrator: INTEGRATOR, bps: 100, profile: 1 });
      expect(chain.locked.get(b.txId)).toEqual({ integrator: OTHER_INTEGRATOR, bps: 300, profile: 0 });
      for (const [index, result] of order.entries()) {
        const calls = chain.executed[index] ?? [];
        expect(escrowIdOfSetEscrowTerms(calls[2]?.data ?? '0x')).toBe(result.txId);
        expect(chain.transactions.get(result.txId)?.escrowId).toBe(result.txId);
      }
    });

    it('a nonce collision rebuilds the whole batch: terms, create and link carry the new id', async () => {
      const stale = computeTransactionId(chain.smartWallet, PROVIDER, K, SERVICE, 0n);
      const rebuilt = computeTransactionId(chain.smartWallet, PROVIDER, K, SERVICE, 1n);
      const submitted: ChainCall[][] = [];
      const bundler = jest.mocked(BundlerClient).prototype;
      bundler.sendUserOperation.mockImplementation(userOp => {
        const calls = FeeSplitChain.callsOf(userOp.callData);
        submitted.push(calls);
        if (submitted.length === 1) {
          chain.nonces.set(chain.smartWallet, 1n);
          return Promise.reject(new Error('execution reverted: Escrow ID already used'));
        }
        chain.execute(userOp.sender, calls);
        return Promise.resolve('0xuserop');
      });

      const result = await wallet.payACTPBatched(params({ feeSplit: { integrator: payoutOnly } }));
      expect(result.txId).toBe(rebuilt);
      expect(submitted).toHaveLength(2);
      for (const [index, id] of [stale, rebuilt].entries()) {
        const calls = submitted[index] ?? [];
        expect(names(calls)).toEqual(['createTransaction', 'approve', 'setEscrowTerms', 'linkEscrow']);
        expect(escrowIdOfSetEscrowTerms(calls[2]?.data ?? '0x')).toBe(id);
      }
      expect(chain.locked.get(rebuilt)).toEqual({ integrator: INTEGRATOR, bps: 100, profile: 0 });
      expect(chain.locked.has(stale)).toBe(false);
      expect(chain.pending.size).toBe(0);
    });
  });

  describe('adapters over a smart wallet', () => {
    let directory: string;
    let runtime: MockRuntime;

    beforeEach(async () => {
      directory = fs.mkdtempSync(path.join(process.cwd(), '.tmp-feesplit-aa-'));
      runtime = new MockRuntime(new MockStateManager(directory));
      await runtime.reset();
      await runtime.mintTokens(chain.smartWallet, '100000000000');
      await runtime.feeSplit.setIntegratorApproval(INTEGRATOR, 100, PROVIDER);
    });

    afterEach(() => {
      fs.rmSync(directory, { recursive: true, force: true });
    });

    const addresses = (): { usdc: string; actpKernel: string; escrowVault: string } => ({
      usdc: chain.usdc,
      actpKernel: chain.kernel,
      escrowVault: chain.plainVault,
    });

    it('BasicAdapter.pay refuses BOTH_AFTER_DISPUTE without acknowledgment before the wallet is asked', async () => {
      const pay = jest.spyOn(wallet, 'payACTPBatched');
      const basic = new BasicAdapter(runtime, chain.smartWallet, undefined, wallet, addresses());
      await expect(basic.pay({ to: PROVIDER, amount: '1000', integrator: bothAfterDispute })).rejects.toBeInstanceOf(
        DisputeFeeNotAcknowledgedError
      );
      runtime.feeSplit.setDefaults(bothAfterDispute);
      await expect(basic.pay({ to: PROVIDER, amount: '1000' })).rejects.toBeInstanceOf(DisputeFeeNotAcknowledgedError);
      expect(pay).not.toHaveBeenCalled();
      expect(jest.mocked(BundlerClient).prototype.sendUserOperation).not.toHaveBeenCalled();
    });

    it('BasicAdapter.pay hands the resolved terms and the caller acknowledgment to the wallet', async () => {
      const pay = jest.spyOn(wallet, 'payACTPBatched').mockResolvedValue({ txId: '0x' + '01'.repeat(32), hash: '0xtx', success: true });
      const basic = new BasicAdapter(runtime, chain.smartWallet, undefined, wallet, addresses());
      runtime.feeSplit.setDefaults(bothAfterDispute);
      const result = await basic.pay({ to: PROVIDER, amount: '1000', acknowledgeDisputeFee: true });
      expect(pay.mock.calls[0]?.[0]).toMatchObject({
        feeSplit: { integrator: bothAfterDispute, acknowledgeDisputeFee: true },
        contracts: { feeSplitVaults: runtime.feeSplit.vaults() },
      });
      expect(result.ifDisputedRefundQuote).toMatchObject({ requesterAmount: '980000000' });
    });

    it('StandardAdapter.linkEscrow through the router: approve, setEscrowTerms, link; refused without acknowledgment', async () => {
      const send = jest.spyOn(wallet, 'sendBatchTransaction').mockResolvedValue({ hash: '0xtx', success: true });
      const standard = new StandardAdapter(runtime, chain.smartWallet, undefined, wallet, addresses());
      const txId = await runtime.createTransaction({
        provider: PROVIDER,
        requester: chain.smartWallet,
        amount: K,
        deadline: runtime.time.now() + 86_400,
      });

      await expect(standard.linkEscrow(txId, { integrator: bothAfterDispute })).rejects.toBeInstanceOf(
        DisputeFeeNotAcknowledgedError
      );
      expect(send).not.toHaveBeenCalled();

      await expect(standard.linkEscrow(txId, { integrator: payoutOnly })).rejects.toThrow(/without the requested integrator terms/);
      const batch = send.mock.calls[0]?.[0] ?? [];
      expect(names(batch.map(tx => ({ target: tx.to, data: tx.data ?? '0x' })))).toEqual(['approve', 'setEscrowTerms', 'linkEscrow']);
      expect(escrowIdOfSetEscrowTerms(batch[1]?.data ?? '0x')).toBe(txId);
      expect(batch.map(tx => tx.to)).toEqual([chain.usdc, runtime.feeSplit.vaults()[0]?.address, chain.kernel]);
    });

    it('StandardAdapter.linkEscrow without terms sends the same two calls as before', async () => {
      const send = jest.spyOn(wallet, 'sendBatchTransaction').mockResolvedValue({ hash: '0xtx', success: true });
      const standard = new StandardAdapter(runtime, chain.smartWallet, undefined, wallet, addresses());
      const txId = await runtime.createTransaction({
        provider: PROVIDER,
        requester: chain.smartWallet,
        amount: K,
        deadline: runtime.time.now() + 86_400,
      });
      await standard.linkEscrow(txId);
      const batch = send.mock.calls[0]?.[0] ?? [];
      expect(names(batch.map(tx => ({ target: tx.to, data: tx.data ?? '0x' })))).toEqual(['approve', 'linkEscrow']);
      expect(batch.map(tx => tx.to)).toEqual([chain.usdc, chain.kernel]);
    });
  });
});
