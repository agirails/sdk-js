/**
 * MessageSigner Security Test Suite
 *
 * CRITICAL: EIP-712 signature security is essential for message integrity
 * Coverage Target: 100% (security-critical code)
 *
 * Security Test Categories:
 * 1. Domain Initialization Security (2 tests)
 * 2. Signature Tampering Detection (3 tests)
 * 3. Message Integrity Protection (3 tests)
 * 4. DID/Address Validation (2 tests)
 *
 * Attack Vectors Tested:
 * - Signature forgery
 * - Message payload tampering
 * - Cross-contract signature replay
 * - DID injection attacks
 *
 * References:
 * - MessageSigner.ts implementation
 * - EIP-712 specification
 * - V4 vulnerability (nonce replay)
 */

import { Wallet } from 'ethers';
import { MessageSigner } from '../../protocol/MessageSigner';
import { ACTPMessage } from '../../types';

// Test signers
const testPrivateKey1 = '0x' + '1'.repeat(64);
const testPrivateKey2 = '0x' + '2'.repeat(64);
const signer1 = new Wallet(testPrivateKey1);
const signer2 = new Wallet(testPrivateKey2);

const TEST_KERNEL_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('MessageSigner - Domain Initialization Security', () => {
  it('should prevent signing without domain initialization', async () => {
    const messageSigner = new MessageSigner(signer1);

    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    // Should throw when domain not initialized
    await expect(messageSigner.signMessage(message)).rejects.toThrow('Domain not initialized');
  });

  it('should initialize domain with correct chainId', async () => {
    const messageSigner = new MessageSigner(signer1);

    // Initialize with explicit chainId
    await messageSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);

    // Should not throw after initialization
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    const signature = await messageSigner.signMessage(message);
    expect(signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
  });
});

describe('MessageSigner - Signature Tampering Detection', () => {
  let messageSigner: MessageSigner;

  beforeAll(async () => {
    messageSigner = new MessageSigner(signer1);
    await messageSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);
  });

  it('should detect tampered message payload', async () => {
    const originalMessage: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { amount: '100', action: 'transfer' }
    };

    const signature = await messageSigner.signMessage(originalMessage);

    // Tamper with the message payload
    const tamperedMessage: ACTPMessage = {
      ...originalMessage,
      data: { amount: '1000000', action: 'transfer' } // Changed amount
    };

    // Verification should fail with tampered message
    const isValid = await messageSigner.verifySignature(tamperedMessage, signature);
    expect(isValid).toBe(false);
  });

  it('should detect invalid signature format', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    // Invalid signature (wrong length, wrong format)
    const invalidSignature = '0x' + '9'.repeat(130);

    // Invalid signature format will throw cryptographic error
    await expect(messageSigner.verifySignature(message, invalidSignature))
      .rejects.toThrow();
  });

  it('should throw SignatureVerificationError on invalid signature', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    const invalidSignature = '0x' + '0'.repeat(130);

    // Should throw error (either cryptographic error or SignatureVerificationError)
    await expect(messageSigner.verifySignatureOrThrow(message, invalidSignature))
      .rejects.toThrow();
  });
});

describe('MessageSigner - Message Integrity Protection', () => {
  let messageSigner: MessageSigner;

  beforeAll(async () => {
    messageSigner = new MessageSigner(signer1);
    await messageSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);
  });

  it('should verify valid signature', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    const signature = await messageSigner.signMessage(message);
    const isValid = await messageSigner.verifySignature(message, signature);

    expect(isValid).toBe(true);
  });

  it('should detect signature from wrong signer', async () => {
    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`, // Claims to be from signer1
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    // But sign with signer2
    const maliciousSigner = new MessageSigner(signer2);
    await maliciousSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);
    const maliciousSignature = await maliciousSigner.signMessage(message);

    // Verification should fail (signature doesn't match claimed 'from' address)
    const isValid = await messageSigner.verifySignature(message, maliciousSignature);
    expect(isValid).toBe(false);
  });

  it('should use canonical JSON encoding for payload', async () => {
    // Test that different JSON key ordering produces same signature
    const message1: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: 1234567890,
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { b: 'value2', a: 'value1' } // Keys in different order
    };

    const message2: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: 1234567890,
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { a: 'value1', b: 'value2' } // Same data, keys sorted
    };

    const signature1 = await messageSigner.signMessage(message1);
    const signature2 = await messageSigner.signMessage(message2);

    // Signatures should be identical due to canonical JSON encoding
    expect(signature1).toBe(signature2);
  });
});

describe('MessageSigner - DID/Address Validation', () => {
  it('should convert valid Ethereum address to DID', () => {
    const messageSigner = new MessageSigner(signer1);
    const address = '0x742d35cc6634c0532925a3b844bc9e7595f0beb0';

    const did = messageSigner.addressToDID(address);

    expect(did).toBe(`did:ethr:${address}`);
  });

  it('should reject invalid Ethereum address in addressToDID', () => {
    const messageSigner = new MessageSigner(signer1);
    const invalidAddress = 'not-an-address';

    expect(() => messageSigner.addressToDID(invalidAddress)).toThrow('Invalid Ethereum address');
  });

  it('should handle standard DID format', async () => {
    const messageSigner = new MessageSigner(signer1);
    await messageSigner.initDomain(TEST_KERNEL_ADDRESS, 84532);

    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    const signature = await messageSigner.signMessage(message);
    const isValid = await messageSigner.verifySignature(message, signature);

    expect(isValid).toBe(true);
  });

  it('should verify cross-contract signature isolation', async () => {
    // Sign message with domain 1 (kernel address 1)
    const messageSigner1 = new MessageSigner(signer1);
    await messageSigner1.initDomain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 84532);

    const message: ACTPMessage = {
      type: 'test.message',
      version: '1.0.0',
      from: `did:ethr:${signer1.address}`,
      to: `did:ethr:${signer2.address}`,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: '0x' + '0'.repeat(63) + '1', // bytes32
      data: { test: 'value' }
    };

    const signature = await messageSigner1.signMessage(message);

    // Try to verify with domain 2 (different kernel address)
    const messageSigner2 = new MessageSigner(signer1);
    await messageSigner2.initDomain('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 84532);

    const isValid = await messageSigner2.verifySignature(message, signature);

    // Should fail due to domain mismatch (prevents cross-contract replay)
    expect(isValid).toBe(false);
  });
});
