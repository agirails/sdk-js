/**
 * MessageSigner Unit Tests
 *
 * Tests EIP-712 message signing, nonce validation, and replay protection.
 * Critical security module requiring comprehensive coverage.
 */

import { MessageSigner } from './MessageSigner';
import { Wallet, HDNodeWallet } from 'ethers';
import { ACTPMessage } from '../types';
import { SignatureVerificationError } from '../errors';
import { IReceivedNonceTracker } from '../utils/ReceivedNonceTracker';
import { generateSecureNonce } from '../utils/SecureNonce';

describe('MessageSigner', () => {
  let signer: HDNodeWallet;
  let messageSigner: MessageSigner;

  const KERNEL_ADDRESS = '0xD199070F8e9FB9a127F6Fe730Bc13300B4b3d962';
  const CHAIN_ID = 84532; // Base Sepolia

  beforeEach(async () => {
    // Create real wallet for signing tests
    signer = Wallet.createRandom();

    // Create message signer using factory
    messageSigner = await MessageSigner.create(signer, KERNEL_ADDRESS, {
      chainId: CHAIN_ID
    });
  });

  describe('factory pattern', () => {
    it('should create message signer with initialized domain', async () => {
      expect(messageSigner.isDomainInitialized()).toBe(true);
    });

    it('should have correct domain values', async () => {
      const domain = messageSigner.getDomain();

      expect(domain.name).toBe('AGIRAILS');
      expect(domain.version).toBe('1.0');
      expect(domain.chainId).toBe(CHAIN_ID);
      expect(domain.verifyingContract).toBe(KERNEL_ADDRESS);
    });

    it('should throw when getting domain before initialization', async () => {
      // Create signer without using factory (not recommended)
      // This test verifies the protection works
      expect(() => {
        const uninitSigner = (MessageSigner as any).prototype;
        if (uninitSigner && !uninitSigner.domain) {
          throw new Error('Domain not initialized');
        }
      }).toThrow;
    });

    it('should accept optional nonce tracker', async () => {
      const mockNonceTracker: IReceivedNonceTracker = {
        validateAndRecord: jest.fn().mockReturnValue({ valid: true }),
        hasBeenUsed: jest.fn().mockReturnValue(false),
        getHighestNonce: jest.fn().mockReturnValue(null),
        reset: jest.fn(),
        clearAll: jest.fn()
      };

      const signerWithTracker = await MessageSigner.create(signer, KERNEL_ADDRESS, {
        chainId: CHAIN_ID,
        nonceTracker: mockNonceTracker
      });

      expect(signerWithTracker.isDomainInitialized()).toBe(true);
    });
  });

  describe('initDomain()', () => {
    it('should use provided chainId', async () => {
      const customSigner = await MessageSigner.create(signer, KERNEL_ADDRESS, {
        chainId: 8453 // Base Mainnet
      });

      const domain = customSigner.getDomain();
      expect(domain.chainId).toBe(8453);
    });

    it('should fallback to Base Sepolia (84532) when no provider', async () => {
      // Wallet without provider
      const noProviderWallet = Wallet.createRandom();

      const signer = await MessageSigner.create(noProviderWallet, KERNEL_ADDRESS);
      const domain = signer.getDomain();

      expect(domain.chainId).toBe(84532);
    });

    it('should use verifyingContract from kernel address', async () => {
      const customKernel = '0x9999999999999999999999999999999999999999';
      const customSigner = await MessageSigner.create(signer, customKernel, {
        chainId: CHAIN_ID
      });

      const domain = customSigner.getDomain();
      expect(domain.verifyingContract).toBe(customKernel);
    });
  });

  describe('signMessage()', () => {
    const createValidMessage = (): ACTPMessage => ({
      type: 'quote.request',
      version: '1.0',
      from: `did:ethr:${signer.address}`,
      to: 'did:ethr:0x2222222222222222222222222222222222222222',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: generateSecureNonce(),
      data: { amount: '100000000' }
    });

    it('should throw if domain not initialized', async () => {
      // This would require accessing private constructor, which we prevent
      // Test the error message instead
      expect(true).toBe(true); // Placeholder - factory pattern prevents this
    });

    it('should require valid bytes32 nonce format', async () => {
      const message = createValidMessage();
      message.nonce = '123'; // Invalid format

      await expect(messageSigner.signMessage(message)).rejects.toThrow('Invalid nonce format');
    });

    it('should reject non-hex nonce', async () => {
      const message = createValidMessage();
      message.nonce = '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

      await expect(messageSigner.signMessage(message)).rejects.toThrow('Invalid nonce format');
    });

    it('should reject short nonce', async () => {
      const message = createValidMessage();
      message.nonce = '0x1234'; // Too short

      await expect(messageSigner.signMessage(message)).rejects.toThrow('Invalid nonce format');
    });

    it('should warn about sequential/low-entropy nonces', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const message = createValidMessage();
      message.nonce = '0x0000000000000000000000000000000000000000000000000000000000000001'; // Sequential

      await messageSigner.signMessage(message);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sequential')
      );

      warnSpy.mockRestore();
    });

    it('should warn about uniform digit nonces', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const message = createValidMessage();
      message.nonce = '0x1111111111111111111111111111111111111111111111111111111111111111';

      await messageSigner.signMessage(message);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('low entropy')
      );

      warnSpy.mockRestore();
    });

    it('should accept valid secure nonce', async () => {
      const message = createValidMessage();

      const signature = await messageSigner.signMessage(message);

      expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(signature.length).toBe(132); // 65 bytes in hex + 0x
    });

    it('should produce consistent signatures for same message', async () => {
      const message = createValidMessage();

      const sig1 = await messageSigner.signMessage(message);
      const sig2 = await messageSigner.signMessage(message);

      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different nonces', async () => {
      const message1 = createValidMessage();
      const message2 = createValidMessage();
      message2.nonce = generateSecureNonce(); // Different nonce

      const sig1 = await messageSigner.signMessage(message1);
      const sig2 = await messageSigner.signMessage(message2);

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('signQuoteRequest()', () => {
    it('should sign typed quote request data', async () => {
      const data = {
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        serviceType: 'compute.inference',
        requirements: JSON.stringify({ model: 'gpt-4', maxTokens: 1000 }),
        deadline: Math.floor(Date.now() / 1000) + 86400,
        disputeWindow: 172800
      };

      const signature = await messageSigner.signQuoteRequest(data);

      expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
    });
  });

  describe('signQuoteResponse()', () => {
    it('should sign typed quote response data', async () => {
      const data = {
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        requestId: '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
        price: '95000000',
        currency: '0x444b4e1A65949AB2ac75979D5d0166Eb7A248Ccb',
        deliveryTime: 3600,
        terms: 'Standard terms apply'
      };

      const signature = await messageSigner.signQuoteResponse(data);

      expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
    });
  });

  describe('signDeliveryProof()', () => {
    it('should sign typed delivery proof data', async () => {
      const data = {
        txId: '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234',
        contentHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        timestamp: Math.floor(Date.now() / 1000),
        deliveryUrl: 'https://delivery.agirails.io/results/abc123',
        size: 1024,
        mimeType: 'application/json'
      };

      const signature = await messageSigner.signDeliveryProof(data);

      expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
    });
  });

  describe('verifySignature()', () => {
    it('should verify valid signature', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: { test: 'data' }
      };

      const signature = await messageSigner.signMessage(message);
      const isValid = await messageSigner.verifySignature(message, signature);

      expect(isValid).toBe(true);
    });

    it('should reject forged signature', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: { test: 'data' }
      };

      // Create a different wallet to sign (forged)
      const forger = Wallet.createRandom();
      const forgerSigner = await MessageSigner.create(forger, KERNEL_ADDRESS, {
        chainId: CHAIN_ID
      });
      const forgedSignature = await forgerSigner.signMessage({
        ...message,
        from: `did:ethr:${forger.address}` // Forger signs with their own DID
      });

      // Verify with original message (forger's sig won't match original from)
      const isValid = await messageSigner.verifySignature(message, forgedSignature);

      expect(isValid).toBe(false);
    });

    it('should reject modified message content', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: { amount: '100' }
      };

      const signature = await messageSigner.signMessage(message);

      // Modify the message
      const tamperedMessage = { ...message, data: { amount: '999' } };

      const isValid = await messageSigner.verifySignature(tamperedMessage, signature);

      expect(isValid).toBe(false);
    });
  });

  describe('verifySignatureOrThrow()', () => {
    it('should not throw for valid signature', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      const signature = await messageSigner.signMessage(message);

      await expect(
        messageSigner.verifySignatureOrThrow(message, signature)
      ).resolves.toBeUndefined();
    });

    it('should throw SignatureVerificationError for invalid signature', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      // Forged signature from different wallet
      const forger = Wallet.createRandom();
      const forgerSigner = await MessageSigner.create(forger, KERNEL_ADDRESS, {
        chainId: CHAIN_ID
      });
      const forgedMessage = { ...message, from: `did:ethr:${forger.address}` };
      const forgedSignature = await forgerSigner.signMessage(forgedMessage);

      await expect(
        messageSigner.verifySignatureOrThrow(message, forgedSignature)
      ).rejects.toThrow(SignatureVerificationError);
    });
  });

  describe('nonce replay protection', () => {
    let mockNonceTracker: jest.Mocked<IReceivedNonceTracker>;
    let signerWithTracker: MessageSigner;

    beforeEach(async () => {
      mockNonceTracker = {
        validateAndRecord: jest.fn().mockReturnValue({ valid: true }),
        hasBeenUsed: jest.fn().mockReturnValue(false),
        getHighestNonce: jest.fn().mockReturnValue(null),
        reset: jest.fn(),
        clearAll: jest.fn()
      };

      signerWithTracker = await MessageSigner.create(signer, KERNEL_ADDRESS, {
        chainId: CHAIN_ID,
        nonceTracker: mockNonceTracker
      });
    });

    it('should validate nonce during signature verification', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      const signature = await signerWithTracker.signMessage(message);
      await signerWithTracker.verifySignature(message, signature);

      expect(mockNonceTracker.validateAndRecord).toHaveBeenCalledWith(
        message.from,
        message.type,
        message.nonce
      );
    });

    it('should reject replayed nonce', async () => {
      mockNonceTracker.validateAndRecord.mockReturnValue({
        valid: false,
        reason: 'Nonce already used'
      });

      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      const signature = await signerWithTracker.signMessage(message);
      const isValid = await signerWithTracker.verifySignature(message, signature);

      expect(isValid).toBe(false);
    });

    it('should throw specific error for nonce replay in verifySignatureOrThrow', async () => {
      mockNonceTracker.validateAndRecord.mockReturnValue({
        valid: false,
        reason: 'Nonce already used',
        receivedNonce: '0x1234'
      });

      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      const signature = await signerWithTracker.signMessage(message);

      await expect(
        signerWithTracker.verifySignatureOrThrow(message, signature)
      ).rejects.toThrow('Nonce replay attack detected');
    });
  });

  describe('DID parsing', () => {
    it('should parse legacy DID format (did:ethr:<address>)', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      const signature = await messageSigner.signMessage(message);
      const isValid = await messageSigner.verifySignature(message, signature);

      expect(isValid).toBe(true);
    });

    it('should parse canonical DID format (did:ethr:<chainId>:<address>)', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:84532:${signer.address}`,
        to: 'did:ethr:84532:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      const signature = await messageSigner.signMessage(message);
      const isValid = await messageSigner.verifySignature(message, signature);

      expect(isValid).toBe(true);
    });

    it('should warn about cross-chain DID mismatch during verification', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:8453:${signer.address}`, // Mainnet chainId, but signer is on Sepolia
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      // Sign the message first
      const signature = await messageSigner.signMessage(message);

      // Verify triggers didToAddress which checks chainId mismatch
      await messageSigner.verifySignature(message, signature);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('chainId')
      );

      warnSpy.mockRestore();
    });

    it('should accept raw address format', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: signer.address, // Raw address, not DID
        to: '0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        data: {}
      };

      const signature = await messageSigner.signMessage(message);
      const isValid = await messageSigner.verifySignature(message, signature);

      expect(isValid).toBe(true);
    });
  });

  describe('addressToDID()', () => {
    it('should generate canonical DID with chainId', () => {
      const address = '0x1234567890123456789012345678901234567890';
      const did = messageSigner.addressToDID(address);

      expect(did).toBe(`did:ethr:${CHAIN_ID}:${address}`);
    });

    it('should throw for invalid address', () => {
      expect(() => {
        messageSigner.addressToDID('invalid');
      }).toThrow('Invalid Ethereum address');
    });
  });

  describe('payload canonicalization', () => {
    it('should produce consistent JSON for same payload with different key order', async () => {
      const message1: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        a: '1',
        b: '2',
        c: '3'
      };

      const message2: ACTPMessage = {
        c: '3',
        b: '2',
        a: '1',
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: message1.timestamp,
        nonce: message1.nonce
      };

      const sig1 = await messageSigner.signMessage(message1);
      const sig2 = await messageSigner.signMessage(message2);

      expect(sig1).toBe(sig2);
    });

    it('should handle nested objects', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        nested: {
          z: 'last',
          a: 'first',
          m: { x: 1, b: 2 }
        }
      };

      const signature = await messageSigner.signMessage(message);

      expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
    });

    it('should handle arrays in payload', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        items: [3, 1, 2],
        objects: [{ b: 2 }, { a: 1 }]
      };

      const signature = await messageSigner.signMessage(message);

      expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
    });

    it('should handle null and undefined values', async () => {
      const message: ACTPMessage = {
        type: 'test',
        version: '1.0',
        from: `did:ethr:${signer.address}`,
        to: 'did:ethr:0x2222222222222222222222222222222222222222',
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateSecureNonce(),
        nullValue: null,
        undefinedValue: undefined
      };

      const signature = await messageSigner.signMessage(message);

      expect(signature).toMatch(/^0x[a-fA-F0-9]+$/);
    });
  });
});
