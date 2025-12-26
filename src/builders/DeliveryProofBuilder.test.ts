/**
 * DeliveryProofBuilder Test Suite
 *
 * Tests cover:
 * - extractAddressFromDID (helper function)
 * - Build flow with mocked dependencies
 * - Error handling
 *
 * Note: Full integration tests require real IPFS and EAS connections.
 * These tests focus on logic validation with mocked dependencies.
 *
 * @module builders/DeliveryProofBuilder.test
 */

import { DeliveryProofBuilder, AGIRAILS_DELIVERY_SCHEMA_UID } from './DeliveryProofBuilder';

describe('DeliveryProofBuilder', () => {
  // ============================================================================
  // Constants Tests
  // ============================================================================

  describe('Constants', () => {
    it('should export AGIRAILS_DELIVERY_SCHEMA_UID', () => {
      expect(AGIRAILS_DELIVERY_SCHEMA_UID).toBeDefined();
      expect(AGIRAILS_DELIVERY_SCHEMA_UID).toMatch(/^0x[a-f0-9]{64}$/);
    });
  });

  // ============================================================================
  // extractAddressFromDID Tests (via error paths)
  // ============================================================================

  describe('extractAddressFromDID (via build errors)', () => {
    // Create minimal mocks for testing DID extraction errors
    const createMocks = () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTestCID'),
        pin: jest.fn().mockResolvedValue(undefined),
      };

      const mockSigner = {
        signTypedData: jest.fn().mockResolvedValue('0x' + '1'.repeat(130)),
        getAddress: jest.fn().mockResolvedValue('0x' + '1'.repeat(40)),
      };

      const mockNonceManager = {
        getNextNonce: jest.fn().mockReturnValue('0x' + '0'.repeat(64)),
        recordNonce: jest.fn(),
      };

      const mockEAS = {
        attest: jest.fn().mockResolvedValue({
          wait: jest.fn().mockResolvedValue('0x' + 'a'.repeat(64)),
        }),
        getAttestation: jest.fn(),
      };

      return { mockIPFS, mockSigner, mockNonceManager, mockEAS };
    };

    it('should handle valid DID format did:ethr:0x...', async () => {
      const { mockIPFS, mockSigner, mockNonceManager, mockEAS } = createMocks();

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      // This should work with valid DID
      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:0x' + '1'.repeat(40),
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        resultData: { test: 'data' },
        chainId: 84532,
        kernelAddress: '0x' + '3'.repeat(40),
      };

      // Should succeed with valid DID format
      const result = await builder.build(params);
      expect(result.deliveryProof.provider).toBe(params.provider);
      expect(result.deliveryProof.consumer).toBe(params.consumer);
    });

    it('should handle DID with chain ID: did:ethr:84532:0x...', async () => {
      const { mockIPFS, mockSigner, mockNonceManager, mockEAS } = createMocks();

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:84532:0x' + '1'.repeat(40),
        consumer: 'did:ethr:84532:0x' + '2'.repeat(40),
        resultData: { test: 'data' },
        chainId: 84532,
        kernelAddress: '0x' + '3'.repeat(40),
      };

      // Should succeed with chain ID in DID
      const result = await builder.build(params);
      expect(result.deliveryProof.provider).toBe(params.provider);
    });
  });

  // ============================================================================
  // Mock Integration Tests
  // ============================================================================

  describe('build() with mocks', () => {
    it('should call IPFS add and pin', async () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTestCID123'),
        pin: jest.fn().mockResolvedValue(undefined),
      };

      const mockSigner = {
        signTypedData: jest.fn().mockResolvedValue('0x' + '1'.repeat(130)),
      };

      const mockNonceManager = {
        getNextNonce: jest.fn().mockReturnValue('0x' + '0'.repeat(64)),
        recordNonce: jest.fn(),
      };

      const mockEAS = {
        attest: jest.fn().mockResolvedValue({
          wait: jest.fn().mockResolvedValue({
            newAttestationUID: '0x' + 'a'.repeat(64),
          }),
        }),
      };

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:0x' + '1'.repeat(40),
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        resultData: { result: 'success' },
        chainId: 84532,
        kernelAddress: '0x' + '3'.repeat(40),
      };

      const result = await builder.build(params);

      // IPFS should be called for result and delivery proof
      expect(mockIPFS.add).toHaveBeenCalledTimes(2);
      expect(mockIPFS.pin).toHaveBeenCalledTimes(2);

      // First call should be result data
      expect(mockIPFS.add).toHaveBeenNthCalledWith(1, JSON.stringify(params.resultData));

      // Result should include CIDs
      expect(result.deliveryProofCID).toBe('QmTestCID123');
    });

    it('should call EAS attest with correct schema', async () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTestCID'),
        pin: jest.fn().mockResolvedValue(undefined),
      };

      const mockSigner = {
        signTypedData: jest.fn().mockResolvedValue('0x' + '1'.repeat(130)),
      };

      const mockNonceManager = {
        getNextNonce: jest.fn().mockReturnValue('0x' + '0'.repeat(64)),
        recordNonce: jest.fn(),
      };

      const attestUID = '0x' + 'b'.repeat(64);
      const mockEAS = {
        attest: jest.fn().mockResolvedValue({
          wait: jest.fn().mockResolvedValue({
            newAttestationUID: attestUID,
          }),
        }),
      };

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:0x' + '1'.repeat(40),
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        resultData: { data: 'test' },
        chainId: 84532,
        kernelAddress: '0x' + '3'.repeat(40),
      };

      const result = await builder.build(params);

      // EAS should be called with correct schema
      expect(mockEAS.attest).toHaveBeenCalledWith(
        expect.objectContaining({
          schema: AGIRAILS_DELIVERY_SCHEMA_UID,
        })
      );

      // Result should include attestation UID
      expect(result.attestationUID).toBe(attestUID);
    });

    it('should include nonce from NonceManager', async () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTestCID'),
        pin: jest.fn().mockResolvedValue(undefined),
      };

      const mockSigner = {
        signTypedData: jest.fn().mockResolvedValue('0x' + '1'.repeat(130)),
      };

      const expectedNonce = '0x' + '42'.padStart(64, '0');
      const mockNonceManager = {
        getNextNonce: jest.fn().mockReturnValue(expectedNonce),
        recordNonce: jest.fn(),
      };

      const mockEAS = {
        attest: jest.fn().mockResolvedValue({
          wait: jest.fn().mockResolvedValue({
            newAttestationUID: '0x' + 'a'.repeat(64),
          }),
        }),
      };

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:0x' + '1'.repeat(40),
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        resultData: { data: 'test' },
        chainId: 84532,
        kernelAddress: '0x' + '3'.repeat(40),
      };

      const result = await builder.build(params);

      // Nonce should come from NonceManager
      expect(mockNonceManager.getNextNonce).toHaveBeenCalledWith('agirails.delivery.v1');
      expect(result.deliveryProof.nonce).toBe(expectedNonce);

      // Nonce should be recorded after use
      expect(mockNonceManager.recordNonce).toHaveBeenCalledWith('agirails.delivery.v1', expectedNonce);
    });

    it('should sign with EIP-712', async () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTestCID'),
        pin: jest.fn().mockResolvedValue(undefined),
      };

      const expectedSignature = '0x' + 'ab'.repeat(65);
      const mockSigner = {
        signTypedData: jest.fn().mockResolvedValue(expectedSignature),
      };

      const mockNonceManager = {
        getNextNonce: jest.fn().mockReturnValue('0x' + '0'.repeat(64)),
        recordNonce: jest.fn(),
      };

      const mockEAS = {
        attest: jest.fn().mockResolvedValue({
          wait: jest.fn().mockResolvedValue({
            newAttestationUID: '0x' + 'a'.repeat(64),
          }),
        }),
      };

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      const kernelAddress = '0x' + '3'.repeat(40);
      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:0x' + '1'.repeat(40),
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        resultData: { data: 'test' },
        chainId: 84532,
        kernelAddress,
      };

      const result = await builder.build(params);

      // Signer should be called with correct domain
      expect(mockSigner.signTypedData).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'AGIRAILS',
          version: '1',
          chainId: 84532,
          verifyingContract: kernelAddress,
        }),
        expect.any(Object), // Types
        expect.any(Object) // Message
      );

      // Result should include signature
      expect(result.deliveryProof.signature).toBe(expectedSignature);
    });

    it('should throw if signer does not support signTypedData', async () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTestCID'),
        pin: jest.fn().mockResolvedValue(undefined),
      };

      // Signer without signTypedData
      const mockSigner = {};

      const mockNonceManager = {
        getNextNonce: jest.fn().mockReturnValue('0x' + '0'.repeat(64)),
        recordNonce: jest.fn(),
      };

      const mockEAS = {
        attest: jest.fn().mockResolvedValue({
          wait: jest.fn().mockResolvedValue({
            newAttestationUID: '0x' + 'a'.repeat(64),
          }),
        }),
      };

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:0x' + '1'.repeat(40),
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        resultData: { data: 'test' },
        chainId: 84532,
        kernelAddress: '0x' + '3'.repeat(40),
      };

      await expect(builder.build(params)).rejects.toThrow('does not support EIP-712');
    });
  });

  // ============================================================================
  // DeliveryProof Structure Tests
  // ============================================================================

  describe('DeliveryProof structure', () => {
    it('should include all required fields', async () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTestCID'),
        pin: jest.fn().mockResolvedValue(undefined),
      };

      const mockSigner = {
        signTypedData: jest.fn().mockResolvedValue('0x' + '1'.repeat(130)),
      };

      const mockNonceManager = {
        getNextNonce: jest.fn().mockReturnValue('0x' + '0'.repeat(64)),
        recordNonce: jest.fn(),
      };

      const mockEAS = {
        attest: jest.fn().mockResolvedValue({
          wait: jest.fn().mockResolvedValue({
            newAttestationUID: '0x' + 'a'.repeat(64),
          }),
        }),
      };

      const builder = new DeliveryProofBuilder(
        mockIPFS as any,
        mockSigner as any,
        mockNonceManager as any,
        mockEAS as any
      );

      const params = {
        txId: '0x' + '1'.repeat(64),
        provider: 'did:ethr:0x' + '1'.repeat(40),
        consumer: 'did:ethr:0x' + '2'.repeat(40),
        resultData: { data: 'test' },
        chainId: 84532,
        kernelAddress: '0x' + '3'.repeat(40),
        metadata: {
          executionTime: 1000,
          outputFormat: 'json',
        },
      };

      const result = await builder.build(params);
      const proof = result.deliveryProof;

      // Required fields
      expect(proof.type).toBe('agirails.delivery.v1');
      expect(proof.version).toBe('1.0.0');
      expect(proof.txId).toBe(params.txId);
      expect(proof.provider).toBe(params.provider);
      expect(proof.consumer).toBe(params.consumer);
      expect(proof.resultCID).toBeDefined();
      expect(proof.resultHash).toBeDefined();
      expect(proof.easAttestationUID).toBeDefined();
      expect(proof.deliveredAt).toBeDefined();
      expect(proof.chainId).toBe(84532);
      expect(proof.nonce).toBeDefined();
      expect(proof.signature).toBeDefined();

      // Metadata
      expect(proof.metadata).toEqual(params.metadata);
    });
  });
});
