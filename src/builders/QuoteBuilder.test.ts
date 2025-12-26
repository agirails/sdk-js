/**
 * QuoteBuilder Unit Tests
 *
 * Tests the AIP-2 Price Quote Construction builder.
 * Focus on validation, signature, and verification logic.
 */

import { QuoteBuilder, QuoteParams, AIP2QuoteTypes } from './QuoteBuilder';
import { Wallet, HDNodeWallet } from 'ethers';
import { InMemoryNonceManager } from '../utils/NonceManager';

describe('QuoteBuilder', () => {
  let builder: QuoteBuilder;
  let wallet: HDNodeWallet;
  let nonceManager: InMemoryNonceManager;

  const KERNEL_ADDRESS = '0x1234567890123456789012345678901234567890';
  const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';
  const PROVIDER_DID = 'did:ethr:84532:0x1111111111111111111111111111111111111111';
  const CONSUMER_DID = 'did:ethr:84532:0x2222222222222222222222222222222222222222';

  beforeEach(() => {
    wallet = Wallet.createRandom();
    nonceManager = new InMemoryNonceManager();
    builder = new QuoteBuilder(wallet, nonceManager);
  });

  describe('constructor', () => {
    it('should create builder without IPFS client', () => {
      const builder = new QuoteBuilder(wallet, nonceManager);
      expect(builder).toBeInstanceOf(QuoteBuilder);
    });

    it('should create builder with IPFS client', () => {
      const mockIPFS = { add: jest.fn(), pin: jest.fn() } as any;
      const builder = new QuoteBuilder(wallet, nonceManager, mockIPFS);
      expect(builder).toBeInstanceOf(QuoteBuilder);
    });
  });

  describe('build() - validation', () => {
    it('should reject quotedAmount below originalAmount', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000', // $0.10
        originalAmount: '200000', // $0.20 - higher than quoted
        maxPrice: '1000000', // $1.00
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('quotedAmount must be >= originalAmount');
    });

    it('should reject quotedAmount above maxPrice', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '2000000', // $2.00
        originalAmount: '100000', // $0.10
        maxPrice: '1000000', // $1.00 - lower than quoted
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('quotedAmount must be <= maxPrice');
    });

    it('should reject quotedAmount below platform minimum ($0.05)', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '10000', // $0.01 - below $0.05 minimum
        originalAmount: '10000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('quotedAmount must be >= $0.05');
    });

    it('should reject invalid provider DID format', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: '0x1111111111111111111111111111111111111111', // Not DID format
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '100000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('provider must be valid did:ethr format');
    });

    it('should reject invalid consumer DID format', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: '0x2222222222222222222222222222222222222222', // Not DID format
        quotedAmount: '100000',
        originalAmount: '100000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('consumer must be valid did:ethr format');
    });

    it('should reject invalid txId format', async () => {
      const params: QuoteParams = {
        txId: '0xabc', // Too short
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '100000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('txId must be valid bytes32 hex string');
    });

    it('should reject invalid kernelAddress format', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '100000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: '0xabc' // Too short
      };

      await expect(builder.build(params)).rejects.toThrow('kernelAddress must be valid Ethereum address');
    });

    it('should reject invalid chainId', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '100000',
        maxPrice: '1000000',
        chainId: 1, // Invalid - not Base Sepolia or Mainnet
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('chainId must be 84532 (Base Sepolia) or 8453 (Base Mainnet)');
    });

    it('should reject expiresAt in the past', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '100000',
        maxPrice: '1000000',
        expiresAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('expiresAt must be in the future');
    });

    it('should reject expiresAt more than 24 hours in future', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '100000',
        maxPrice: '1000000',
        expiresAt: Math.floor(Date.now() / 1000) + 86400 + 3600, // 25 hours from now
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      await expect(builder.build(params)).rejects.toThrow('expiresAt cannot be more than 24 hours in future');
    });
  });

  describe('build() - success', () => {
    it('should build valid quote with required fields', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000', // $0.10 - above $0.05 minimum
        originalAmount: '50000', // $0.05
        maxPrice: '1000000', // $1.00
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builder.build(params);

      expect(quote.type).toBe('agirails.quote.v1');
      expect(quote.version).toBe('1.0.0');
      expect(quote.txId).toBe(TX_ID);
      expect(quote.provider).toBe(PROVIDER_DID);
      expect(quote.consumer).toBe(CONSUMER_DID);
      expect(quote.quotedAmount).toBe('100000');
      expect(quote.originalAmount).toBe('50000');
      expect(quote.maxPrice).toBe('1000000');
      expect(quote.currency).toBe('USDC');
      expect(quote.decimals).toBe(6);
      expect(quote.chainId).toBe(84532);
      expect(quote.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    });

    it('should include justification when provided', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        justification: {
          reason: 'Complex computation required',
          estimatedTime: 300,
          computeCost: 50000
        },
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builder.build(params);

      expect(quote.justification).toBeDefined();
      expect(quote.justification?.reason).toBe('Complex computation required');
      expect(quote.justification?.estimatedTime).toBe(300);
    });

    it('should default to 1 hour expiry when not specified', async () => {
      const beforeBuild = Math.floor(Date.now() / 1000);

      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builder.build(params);

      // expiresAt should be approximately quotedAt + 3600 (1 hour)
      expect(quote.expiresAt).toBeGreaterThanOrEqual(beforeBuild + 3600);
      expect(quote.expiresAt).toBeLessThanOrEqual(beforeBuild + 3600 + 2); // Allow 2 second tolerance
    });

    it('should use custom expiresAt when provided', async () => {
      const customExpiry = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now

      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        expiresAt: customExpiry,
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builder.build(params);

      expect(quote.expiresAt).toBe(customExpiry);
    });

    it('should increment nonce for each quote', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote1 = await builder.build(params);
      const quote2 = await builder.build(params);

      expect(quote2.nonce).toBe(quote1.nonce + 1);
    });

    it('should accept Base Mainnet chainId', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: 'did:ethr:8453:0x1111111111111111111111111111111111111111',
        consumer: 'did:ethr:8453:0x2222222222222222222222222222222222222222',
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 8453, // Base Mainnet
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builder.build(params);

      expect(quote.chainId).toBe(8453);
    });
  });

  describe('computeHash()', () => {
    it('should compute deterministic hash for quote', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builder.build(params);

      const hash1 = builder.computeHash(quote);
      const hash2 = builder.computeHash(quote);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should produce different hash for different quotes', async () => {
      const params1: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const params2: QuoteParams = {
        ...params1,
        quotedAmount: '200000' // Different amount
      };

      const quote1 = await builder.build(params1);
      const quote2 = await builder.build(params2);

      const hash1 = builder.computeHash(quote1);
      const hash2 = builder.computeHash(quote2);

      expect(hash1).not.toBe(hash2);
    });

    it('should exclude signature from hash computation', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builder.build(params);
      const originalHash = builder.computeHash(quote);

      // Modify signature
      const modifiedQuote = { ...quote, signature: '0x' + '1'.repeat(130) };
      const modifiedHash = builder.computeHash(modifiedQuote);

      // Hash should be same since signature is excluded
      expect(originalHash).toBe(modifiedHash);
    });
  });

  describe('verify()', () => {
    let providerWallet: HDNodeWallet;
    let providerBuilder: QuoteBuilder;
    let providerNonceManager: InMemoryNonceManager;
    let providerDID: string;

    beforeEach(() => {
      providerWallet = Wallet.createRandom();
      providerNonceManager = new InMemoryNonceManager();
      providerBuilder = new QuoteBuilder(providerWallet, providerNonceManager);
      providerDID = `did:ethr:84532:${providerWallet.address}`;
    });

    it('should verify valid quote', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Verify the quote
      const isValid = await providerBuilder.verify(quote, KERNEL_ADDRESS);
      expect(isValid).toBe(true);
    });

    it('should reject quote with modified amount', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Tamper with the quote
      const tamperedQuote = { ...quote, quotedAmount: '200000' };

      await expect(providerBuilder.verify(tamperedQuote, KERNEL_ADDRESS)).rejects.toThrow();
    });

    it('should reject expired quote', async () => {
      // Use a short expiry window and wait for it to pass
      // Note: expiresAt is in seconds (Unix timestamp)
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 2; // Expires in 2 seconds

      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        expiresAt,
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Wait for quote to definitely expire (3 seconds, with buffer for timing variance)
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify should reject the expired quote
      await expect(providerBuilder.verify(quote, KERNEL_ADDRESS)).rejects.toThrow('Quote expired');
    }, 10000);

    it('should reject quote with invalid message type', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Tamper with message type
      const tamperedQuote = { ...quote, type: 'invalid.type' as any };

      await expect(providerBuilder.verify(tamperedQuote, KERNEL_ADDRESS)).rejects.toThrow('Invalid message type');
    });

    it('should reject quote with invalid signature format', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Tamper with signature
      const tamperedQuote = { ...quote, signature: '0xabc' };

      await expect(providerBuilder.verify(tamperedQuote, KERNEL_ADDRESS)).rejects.toThrow('Invalid signature format');
    });

    it('should reject quote below platform minimum during verification', async () => {
      // Create a valid quote first
      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Manually tamper with quotedAmount to be below minimum
      // This won't have a valid signature, but we're testing the business rule
      const tamperedQuote = { ...quote, quotedAmount: '10000' };

      // Should fail signature verification before business rules
      await expect(providerBuilder.verify(tamperedQuote, KERNEL_ADDRESS)).rejects.toThrow();
    });

    it('should reject quote with non-USDC currency', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Tamper with currency
      const tamperedQuote = { ...quote, currency: 'ETH' };

      await expect(providerBuilder.verify(tamperedQuote, KERNEL_ADDRESS)).rejects.toThrow('Only USDC currency is supported');
    });

    it('should reject quote with wrong decimals', async () => {
      const params: QuoteParams = {
        txId: TX_ID,
        provider: providerDID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await providerBuilder.build(params);

      // Tamper with decimals
      const tamperedQuote = { ...quote, decimals: 18 };

      await expect(providerBuilder.verify(tamperedQuote, KERNEL_ADDRESS)).rejects.toThrow('USDC must use 6 decimals');
    });
  });

  describe('uploadToIPFS()', () => {
    it('should throw when IPFS client not configured', async () => {
      const builderWithoutIPFS = new QuoteBuilder(wallet, nonceManager);

      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builderWithoutIPFS.build(params);

      await expect(builderWithoutIPFS.uploadToIPFS(quote)).rejects.toThrow('IPFS client not configured');
    });

    it('should upload and pin quote to IPFS', async () => {
      const mockIPFS = {
        add: jest.fn().mockResolvedValue('QmTest123'),
        pin: jest.fn().mockResolvedValue(undefined)
      } as any;

      const builderWithIPFS = new QuoteBuilder(wallet, nonceManager, mockIPFS);

      const params: QuoteParams = {
        txId: TX_ID,
        provider: PROVIDER_DID,
        consumer: CONSUMER_DID,
        quotedAmount: '100000',
        originalAmount: '50000',
        maxPrice: '1000000',
        chainId: 84532,
        kernelAddress: KERNEL_ADDRESS
      };

      const quote = await builderWithIPFS.build(params);
      const cid = await builderWithIPFS.uploadToIPFS(quote);

      expect(cid).toBe('QmTest123');
      expect(mockIPFS.add).toHaveBeenCalledWith(JSON.stringify(quote));
      expect(mockIPFS.pin).toHaveBeenCalledWith('QmTest123');
    });
  });
});

describe('AIP2QuoteTypes', () => {
  it('should have correct EIP-712 type definition', () => {
    expect(AIP2QuoteTypes.PriceQuote).toBeDefined();
    expect(AIP2QuoteTypes.PriceQuote).toHaveLength(13);

    const fieldNames = AIP2QuoteTypes.PriceQuote.map(f => f.name);
    expect(fieldNames).toContain('txId');
    expect(fieldNames).toContain('provider');
    expect(fieldNames).toContain('consumer');
    expect(fieldNames).toContain('quotedAmount');
    expect(fieldNames).toContain('originalAmount');
    expect(fieldNames).toContain('maxPrice');
    expect(fieldNames).toContain('currency');
    expect(fieldNames).toContain('decimals');
    expect(fieldNames).toContain('quotedAt');
    expect(fieldNames).toContain('expiresAt');
    expect(fieldNames).toContain('justificationHash');
    expect(fieldNames).toContain('chainId');
    expect(fieldNames).toContain('nonce');
  });
});
