/**
 * StandardAdapter Gasless Routing Tests
 *
 * Verifies that createTransaction() and linkEscrow() route through
 * Smart Wallet (gasless) when available, and fall back to runtime (EOA) when not.
 */

import { StandardAdapter } from './StandardAdapter';
import { MockRuntime } from '../runtime/MockRuntime';
import { IWalletProvider, TransactionReceipt, WalletInfo, CreateACTPTransactionResult } from '../wallet/IWalletProvider';
import { ethers } from 'ethers';
import { computeTransactionId } from '../wallet/aa/TransactionBatcher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REQUESTER = '0x1111111111111111111111111111111111111111';
const PROVIDER = '0x2222222222222222222222222222222222222222';

const CONTRACT_ADDRESSES = {
  usdc: '0x' + '33'.repeat(20),
  actpKernel: '0x' + '44'.repeat(20),
  escrowVault: '0x' + '55'.repeat(20),
};

function createMockWalletProvider(overrides: Partial<IWalletProvider> = {}): IWalletProvider {
  return {
    getAddress: () => REQUESTER,
    sendTransaction: jest.fn().mockResolvedValue({ hash: '0xhash', success: true }),
    sendBatchTransaction: jest.fn().mockResolvedValue({ hash: '0xbatchhash', success: true }),
    getWalletInfo: (): WalletInfo => ({
      address: REQUESTER,
      tier: 'auto',
      supportsBatching: true,
      gasSponsored: true,
      chainId: 84532,
    }),
    // Mark as AA wallet by providing payACTPBatched
    payACTPBatched: jest.fn().mockResolvedValue({ txId: '0x00', hash: '0x00', success: true }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: createTransaction gasless routing
// ---------------------------------------------------------------------------

describe('StandardAdapter gasless routing', () => {
  let runtime: MockRuntime;

  beforeEach(async () => {
    runtime = new MockRuntime();
    await runtime.reset();
    await runtime.mintTokens(REQUESTER, '10000000000');
  });

  describe('createTransaction', () => {
    it('routes through walletProvider.createACTPTransaction when Smart Wallet available', async () => {
      const fakeTxId = '0x' + 'aa'.repeat(32);

      const createACTPTransaction = jest.fn().mockResolvedValue({
        txId: fakeTxId,
        receipt: { hash: '0xuserop', success: true },
      } satisfies CreateACTPTransactionResult);

      const walletProvider = createMockWalletProvider({ createACTPTransaction });

      const adapter = new StandardAdapter(
        runtime,
        REQUESTER,
        undefined, // easHelper
        walletProvider,
        CONTRACT_ADDRESSES,
      );

      const txId = await adapter.createTransaction({
        provider: PROVIDER,
        amount: '100',
      });

      expect(txId).toBe(fakeTxId);
      expect(createACTPTransaction).toHaveBeenCalledTimes(1);

      const callArgs = createACTPTransaction.mock.calls[0][0];
      expect(callArgs.provider).toBe(PROVIDER);
      expect(callArgs.requester).toBe(REQUESTER);
      expect(callArgs.amount).toBe('100000000'); // parsed from "100"
      expect(callArgs.contracts.actpKernel).toBe(CONTRACT_ADDRESSES.actpKernel);
    });

    it('computes serviceHash from serviceDescription (not ZeroHash)', async () => {
      const createACTPTransaction = jest.fn().mockResolvedValue({
        txId: '0x' + 'bb'.repeat(32),
        receipt: { hash: '0x00', success: true },
      } satisfies CreateACTPTransactionResult);

      const walletProvider = createMockWalletProvider({ createACTPTransaction });

      const adapter = new StandardAdapter(
        runtime, REQUESTER, undefined, walletProvider, CONTRACT_ADDRESSES,
      );

      await adapter.createTransaction({
        provider: PROVIDER,
        amount: '50',
        serviceDescription: 'translation service',
      });

      const callArgs = createACTPTransaction.mock.calls[0][0];
      const expectedHash = ethers.keccak256(ethers.toUtf8Bytes('translation service'));
      expect(callArgs.serviceHash).toBe(expectedHash);
    });

    it('passes through pre-computed bytes32 serviceDescription as-is', async () => {
      const precomputed = ethers.keccak256(ethers.toUtf8Bytes('pre-hashed'));

      const createACTPTransaction = jest.fn().mockResolvedValue({
        txId: '0x' + 'cc'.repeat(32),
        receipt: { hash: '0x00', success: true },
      } satisfies CreateACTPTransactionResult);

      const walletProvider = createMockWalletProvider({ createACTPTransaction });

      const adapter = new StandardAdapter(
        runtime, REQUESTER, undefined, walletProvider, CONTRACT_ADDRESSES,
      );

      await adapter.createTransaction({
        provider: PROVIDER,
        amount: '50',
        serviceDescription: precomputed,
      });

      const callArgs = createACTPTransaction.mock.calls[0][0];
      expect(callArgs.serviceHash).toBe(precomputed);
    });

    it('uses ZeroHash when serviceDescription is omitted', async () => {
      const createACTPTransaction = jest.fn().mockResolvedValue({
        txId: '0x' + 'dd'.repeat(32),
        receipt: { hash: '0x00', success: true },
      } satisfies CreateACTPTransactionResult);

      const walletProvider = createMockWalletProvider({ createACTPTransaction });

      const adapter = new StandardAdapter(
        runtime, REQUESTER, undefined, walletProvider, CONTRACT_ADDRESSES,
      );

      await adapter.createTransaction({
        provider: PROVIDER,
        amount: '50',
      });

      const callArgs = createACTPTransaction.mock.calls[0][0];
      expect(callArgs.serviceHash).toBe(ethers.ZeroHash);
    });

    it('throws when UserOp receipt indicates failure', async () => {
      const createACTPTransaction = jest.fn().mockResolvedValue({
        txId: '0x' + 'ee'.repeat(32),
        receipt: { hash: '0xfailed', success: false },
      } satisfies CreateACTPTransactionResult);

      const walletProvider = createMockWalletProvider({ createACTPTransaction });

      const adapter = new StandardAdapter(
        runtime, REQUESTER, undefined, walletProvider, CONTRACT_ADDRESSES,
      );

      await expect(adapter.createTransaction({
        provider: PROVIDER,
        amount: '100',
      })).rejects.toThrow('createTransaction UserOp failed');
    });

    it('falls back to runtime when createACTPTransaction is not available', async () => {
      // Wallet without createACTPTransaction (e.g. older version)
      const walletProvider = createMockWalletProvider();
      delete (walletProvider as any).createACTPTransaction;

      const adapter = new StandardAdapter(
        runtime, REQUESTER, undefined, walletProvider, CONTRACT_ADDRESSES,
      );

      const txId = await adapter.createTransaction({
        provider: PROVIDER,
        amount: '100',
      });

      // Should still work via MockRuntime
      expect(txId).toMatch(/^0x[0-9a-f]{64}$/);
      const tx = await runtime.getTransaction(txId);
      expect(tx).not.toBeNull();
      expect(tx!.state).toBe('INITIATED');
    });

    it('falls back to runtime when no walletProvider (EOA mode)', async () => {
      const adapter = new StandardAdapter(runtime, REQUESTER);

      const txId = await adapter.createTransaction({
        provider: PROVIDER,
        amount: '100',
      });

      expect(txId).toMatch(/^0x[0-9a-f]{64}$/);
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('INITIATED');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: linkEscrow gasless routing
  // ---------------------------------------------------------------------------

  describe('linkEscrow', () => {
    it('routes through smartWalletRouter.sendLinkEscrow when Smart Wallet available', async () => {
      const walletProvider = createMockWalletProvider();

      const adapter = new StandardAdapter(
        runtime, REQUESTER, undefined, walletProvider, CONTRACT_ADDRESSES,
      );

      // Create tx via runtime (mock mode) first
      const txId = await runtime.createTransaction({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        deadline: runtime.time.now() + 86400,
        disputeWindow: 172800,
      });

      const escrowId = await adapter.linkEscrow(txId);

      // Should return txId as escrowId (ACTP standard)
      expect(escrowId).toBe(txId);

      // Should have called sendBatchTransaction (approve + linkEscrow)
      expect(walletProvider.sendBatchTransaction).toHaveBeenCalledTimes(1);
      const batchCalls = (walletProvider.sendBatchTransaction as jest.Mock).mock.calls[0][0];
      expect(batchCalls).toHaveLength(2); // approve + linkEscrow
      expect(batchCalls[0].to).toBe(CONTRACT_ADDRESSES.usdc); // approve call
      expect(batchCalls[1].to).toBe(CONTRACT_ADDRESSES.actpKernel); // linkEscrow call
    });

    it('throws when linkEscrow UserOp fails', async () => {
      const walletProvider = createMockWalletProvider();
      (walletProvider.sendBatchTransaction as jest.Mock).mockResolvedValue({
        hash: '0xfailed', success: false,
      });

      const adapter = new StandardAdapter(
        runtime, REQUESTER, undefined, walletProvider, CONTRACT_ADDRESSES,
      );

      const txId = await runtime.createTransaction({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        deadline: runtime.time.now() + 86400,
        disputeWindow: 172800,
      });

      await expect(adapter.linkEscrow(txId)).rejects.toThrow('linkEscrow UserOp failed');
    });

    it('falls back to runtime when no Smart Wallet (EOA mode)', async () => {
      const adapter = new StandardAdapter(runtime, REQUESTER);

      const txId = await runtime.createTransaction({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '100000000',
        deadline: runtime.time.now() + 86400,
        disputeWindow: 172800,
      });

      const escrowId = await adapter.linkEscrow(txId);

      // MockRuntime linkEscrow returns an escrow ID
      expect(escrowId).toBeTruthy();

      // Transaction should be COMMITTED after linkEscrow
      const tx = await runtime.getTransaction(txId);
      expect(tx!.state).toBe('COMMITTED');
    });
  });
});
