"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageSigner = void 0;
const ethers_1 = require("ethers");
const errors_1 = require("../errors");
const eip712_1 = require("../types/eip712");
/**
 * MessageSigner - Cryptographic signing for ACTP messages with EIP-712
 * Reference: Yellow Paper §11.4.2
 *
 * V4 Security Enhancement: Optional nonce replay protection via ReceivedNonceTracker
 *
 * IMPORTANT: Use MessageSigner.create() factory method to ensure domain is initialized.
 */
class MessageSigner {
    /**
     * Private constructor - use MessageSigner.create() factory method
     */
    constructor(signer, nonceTracker) {
        this.signer = signer;
        this.nonceTracker = nonceTracker;
        this.domain = null;
    }
    /**
     * SECURITY FIX (H-4): Factory method to create MessageSigner with guaranteed domain initialization
     *
     * This factory ensures the EIP-712 domain is always properly initialized before use.
     * Prevents the common bug of calling sign/verify without initializing domain first.
     *
     * @param signer - Ethers signer for signing messages
     * @param kernelAddress - Address of ACTP Kernel contract (for domain separation)
     * @param options - Optional configuration (chainId, nonceTracker)
     * @returns Promise resolving to initialized MessageSigner
     *
     * @example
     * ```typescript
     * const messageSigner = await MessageSigner.create(
     *   signer,
     *   KERNEL_ADDRESS,
     *   { chainId: 84532 }
     * );
     * const signature = await messageSigner.signMessage(message);
     * ```
     */
    static async create(signer, kernelAddress, options) {
        const messageSigner = new MessageSigner(signer, options?.nonceTracker);
        await messageSigner.initDomain(kernelAddress, options?.chainId);
        return messageSigner;
    }
    /**
     * Check if domain is initialized
     * @returns true if domain has been initialized
     */
    isDomainInitialized() {
        return this.domain !== null;
    }
    /**
     * Get the current domain (throws if not initialized)
     * @returns Current EIP-712 domain
     * @throws Error if domain not initialized
     */
    getDomain() {
        if (!this.domain) {
            throw new Error('Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.');
        }
        return this.domain;
    }
    /**
     * Initialize EIP-712 domain (must be called before signing)
     * @param kernelAddress - Address of ACTP Kernel contract
     * @param chainId - Optional chainId (defaults to signer's chainId or 84532 for Base Sepolia)
     */
    async initDomain(kernelAddress, chainId) {
        let resolvedChainId;
        if (chainId !== undefined) {
            resolvedChainId = chainId;
        }
        else {
            try {
                // ethers v6: signer.provider might be null, check first
                if (this.signer.provider) {
                    const network = await this.signer.provider.getNetwork();
                    resolvedChainId = Number(network.chainId);
                }
                else {
                    // Fallback to Base Sepolia for testing without provider
                    resolvedChainId = 84532;
                }
            }
            catch (error) {
                // Fallback to Base Sepolia for testing without provider
                resolvedChainId = 84532;
            }
        }
        // SECURITY FIX (H-6): Standardize domain name to 'AGIRAILS' for brand consistency
        // Note: This change requires coordination with any existing signed messages
        this.domain = {
            name: 'AGIRAILS',
            version: '1.0',
            chainId: resolvedChainId,
            verifyingContract: kernelAddress
        };
    }
    /**
     * Sign ACTP message using EIP-712 typed data
     * Uses ECDSA (secp256k1) with domain separation per Yellow Paper §11.4.2
     *
     * Generic ACTPMessage format (backward compatible).
     * For strict typed AIP messages, use signQuoteRequest/signQuoteResponse/signDeliveryProof
     */
    async signMessage(message) {
        if (!this.domain) {
            throw new Error('Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.');
        }
        const { type, version, from, to, timestamp, nonce, signature, ...payload } = message;
        // Generic ACTPMessage with payload encoding (backward compatible)
        const abiCoder = ethers_1.AbiCoder.defaultAbiCoder();
        const payloadBytes = abiCoder.encode(['string'], [this.canonicalizePayload(payload)]);
        const typedMessage = {
            type,
            version,
            from,
            to,
            timestamp,
            nonce,
            payload: payloadBytes
        };
        // Use generic ACTPMessage types
        const messageTypes = (0, eip712_1.getMessageTypes)('default');
        // Sign using EIP-712 (ethers v6 API)
        const signer = this.signer;
        const sig = await signer.signTypedData(this.domain, messageTypes, typedMessage);
        return sig;
    }
    /**
     * Sign typed QuoteRequest message
     */
    async signQuoteRequest(data) {
        if (!this.domain) {
            throw new Error('Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.');
        }
        const messageTypes = (0, eip712_1.getMessageTypes)('quote.request');
        const signer = this.signer;
        return await signer.signTypedData(this.domain, messageTypes, data);
    }
    /**
     * Sign typed QuoteResponse message
     */
    async signQuoteResponse(data) {
        if (!this.domain) {
            throw new Error('Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.');
        }
        const messageTypes = (0, eip712_1.getMessageTypes)('quote.response');
        const signer = this.signer;
        return await signer.signTypedData(this.domain, messageTypes, data);
    }
    /**
     * Sign typed DeliveryProof message
     */
    async signDeliveryProof(data) {
        if (!this.domain) {
            throw new Error('Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.');
        }
        const messageTypes = (0, eip712_1.getMessageTypes)('delivery.proof');
        const signer = this.signer;
        return await signer.signTypedData(this.domain, messageTypes, data);
    }
    /**
     * Convenience helper to sign a DeliveryProof generated by ProofGenerator
     */
    async signGeneratedDeliveryProof(proof) {
        const typedData = (0, eip712_1.deliveryProofDataFromProof)(proof);
        return await this.signDeliveryProof(typedData);
    }
    /**
     * Verify message signature using EIP-712
     * Uses generic ACTPMessage types (backward compatible)
     *
     * V4 Security: If nonceTracker is configured, validates nonce for replay protection
     */
    async verifySignature(message, signature) {
        if (!this.domain) {
            throw new Error('Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.');
        }
        const { type, version, from, to, timestamp, nonce, signature: _, ...payload } = message;
        const abiCoder = ethers_1.AbiCoder.defaultAbiCoder();
        const payloadBytes = abiCoder.encode(['string'], [this.canonicalizePayload(payload)]);
        const typedMessage = {
            type,
            version,
            from,
            to,
            timestamp,
            nonce,
            payload: payloadBytes
        };
        // Use generic ACTPMessage types (backward compatible)
        const messageTypes = (0, eip712_1.getMessageTypes)('default');
        const recoveredAddress = ethers_1.ethers.verifyTypedData(this.domain, messageTypes, typedMessage, signature);
        const expectedAddress = this.didToAddress(from);
        // Verify signature matches sender
        if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
            return false;
        }
        // V4 Security: Validate nonce for replay protection (if tracker configured)
        if (this.nonceTracker) {
            const nonceValidation = this.nonceTracker.validateAndRecord(from, type, nonce);
            if (!nonceValidation.valid) {
                // Nonce replay detected - return false
                return false;
            }
        }
        return true;
    }
    /**
     * Verify signature and throw if invalid
     * V4 Security: Throws specific error for nonce replay detection
     */
    async verifySignatureOrThrow(message, signature) {
        if (!this.domain) {
            throw new Error('Domain not initialized');
        }
        const { type, version, from, to, timestamp, nonce, signature: _, ...payload } = message;
        const abiCoder = ethers_1.AbiCoder.defaultAbiCoder();
        const payloadBytes = abiCoder.encode(['string'], [this.canonicalizePayload(payload)]);
        const typedMessage = { type, version, from, to, timestamp, nonce, payload: payloadBytes };
        const messageTypes = (0, eip712_1.getMessageTypes)('default');
        const recoveredAddress = ethers_1.ethers.verifyTypedData(this.domain, messageTypes, typedMessage, signature);
        const expectedAddress = this.didToAddress(from);
        // Check signature validity first
        if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
            throw new errors_1.SignatureVerificationError(expectedAddress, recoveredAddress);
        }
        // V4 Security: Validate nonce for replay protection (if tracker configured)
        if (this.nonceTracker) {
            const nonceValidation = this.nonceTracker.validateAndRecord(from, type, nonce);
            if (!nonceValidation.valid) {
                // Throw specific error for nonce replay
                throw new Error(`Nonce replay attack detected: ${nonceValidation.reason}. ` +
                    `Received nonce: ${nonceValidation.receivedNonce}. ` +
                    (nonceValidation.expectedMinimum ? `Expected minimum: ${nonceValidation.expectedMinimum}` : ''));
            }
        }
    }
    /**
     * Canonicalize payload to deterministic string (recursively sorted keys)
     * Prevents JSON serialization ambiguity across different JS runtimes
     * Recursively handles nested objects and arrays
     */
    canonicalizePayload(payload) {
        return JSON.stringify(this.recursiveSort(payload));
    }
    /**
     * Recursively sort object keys for deterministic JSON encoding
     */
    recursiveSort(obj) {
        if (obj === null || obj === undefined) {
            return obj;
        }
        // Handle arrays: recursively sort each element
        if (Array.isArray(obj)) {
            return obj.map((item) => this.recursiveSort(item));
        }
        // Handle objects: sort keys and recursively sort values
        if (typeof obj === 'object' && obj.constructor === Object) {
            const sortedKeys = Object.keys(obj).sort();
            const canonical = {};
            for (const key of sortedKeys) {
                canonical[key] = this.recursiveSort(obj[key]);
            }
            return canonical;
        }
        // Primitives (string, number, boolean)
        return obj;
    }
    /**
     * Convert DID to Ethereum address
     * MVP: Simple did:ethr → address conversion
     */
    didToAddress(did) {
        if (did.startsWith('did:ethr:')) {
            return did.replace('did:ethr:', '');
        }
        // If already an address, return as-is
        if (ethers_1.ethers.isAddress(did)) {
            return did;
        }
        throw new Error(`Invalid DID format: ${did}`);
    }
    /**
     * Convert Ethereum address to DID
     */
    addressToDID(address) {
        if (!ethers_1.ethers.isAddress(address)) {
            throw new Error(`Invalid Ethereum address: ${address}`);
        }
        return `did:ethr:${address}`;
    }
}
exports.MessageSigner = MessageSigner;
//# sourceMappingURL=MessageSigner.js.map