import { verifyMessage, getAddress } from 'ethers';
// NOTE: These imports require npm packages to be installed:
// - did-resolver
// - ethr-did-resolver
import { Resolver } from 'did-resolver';
import { getResolver } from 'ethr-did-resolver';
import {
  DID,
  DIDResolutionResult,
  DIDResolverConfig,
  ParsedDID,
  VerifySignatureOptions,
  SignatureVerificationResult,
  VerificationMethod
} from '../types/did';
import { getNetwork } from '../config/networks';
import { ValidationError } from '../errors';

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
export class DIDResolver {
  private resolver!: Resolver;
  private config: Required<DIDResolverConfig>;

  /**
   * Private constructor - use DIDResolver.create() factory method
   */
  private constructor(config: Required<DIDResolverConfig>) {
    this.config = config;
  }

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
  static async create(config: DIDResolverConfig = {}): Promise<DIDResolver> {
    // Resolve configuration with defaults
    const resolvedConfig = DIDResolver.resolveConfig(config);

    // Validate configuration
    DIDResolver.validateConfig(resolvedConfig);

    // Initialize did-resolver with ethr-did-resolver
    const providerConfig = {
      networks: [
        {
          name: resolvedConfig.network || `chain-${resolvedConfig.chainId}`,
          chainId: `0x${resolvedConfig.chainId.toString(16)}`,
          rpcUrl: resolvedConfig.rpcUrl,
          registry: resolvedConfig.registryAddress
        }
      ]
    };

    const ethrResolver = getResolver(providerConfig);
    const resolver = new Resolver(ethrResolver);

    const instance = new DIDResolver(resolvedConfig);
    instance.resolver = resolver;

    return instance;
  }

  /**
   * Resolve configuration with defaults from network config
   */
  private static resolveConfig(config: DIDResolverConfig): Required<DIDResolverConfig> {
    // If network specified, use network defaults
    if (config.network) {
      const networkConfig = getNetwork(config.network);
      return {
        network: config.network,
        chainId: config.chainId || networkConfig.chainId,
        rpcUrl: config.rpcUrl || networkConfig.rpcUrl,
        registryAddress: config.registryAddress || networkConfig.contracts.identityRegistry || ''
      };
    }

    // Custom configuration (must provide all required fields)
    if (!config.chainId || !config.rpcUrl) {
      throw new ValidationError(
        'config',
        'Must provide either network name or (chainId + rpcUrl)'
      );
    }

    return {
      network: config.network || '',
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      registryAddress: config.registryAddress || ''
    };
  }

  /**
   * Validate configuration
   */
  private static validateConfig(config: Required<DIDResolverConfig>): void {
    if (!config.chainId || config.chainId <= 0) {
      throw new ValidationError('chainId', 'Invalid chainId');
    }

    if (!config.rpcUrl || !config.rpcUrl.startsWith('http')) {
      throw new ValidationError('rpcUrl', 'Invalid RPC URL');
    }

    // Registry address is optional (will use default if not provided)
    // But if provided, must be valid address
    if (config.registryAddress) {
      try {
        getAddress(config.registryAddress);
      } catch (error) {
        throw new ValidationError('registryAddress', 'Invalid registry address');
      }
    }
  }

  /**
   * Get resolver configuration
   */
  getConfig(): Required<DIDResolverConfig> {
    return { ...this.config };
  }

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
  async resolve(did: DID): Promise<DIDResolutionResult> {
    // Validate DID format
    const parsed = DIDResolver.parseDID(did);

    // Check chainId matches expected network
    if (parsed.chainId !== this.config.chainId) {
      return {
        didDocument: null,
        didResolutionMetadata: {
          error: 'invalidDid',
          message: `DID chainId ${parsed.chainId} does not match resolver chainId ${this.config.chainId}`
        },
        didDocumentMetadata: {}
      };
    }

    // Perform resolution using did-resolver
    const result = await this.resolver.resolve(did);
    return result as DIDResolutionResult;
  }

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
  async verifySignature(
    did: DID,
    message: string,
    signature: string,
    options: VerifySignatureOptions
  ): Promise<SignatureVerificationResult> {
    try {
      // Validate DID format
      const parsed = DIDResolver.parseDID(did);

      // Validate chainId matches
      if (parsed.chainId !== options.chainId) {
        return {
          valid: false,
          error: `DID chainId ${parsed.chainId} does not match expected chainId ${options.chainId}`
        };
      }

      // SECURITY FIX (MEDIUM): Domain separation to prevent cross-protocol replay attacks
      // Default to true for security, but allow opt-out for backwards compatibility
      const useDomainSeparation = options.useDomainSeparation !== false;
      const messageToVerify = useDomainSeparation
        ? this.createDomainSeparatedMessage(message, parsed.chainId, did)
        : message;

      // Recover signer from signature
      const recoveredAddress = verifyMessage(messageToVerify, signature);
      const signerLower = recoveredAddress.toLowerCase();
      const didAddressLower = parsed.address.toLowerCase();

      // Check if signer is the DID address itself (owner)
      if (signerLower === didAddressLower) {
        return {
          valid: true,
          signer: recoveredAddress,
          isDelegate: false
        };
      }

      // SECURITY FIX (MEDIUM): Implement delegate validation
      // Check if signer is a valid delegate in the DID Document
      const resolution = await this.resolve(did);
      if (resolution.didDocument && resolution.didDocument.authentication) {
        // Iterate through authentication methods to find valid delegates
        for (const auth of resolution.didDocument.authentication) {
          // auth can be a string (reference to verificationMethod) or VerificationMethod object
          const verificationMethod = typeof auth === 'string'
            ? resolution.didDocument.verificationMethod?.find(vm => vm.id === auth)
            : auth;

          if (verificationMethod) {
            // Extract delegate address from verification method
            const delegateAddress = this.extractAddressFromVerificationMethod(verificationMethod);

            if (delegateAddress && delegateAddress.toLowerCase() === signerLower) {
              // Check delegate validity if timestamp provided
              if (options.timestamp && verificationMethod.validTo) {
                const validToTimestamp = typeof verificationMethod.validTo === 'bigint'
                  ? Number(verificationMethod.validTo)
                  : verificationMethod.validTo;

                if (options.timestamp > validToTimestamp) {
                  return {
                    valid: false,
                    signer: recoveredAddress,
                    error: 'Delegate expired'
                  };
                }
              }

              return {
                valid: true,
                signer: recoveredAddress,
                isDelegate: true,
                delegateType: verificationMethod.type
              };
            }
          }
        }
      }

      // Signer is neither owner nor valid delegate
      return {
        valid: false,
        signer: recoveredAddress,
        error: 'Signer is not the DID controller or a valid delegate'
      };

    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Signature verification failed'
      };
    }
  }

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
  static buildDID(address: string, chainId: number): DID {
    // Validate and checksum address
    const checksummed = getAddress(address);

    // Convert to lowercase for canonical format (per AIP-7 §2.1)
    const canonical = checksummed.toLowerCase();

    return `did:ethr:${chainId}:${canonical}`;
  }

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
  static parseDID(did: DID): ParsedDID {
    // Validate basic format
    if (!did || typeof did !== 'string') {
      throw new ValidationError('did', 'DID must be a non-empty string');
    }

    // DID format: did:ethr:<chainId>:<address>
    const parts = did.split(':');

    if (parts.length !== 4) {
      throw new ValidationError(
        'did',
        'Invalid DID format. Expected: did:ethr:<chainId>:<address>'
      );
    }

    const [scheme, method, chainIdStr, address] = parts;

    // Validate scheme
    if (scheme !== 'did') {
      throw new ValidationError('did', `Invalid DID scheme: ${scheme}. Expected: did`);
    }

    // Validate method
    if (method !== 'ethr') {
      throw new ValidationError('did', `Invalid DID method: ${method}. Expected: ethr`);
    }

    // Validate chainId
    const chainId = parseInt(chainIdStr, 10);
    if (isNaN(chainId) || chainId <= 0) {
      throw new ValidationError('did', `Invalid chainId: ${chainIdStr}`);
    }

    // Validate address
    try {
      const checksummed = getAddress(address);
      return {
        method,
        chainId,
        address: checksummed.toLowerCase() // Canonical format per AIP-7
      };
    } catch (error) {
      throw new ValidationError('did', `Invalid Ethereum address: ${address}`);
    }
  }

  /**
   * Validate DID format
   *
   * @param did - DID to validate
   * @returns True if valid, false otherwise
   */
  static isValidDID(did: DID): boolean {
    try {
      DIDResolver.parseDID(did);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract address from DID
   *
   * @param did - DID to extract from
   * @returns Ethereum address (lowercase)
   * @throws ValidationError if DID format is invalid
   */
  static extractAddress(did: DID): string {
    const parsed = DIDResolver.parseDID(did);
    return parsed.address;
  }

  /**
   * Extract chainId from DID
   *
   * @param did - DID to extract from
   * @returns Chain ID
   * @throws ValidationError if DID format is invalid
   */
  static extractChainId(did: DID): number {
    const parsed = DIDResolver.parseDID(did);
    return parsed.chainId;
  }

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
  private createDomainSeparatedMessage(message: string, chainId: number, did: string): string {
    return `AGIRAILS:${chainId}:${did}\n${message}`;
  }

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
  private extractAddressFromVerificationMethod(vm: VerificationMethod): string | null {
    // Try blockchainAccountId first (CAIP-10 format: "0x123...@eip155:chainId")
    if (vm.blockchainAccountId) {
      const match = vm.blockchainAccountId.match(/^(0x[a-fA-F0-9]{40})@/);
      if (match) {
        try {
          return getAddress(match[1]); // Checksum the address
        } catch {
          return null;
        }
      }
    }

    // Try ethereumAddress field
    if (vm.ethereumAddress) {
      try {
        return getAddress(vm.ethereumAddress);
      } catch {
        return null;
      }
    }

    // Try extracting from controller DID
    if (vm.controller) {
      try {
        const { address } = DIDResolver.parseDID(vm.controller);
        return getAddress(address); // Already lowercase, checksum it
      } catch {
        return null;
      }
    }

    return null;
  }
}
