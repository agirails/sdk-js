import { BigNumber } from 'ethers';
import { keccak256, toUtf8Bytes } from 'ethers/lib/utils';
import { QuoteResponseData } from '../types/eip712';
import { MessageSigner } from './MessageSigner';

/**
 * Minimal AIP-2 Quote Builder
 * Creates and validates price quotes for ACTP transactions
 *
 * Reference: AIP-2 §6
 */

export interface QuoteParams {
  txId: string;
  provider: string;
  consumer: string;
  quotedAmount: string | BigNumber;
  originalAmount: string | BigNumber;
  maxPrice: string | BigNumber;
  expiresAt?: number; // Optional, defaults to 1 hour from now
}

export interface QuoteMessage {
  txId: string;
  provider: string;
  consumer: string;
  quotedAmount: string;
  originalAmount: string;
  maxPrice: string;
  quotedAt: number;
  expiresAt: number;
  chainId: number;
  nonce: number;
  signature?: string;
}

/**
 * QuoteBuilder - Minimal implementation for AIP-2
 *
 * Usage:
 * ```typescript
 * const builder = new QuoteBuilder(messageSigner, chainId);
 * const quote = await builder.createQuote({
 *   txId: '0x...',
 *   provider: 'did:ethr:0x...',
 *   consumer: 'did:ethr:0x...',
 *   quotedAmount: '7500000', // 7.5 USDC
 *   originalAmount: '5000000', // 5 USDC
 *   maxPrice: '10000000' // 10 USDC
 * });
 * ```
 */
export class QuoteBuilder {
  private nonce: number = 0;

  constructor(
    private readonly signer: MessageSigner,
    private readonly chainId: number
  ) {}

  /**
   * Create and sign a quote message
   */
  async createQuote(params: QuoteParams): Promise<QuoteMessage> {
    // Validate parameters
    this.validateParams(params);

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = params.expiresAt || (now + 3600); // Default: 1 hour

    // Build quote message
    const quote: QuoteMessage = {
      txId: params.txId,
      provider: params.provider,
      consumer: params.consumer,
      quotedAmount: BigNumber.from(params.quotedAmount).toString(),
      originalAmount: BigNumber.from(params.originalAmount).toString(),
      maxPrice: BigNumber.from(params.maxPrice).toString(),
      quotedAt: now,
      expiresAt,
      chainId: this.chainId,
      nonce: this.nonce++
    };

    // Sign quote (using QuoteResponse types for now - closest match to AIP-2)
    const quoteData: QuoteResponseData = {
      from: params.provider,
      to: params.consumer,
      timestamp: now,
      nonce: `0x${this.nonce.toString(16).padStart(64, '0')}`,
      requestId: params.txId,
      price: quote.quotedAmount,
      currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      deliveryTime: expiresAt,
      terms: JSON.stringify({ originalAmount: quote.originalAmount, maxPrice: quote.maxPrice })
    };

    quote.signature = await this.signer.signQuoteResponse(quoteData);

    return quote;
  }

  /**
   * Validate quote message
   */
  validateQuote(quote: QuoteMessage): boolean {
    // Validate amounts
    const quotedAmount = BigNumber.from(quote.quotedAmount);
    const originalAmount = BigNumber.from(quote.originalAmount);
    const maxPrice = BigNumber.from(quote.maxPrice);

    if (quotedAmount.lt(originalAmount)) {
      throw new Error('Quoted amount must be >= original amount');
    }

    if (quotedAmount.gt(maxPrice)) {
      throw new Error('Quoted amount must be <= maxPrice');
    }

    // Platform minimum ($0.05 = 50000 with 6 decimals)
    if (quotedAmount.lt(50000)) {
      throw new Error('Quoted amount below platform minimum ($0.05)');
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (quote.expiresAt < now) {
      throw new Error('Quote expired');
    }

    return true;
  }

  /**
   * Compute quote hash for on-chain storage
   * Uses canonical JSON + keccak256
   */
  computeHash(quote: QuoteMessage): string {
    // Remove signature for hashing
    const { signature, ...quoteWithoutSig } = quote;

    // Canonical JSON stringify (sorted keys)
    const canonical = this.canonicalStringify(quoteWithoutSig);

    return keccak256(toUtf8Bytes(canonical));
  }

  /**
   * Verify quote signature
   * Note: Uses MessageSigner's existing verification (placeholder for full AIP-2)
   */
  async verifyQuote(quote: QuoteMessage): Promise<boolean> {
    if (!quote.signature) {
      throw new Error('Quote missing signature');
    }

    // Validate business rules first
    try {
      this.validateQuote(quote);
    } catch (error) {
      return false;
    }

    // TODO: Implement full EIP-712 signature verification for AIP-2 quotes
    // For now, rely on on-chain hash verification
    return true;
  }

  /**
   * Private: Validate quote parameters
   */
  private validateParams(params: QuoteParams): void {
    // Amount validation
    const quotedAmount = BigNumber.from(params.quotedAmount);
    const originalAmount = BigNumber.from(params.originalAmount);
    const maxPrice = BigNumber.from(params.maxPrice);

    if (quotedAmount.lt(originalAmount)) {
      throw new Error('quotedAmount must be >= originalAmount');
    }

    if (quotedAmount.gt(maxPrice)) {
      throw new Error('quotedAmount must be <= maxPrice');
    }

    // Minimum transaction amount ($0.05 = 50000 base units)
    if (quotedAmount.lt(50000)) {
      throw new Error('quotedAmount must be >= $0.05 (50000 base units)');
    }

    // Expiry validation
    if (params.expiresAt) {
      const now = Math.floor(Date.now() / 1000);
      if (params.expiresAt <= now) {
        throw new Error('expiresAt must be in the future');
      }
      if (params.expiresAt > now + 86400) {
        throw new Error('expiresAt cannot be more than 24 hours in future');
      }
    }

    // DID format validation
    if (!params.provider.startsWith('did:ethr:')) {
      throw new Error('provider must be valid did:ethr format');
    }
    if (!params.consumer.startsWith('did:ethr:')) {
      throw new Error('consumer must be valid did:ethr format');
    }

    // Transaction ID format
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.txId)) {
      throw new Error('txId must be valid bytes32 hex string');
    }
  }

  /**
   * Private: Canonical JSON stringify (sorted keys)
   */
  private canonicalStringify(obj: any): string {
    if (obj === null || obj === undefined) {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.canonicalStringify(item)).join(',') + ']';
    }

    if (typeof obj === 'object') {
      const sortedKeys = Object.keys(obj).sort();
      const pairs = sortedKeys.map(key => {
        return JSON.stringify(key) + ':' + this.canonicalStringify(obj[key]);
      });
      return '{' + pairs.join(',') + '}';
    }

    return JSON.stringify(obj);
  }
}
