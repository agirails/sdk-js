/**
 * DeliveryProofBuilder Test Suite
 *
 * Coverage Target: 80%+ (statements, functions, lines, branches)
 *
 * Test Categories:
 * 1. Delivery Proof Building (5 tests)
 * 2. Delivery Proof Verification (5 tests)
 * 3. Signature Operations (3 tests)
 * 4. DID Parsing (2 tests)
 *
 * References:
 * - DeliveryProofBuilder.ts implementation
 * - AIP-4 §9.1 (Delivery Proof Construction)
 */

import { Wallet } from 'ethers';
import { DeliveryProofBuilder, AGIRAILS_DELIVERY_SCHEMA_UID } from '../../builders/DeliveryProofBuilder';
import { IPFSClient } from '../../utils/IPFSClient';
import { NonceManager } from '../../utils/NonceManager';
import { EAS } from '@ethereum-attestation-service/eas-sdk';

// Mock IPFSClient
const mockIPFS: jest.Mocked<IPFSClient> = {
  add: jest.fn(),
  pin: jest.fn(),
  get: jest.fn(),
  cat: jest.fn()
} as any;

// Mock NonceManager
const mockNonceManager: jest.Mocked<NonceManager> = {
  getNextNonce: jest.fn(),
  recordNonce: jest.fn(),
  getCurrentNonce: jest.fn()
} as any;

// Mock EAS
const mockEAS: jest.Mocked<EAS> = {
  attest: jest.fn(),
  getAttestation: jest.fn()
} as any;

// Test signer
const testPrivateKey = '0x' + '1'.repeat(64);
const testSigner = new Wallet(testPrivateKey);
const testProviderAddress = testSigner.address.toLowerCase();

describe('DeliveryProofBuilder - Delivery Proof Building', () => {
  let builder: DeliveryProofBuilder;

  beforeEach(() => {
    jest.clearAllMocks();
    builder = new DeliveryProofBuilder(mockIPFS, testSigner, mockNonceManager, mockEAS);

    // Default mock implementations
    mockIPFS.add.mockResolvedValue('QmTestCID123456789');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockNonceManager.recordNonce.mockReturnValue(undefined);
  });

  it('should build complete delivery proof with IPFS upload', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { result: 'success', output: 'test-output' },
      metadata: {
        executionTime: 1500,
        outputFormat: 'json',
        outputSize: 256
      },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    const result = await builder.build(params);

    // Verify IPFS uploads
    expect(mockIPFS.add).toHaveBeenCalledTimes(2); // resultData + deliveryProof
    expect(mockIPFS.pin).toHaveBeenCalledTimes(2);
    expect(mockIPFS.add).toHaveBeenCalledWith(JSON.stringify(params.resultData));

    // Verify EAS attestation
    expect(mockEAS.attest).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: AGIRAILS_DELIVERY_SCHEMA_UID,
        data: expect.objectContaining({
          recipient: '0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
          revocable: false
        })
      })
    );

    // Verify nonce management
    expect(mockNonceManager.getNextNonce).toHaveBeenCalledWith('agirails.delivery.v1');
    expect(mockNonceManager.recordNonce).toHaveBeenCalledWith('agirails.delivery.v1', 1);

    // Verify result structure
    expect(result.deliveryProof).toMatchObject({
      type: 'agirails.delivery.v1',
      version: '1.0.0',
      txId: params.txId,
      provider: params.provider,
      consumer: params.consumer,
      resultCID: 'QmTestCID123456789',
      easAttestationUID: mockAttestationUID,
      chainId: params.chainId,
      nonce: 1
    });

    expect(result.deliveryProof.signature).toBeTruthy();
    expect(result.deliveryProof.signature.startsWith('0x')).toBe(true);
    expect(result.deliveryProofCID).toBe('QmTestCID123456789');
    expect(result.attestationUID).toBe(mockAttestationUID);
  });

  it('should build delivery proof with empty metadata', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { result: 'success' },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    const result = await builder.build(params);

    expect(result.deliveryProof.metadata).toEqual({});
  });

  it('should compute result hash correctly', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { a: 1, b: 2 },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    const result = await builder.build(params);

    // resultHash should be a bytes32 hex string
    expect(result.deliveryProof.resultHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });

  it('should set deliveredAt timestamp correctly', async () => {
    const beforeTime = Math.floor(Date.now() / 1000);

    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { result: 'success' },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    const result = await builder.build(params);

    const afterTime = Math.floor(Date.now() / 1000);

    expect(result.deliveryProof.deliveredAt).toBeGreaterThanOrEqual(beforeTime);
    expect(result.deliveryProof.deliveredAt).toBeLessThanOrEqual(afterTime);
  });

  it('should handle different chain IDs', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const paramsMainnet = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:8453:${testProviderAddress}`,
      consumer: 'did:ethr:8453:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { result: 'success' },
      chainId: 8453, // Base Mainnet
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    const result = await builder.build(paramsMainnet);

    expect(result.deliveryProof.chainId).toBe(8453);
  });
});

describe('DeliveryProofBuilder - Delivery Proof Verification', () => {
  let builder: DeliveryProofBuilder;

  beforeEach(() => {
    jest.clearAllMocks();
    builder = new DeliveryProofBuilder(mockIPFS, testSigner, mockNonceManager, mockEAS);
  });

  it('should verify valid delivery proof', async () => {
    const resultData = { result: 'success', output: 'test' };
    const txId = '0x' + '1'.repeat(64);
    const mockAttestationUID = '0x' + '2'.repeat(64);
    const kernelAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // Build a real delivery proof first
    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const { deliveryProof } = await builder.build({
      txId,
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData,
      chainId: 84532,
      kernelAddress
    });

    // Mock EAS attestation retrieval
    mockEAS.getAttestation.mockResolvedValue({
      schema: AGIRAILS_DELIVERY_SCHEMA_UID,
      data: '0x', // Will be decoded by SchemaEncoder
      revoked: false
    } as any);

    // Mock SchemaEncoder decodeData
    const originalSchemaEncoder = jest.requireActual('@ethereum-attestation-service/eas-sdk').SchemaEncoder;
    jest.spyOn(originalSchemaEncoder.prototype, 'decodeData').mockReturnValue([
      { name: 'txId', value: { value: txId } },
      { name: 'resultCID', value: { value: deliveryProof.resultCID } },
      { name: 'resultHash', value: { value: deliveryProof.resultHash } },
      { name: 'deliveredAt', value: { value: deliveryProof.deliveredAt } }
    ]);

    const isValid = await builder.verify(deliveryProof, resultData, kernelAddress);

    expect(isValid).toBe(true);
    expect(mockEAS.getAttestation).toHaveBeenCalledWith(mockAttestationUID);
  });

  it('should reject delivery proof with invalid signature', async () => {
    const resultData = { result: 'success' };
    const deliveryProof = {
      type: 'agirails.delivery.v1' as const,
      version: '1.0.0',
      txId: '0x' + '1'.repeat(64),
      provider: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0', // Wrong provider
      consumer: 'did:ethr:84532:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      resultCID: 'QmTestCID',
      resultHash: '0x' + '3'.repeat(64),
      metadata: {},
      easAttestationUID: '0x' + '2'.repeat(64),
      deliveredAt: Math.floor(Date.now() / 1000),
      chainId: 84532,
      nonce: 1,
      signature: '0x' + '9'.repeat(130) // Invalid signature
    };

    await expect(
      builder.verify(deliveryProof, resultData, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    ).rejects.toThrow('Invalid signature');
  });

  it('should reject delivery proof with tampered result data', async () => {
    const originalData = { result: 'success', output: 'original' };
    const tamperedData = { result: 'success', output: 'tampered' };
    const txId = '0x' + '1'.repeat(64);
    const mockAttestationUID = '0x' + '2'.repeat(64);
    const kernelAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // Build proof with original data
    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const { deliveryProof } = await builder.build({
      txId,
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: originalData,
      chainId: 84532,
      kernelAddress
    });

    // Try to verify with tampered data
    await expect(
      builder.verify(deliveryProof, tamperedData, kernelAddress)
    ).rejects.toThrow('Result hash mismatch');
  });

  it('should reject delivery proof with non-existent EAS attestation', async () => {
    const resultData = { result: 'success' };
    const txId = '0x' + '1'.repeat(64);
    const mockAttestationUID = '0x' + '2'.repeat(64);
    const kernelAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const { deliveryProof } = await builder.build({
      txId,
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData,
      chainId: 84532,
      kernelAddress
    });

    // Mock attestation not found
    mockEAS.getAttestation.mockResolvedValue(null as any);

    await expect(
      builder.verify(deliveryProof, resultData, kernelAddress)
    ).rejects.toThrow('Attestation not found on EAS');
  });

  it('should reject revoked EAS attestation', async () => {
    const resultData = { result: 'success' };
    const txId = '0x' + '1'.repeat(64);
    const mockAttestationUID = '0x' + '2'.repeat(64);
    const kernelAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const { deliveryProof } = await builder.build({
      txId,
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData,
      chainId: 84532,
      kernelAddress
    });

    // Mock revoked attestation
    mockEAS.getAttestation.mockResolvedValue({
      schema: AGIRAILS_DELIVERY_SCHEMA_UID,
      data: '0x',
      revoked: true,
      revocationTime: 1234567890
    } as any);

    await expect(
      builder.verify(deliveryProof, resultData, kernelAddress)
    ).rejects.toThrow('Attestation was revoked');
  });
});

describe('DeliveryProofBuilder - Signature Operations', () => {
  let builder: DeliveryProofBuilder;

  beforeEach(() => {
    jest.clearAllMocks();
    builder = new DeliveryProofBuilder(mockIPFS, testSigner, mockNonceManager, mockEAS);
  });

  it('should sign delivery proof with EIP-712', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { result: 'success' },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    const { deliveryProof } = await builder.build(params);

    // Signature should be 0x-prefixed, 130 characters (65 bytes * 2 hex chars)
    expect(deliveryProof.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
  });

  it('should recover correct signer from signature', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { result: 'success' },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    const { deliveryProof } = await builder.build(params);

    // Recover signer by verifying with same data
    mockEAS.getAttestation.mockResolvedValue({
      schema: AGIRAILS_DELIVERY_SCHEMA_UID,
      data: '0x',
      revoked: false
    } as any);

    const originalSchemaEncoder = jest.requireActual('@ethereum-attestation-service/eas-sdk').SchemaEncoder;
    jest.spyOn(originalSchemaEncoder.prototype, 'decodeData').mockReturnValue([
      { name: 'txId', value: { value: params.txId } },
      { name: 'resultCID', value: { value: deliveryProof.resultCID } },
      { name: 'resultHash', value: { value: deliveryProof.resultHash } },
      { name: 'deliveredAt', value: { value: deliveryProof.deliveredAt } }
    ]);

    const isValid = await builder.verify(deliveryProof, params.resultData, params.kernelAddress);
    expect(isValid).toBe(true);
  });

  it('should throw error if signer does not support EIP-712', async () => {
    const invalidSigner = {
      getAddress: jest.fn().mockResolvedValue('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      // Missing _signTypedData
    } as any;

    const builderWithInvalidSigner = new DeliveryProofBuilder(mockIPFS, invalidSigner, mockNonceManager, mockEAS);

    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: '0x' + '2'.repeat(64)
      })
    } as any);

    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: 'did:ethr:84532:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      consumer: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      resultData: { result: 'success' },
      chainId: 84532,
      kernelAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    };

    await expect(builderWithInvalidSigner.build(params)).rejects.toThrow(
      'Signer does not support EIP-712 typed data signing'
    );
  });
});

describe('DeliveryProofBuilder - DID Parsing', () => {
  let builder: DeliveryProofBuilder;

  beforeEach(() => {
    jest.clearAllMocks();
    builder = new DeliveryProofBuilder(mockIPFS, testSigner, mockNonceManager, mockEAS);
  });

  it('should extract address from DID with chain ID', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const consumerAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';
    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:84532:${testProviderAddress}`,
      consumer: `did:ethr:84532:${consumerAddress}`,
      resultData: { result: 'success' },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    await builder.build(params);

    // Verify EAS attestation was created with correct recipient
    expect(mockEAS.attest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: consumerAddress
        })
      })
    );
  });

  it('should extract address from DID without chain ID', async () => {
    const mockAttestationUID = '0x' + '2'.repeat(64);
    mockIPFS.add.mockResolvedValue('QmTestCID');
    mockIPFS.pin.mockResolvedValue(undefined);
    mockNonceManager.getNextNonce.mockReturnValue(1);
    mockEAS.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        newAttestationUID: mockAttestationUID
      })
    } as any);

    const consumerAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';
    const params = {
      txId: '0x' + '1'.repeat(64),
      provider: `did:ethr:${testProviderAddress}`,
      consumer: `did:ethr:${consumerAddress}`,
      resultData: { result: 'success' },
      chainId: 84532,
      kernelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    };

    await builder.build(params);

    // Verify EAS attestation was created with correct recipient
    expect(mockEAS.attest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipient: consumerAddress
        })
      })
    );
  });
});
