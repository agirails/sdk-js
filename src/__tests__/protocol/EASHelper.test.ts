/**
 * EASHelper Test Suite
 *
 * Coverage Target: 80%+ (statements, functions, lines, branches)
 *
 * Test Categories:
 * 1. Attestation Creation (3 tests)
 * 2. Attestation Revocation (2 tests)
 * 3. Attestation Retrieval (3 tests)
 *
 * References:
 * - EASHelper.ts implementation
 * - Ethereum Attestation Service integration
 */

import { Wallet, BigNumber, utils } from 'ethers';
import { EASHelper } from '../../protocol/EASHelper';
import { DeliveryProof } from '../../types';

// Test signer
const testPrivateKey = '0x' + '1'.repeat(64);
const testSigner = new Wallet(testPrivateKey);

// Mock EAS contract
const mockEASContract = {
  attest: jest.fn(),
  revoke: jest.fn(),
  getAttestation: jest.fn()
};

// Mock Contract constructor
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => mockEASContract)
  };
});

// Test delivery proof
const testDeliveryProof: DeliveryProof = {
  type: 'delivery.proof',
  txId: '0x' + '1'.repeat(64),
  contentHash: '0x' + '2'.repeat(64),
  timestamp: Math.floor(Date.now() / 1000),
  deliveryUrl: 'ipfs://QmTest123',
  metadata: {
    size: 1024,
    mimeType: 'application/json'
  }
};

// Test EAS config
const testConfig = {
  contractAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  deliveryProofSchemaId: '0x' + '3'.repeat(64)
};

describe('EASHelper - Attestation Creation', () => {
  let easHelper: EASHelper;

  beforeEach(() => {
    jest.clearAllMocks();
    easHelper = new EASHelper(testSigner, testConfig);
  });

  it('should create attestation with default options', async () => {
    const recipientAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';
    const mockAttestationUID = '0x' + '4'.repeat(64);
    const mockTxHash = '0x' + '5'.repeat(64);

    mockEASContract.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        transactionHash: mockTxHash,
        events: [
          {
            event: 'Attested',
            args: {
              uid: mockAttestationUID,
              attester: testSigner.address,
              schema: testConfig.deliveryProofSchemaId
            }
          }
        ]
      })
    });

    const result = await easHelper.attestDeliveryProof(testDeliveryProof, recipientAddress);

    expect(mockEASContract.attest).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: testConfig.deliveryProofSchemaId,
        data: expect.objectContaining({
          recipient: recipientAddress,
          expirationTime: 0,
          revocable: true,
          refUID: testDeliveryProof.txId
        })
      })
    );

    expect(result).toEqual({
      uid: mockAttestationUID,
      transactionHash: mockTxHash
    });
  });

  it('should create attestation with custom options', async () => {
    const recipientAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';
    const mockAttestationUID = '0x' + '4'.repeat(64);
    const mockTxHash = '0x' + '5'.repeat(64);
    const customExpirationTime = Math.floor(Date.now() / 1000) + 86400; // 24 hours

    mockEASContract.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        transactionHash: mockTxHash,
        events: [
          {
            event: 'Attested',
            args: {
              uid: mockAttestationUID
            }
          }
        ]
      })
    });

    const result = await easHelper.attestDeliveryProof(
      testDeliveryProof,
      recipientAddress,
      {
        expirationTime: customExpirationTime,
        revocable: false
      }
    );

    expect(mockEASContract.attest).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: testConfig.deliveryProofSchemaId,
        data: expect.objectContaining({
          recipient: recipientAddress,
          expirationTime: customExpirationTime,
          revocable: false,
          refUID: testDeliveryProof.txId
        })
      })
    );

    expect(result.uid).toBe(mockAttestationUID);
    expect(result.transactionHash).toBe(mockTxHash);
  });

  it('should handle attestation creation with missing event', async () => {
    const recipientAddress = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';
    const mockTxHash = '0x' + '5'.repeat(64);

    // Mock response with no Attested event (edge case)
    mockEASContract.attest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        transactionHash: mockTxHash,
        events: [] // No events
      })
    });

    const result = await easHelper.attestDeliveryProof(testDeliveryProof, recipientAddress);

    expect(result.uid).toBe(utils.hexZeroPad('0x0', 32));
    expect(result.transactionHash).toBe(mockTxHash);
  });
});

describe('EASHelper - Attestation Revocation', () => {
  let easHelper: EASHelper;

  beforeEach(() => {
    jest.clearAllMocks();
    easHelper = new EASHelper(testSigner, testConfig);
  });

  it('should revoke attestation successfully', async () => {
    const attestationUID = '0x' + '4'.repeat(64);
    const mockTxHash = '0x' + '6'.repeat(64);

    mockEASContract.revoke.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        transactionHash: mockTxHash
      })
    });

    const result = await easHelper.revokeAttestation(attestationUID);

    expect(mockEASContract.revoke).toHaveBeenCalledWith({
      schema: testConfig.deliveryProofSchemaId,
      uid: attestationUID
    });

    expect(result).toBe(mockTxHash);
  });

  it('should handle revocation errors', async () => {
    const attestationUID = '0x' + '4'.repeat(64);

    mockEASContract.revoke.mockRejectedValue(new Error('Attestation not found'));

    await expect(easHelper.revokeAttestation(attestationUID)).rejects.toThrow('Attestation not found');

    expect(mockEASContract.revoke).toHaveBeenCalledWith({
      schema: testConfig.deliveryProofSchemaId,
      uid: attestationUID
    });
  });
});

describe('EASHelper - Attestation Retrieval', () => {
  let easHelper: EASHelper;

  beforeEach(() => {
    jest.clearAllMocks();
    easHelper = new EASHelper(testSigner, testConfig);
  });

  it('should get attestation data', async () => {
    const attestationUID = '0x' + '4'.repeat(64);
    const mockAttestationData = {
      uid: attestationUID,
      schema: testConfig.deliveryProofSchemaId,
      recipient: '0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      attester: testSigner.address,
      time: BigNumber.from(Math.floor(Date.now() / 1000)),
      expirationTime: BigNumber.from(0),
      revocable: true,
      refUID: testDeliveryProof.txId,
      data: '0x',
      bump: 0
    };

    mockEASContract.getAttestation.mockResolvedValue(mockAttestationData);

    const result = await easHelper.getAttestation(attestationUID);

    expect(mockEASContract.getAttestation).toHaveBeenCalledWith(attestationUID);
    expect(result).toEqual(mockAttestationData);
  });

  it('should handle non-existent attestation', async () => {
    const attestationUID = '0x' + '4'.repeat(64);

    mockEASContract.getAttestation.mockResolvedValue(null);

    const result = await easHelper.getAttestation(attestationUID);

    expect(result).toBeNull();
  });

  it('should verify attestation structure', async () => {
    const attestationUID = '0x' + '4'.repeat(64);
    const mockAttestationData = {
      uid: attestationUID,
      schema: testConfig.deliveryProofSchemaId,
      recipient: '0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
      attester: testSigner.address,
      time: BigNumber.from(Math.floor(Date.now() / 1000)),
      expirationTime: BigNumber.from(0),
      revocable: true,
      refUID: testDeliveryProof.txId,
      data: '0x',
      bump: 0
    };

    mockEASContract.getAttestation.mockResolvedValue(mockAttestationData);

    const result = await easHelper.getAttestation(attestationUID);

    expect(result).toHaveProperty('uid');
    expect(result).toHaveProperty('schema');
    expect(result).toHaveProperty('recipient');
    expect(result).toHaveProperty('attester');
    expect(result).toHaveProperty('time');
    expect(result).toHaveProperty('expirationTime');
    expect(result).toHaveProperty('revocable');
    expect(result).toHaveProperty('refUID');
    expect(result).toHaveProperty('data');
  });
});
