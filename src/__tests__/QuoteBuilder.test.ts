/**
 * QuoteBuilder Tests
 * Reference: AIP-2 §9 (Test Vectors), §10.2 (Validation Checklist)
 */

import { Wallet, parseUnits, HDNodeWallet } from 'ethers';
import { QuoteBuilder, QuoteParams, QuoteMessage } from '../builders/QuoteBuilder';
import { NonceManager, InMemoryNonceManager } from '../utils/NonceManager';
import { IPFSClient } from '../utils/IPFSClient';

describe('QuoteBuilder', () => {
  let quoteBuilder: QuoteBuilder;
  let signer: HDNodeWallet;
  let nonceManager: NonceManager;
  let mockIPFS: jest.Mocked<IPFSClient>;

  // Test constants
  const TEST_CHAIN_ID = 84532; // Base Sepolia
  const TEST_KERNEL_ADDRESS = '0x1234567890123456789012345678901234567890';
  const TEST_TX_ID = '0x7d87c3b8e23a5c9d1f4e6b2a8c5d9e3f1a7b4c6d8e2f5a3b9c1d7e4f6a8b2c5d';
  const PROVIDER_WALLET = Wallet.createRandom();
  const CONSUMER_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

  const PROVIDER_DID = `did:ethr:${TEST_CHAIN_ID}:${PROVIDER_WALLET.address}`;
  const CONSUMER_DID = `did:ethr:${TEST_CHAIN_ID}:${CONSUMER_ADDRESS}`;

  beforeEach(() => {
    signer = PROVIDER_WALLET;
    nonceManager = new InMemoryNonceManager();

    // Mock IPFS client
    mockIPFS = {
      add: jest.fn().mockResolvedValue('bafybeigtest123'),
      pin: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      unpin: jest.fn()
    } as any;

    quoteBuilder = new QuoteBuilder(signer, nonceManager, mockIPFS);
  });

  describe('build()', () => {
    it('should build valid quote with all required fields', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: parseUnits('7.5', 6).toString(), // $7.50
        originalAmount: parseUnits('5.0', 6).toString(), // $5.00
        maxPrice: parseUnits('10.0', 6).toString(), // $10.00
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);

      // Verify structure
      expect(quote.type).toBe('agirails.quote.v1');
      expect(quote.version).toBe('1.0.0');
      expect(quote.txId).toBe(TEST_TX_ID);
      expect(quote.provider).toBe(PROVIDER_DID);
      expect(quote.consumer).toBe(CONSUMER_DID);
      expect(quote.quotedAmount).toBe(params.quotedAmount);
      expect(quote.originalAmount).toBe(params.originalAmount);
      expect(quote.maxPrice).toBe(params.maxPrice);
      expect(quote.currency).toBe('USDC');
      expect(quote.decimals).toBe(6);
      expect(quote.chainId).toBe(TEST_CHAIN_ID);
      expect(quote.nonce).toBe(1);
      expect(quote.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);

      // Verify timestamps
      const now = Math.floor(Date.now() / 1000);
      expect(quote.quotedAt).toBeGreaterThanOrEqual(now - 5);
      expect(quote.quotedAt).toBeLessThanOrEqual(now + 5);
      expect(quote.expiresAt).toBe(quote.quotedAt + 3600); // Default 1 hour
    });

    it('should build quote with custom expiry', async () => {
      const customExpiry = Math.floor(Date.now() / 1000) + 7200; // 2 hours

      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        expiresAt: customExpiry,
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      expect(quote.expiresAt).toBe(customExpiry);
    });

    it('should build quote with justification', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        justification: {
          reason: 'Dataset size requires additional compute',
          estimatedTime: 300,
          computeCost: 2.5,
          breakdown: {
            basePrice: 5.0,
            additionalCompute: 2.5
          }
        },
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      expect(quote.justification).toEqual(params.justification);
    });

    it('should increment nonce for subsequent quotes', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote1 = await quoteBuilder.build(params);
      const quote2 = await quoteBuilder.build({ ...params, txId: TEST_TX_ID.replace('5d', '6e') });

      expect(quote1.nonce).toBe(1);
      expect(quote2.nonce).toBe(2);
    });
  });

  describe('build() - validation errors', () => {
    it('should reject quote below originalAmount', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '4000000', // $4.00 (below $5.00 original)
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('quotedAmount must be >= originalAmount');
    });

    it('should reject quote above maxPrice', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '11000000', // $11.00 (above $10.00 max)
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('quotedAmount must be <= maxPrice');
    });

    it('should reject quote below platform minimum ($0.05)', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '40000', // $0.04 (below $0.05 minimum)
        originalAmount: '30000',
        maxPrice: '100000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('quotedAmount must be >= $0.05');
    });

    it('should reject expiry in the past', async () => {
      const pastExpiry = Math.floor(Date.now() / 1000) - 3600;

      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        expiresAt: pastExpiry,
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('expiresAt must be in the future');
    });

    it('should reject expiry beyond 24 hours', async () => {
      const farFutureExpiry = Math.floor(Date.now() / 1000) + 86401; // 24h + 1 second

      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        expiresAt: farFutureExpiry,
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('expiresAt cannot be more than 24 hours');
    });

    it('should reject invalid provider DID format', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: 'invalid-did',
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('provider must be valid did:ethr format');
    });

    it('should reject invalid transaction ID format', async () => {
      const params: QuoteParams = {
        txId: '0xinvalid',
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('txId must be valid bytes32 hex string');
    });

    it('should reject invalid chainId', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: 1, // Ethereum mainnet (not supported)
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      await expect(quoteBuilder.build(params)).rejects.toThrow('chainId must be 84532 (Base Sepolia) or 8453 (Base Mainnet)');
    });
  });

  describe('verify()', () => {
    let validQuote: QuoteMessage;

    beforeEach(async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      validQuote = await quoteBuilder.build(params);
    });

    it('should verify valid quote', async () => {
      const result = await quoteBuilder.verify(validQuote, TEST_KERNEL_ADDRESS);
      expect(result).toBe(true);
    });

    it('should reject quote with tampered quotedAmount', async () => {
      const tamperedQuote = { ...validQuote, quotedAmount: '99999999' };

      await expect(quoteBuilder.verify(tamperedQuote, TEST_KERNEL_ADDRESS)).rejects.toThrow('Invalid signature');
    });

    it('should reject quote with invalid signature', async () => {
      const invalidQuote = {
        ...validQuote,
        signature: '0x' + '0'.repeat(130)
      };

      await expect(quoteBuilder.verify(invalidQuote, TEST_KERNEL_ADDRESS)).rejects.toThrow('Signature verification failed');
    });

    it('should reject expired quote', async () => {
      const expiredQuote = {
        ...validQuote,
        expiresAt: Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
      };

      // Need to rebuild with new expiry for valid signature
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        expiresAt: expiredQuote.expiresAt,
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      // Mock Date.now to make quote appear valid at build time
      const realDateNow = Date.now;
      Date.now = jest.fn(() => (expiredQuote.expiresAt - 1800) * 1000);

      const expiredButSignedQuote = await quoteBuilder.build(params);

      // Restore Date.now
      Date.now = realDateNow;

      await expect(quoteBuilder.verify(expiredButSignedQuote, TEST_KERNEL_ADDRESS)).rejects.toThrow('Quote expired');
    });
  });

  describe('computeHash()', () => {
    it('should compute deterministic hash', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      const hash1 = quoteBuilder.computeHash(quote);
      const hash2 = quoteBuilder.computeHash(quote);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should produce different hashes for different quotes', async () => {
      const params1: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const params2 = { ...params1, quotedAmount: '8000000' };

      const quote1 = await quoteBuilder.build(params1);
      const quote2 = await quoteBuilder.build(params2);

      const hash1 = quoteBuilder.computeHash(quote1);
      const hash2 = quoteBuilder.computeHash(quote2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('uploadToIPFS()', () => {
    it('should upload quote to IPFS and return CID', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      const cid = await quoteBuilder.uploadToIPFS(quote);

      expect(cid).toBe('bafybeigtest123');
      expect(mockIPFS.add).toHaveBeenCalledWith(JSON.stringify(quote));
      expect(mockIPFS.pin).toHaveBeenCalledWith(cid);
    });

    it('should throw error if IPFS client not configured', async () => {
      const builderWithoutIPFS = new QuoteBuilder(signer, nonceManager);

      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await builderWithoutIPFS.build(params);

      await expect(builderWithoutIPFS.uploadToIPFS(quote)).rejects.toThrow('IPFS client not configured');
    });
  });

  describe('Edge cases (AIP-2 §9.2)', () => {
    it('should accept quote at maxPrice boundary', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '10000000', // Exactly at maxPrice
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      expect(quote.quotedAmount).toBe('10000000');

      const result = await quoteBuilder.verify(quote, TEST_KERNEL_ADDRESS);
      expect(result).toBe(true);
    });

    it('should accept quote at platform minimum boundary ($0.05)', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '50000', // Exactly $0.05
        originalAmount: '50000',
        maxPrice: '100000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      const result = await quoteBuilder.verify(quote, TEST_KERNEL_ADDRESS);
      expect(result).toBe(true);
    });

    it('should accept quote expiring exactly at 24-hour limit', async () => {
      const exactExpiry = Math.floor(Date.now() / 1000) + 86400;

      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        expiresAt: exactExpiry,
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      expect(quote.expiresAt).toBe(exactExpiry);
    });

    it('should handle quote with empty justification', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        justification: {},
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      expect(quote.justification).toEqual({});
    });

    it('should handle quote with undefined justification', async () => {
      const params: QuoteParams = {
        txId: TEST_TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '7500000',
        originalAmount: '5000000',
        maxPrice: '10000000',
        chainId: TEST_CHAIN_ID,
        kernelAddress: TEST_KERNEL_ADDRESS
      };

      const quote = await quoteBuilder.build(params);
      expect(quote.justification).toBeUndefined();
    });
  });
});
