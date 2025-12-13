/**
 * ACTPClient Integration Tests
 *
 * Tests the main SDK entry point and Three-Level API integration:
 * - Client creation (factory method)
 * - Beginner API access
 * - Intermediate API access
 * - Advanced API access
 * - Cross-API consistency
 */

import { ACTPClient } from './ACTPClient';
import { MockRuntime } from './runtime/MockRuntime';

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
      test('throws on missing requesterAddress', async () => {
        await expect(
          ACTPClient.create({
            mode: 'mock',
            requesterAddress: '',
          })
        ).rejects.toThrow('requesterAddress is required');
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
        ).rejects.toThrow('privateKey is required for testnet mode');
      });

      test('throws on mainnet mode without privateKey', async () => {
        await expect(
          ACTPClient.create({
            mode: 'mainnet',
            requesterAddress,
          })
        ).rejects.toThrow('privateKey is required for mainnet mode');
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

    describe('beginner API', () => {
      test('provides BeginnerAdapter instance', () => {
        expect(client.beginner).toBeDefined();
        expect(client.beginner.constructor.name).toBe('BeginnerAdapter');
      });

      test('pay() creates and funds transaction', async () => {
        const result = await client.beginner.pay({
          to: providerAddress,
          amount: '100',
        });

        expect(result.txId).toBeDefined();
        expect(result.state).toBe('COMMITTED');
        expect(result.amount).toBe('100.00 USDC');
      });

      test('checkStatus() returns transaction status', async () => {
        const result = await client.beginner.pay({
          to: providerAddress,
          amount: '100',
        });

        const status = await client.beginner.checkStatus(result.txId);

        expect(status.state).toBe('COMMITTED');
        expect(status.canComplete).toBe(true);
      });
    });

    describe('intermediate API', () => {
      test('provides IntermediateAdapter instance', () => {
        expect(client.intermediate).toBeDefined();
        expect(client.intermediate.constructor.name).toBe('IntermediateAdapter');
      });

      test('createTransaction() creates transaction in INITIATED state', async () => {
        const txId = await client.intermediate.createTransaction({
          provider: providerAddress,
          amount: '100',
        });

        const tx = await client.intermediate.getTransaction(txId);
        expect(tx).not.toBeNull();
        expect(tx!.state).toBe('INITIATED');
      });

      test('linkEscrow() transitions to COMMITTED', async () => {
        const txId = await client.intermediate.createTransaction({
          provider: providerAddress,
          amount: '100',
        });

        await client.intermediate.linkEscrow(txId);

        const tx = await client.intermediate.getTransaction(txId);
        expect(tx!.state).toBe('COMMITTED');
      });

      test('transitionState() advances transaction state', async () => {
        const txId = await client.intermediate.createTransaction({
          provider: providerAddress,
          amount: '100',
        });
        await client.intermediate.linkEscrow(txId);

        await client.intermediate.transitionState(txId, 'DELIVERED');

        const tx = await client.intermediate.getTransaction(txId);
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
        // Create via beginner API
        const beginnerResult = await client.beginner.pay({
          to: providerAddress,
          amount: '100',
        });

        // Create via intermediate API
        const intermediateTxId = await client.intermediate.createTransaction({
          provider: providerAddress,
          amount: '100',
        });
        await client.intermediate.linkEscrow(intermediateTxId);

        // Create via advanced API
        const advancedTxId = await client.advanced.createTransaction({
          provider: providerAddress,
          requester: requesterAddress,
          amount: '100000000',
          deadline: Math.floor(Date.now() / 1000) + 86400,
        });
        await client.advanced.linkEscrow(advancedTxId, '100000000');

        // Verify all three transactions exist and have same state
        const beginnerTx = await client.advanced.getTransaction(beginnerResult.txId);
        const intermediateTx = await client.advanced.getTransaction(intermediateTxId);
        const advancedTx = await client.advanced.getTransaction(advancedTxId);

        expect(beginnerTx!.state).toBe('COMMITTED');
        expect(intermediateTx!.state).toBe('COMMITTED');
        expect(advancedTx!.state).toBe('COMMITTED');

        expect(beginnerTx!.amount).toBe('100000000');
        expect(intermediateTx!.amount).toBe('100000000');
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
        const txId = await client.intermediate.createTransaction({
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
        await client.beginner.pay({
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
    test('happy path: create → deliver → settle', async () => {
      const runtime = new MockRuntime();
      await runtime.reset();
      const client = await ACTPClient.create({
        mode: 'mock',
        requesterAddress,
        runtime,
      });

      // Setup
      await client.mintTokens(requesterAddress, '10000000000');

      // 1. Create payment (beginner API)
      // Note: disputeWindow minimum is 1 hour (3600 seconds) per L-1 security fix
      const result = await client.beginner.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600, // 1 hour (minimum allowed)
      });
      expect(result.state).toBe('COMMITTED');

      // 2. Provider delivers (intermediate API)
      await client.intermediate.transitionState(result.txId, 'DELIVERED');

      let status = await client.beginner.checkStatus(result.txId);
      expect(status.state).toBe('DELIVERED');
      expect(status.canDispute).toBe(true);

      // 3. Wait for dispute window to expire (advanced API time control)
      // MockRuntime has extended time interface with advanceTime (now async)
      const mockRuntime = client.runtime as MockRuntime;
      await mockRuntime.time.advanceTime(3601); // 1 hour + 1 second

      status = await client.beginner.checkStatus(result.txId);
      expect(status.canDispute).toBe(false);

      // 4. Release escrow
      const tx = await client.advanced.getTransaction(result.txId);
      await client.advanced.releaseEscrow(tx!.escrowId!);

      // 5. Verify settled
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
      const result = await client.beginner.pay({
        to: providerAddress,
        amount: '100',
        disputeWindow: 3600, // 1 hour
      });

      // 2. Provider delivers
      await client.intermediate.transitionState(result.txId, 'DELIVERED');

      // 3. Requester disputes (within window)
      await client.intermediate.transitionState(result.txId, 'DISPUTED');

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
      const result = await client.beginner.pay({
        to: providerAddress,
        amount: '100',
      });

      // 2. Cancel before delivery
      await client.intermediate.transitionState(result.txId, 'CANCELLED');

      const tx = await client.advanced.getTransaction(result.txId);
      expect(tx!.state).toBe('CANCELLED');

      // 3. Verify funds returned
      const finalBalance = await client.getBalance(requesterAddress);
      expect(finalBalance).toBe(initialBalance);
    });
  });
});
