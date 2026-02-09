/**
 * TransactionBatcher Tests
 *
 * Tests cover:
 * - computeTransactionId: matches contract formula
 * - buildACTPPayBatch: correct 3-call structure
 * - buildRegisterAgentBatch: correct encoding
 * - buildTestnetMintBatch: correct encoding
 */

import { ethers } from 'ethers';
import {
  computeTransactionId,
  buildACTPPayBatch,
  buildRegisterAgentBatch,
  buildTestnetMintBatch,
  buildTestnetInitBatch,
} from './TransactionBatcher';
import { ServiceDescriptor } from '../../types/agent';

// Test addresses
const REQUESTER = '0x' + '11'.repeat(20);
const PROVIDER = '0x' + '22'.repeat(20);
const USDC = '0x' + '33'.repeat(20);
const KERNEL = '0x' + '44'.repeat(20);
const VAULT = '0x' + '55'.repeat(20);
const REGISTRY = '0x' + '66'.repeat(20);
const ZERO_HASH = '0x' + '00'.repeat(32);

describe('TransactionBatcher', () => {
  describe('computeTransactionId()', () => {
    it('should match solidityPacked keccak256 formula', () => {
      const txId = computeTransactionId(
        REQUESTER,
        PROVIDER,
        '1000000', // 1 USDC
        ZERO_HASH,
        0n
      );

      // Verify it matches manual computation
      const expected = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'address', 'uint256', 'bytes32', 'uint256'],
          [REQUESTER, PROVIDER, 1000000n, ZERO_HASH, 0n]
        )
      );

      expect(txId).toBe(expected);
    });

    it('should produce different IDs for different nonces', () => {
      const txId0 = computeTransactionId(REQUESTER, PROVIDER, '1000000', ZERO_HASH, 0n);
      const txId1 = computeTransactionId(REQUESTER, PROVIDER, '1000000', ZERO_HASH, 1n);
      expect(txId0).not.toBe(txId1);
    });

    it('should produce different IDs for different amounts', () => {
      const txId1 = computeTransactionId(REQUESTER, PROVIDER, '1000000', ZERO_HASH, 0n);
      const txId2 = computeTransactionId(REQUESTER, PROVIDER, '2000000', ZERO_HASH, 0n);
      expect(txId1).not.toBe(txId2);
    });
  });

  describe('buildACTPPayBatch()', () => {
    it('should produce exactly 3 calls', () => {
      const result = buildACTPPayBatch({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '1000000',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        serviceHash: ZERO_HASH,
        agentId: '0',
        actpNonce: 0n,
        contracts: { usdc: USDC, actpKernel: KERNEL, escrowVault: VAULT },
      });

      expect(result.calls).toHaveLength(3);
      expect(result.txId).toBeDefined();
      expect(result.txId.startsWith('0x')).toBe(true);
      expect(result.txId.length).toBe(66); // bytes32
    });

    it('should target correct contracts', () => {
      const result = buildACTPPayBatch({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '1000000',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        serviceHash: ZERO_HASH,
        agentId: '0',
        actpNonce: 0n,
        contracts: { usdc: USDC, actpKernel: KERNEL, escrowVault: VAULT },
      });

      // Call 1: USDC.approve
      expect(result.calls[0].target).toBe(USDC);
      expect(result.calls[0].value).toBe(0n);

      // Call 2: ACTPKernel.createTransaction
      expect(result.calls[1].target).toBe(KERNEL);

      // Call 3: ACTPKernel.linkEscrow
      expect(result.calls[2].target).toBe(KERNEL);
    });

    it('should produce consistent txId for same params', () => {
      const params = {
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '1000000',
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        serviceHash: ZERO_HASH,
        agentId: '0',
        actpNonce: 5n,
        contracts: { usdc: USDC, actpKernel: KERNEL, escrowVault: VAULT },
      };

      const result1 = buildACTPPayBatch(params);
      const result2 = buildACTPPayBatch(params);

      expect(result1.txId).toBe(result2.txId);
    });

    it('should encode approve calldata correctly', () => {
      const result = buildACTPPayBatch({
        provider: PROVIDER,
        requester: REQUESTER,
        amount: '5000000', // 5 USDC
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800,
        serviceHash: ZERO_HASH,
        agentId: '0',
        actpNonce: 0n,
        contracts: { usdc: USDC, actpKernel: KERNEL, escrowVault: VAULT },
      });

      // Decode approve call
      const iface = new ethers.Interface(['function approve(address spender, uint256 amount)']);
      const decoded = iface.decodeFunctionData('approve', result.calls[0].data);
      expect(decoded[0].toLowerCase()).toBe(VAULT.toLowerCase()); // spender = escrowVault
      expect(decoded[1]).toBe(5000000n); // amount
    });
  });

  describe('buildRegisterAgentBatch()', () => {
    const TEST_SERVICE: ServiceDescriptor = {
      serviceTypeHash: ethers.keccak256(ethers.toUtf8Bytes('text-generation')),
      serviceType: 'text-generation',
      schemaURI: '',
      minPrice: 0n,
      maxPrice: 1_000_000_000n,
      avgCompletionTime: 3600,
      metadataCID: '',
    };

    it('should produce a single call with correct ABI', () => {
      const calls = buildRegisterAgentBatch(REGISTRY, 'https://agent.example.com', [TEST_SERVICE]);
      expect(calls).toHaveLength(1);
      expect(calls[0].target).toBe(REGISTRY);
      expect(calls[0].value).toBe(0n);

      // Decode and verify it matches the real contract ABI
      const iface = new ethers.Interface([
        'function registerAgent(string endpoint, (bytes32 serviceTypeHash, string serviceType, string schemaURI, uint256 minPrice, uint256 maxPrice, uint256 avgCompletionTime, string metadataCID)[] serviceDescriptors)',
      ]);
      const decoded = iface.decodeFunctionData('registerAgent', calls[0].data);
      expect(decoded[0]).toBe('https://agent.example.com');
      expect(decoded[1]).toHaveLength(1);
      expect(decoded[1][0].serviceType).toBe('text-generation');
    });

    it('should reject empty service descriptors', () => {
      expect(() => buildRegisterAgentBatch(REGISTRY, 'https://example.com', []))
        .toThrow('At least one service descriptor');
    });
  });

  describe('buildTestnetMintBatch()', () => {
    it('should produce a single mint call', () => {
      const calls = buildTestnetMintBatch(USDC, REQUESTER, '10000000000');
      expect(calls).toHaveLength(1);
      expect(calls[0].target).toBe(USDC);

      // Decode
      const iface = new ethers.Interface(['function mint(address to, uint256 amount)']);
      const decoded = iface.decodeFunctionData('mint', calls[0].data);
      expect(decoded[0].toLowerCase()).toBe(REQUESTER.toLowerCase());
      expect(decoded[1]).toBe(10000000000n);
    });
  });

  describe('buildTestnetInitBatch()', () => {
    it('should combine register + mint calls', () => {
      const service: ServiceDescriptor = {
        serviceTypeHash: ethers.keccak256(ethers.toUtf8Bytes('general')),
        serviceType: 'general',
        schemaURI: '',
        minPrice: 0n,
        maxPrice: 1_000_000_000n,
        avgCompletionTime: 3600,
        metadataCID: '',
      };

      const calls = buildTestnetInitBatch({
        agentRegistryAddress: REGISTRY,
        endpoint: 'https://agent.example.com',
        serviceDescriptors: [service],
        mockUsdcAddress: USDC,
        recipient: REQUESTER,
        mintAmount: '10000000000',
      });

      // Should produce 2 calls: register + mint
      expect(calls).toHaveLength(2);
      expect(calls[0].target).toBe(REGISTRY); // registerAgent
      expect(calls[1].target).toBe(USDC);     // mint
    });
  });
});
