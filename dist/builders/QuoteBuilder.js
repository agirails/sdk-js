"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuoteBuilder = exports.AIP2QuoteTypes = void 0;
const ethers_1 = require("ethers");
const canonicalJson_1 = require("../utils/canonicalJson");
const errors_1 = require("../errors");
/**
 * EIP-712 types for AIP-2 quote messages
 * Reference: AIP-2 §3.1
 */
exports.AIP2QuoteTypes = {
    PriceQuote: [
        { name: 'txId', type: 'bytes32' },
        { name: 'provider', type: 'string' },
        { name: 'consumer', type: 'string' },
        { name: 'quotedAmount', type: 'string' },
        { name: 'originalAmount', type: 'string' },
        { name: 'maxPrice', type: 'string' },
        { name: 'currency', type: 'string' },
        { name: 'decimals', type: 'uint8' },
        { name: 'quotedAt', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
        { name: 'justificationHash', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }
    ]
};
/**
 * QuoteBuilder - Main Builder Class
 * Reference: AIP-2 §6.1
 */
class QuoteBuilder {
    constructor(signer, nonceManager, ipfs) {
        this.signer = signer;
        this.nonceManager = nonceManager;
        this.ipfs = ipfs;
    }
    /**
     * Build and sign a quote message
     * Reference: AIP-2 §4.1 (Provider workflow)
     *
     * @param params - Quote parameters
     * @returns Signed quote message
     */
    async build(params) {
        // Validate parameters
        this.validateParams(params);
        const quotedAt = Math.floor(Date.now() / 1000);
        const expiresAt = params.expiresAt || (quotedAt + 3600); // Default 1 hour
        // Validate expiry
        if (expiresAt <= quotedAt) {
            throw new Error('expiresAt must be after quotedAt');
        }
        if (expiresAt > quotedAt + 86400) {
            throw new Error('expiresAt cannot exceed 24 hours from quotedAt');
        }
        // Construct quote message (unsigned)
        const quote = {
            type: 'agirails.quote.v1',
            version: '1.0.0',
            txId: params.txId,
            provider: params.provider,
            consumer: params.consumer,
            quotedAmount: params.quotedAmount,
            originalAmount: params.originalAmount,
            maxPrice: params.maxPrice,
            currency: params.currency || 'USDC',
            decimals: params.decimals !== undefined ? params.decimals : 6,
            quotedAt,
            expiresAt,
            justification: params.justification,
            chainId: params.chainId,
            nonce: this.nonceManager.getNextNonce('agirails.quote.v1'),
            signature: '' // Filled in next step
        };
        // Sign with EIP-712
        const signature = await this.signQuote(quote, params.kernelAddress);
        quote.signature = signature;
        // Record nonce usage
        this.nonceManager.recordNonce('agirails.quote.v1', quote.nonce);
        return quote;
    }
    /**
     * Verify quote signature and business rules
     * Reference: AIP-2 §5.2, §5.3
     *
     * @param quote - Quote message to verify
     * @param kernelAddress - ACTPKernel contract address
     * @returns true if valid, throws error otherwise
     */
    async verify(quote, kernelAddress) {
        // 1. Validate schema
        this.validateQuoteSchema(quote);
        // 2. Verify signature
        const recoveredAddress = this.recoverQuoteSigner(quote, kernelAddress);
        const expectedAddress = this.extractAddressFromDID(quote.provider);
        if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
            throw new Error('Invalid signature: recovered address does not match provider');
        }
        // 3. Validate business rules
        const quotedAmount = BigInt(quote.quotedAmount);
        const originalAmount = BigInt(quote.originalAmount);
        const maxPrice = BigInt(quote.maxPrice);
        if (quotedAmount < originalAmount) {
            throw new Error('Quoted amount below original amount');
        }
        if (quotedAmount > maxPrice) {
            throw new Error('Quoted amount exceeds maxPrice');
        }
        // Platform minimum: $0.05 = 50000 base units (6 decimals)
        if (quotedAmount < 50000n) {
            throw new Error('Quoted amount below platform minimum ($0.05)');
        }
        // 4. Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (quote.expiresAt < now) {
            throw new Error('Quote expired');
        }
        // 5. Timestamp freshness check
        if (Math.abs(now - quote.quotedAt) > 300) {
            throw new Error('Quote timestamp outside 5-minute tolerance');
        }
        return true;
    }
    /**
     * Upload quote to IPFS and return CID
     * Reference: AIP-2 §6 (optional IPFS storage)
     *
     * @param quote - Quote message
     * @returns IPFS CID
     */
    async uploadToIPFS(quote) {
        if (!this.ipfs) {
            throw new Error('IPFS client not configured');
        }
        const cid = await this.ipfs.add(JSON.stringify(quote));
        await this.ipfs.pin(cid); // Pin for dispute window
        return cid;
    }
    /**
     * Compute quote hash (canonical JSON + keccak256)
     * Used for on-chain storage in transaction metadata
     * Reference: AIP-2 §4.1 (Step 6)
     *
     * @param quote - Quote message
     * @returns Keccak256 hash (0x-prefixed)
     */
    computeHash(quote) {
        // Remove signature field for hashing
        const { signature, ...quoteWithoutSig } = quote;
        return (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)((0, canonicalJson_1.canonicalJsonStringify)(quoteWithoutSig)));
    }
    /**
     * Sign quote message with EIP-712
     * Reference: AIP-2 §3.1, §3.2
     *
     * @param quote - Quote message (unsigned)
     * @param kernelAddress - ACTPKernel contract address
     * @returns EIP-712 signature (0x-prefixed, 130 chars)
     */
    async signQuote(quote, kernelAddress) {
        const domain = {
            name: 'AGIRAILS',
            version: '1',
            chainId: quote.chainId,
            verifyingContract: kernelAddress
        };
        // Compute justification hash
        const justificationHash = this.computeJustificationHash(quote.justification);
        const message = {
            txId: quote.txId,
            provider: quote.provider,
            consumer: quote.consumer,
            quotedAmount: quote.quotedAmount,
            originalAmount: quote.originalAmount,
            maxPrice: quote.maxPrice,
            currency: quote.currency,
            decimals: quote.decimals,
            quotedAt: quote.quotedAt,
            expiresAt: quote.expiresAt,
            justificationHash,
            chainId: quote.chainId,
            nonce: quote.nonce
        };
        // Sign using ethers.js signTypedData (v6 API)
        if ('signTypedData' in this.signer && typeof this.signer.signTypedData === 'function') {
            const signature = await this.signer.signTypedData(domain, exports.AIP2QuoteTypes, message);
            return signature;
        }
        throw new Error('Signer does not support EIP-712 typed data signing');
    }
    /**
     * Recover signer address from quote signature
     * Reference: AIP-2 §5.3
     *
     * @param quote - Quote message
     * @param kernelAddress - ACTPKernel contract address
     * @returns Recovered Ethereum address
     */
    recoverQuoteSigner(quote, kernelAddress) {
        const domain = {
            name: 'AGIRAILS',
            version: '1',
            chainId: quote.chainId,
            verifyingContract: kernelAddress
        };
        const justificationHash = this.computeJustificationHash(quote.justification);
        const message = {
            txId: quote.txId,
            provider: quote.provider,
            consumer: quote.consumer,
            quotedAmount: quote.quotedAmount,
            originalAmount: quote.originalAmount,
            maxPrice: quote.maxPrice,
            currency: quote.currency,
            decimals: quote.decimals,
            quotedAt: quote.quotedAt,
            expiresAt: quote.expiresAt,
            justificationHash,
            chainId: quote.chainId,
            nonce: quote.nonce
        };
        // Recover address using ethers.js verifyTypedData
        // Wrap in try-catch to handle low-level cryptographic errors gracefully
        try {
            const recoveredAddress = (0, ethers_1.verifyTypedData)(domain, exports.AIP2QuoteTypes, message, quote.signature);
            return recoveredAddress;
        }
        catch (error) {
            // Wrap low-level cryptographic errors in SignatureVerificationError
            throw new errors_1.SignatureVerificationError(quote.provider, 'unknown');
        }
    }
    /**
     * Compute justification hash for EIP-712 signature
     * Reference: AIP-2 §3.2
     *
     * @param justification - Optional justification object
     * @returns Keccak256 hash (0x-prefixed), or zero hash if omitted
     */
    computeJustificationHash(justification) {
        if (!justification || Object.keys(justification).length === 0) {
            return '0x0000000000000000000000000000000000000000000000000000000000000000';
        }
        return (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)((0, canonicalJson_1.canonicalJsonStringify)(justification)));
    }
    /**
     * Validate quote parameters
     * Reference: AIP-2 §5.1, §5.2
     *
     * @param params - Quote parameters
     * @throws Error if validation fails
     */
    validateParams(params) {
        // Amount validation
        const quotedAmount = BigInt(params.quotedAmount);
        const originalAmount = BigInt(params.originalAmount);
        const maxPrice = BigInt(params.maxPrice);
        if (quotedAmount < originalAmount) {
            throw new Error('quotedAmount must be >= originalAmount');
        }
        if (quotedAmount > maxPrice) {
            throw new Error('quotedAmount must be <= maxPrice');
        }
        // Platform minimum: $0.05 = 50000 base units (6 decimals)
        if (quotedAmount < 50000n) {
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
        // Kernel address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(params.kernelAddress)) {
            throw new Error('kernelAddress must be valid Ethereum address');
        }
        // ChainId validation
        if (params.chainId !== 84532 && params.chainId !== 8453) {
            throw new Error('chainId must be 84532 (Base Sepolia) or 8453 (Base Mainnet)');
        }
    }
    /**
     * Validate quote message schema
     * Reference: AIP-2 §2.1, §5.1
     *
     * @param quote - Quote message
     * @throws Error if validation fails
     */
    validateQuoteSchema(quote) {
        if (quote.type !== 'agirails.quote.v1') {
            throw new Error('Invalid message type');
        }
        if (!/^\d+\.\d+\.\d+$/.test(quote.version)) {
            throw new Error('Invalid version format');
        }
        if (!/^0x[a-fA-F0-9]{64}$/.test(quote.txId)) {
            throw new Error('Invalid txId format');
        }
        if (!quote.provider.startsWith('did:ethr:')) {
            throw new Error('Invalid provider DID format');
        }
        if (!quote.consumer.startsWith('did:ethr:')) {
            throw new Error('Invalid consumer DID format');
        }
        if (!/^\d+$/.test(quote.quotedAmount)) {
            throw new Error('Invalid quotedAmount format (must be numeric string)');
        }
        if (!/^\d+$/.test(quote.originalAmount)) {
            throw new Error('Invalid originalAmount format (must be numeric string)');
        }
        if (!/^\d+$/.test(quote.maxPrice)) {
            throw new Error('Invalid maxPrice format (must be numeric string)');
        }
        if (quote.currency !== 'USDC') {
            throw new Error('Only USDC currency is supported');
        }
        if (quote.decimals !== 6) {
            throw new Error('USDC must use 6 decimals');
        }
        if (quote.chainId !== 84532 && quote.chainId !== 8453) {
            throw new Error('Invalid chainId');
        }
        if (!/^0x[a-fA-F0-9]{130}$/.test(quote.signature)) {
            throw new Error('Invalid signature format');
        }
    }
    /**
     * Extract Ethereum address from DID
     * Supports: did:ethr:0x... and did:ethr:84532:0x...
     * Reference: AIP-0 §2.1 (DID format)
     *
     * @param did - DID string
     * @returns Ethereum address (0x-prefixed)
     */
    extractAddressFromDID(did) {
        const parts = did.replace('did:ethr:', '').split(':');
        const address = parts.length === 2 ? parts[1] : parts[0];
        if (!address.startsWith('0x') || address.length !== 42) {
            throw new Error(`Invalid DID format: ${did}`);
        }
        return address;
    }
}
exports.QuoteBuilder = QuoteBuilder;
//# sourceMappingURL=QuoteBuilder.js.map