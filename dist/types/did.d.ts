/**
 * DID (Decentralized Identity) Types - AIP-7 §2
 *
 * Implements W3C DID specification for Ethereum-based identities
 * using the did:ethr method with ERC-1056 registry
 */
/**
 * DID format: did:ethr:<chainId>:<address>
 * Example: did:ethr:84532:0x742d35cc6634c0532925a3b844bc9e7595f0beb
 */
export type DID = string;
/**
 * W3C DID Document structure
 * @see https://www.w3.org/TR/did-core/
 */
export interface DIDDocument {
    '@context': string | string[];
    id: DID;
    verificationMethod?: VerificationMethod[];
    authentication?: (string | VerificationMethod)[];
    assertionMethod?: (string | VerificationMethod)[];
    keyAgreement?: (string | VerificationMethod)[];
    capabilityInvocation?: (string | VerificationMethod)[];
    capabilityDelegation?: (string | VerificationMethod)[];
    service?: ServiceEndpoint[];
}
/**
 * Verification method for cryptographic key
 */
export interface VerificationMethod {
    id: string;
    type: string;
    controller: DID;
    blockchainAccountId?: string;
    publicKeyHex?: string;
    publicKeyBase58?: string;
    publicKeyMultibase?: string;
    ethereumAddress?: string;
    validTo?: number | bigint;
}
/**
 * Service endpoint in DID Document
 */
export interface ServiceEndpoint {
    id: string;
    type: string;
    serviceEndpoint: string | string[] | Record<string, unknown>;
    description?: string;
}
/**
 * DID Resolution result
 */
export interface DIDResolutionResult {
    didDocument: DIDDocument | null;
    didResolutionMetadata: DIDResolutionMetadata;
    didDocumentMetadata: DIDDocumentMetadata;
}
/**
 * DID Resolution metadata
 */
export interface DIDResolutionMetadata {
    contentType?: string;
    error?: 'invalidDid' | 'notFound' | 'representationNotSupported' | 'unsupportedDidMethod' | string;
    message?: string;
}
/**
 * DID Document metadata
 */
export interface DIDDocumentMetadata {
    created?: string;
    updated?: string;
    deactivated?: boolean;
    versionId?: string;
    nextUpdate?: string;
    nextVersionId?: string;
}
/**
 * Configuration for DID Resolver
 */
export interface DIDResolverConfig {
    /**
     * Network to use (base-sepolia or base-mainnet)
     */
    network?: string;
    /**
     * Custom RPC URL (overrides network default)
     */
    rpcUrl?: string;
    /**
     * Custom Identity Registry address (overrides network default)
     */
    registryAddress?: string;
    /**
     * Chain ID (required if not using predefined network)
     */
    chainId?: number;
}
/**
 * Parsed DID components
 */
export interface ParsedDID {
    method: string;
    chainId: number;
    address: string;
}
/**
 * ERC-1056 Identity Changed Event
 */
export interface DIDOwnerChangedEvent {
    identity: string;
    owner: string;
    previousChange: bigint;
}
/**
 * ERC-1056 Delegate Changed Event
 */
export interface DIDDelegateChangedEvent {
    identity: string;
    delegateType: string;
    delegate: string;
    validTo: bigint;
    previousChange: bigint;
}
/**
 * ERC-1056 Attribute Changed Event
 */
export interface DIDAttributeChangedEvent {
    identity: string;
    name: string;
    value: Uint8Array;
    validTo: bigint;
    previousChange: bigint;
}
/**
 * Delegate types for ERC-1056
 */
export declare enum DelegateType {
    /** Can sign on behalf of identity */
    SIGNING = "veriKey",
    /** Can encrypt messages for identity */
    ENCRYPTION = "encryptionKey",
    /** Can perform general actions */
    GENERAL = "delegate",
    /** Custom delegate type */
    CUSTOM = "custom"
}
/**
 * Attribute names for ERC-1056
 */
export declare enum AttributeName {
    /** Service endpoint (e.g., AGIRAILS API endpoint) */
    SERVICE_ENDPOINT = "did/svc/AGIRAILSProvider",
    /** Public key for verification */
    PUBLIC_KEY = "did/pub/Secp256k1/veriKey",
    /** Encryption public key */
    ENCRYPTION_KEY = "did/pub/X25519/enc",
    /** Custom attribute */
    CUSTOM = "custom"
}
/**
 * Options for DID signature verification
 */
export interface VerifySignatureOptions {
    /** Chain ID to verify against (prevents cross-chain replay) */
    chainId: number;
    /** Expected DID (optional additional check) */
    expectedDID?: DID;
    /** Timestamp for delegate validity check */
    timestamp?: number;
    /**
     * Use domain separation to prevent cross-protocol replay attacks
     * Default: true (recommended for security)
     * Set to false only for backwards compatibility with old signatures
     */
    useDomainSeparation?: boolean;
}
/**
 * Result of signature verification
 */
export interface SignatureVerificationResult {
    /** Whether signature is valid */
    valid: boolean;
    /** Recovered signer address */
    signer?: string;
    /** Error message if verification failed */
    error?: string;
    /** Whether signer is a delegate (not the owner) */
    isDelegate?: boolean;
    /** Delegate type if signer is a delegate */
    delegateType?: string;
}
//# sourceMappingURL=did.d.ts.map