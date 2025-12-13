/**
 * QuoteBuilder - AIP-2 Price Quote Construction
 * Reference: AIP-2 §6.1
 *
 * Builds price quotes with:
 * - Amount validation (≥ originalAmount, ≤ maxPrice)
 * - EIP-712 signature
 * - Canonical JSON hashing
 * - Optional IPFS upload
 */
import { Signer } from 'ethers';
import { IPFSClient } from '../utils/IPFSClient';
import { NonceManager } from '../utils/NonceManager';
/**
 * Quote message interface (AIP-2)
 * Reference: AIP-2 §2.1
 */
export interface QuoteMessage {
    type: 'agirails.quote.v1';
    version: '1.0.0';
    txId: string;
    provider: string;
    consumer: string;
    quotedAmount: string;
    originalAmount: string;
    maxPrice: string;
    currency: string;
    decimals: number;
    quotedAt: number;
    expiresAt: number;
    justification?: {
        reason?: string;
        estimatedTime?: number;
        computeCost?: number;
        breakdown?: Record<string, any>;
    };
    chainId: number;
    nonce: number;
    signature: string;
}
/**
 * Quote build parameters
 * Reference: AIP-2 §6.1
 */
export interface QuoteParams {
    txId: string;
    provider: string;
    consumer: string;
    quotedAmount: string;
    originalAmount: string;
    maxPrice: string;
    currency?: string;
    decimals?: number;
    expiresAt?: number;
    justification?: {
        reason?: string;
        estimatedTime?: number;
        computeCost?: number;
        breakdown?: Record<string, any>;
    };
    chainId: number;
    kernelAddress: string;
}
/**
 * EIP-712 types for AIP-2 quote messages
 * Reference: AIP-2 §3.1
 */
export declare const AIP2QuoteTypes: {
    PriceQuote: {
        name: string;
        type: string;
    }[];
};
/**
 * QuoteBuilder - Main Builder Class
 * Reference: AIP-2 §6.1
 */
export declare class QuoteBuilder {
    private signer;
    private nonceManager;
    private ipfs?;
    constructor(signer: Signer, nonceManager: NonceManager, ipfs?: IPFSClient | undefined);
    /**
     * Build and sign a quote message
     * Reference: AIP-2 §4.1 (Provider workflow)
     *
     * @param params - Quote parameters
     * @returns Signed quote message
     */
    build(params: QuoteParams): Promise<QuoteMessage>;
    /**
     * Verify quote signature and business rules
     * Reference: AIP-2 §5.2, §5.3
     *
     * @param quote - Quote message to verify
     * @param kernelAddress - ACTPKernel contract address
     * @returns true if valid, throws error otherwise
     */
    verify(quote: QuoteMessage, kernelAddress: string): Promise<boolean>;
    /**
     * Upload quote to IPFS and return CID
     * Reference: AIP-2 §6 (optional IPFS storage)
     *
     * @param quote - Quote message
     * @returns IPFS CID
     */
    uploadToIPFS(quote: QuoteMessage): Promise<string>;
    /**
     * Compute quote hash (canonical JSON + keccak256)
     * Used for on-chain storage in transaction metadata
     * Reference: AIP-2 §4.1 (Step 6)
     *
     * @param quote - Quote message
     * @returns Keccak256 hash (0x-prefixed)
     */
    computeHash(quote: QuoteMessage): string;
    /**
     * Sign quote message with EIP-712
     * Reference: AIP-2 §3.1, §3.2
     *
     * @param quote - Quote message (unsigned)
     * @param kernelAddress - ACTPKernel contract address
     * @returns EIP-712 signature (0x-prefixed, 130 chars)
     */
    private signQuote;
    /**
     * Recover signer address from quote signature
     * Reference: AIP-2 §5.3
     *
     * @param quote - Quote message
     * @param kernelAddress - ACTPKernel contract address
     * @returns Recovered Ethereum address
     */
    private recoverQuoteSigner;
    /**
     * Compute justification hash for EIP-712 signature
     * Reference: AIP-2 §3.2
     *
     * @param justification - Optional justification object
     * @returns Keccak256 hash (0x-prefixed), or zero hash if omitted
     */
    private computeJustificationHash;
    /**
     * Validate quote parameters
     * Reference: AIP-2 §5.1, §5.2
     *
     * @param params - Quote parameters
     * @throws Error if validation fails
     */
    private validateParams;
    /**
     * Validate quote message schema
     * Reference: AIP-2 §2.1, §5.1
     *
     * @param quote - Quote message
     * @throws Error if validation fails
     */
    private validateQuoteSchema;
    /**
     * Extract Ethereum address from DID
     * Supports: did:ethr:0x... and did:ethr:84532:0x...
     * Reference: AIP-0 §2.1 (DID format)
     *
     * @param did - DID string
     * @returns Ethereum address (0x-prefixed)
     */
    private extractAddressFromDID;
}
//# sourceMappingURL=QuoteBuilder.d.ts.map