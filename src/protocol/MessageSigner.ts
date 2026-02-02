import { Signer, ethers, AbiCoder } from 'ethers';
import { ACTPMessage, DeliveryProof } from '../types';
import { SignatureVerificationError } from '../errors';
import {
  EIP712Domain,
  getMessageTypes,
  QuoteRequestData,
  QuoteResponseData,
  DeliveryProofData,
  deliveryProofDataFromProof
} from '../types/eip712';
import { IReceivedNonceTracker } from '../utils/ReceivedNonceTracker';
import { sdkLogger } from '../utils/Logger';

// Legacy generic ACTP message types moved to types/eip712.ts

/**
 * TypeScript interface for ethers v6 Signer with signTypedData method
 *
 * Note: ethers v6 uses signTypedData() (without underscore), not _signTypedData().
 * This interface properly types the method for v6 compatibility.
 */
interface SignerWithTypedData extends Signer {
  signTypedData(
    domain: EIP712Domain,
    types: Record<string, any>,
    value: Record<string, any>
  ): Promise<string>;
}

/**
 * MessageSigner - Cryptographic signing for ACTP messages with EIP-712
 * Reference: Yellow Paper §11.4.2
 *
 * V4 Security Enhancement: Optional nonce replay protection via ReceivedNonceTracker
 *
 * IMPORTANT: Use MessageSigner.create() factory method to ensure domain is initialized.
 */
export class MessageSigner {
  private domain: EIP712Domain | null = null;

  /**
   * SECURITY FIX (H-5): Private constructor - MUST use MessageSigner.create() factory method
   *
   * This ensures EIP-712 domain is ALWAYS initialized before use (prevents race conditions).
   * Direct construction would allow calling sign/verify without domain initialization.
   */
  private constructor(
    private readonly signer: Signer,
    private readonly nonceTracker?: IReceivedNonceTracker
  ) {}

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
  static async create(
    signer: Signer,
    kernelAddress: string,
    options?: {
      chainId?: number;
      nonceTracker?: IReceivedNonceTracker;
    }
  ): Promise<MessageSigner> {
    const messageSigner = new MessageSigner(signer, options?.nonceTracker);
    await messageSigner.initDomain(kernelAddress, options?.chainId);
    return messageSigner;
  }

  /**
   * Check if domain is initialized
   * @returns true if domain has been initialized
   */
  isDomainInitialized(): boolean {
    return this.domain !== null;
  }

  /**
   * Get the current domain (throws if not initialized)
   * @returns Current EIP-712 domain
   * @throws Error if domain not initialized
   */
  getDomain(): EIP712Domain {
    if (!this.domain) {
      throw new Error(
        'Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.'
      );
    }
    return this.domain;
  }

  /**
   * Initialize EIP-712 domain (must be called before signing)
   * @param kernelAddress - Address of ACTP Kernel contract
   * @param chainId - Optional chainId (defaults to signer's chainId or 84532 for Base Sepolia)
   */
  async initDomain(kernelAddress: string, chainId?: number): Promise<void> {
    let resolvedChainId: number;

    if (chainId !== undefined) {
      resolvedChainId = chainId;
    } else {
      try {
        // ethers v6: signer.provider might be null, check first
        if (this.signer.provider) {
          const network = await this.signer.provider.getNetwork();
          resolvedChainId = Number(network.chainId);
        } else {
          // Fallback to Base Sepolia for testing without provider
          resolvedChainId = 84532;
        }
      } catch (error) {
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
   * SECURITY FIX (H-3): Validates nonce format and warns about sequential nonces
   *
   * Generic ACTPMessage format (backward compatible).
   * For strict typed AIP messages, use signQuoteRequest/signQuoteResponse/signDeliveryProof
   */
  async signMessage(message: ACTPMessage): Promise<string> {
    if (!this.domain) {
      throw new Error(
        'Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.'
      );
    }

    const { type, version, from, to, timestamp, nonce, signature: _sig, ...payload } = message;

    // SECURITY FIX (H-3): Validate nonce format (must be bytes32)
    if (!nonce || !/^0x[a-fA-F0-9]{64}$/.test(nonce)) {
      throw new Error(
        `Invalid nonce format: "${nonce}". ` +
        `Nonce MUST be a bytes32 hex string (0x + 64 hex chars). ` +
        `Use SecureNonce.generateSecureNonce() to generate cryptographically secure nonces. ` +
        `Never use sequential integers (1, 2, 3...) or timestamps as nonces.`
      );
    }

    // SECURITY FIX (H-3): Warn about sequential nonces (low entropy)
    // Sequential nonces like 0x0000...0001, 0x0000...0002 are weak
    // Check if nonce has low entropy (e.g., last 8 bytes are zero, or all same digits)
    const nonceValue = BigInt(nonce);
    if (nonceValue < 0xFFFFFFFFn) {
      // Nonce is suspiciously small (< 4 billion = likely sequential)
      sdkLogger.warn('Nonce appears sequential - use SecureNonce.generateSecureNonce()', { nonce });
    }

    // Check if nonce has all same digits (e.g., 0x111...111 or 0x000...000)
    const hexDigits = nonce.slice(2); // Remove '0x'
    const firstDigit = hexDigits[0];
    if (hexDigits.split('').every(d => d === firstDigit)) {
      sdkLogger.warn('Nonce has low entropy - use SecureNonce.generateSecureNonce()', { nonce, repeatedDigit: firstDigit });
    }

    // Generic ACTPMessage with payload encoding (backward compatible)
    const abiCoder = AbiCoder.defaultAbiCoder();
    const payloadBytes = abiCoder.encode(
      ['string'],
      [this.canonicalizePayload(payload)]
    );

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
    const messageTypes = getMessageTypes('default');

    // Sign using EIP-712 (ethers v6 API)
    const signer = this.signer as SignerWithTypedData;
    const sig = await signer.signTypedData(this.domain, messageTypes, typedMessage);

    return sig;
  }

  /**
   * Sign typed QuoteRequest message
   */
  async signQuoteRequest(data: QuoteRequestData): Promise<string> {
    if (!this.domain) {
      throw new Error(
        'Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.'
      );
    }

    const messageTypes = getMessageTypes('quote.request');
    const signer = this.signer as SignerWithTypedData;
    return await signer.signTypedData(this.domain, messageTypes, data);
  }

  /**
   * Sign typed QuoteResponse message
   */
  async signQuoteResponse(data: QuoteResponseData): Promise<string> {
    if (!this.domain) {
      throw new Error(
        'Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.'
      );
    }

    const messageTypes = getMessageTypes('quote.response');
    const signer = this.signer as SignerWithTypedData;
    return await signer.signTypedData(this.domain, messageTypes, data);
  }

  /**
   * Sign typed DeliveryProof message
   */
  async signDeliveryProof(data: DeliveryProofData): Promise<string> {
    if (!this.domain) {
      throw new Error(
        'Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.'
      );
    }

    const messageTypes = getMessageTypes('delivery.proof');
    const signer = this.signer as SignerWithTypedData;
    return await signer.signTypedData(this.domain, messageTypes, data);
  }

  /**
   * Convenience helper to sign a DeliveryProof generated by ProofGenerator
   */
  async signGeneratedDeliveryProof(proof: DeliveryProof): Promise<string> {
    const typedData = deliveryProofDataFromProof(proof);
    return await this.signDeliveryProof(typedData);
  }

  /**
   * Verify message signature using EIP-712
   * Uses generic ACTPMessage types (backward compatible)
   *
   * V4 Security: If nonceTracker is configured, validates nonce for replay protection
   */
  async verifySignature(message: ACTPMessage, signature: string): Promise<boolean> {
    if (!this.domain) {
      throw new Error(
        'Domain not initialized. Use MessageSigner.create() factory or call initDomain() first.'
      );
    }

    const { type, version, from, to, timestamp, nonce, signature: _, ...payload } = message;

    const abiCoder = AbiCoder.defaultAbiCoder();
    const payloadBytes = abiCoder.encode(
      ['string'],
      [this.canonicalizePayload(payload)]
    );

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
    const messageTypes = getMessageTypes('default');
    const recoveredAddress = ethers.verifyTypedData(
      this.domain,
      messageTypes,
      typedMessage,
      signature
    );

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
  async verifySignatureOrThrow(message: ACTPMessage, signature: string): Promise<void> {
    if (!this.domain) {
      throw new Error('Domain not initialized');
    }

    const { type, version, from, to, timestamp, nonce, signature: _, ...payload } = message;

    const abiCoder = AbiCoder.defaultAbiCoder();
    const payloadBytes = abiCoder.encode(
      ['string'],
      [this.canonicalizePayload(payload)]
    );

    const typedMessage = { type, version, from, to, timestamp, nonce, payload: payloadBytes };

    const messageTypes = getMessageTypes('default');
    const recoveredAddress = ethers.verifyTypedData(
      this.domain,
      messageTypes,
      typedMessage,
      signature
    );

    const expectedAddress = this.didToAddress(from);

    // Check signature validity first
    if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new SignatureVerificationError(expectedAddress, recoveredAddress);
    }

    // V4 Security: Validate nonce for replay protection (if tracker configured)
    if (this.nonceTracker) {
      const nonceValidation = this.nonceTracker.validateAndRecord(from, type, nonce);
      if (!nonceValidation.valid) {
        // Throw specific error for nonce replay
        throw new Error(
          `Nonce replay attack detected: ${nonceValidation.reason}. ` +
          `Received nonce: ${nonceValidation.receivedNonce}. ` +
          (nonceValidation.expectedMinimum ? `Expected minimum: ${nonceValidation.expectedMinimum}` : '')
        );
      }
    }
  }

  /**
   * Canonicalize payload to deterministic string (recursively sorted keys)
   * Prevents JSON serialization ambiguity across different JS runtimes
   * Recursively handles nested objects and arrays
   */
  private canonicalizePayload(payload: Record<string, any>): string {
    return JSON.stringify(this.recursiveSort(payload));
  }

  /**
   * Recursively sort object keys for deterministic JSON encoding
   */
  private recursiveSort(obj: any): any {
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
      const canonical: Record<string, any> = {};

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
   *
   * SECURITY FIX (DID-FORMAT): Handles both DID formats:
   * - Legacy: did:ethr:<address>
   * - Canonical (EIP-3770): did:ethr:<chainId>:<address>
   *
   * Examples:
   * - "did:ethr:0x1234...abcd" → "0x1234...abcd"
   * - "did:ethr:84532:0x1234...abcd" → "0x1234...abcd"
   * - "0x1234...abcd" → "0x1234...abcd" (raw address passthrough)
   */
  private didToAddress(did: string): string {
    // Check for DID format first
    const DID_PREFIX = 'did:ethr:';
    if (did.startsWith(DID_PREFIX)) {
      const remainder = did.slice(DID_PREFIX.length);

      // Check if it's canonical format: did:ethr:<chainId>:<address>
      // chainId is numeric, address starts with 0x
      const parts = remainder.split(':');

      if (parts.length === 2) {
        // Canonical format: did:ethr:<chainId>:<address>
        const [chainIdStr, address] = parts;
        const chainId = parseInt(chainIdStr, 10);

        if (isNaN(chainId)) {
          throw new Error(
            `Invalid DID format: ${did}. ` +
            `Expected did:ethr:<chainId>:<address> but chainId "${chainIdStr}" is not a number.`
          );
        }

        if (!ethers.isAddress(address)) {
          throw new Error(
            `Invalid DID format: ${did}. ` +
            `Expected did:ethr:<chainId>:<address> but "${address}" is not a valid Ethereum address.`
          );
        }

        // SECURITY: Optionally validate chainId matches domain chainId
        // This prevents cross-chain replay attacks where a message signed for one chain
        // is replayed on another. For now, we just extract the address but log a warning.
        if (this.domain && this.domain.chainId !== chainId) {
          sdkLogger.warn('DID chainId mismatch - potential cross-chain replay attempt', {
            didChainId: chainId,
            domainChainId: this.domain.chainId,
            did,
          });
        }

        return address;
      } else if (parts.length === 1 && ethers.isAddress(parts[0])) {
        // Legacy format: did:ethr:<address>
        return parts[0];
      } else {
        throw new Error(
          `Invalid DID format: ${did}. ` +
          `Expected did:ethr:<address> or did:ethr:<chainId>:<address>.`
        );
      }
    }

    // If already an address (raw 0x format), return as-is
    if (ethers.isAddress(did)) {
      return did;
    }

    throw new Error(
      `Invalid DID format: ${did}. ` +
      `Expected Ethereum address (0x...) or DID (did:ethr:...).`
    );
  }

  /**
   * Convert Ethereum address to DID
   *
   * SECURITY FIX (DID-FORMAT): Now generates canonical DID format
   * with chainId when domain is initialized: did:ethr:<chainId>:<address>
   *
   * Falls back to legacy format if domain not initialized.
   */
  addressToDID(address: string): string {
    if (!ethers.isAddress(address)) {
      throw new Error(`Invalid Ethereum address: ${address}`);
    }

    // Use canonical format with chainId if domain is initialized
    if (this.domain && this.domain.chainId) {
      return `did:ethr:${this.domain.chainId}:${address}`;
    }

    // Fallback to legacy format (backward compatible)
    return `did:ethr:${address}`;
  }
}
