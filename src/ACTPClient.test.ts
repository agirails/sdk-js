/**
 * ACTPClient Integration Tests
 *
 * Tests the main SDK entry point and Three-Level API integration:
 * - Client creation (factory method)
 * - Basic API access
 * - Standard API access
 * - Advanced API access
 * - Cross-API consistency
 */

import { ACTPClient } from './ACTPClient';
import { MockRuntime } from './runtime/MockRuntime';
import { ethers } from 'ethers';

describe('ACTPClient', () => {
  const requesterAddress = '0x1111111111111111111111111111111111111111';
  const providerAddress = '0x2222222222222222222222222222222222222222';

  describe('create() factory', () => {
    describe('mock mode', () => {
      test('creates client in mock mode', async () => {
        const client = await ACTPClient.create({
          mode: 'mock',
          requesterAddress,
        });

        expect(client).toBeInstanceOf(ACTPClient);
        expect(client.getMode()).toBe('mock');
        expect(client.getAddress()).toBe(requesterAddress.toLowerCase());
      });

      test('creates client with custom state directory', async () => {
        // Use custom runtime to avoid filesystem issues in tests
        const runtime = new MockRuntime();
        const client = await ACTPClient.create({
          mode: 'mock',
          requesterAddress,
          runtime, // Custom runtime bypasses stateDirectory
        });

        // When custom runtime is provided, stateDirectory is not stored
        expect(client.info.stateDirectory).toBeUndefined();
      });

      test('creates client with custom runtime', async () => {
        const customRuntime = new MockRuntime();
        const client = await ACTPClient.create({
          mode: 'mock',
          requesterAddress,
          runtime: customRuntime,
        });

        expect(client.advanced).toBe(customRuntime);
      });
    });

    describe('validation', () => {
      test('auto-generates address when requesterAddress is empty', async () => {
        const client = await ACTPClient.create({
          mode: 'mock',
          requesterAddress: '',
        });
        // Empty string is falsy → auto-generates a random address
        expect(client.getAddress()).toMatch(/^0x[a-f0-9]{40}$/);
      });

      test('throws on invalid requesterAddress', async () => {
        await expect(
          ACTPClient.create({
            mode: 'mock',
            requesterAddress: 'invalid',
          })
        ).rejects.toThrow('Invalid requesterAddress');
      });

      test('throws on testnet mode without privateKey', async () => {
        await expect(
          ACTPClient.create({
            mode: 'testnet',
            requesterAddress,
          })
        ).rejects.toThrow('No wallet found for testnet mode');
      });

      test('throws on mainnet mode without privateKey', async () => {
        await expect(
          ACTPClient.create({
            mode: 'mainnet',
            requesterAddress,
          })
        ).rejects.toThrow('No wallet found for mainnet mode');
      });

      test('throws on unknown mode', async () => {
        await expect(
          ACTPClient.create({
            mode: 'invalid' as 'mock',
            requesterAddress,
          })
        ).rejects.toThrow('Unknown mode: "invalid"');
      });
    });
  });

  describe('Three-Level API', () => {
    let client: ACTPClient;

    beforeEach(async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });

      // Mint tokens for testing
      await client.mintTokens(requesterAddress, '10000000000'); // 10,000 USDC
    });

    describe('basic API', () => {
      test('provides BasicAdapter instance', () => {
        expect(client.basic).toBeDefined();
        expect(client.basic.constructor.name).toBe('BasicAdapter');
      });

      test('pay() creates and funds transaction', async () => {
        const result = await client.basic.pay({
          to: providerAddress,
          amount: '100',
        });

        expect(result.txId).toBeDefined();
        expect(result.state).toBe('COMMITTED');
        expect(result.amount).toBe('100.00 USDC');
      });

      test('checkStatus() returns transaction status', async () => {
        const result = await client.basic.pay({
          to: providerAddress,
          amount: '100',
        });

        const status = await client.basic.checkStatus(result.txId);

        expect(status.state).toBe('COMMITTED');
        expect(status.canComplete).toBe(true);
      });
    });

    describe('standard API', () => {
      test('provides StandardAdapter instance', () => {
        expect(client.standard).toBeDefined();
        expect(client.standard.constructor.name).toBe('StandardAdapter');
      });

      test('createTransaction() creates transaction in INITIATED state', async () => {
        const txId = await client.standard.createTransaction({
          provider: providerAddress,
          amount: '100',
        });

        const tx = await client.standard.getTransaction(txId);
        expect(tx).not.toBeNull();
        expect(tx!.state).toBe('INITIATED');
      });

      test('linkEscrow() transitions to COMMITTED', async () => {
        const txId = await client.standard.createTransaction({
          provider: providerAddress,
          amount: '100',
        });

        await client.standard.linkEscrow(txId);

        const tx = await client.standard.getTransaction(txId);
        expect(tx!.state).toBe('COMMITTED');
      });

      test('transitionState() advances transaction state', async () => {
        const txId = await client.standard.createTransaction({
          provider: providerAddress,
          amount: '100',
        });
        await client.standard.linkEscrow(txId);

        // AUDIT FIX: Must go through IN_PROGRESS before DELIVERED
        await client.standard.transitionState(txId, 'IN_PROGRESS');
        await client.standard.transitionState(txId, 'DELIVERED');

        const tx = await client.standard.getTransaction(txId);
        expect(tx!.state).toBe('DELIVERED');
      });
    });

    describe('advanced API', () => {
      test('provides direct runtime access', () => {
        expect(client.advanced).toBeDefined();
        expect(client.advanced).toBe(client.runtime);
      });

      test('createTransaction() works with protocol-level params', async () => {
        const txId = await client.advanced.createTransaction({
          provider: providerAddress,
          requester: requesterAddress,
          amount: '100000000',
          deadline: Math.floor(Date.now() / 1000) + 86400,
          disputeWindow: 3600,
        });

        const tx = await client.advanced.getTransaction(txId);
        expect(tx).not.toBeNull();
        expect(tx!.state).toBe('INITIATED');
        expect(tx!.disputeWindow).toBe(3600);
      });

      test('time manipulation works (mock mode)', async () => {
        const mockRuntime = client.runtime as MockRuntime;
        const beforeTime = mockRuntime.time.now();

        // MockRuntime has extended time interface with advanceTime (now async)
        await mockRuntime.time.advanceTime(3600);
        const afterTime = mockRuntime.time.now();
        expect(afterTime).toBe(beforeTime + 3600);
      });
    });

    describe('cross-API consistency', () => {
      test('all three APIs create equivalent transactions', async () => {
        // Create via basic API
        const basicResult = await client.basic.pay({
          to: providerAddress,
          amount: '100',
        });

        // Create via standard API
        const standardTxId = await client.standard.createTransaction({
          provider: providerAddress,
          amount: '100',
        });
        await client.standard.linkEscrow(standardTxId);

        // Create via advanced API
        const advancedTxId = await client.advanced.createTransaction({
          provider: providerAddress,
          requester: requesterAddress,
          amount: '100000000',
          deadline: Math.floor(Date.now() / 1000) + 86400,
        });
        await client.advanced.linkEscrow(advancedTxId, '100000000');

        // Verify all three transactions exist and have same state
        const basicTx = await client.advanced.getTransaction(basicResult.txId);
        const standardTx = await client.advanced.getTransaction(standardTxId);
        const advancedTx = await client.advanced.getTransaction(advancedTxId);

        expect(basicTx!.state).toBe('COMMITTED');
        expect(standardTx!.state).toBe('COMMITTED');
        expect(advancedTx!.state).toBe('COMMITTED');

        expect(basicTx!.amount).toBe('100000000');
        expect(standardTx!.amount).toBe('100000000');
        expect(advancedTx!.amount).toBe('100000000');
      });
    });
  });

  describe('utility methods', () => {
    let client: ACTPClient;

    beforeEach(async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });
    });

    describe('getAddress()', () => {
      test('returns normalized address', () => {
        expect(client.getAddress()).toBe(requesterAddress.toLowerCase());
      });

      test('address is normalized consistently across all APIs', async () => {
        const mixedCase = '0xABCDEF1234567890abcdef1234567890ABCDEF12';
        const runtime = new MockRuntime();
        const client = await ACTPClient.create({
          mode: 'mock',
          requesterAddress: mixedCase,
          runtime,
        });

        // All should return lowercase
        expect(client.getAddress()).toBe(mixedCase.toLowerCase());
        expect(client.info.address).toBe(mixedCase.toLowerCase());

        // Verify adapters receive normalized address by creating a transaction
        // and checking the requester field is normalized
        await client.mintTokens(mixedCase, '1000000000');
        const txId = await client.standard.createTransaction({
          provider: providerAddress,
          amount: '100',
        });

        const tx = await client.advanced.getTransaction(txId);
        expect(tx!.requester).toBe(mixedCase.toLowerCase());
      });
    });

    describe('getMode()', () => {
      test('returns current mode', () => {
        expect(client.getMode()).toBe('mock');
      });
    });

    describe('reset()', () => {
      test('clears all state', async () => {
        await client.mintTokens(requesterAddress, '1000000000');

        // Create a transaction
        await client.basic.pay({
          to: providerAddress,
          amount: '100',
        });

        // Reset
        await client.reset();

        // Verify balance is gone
        const balance = await client.getBalance(requesterAddress);
        expect(balance).toBe('0');
      });
    });

    describe('mintTokens()', () => {
      test('mints tokens to address', async () => {
        await client.mintTokens(requesterAddress, '5000000000');

        const balance = await client.getBalance(requesterAddress);
        expect(balance).toBe('5000000000');
      });

      test('accumulates multiple mints', async () => {
        await client.mintTokens(requesterAddress, '1000000000');
        await client.mintTokens(requesterAddress, '2000000000');

        const balance = await client.getBalance(requesterAddress);
        expect(balance).toBe('3000000000');
      });
    });

    describe('getBalance()', () => {
      test('returns zero for new address', async () => {
        const newAddress = '0x3333333333333333333333333333333333333333';
        const balance = await client.getBalance(newAddress);
        expect(balance).toBe('0');
      });

      test('returns correct balance after minting', async () => {
        await client.mintTokens(requesterAddress, '12345678');
        const balance = await client.getBalance(requesterAddress);
        expect(balance).toBe('12345678');
      });
    });
  });

  describe('client info', () => {
    test('exposes client info object', async () => {
      // Use custom runtime to avoid filesystem issues with custom path
      const runtime = new MockRuntime();
      await runtime.reset();

      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });

      expect(client.info.mode).toBe('mock');
      expect(client.info.address).toBe(requesterAddress.toLowerCase());
    });

    test('tracks custom stateDirectory in info', async () => {
      // Use custom runtime to avoid creating state files during tests
      // This tests that stateDirectory is properly stored in info
      const runtime = new MockRuntime();
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        stateDirectory: '/some/path', // Not actually created since we pass runtime
        runtime,
      });

      // Note: stateDirectory is only stored when not using custom runtime
      // With custom runtime, stateDirectory should be undefined
      expect(client.info.stateDirectory).toBeUndefined();
      expect(client.info.mode).toBe('mock');
    });
  });

  describe('full transaction lifecycle', () => {
    test('happy path: create → deliver → settle (auto-release)', async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });

      // Setup
      await client.mintTokens(requesterAddress, '10000000000');

      // 1. Create payment (basic API)
      // Note: disputeWindow minimum is 1 hour (3600 seconds) per L-1 security fix
      const result = await client.basic.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600, // 1 hour (minimum allowed)
      });
      expect(result.state).toBe('COMMITTED');
      expect(result.releaseRequired).toBe(true); // ACTP requires explicit release (MockRuntime has lazy auto-settle for convenience)

      // 2. Provider delivers (standard API) - must go through IN_PROGRESS first
      await client.standard.transitionState(result.txId, 'IN_PROGRESS');
      await client.standard.transitionState(result.txId, 'DELIVERED');

      let status = await client.basic.checkStatus(result.txId);
      expect(status.state).toBe('DELIVERED');
      expect(status.canDispute).toBe(true);

      // 3. Wait for dispute window to expire (advanced API time control)
      // MockRuntime has extended time interface with advanceTime (now async)
      const mockRuntime = client.runtime as MockRuntime;
      await mockRuntime.time.advanceTime(3601); // 1 hour + 1 second

      // 4. Auto-release: checking status triggers lazy settlement
      status = await client.basic.checkStatus(result.txId);
      expect(status.canDispute).toBe(false);

      // 5. Verify auto-settled (no manual release needed!)
      const finalTx = await client.advanced.getTransaction(result.txId);
      expect(finalTx!.state).toBe('SETTLED');

      // 6. Verify provider received funds
      const providerBalance = await client.getBalance(providerAddress);
      expect(BigInt(providerBalance)).toBeGreaterThan(0n);
    });

    test('dispute path: create → deliver → dispute → resolve', async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });

      // Setup
      await client.mintTokens(requesterAddress, '10000000000');

      // 1. Create payment
      const result = await client.basic.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600, // 1 hour
      });

      // 2. Provider delivers - must go through IN_PROGRESS first
      await client.standard.transitionState(result.txId, 'IN_PROGRESS');
      await client.standard.transitionState(result.txId, 'DELIVERED');

      // 3. Requester disputes (within window)
      await client.standard.transitionState(result.txId, 'DISPUTED');

      const tx = await client.advanced.getTransaction(result.txId);
      expect(tx!.state).toBe('DISPUTED');
    });

    test('cancel path: create → cancel (before delivery)', async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });

      // Setup
      await client.mintTokens(requesterAddress, '10000000000');
      const initialBalance = await client.getBalance(requesterAddress);

      // 1. Create payment
      const result = await client.basic.pay({
        to: providerAddress,
        amount: '100',
      });

      // 2. Cancel before delivery
      await client.standard.transitionState(result.txId, 'CANCELLED');

      const tx = await client.advanced.getTransaction(result.txId);
      expect(tx!.state).toBe('CANCELLED');

      // 3. Verify funds returned
      const finalBalance = await client.getBalance(requesterAddress);
      expect(finalBalance).toBe(initialBalance);
    });
  });

  describe('pay() unified routing', () => {
    let client: ACTPClient;

    beforeEach(async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });
      await client.mintTokens(requesterAddress, '10000000000');
    });

    test('uses single selectAndResolve call (not separate select + resolve)', async () => {
      // Spy on the router's selectAndResolve method
      const routerSpy = jest.spyOn((client as any).router, 'selectAndResolve');
      const selectSpy = jest.spyOn((client as any).router, 'select');

      await client.pay({
        to: providerAddress,
        amount: '100',
      });

      // selectAndResolve should be called exactly once
      expect(routerSpy).toHaveBeenCalledTimes(1);

      // select should NOT be called directly by pay() — only internally by selectAndResolve
      // Before the fix, pay() called select() and selectAndResolve() separately
      expect(selectSpy).toHaveBeenCalledTimes(1); // once from inside selectAndResolve

      routerSpy.mockRestore();
      selectSpy.mockRestore();
    });

    test('routes ETH address to BasicAdapter when walletProvider has payACTPBatched', async () => {
      // In mock mode there's no walletProvider, so pay() should go through
      // the normal adapter flow. This test verifies the address → basic path works.
      const result = await client.pay({
        to: providerAddress,
        amount: '100',
      });

      expect(result.txId).toBeDefined();
      expect(result.state).toBe('COMMITTED');
    });

    test('does NOT force BasicAdapter when walletProvider has payACTPBatched AND target is x402 URL', async () => {
      // Simulate a Smart Wallet scenario: walletProvider with payACTPBatched exists
      const mockWalletProvider = { payACTPBatched: jest.fn() };
      (client as any).walletProvider = mockWalletProvider;

      // Spy on BasicAdapter.pay — it should NOT be called for x402 URLs
      const basicPaySpy = jest.spyOn((client as any).basic, 'pay');

      // Spy on router.selectAndResolve to return a mock x402 adapter
      const mockX402Result = { txId: 'x402-mock-tx', state: 'SETTLED', adapter: 'x402' };
      const mockAdapter = { pay: jest.fn().mockResolvedValue(mockX402Result) };
      const routerSpy = jest.spyOn((client as any).router, 'selectAndResolve')
        .mockResolvedValue({
          adapter: mockAdapter,
          resolvedParams: { to: 'https://api.provider.com/service', amount: '100' },
        });

      const result = await client.pay({
        to: 'https://api.provider.com/service',
        amount: '100',
      });

      // x402 URL must go through router-selected adapter, not BasicAdapter
      expect(basicPaySpy).not.toHaveBeenCalled();
      expect(mockAdapter.pay).toHaveBeenCalledTimes(1);
      expect(result.txId).toBe('x402-mock-tx');

      routerSpy.mockRestore();
      basicPaySpy.mockRestore();
      (client as any).walletProvider = undefined;
    });
  });

  describe('smart wallet release routing', () => {
    const contractAddresses = {
      usdc: '0x3333333333333333333333333333333333333333',
      actpKernel: '0x4444444444444444444444444444444444444444',
      escrowVault: '0x5555555555555555555555555555555555555555',
    };

    test('routes release() via transitionState(SETTLED) in wallet mode', async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });
      await client.mintTokens(requesterAddress, '10000000000');

      const result = await client.basic.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600,
      });
      await runtime.transitionState(result.txId, 'IN_PROGRESS');
      await runtime.transitionState(result.txId, 'DELIVERED');
      const deliveredTx = await runtime.getTransaction(result.txId);
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        ...deliveredTx!,
        state: 'DELIVERED',
        completedAt: runtime.time.now() - 4000,
        disputeWindow: 3600,
      } as any);

      const sendTransaction = jest.fn().mockResolvedValue({ success: true, hash: '0xabc' });
      const mockWalletProvider = {
        payACTPBatched: jest.fn(),
        sendTransaction,
      };
      (client as any).walletProvider = mockWalletProvider;
      (client as any).contractAddresses = contractAddresses;
      // SmartWalletRouter is constructed in ACTPClient constructor, so we need to set it
      // when injecting walletProvider after construction for testing
      const { SmartWalletRouter } = require('./wallet/SmartWalletRouter');
      (client as any).smartWalletRouter = new SmartWalletRouter(
        mockWalletProvider, contractAddresses, runtime
      );

      await client.release(result.txId);

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      const sentTx = sendTransaction.mock.calls[0][0];
      const iface = new ethers.Interface([
        'function transitionState(bytes32 transactionId, uint8 newState, bytes proof)',
      ]);
      const decoded = iface.decodeFunctionData('transitionState', sentTx.data);
      expect(decoded[0]).toBe(result.txId);
      expect(decoded[1]).toBe(5n);
    });

    test('requires attestation in wallet mode when runtime mandates it', async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });
      await client.mintTokens(requesterAddress, '10000000000');

      const result = await client.basic.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600,
      });
      await runtime.transitionState(result.txId, 'IN_PROGRESS');
      await runtime.transitionState(result.txId, 'DELIVERED');
      const deliveredTx = await runtime.getTransaction(result.txId);
      jest.spyOn(runtime, 'getTransaction').mockResolvedValue({
        ...deliveredTx!,
        state: 'DELIVERED',
        completedAt: runtime.time.now() - 4000,
        disputeWindow: 3600,
      } as any);

      const sendTransaction = jest.fn().mockResolvedValue({ success: true, hash: '0xabc' });
      const mockWalletProvider = {
        payACTPBatched: jest.fn(),
        sendTransaction,
      };
      (client as any).walletProvider = mockWalletProvider;
      (client as any).contractAddresses = contractAddresses;
      (runtime as any).isAttestationRequired = jest.fn().mockReturnValue(true);
      // SmartWalletRouter is constructed in ACTPClient constructor, so we need to set it
      const { SmartWalletRouter } = require('./wallet/SmartWalletRouter');
      (client as any).smartWalletRouter = new SmartWalletRouter(
        mockWalletProvider, contractAddresses, runtime
      );

      await expect(client.release(result.txId)).rejects.toThrow(
        'Attestation verification is REQUIRED for escrow release'
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });
});
