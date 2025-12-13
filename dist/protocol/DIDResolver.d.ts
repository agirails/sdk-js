import { DID, DIDResolutionResult, DIDResolverConfig, ParsedDID, VerifySignatureOptions, SignatureVerificationResult } from '../types/did';
/**
 * DIDResolver - Resolve DIDs to DID Documents (AIP-7 §2.2)
 *
 * Uses ethr-did-resolver library for resolution against AGIRAILS Identity Registry.
 * Supports did:ethr method with explicit chainId format: did:ethr:<chainId>:<address>
 *
 * @example
 * ```typescript
 * const resolver = await DIDResolver.create({ network: 'base-sepolia' });
 *
 * // Resolve DID to DID Document
 * const result = await resolver.resolve('did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb');
 * console.log(result.didDocument);
 *
 * // Verify signature
 * const isValid = await resolver.verifySignature(
 *   'did:ethr:84532:0x742d35cc...',
 *   'Hello AGIRAILS',
 *   '0x1234...',
 *   { chainId: 84532 }
 * );
 * ```
 *
 * @security
 * - Always validates DID format before resolution
 * - Checks chainId matches expected network
 * - Verifies signatures using ethers.js verifyMessage
 * - Prevents cross-chain replay attacks via chainId validation
 */
export declare class DIDResolver {
    private resolver;
    private config;
    /**
     * Private constructor - use DIDResolver.create() factory method
     */
    private constructor();
    /**
     * Factory method to create DIDResolver instance
     *
     * @param config - Configuration options
     * @returns Configured DIDResolver instance
     * @throws ValidationError if configuration is invalid
     *
     * @example
     * ```typescript
     * // Using predefined network
     * const resolver = await DIDResolver.create({ network: 'base-sepolia' });
     *
     * // Using custom RPC and registry
     * const resolver = await DIDResolver.create({
     *   chainId: 84532,
     *   rpcUrl: 'https://sepolia.base.org',
     *   registryAddress: '0x...'
     * });
     * ```
     */
    static create(config?: DIDResolverConfig): Promise<DIDResolver>;
    /**
     * Resolve configuration with defaults from network config
     */
    private static resolveConfig;
    /**
     * Validate configuration
     */
    private static validateConfig;
    /**
     * Get resolver configuration
     */
    getConfig(): Required<DIDResolverConfig>;
    /**
     * Resolve DID to DID Document
     *
     * @param did - DID to resolve (format: did:ethr:<chainId>:<address>)
     * @returns DID resolution result with document and metadata
     * @throws ValidationError if DID format is invalid
     *
     * @example
     * ```typescript
     * const result = await resolver.resolve('did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb');
     *
     * if (result.didDocument) {
     *   console.log('Identity owner:', result.didDocument.verificationMethod[0].controller);
     *   console.log('Service endpoints:', result.didDocument.service);
     * } else {
     *   console.error('Resolution failed:', result.didResolutionMetadata.error);
     * }
     * ```
     */
    resolve(did: DID): Promise<DIDResolutionResult>;
    /**
     * Verify a signature was made by DID controller or authorized delegate
     *
     * @param did - DID of expected signer
     * @param message - Original message that was signed
     * @param signature - Signature to verify (0x-prefixed hex string)
     * @param options - Verification options (chainId validation, domain separation, etc.)
     * @returns Verification result with validity and signer info
     *
     * @security
     * - Validates chainId to prevent cross-chain replay attacks
     * - Uses domain separation to prevent cross-protocol replay attacks (MEDIUM finding fix)
     * - Resolves DID to get current owner and delegates
     * - Checks if signer is owner or valid delegate (MEDIUM finding fix)
     * - Validates delegate expiration timestamps if provided
     *
     * @example
     * ```typescript
     * // With domain separation (recommended - default)
     * const result = await resolver.verifySignature(
     *   'did:ethr:84532:0x742d35cc...',
     *   'Hello AGIRAILS',
     *   '0x1234...',
     *   { chainId: 84532, useDomainSeparation: true }
     * );
     *
     * // Without domain separation (backwards compatibility only)
     * const legacyResult = await resolver.verifySignature(
     *   'did:ethr:84532:0x742d35cc...',
     *   'Hello AGIRAILS',
     *   '0x1234...',
     *   { chainId: 84532, useDomainSeparation: false }
     * );
     *
     * if (result.valid) {
     *   console.log('Signature is valid!');
     *   console.log('Signer:', result.signer);
     *   console.log('Is delegate:', result.isDelegate);
     *   if (result.isDelegate) {
     *     console.log('Delegate type:', result.delegateType);
     *   }
     * } else {
     *   console.error('Invalid signature:', result.error);
     * }
     * ```
     */
    verifySignature(did: DID, message: string, signature: string, options: VerifySignatureOptions): Promise<SignatureVerificationResult>;
    /**
     * Build DID from address and chainId
     *
     * @param address - Ethereum address (with or without 0x prefix)
     * @param chainId - Chain ID (e.g., 84532 for Base Sepolia)
     * @returns Canonical DID string (lowercase address)
     *
     * @example
     * ```typescript
     * const did = DIDResolver.buildDID('0x742d35cc6634c0532925a3b844bc9e7595f0beb', 84532);
     * // Returns: 'did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb'
     * ```
     */
    static buildDID(address: string, chainId: number): DID;
    /**
     * Parse DID to extract components
     *
     * @param did - DID to parse
     * @returns Parsed components
     * @throws ValidationError if DID format is invalid
     *
     * @example
     * ```typescript
     * const parsed = DIDResolver.parseDID('did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb');
     * console.log(parsed.method);   // 'ethr'
     * console.log(parsed.chainId);  // 84532
     * console.log(parsed.address);  // '0x742d35cc6634c0532925a3b844bc9e7595f0beb'
     * ```
     */
    static parseDID(did: DID): ParsedDID;
    /**
     * Validate DID format
     *
     * @param did - DID to validate
     * @returns True if valid, false otherwise
     */
    static isValidDID(did: DID): boolean;
    /**
     * Extract address from DID
     *
     * @param did - DID to extract from
     * @returns Ethereum address (lowercase)
     * @throws ValidationError if DID format is invalid
     */
    static extractAddress(did: DID): string;
    /**
     * Extract chainId from DID
     *
     * @param did - DID to extract from
     * @returns Chain ID
     * @throws ValidationError if DID format is invalid
     */
    static extractChainId(did: DID): number;
    /**
     * Create domain-separated message to prevent cross-protocol replay attacks
     *
     * @param message - Original message
     * @param chainId - Chain ID for domain separation
     * @param did - DID for additional context binding
     * @returns Domain-separated message
     *
     * @security
     * - Binds signature to AGIRAILS protocol
     * - Binds signature to specific chainId (prevents cross-chain replay)
     * - Binds signature to specific DID (prevents cross-identity replay)
     *
     * @example
     * ```typescript
     * const domainMsg = this.createDomainSeparatedMessage('Hello', 84532, 'did:ethr:84532:0x...');
     * // Returns: "AGIRAILS:84532:did:ethr:84532:0x...\nHello"
     * ```
     */
    private createDomainSeparatedMessage;
    /**
     * Extract Ethereum address from a verification method
     *
     * @param vm - Verification method from DID Document
     * @returns Ethereum address (checksummed) or null if not found
     *
     * @security
     * - Handles multiple address formats (blockchainAccountId, ethereumAddress, controller DID)
     * - Validates extracted address format
     * - Returns null instead of throwing for graceful error handling
     *
     * @example
     * ```typescript
     * const vm = {
     *   id: 'did:ethr:84532:0x123...#delegate1',
     *   type: 'EcdsaSecp256k1RecoveryMethod2020',
     *   controller: 'did:ethr:84532:0x123...',
     *   blockchainAccountId: '0x456...@eip155:84532'
     * };
     * const address = this.extractAddressFromVerificationMethod(vm);
     * // Returns: '0x456...' (checksummed)
     * ```
     */
    private extractAddressFromVerificationMethod;
}
//# sourceMappingURL=DIDResolver.d.ts.map