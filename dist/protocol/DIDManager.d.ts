import { Signer } from 'ethers';
import { DelegateType, AttributeName, DIDOwnerChangedEvent, DIDDelegateChangedEvent, DIDAttributeChangedEvent } from '../types/did';
/**
 * Gas options for transactions
 */
interface GasOptions {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
}
/**
 * DIDManager - Manage DID attributes and delegates (AIP-7 §2.2)
 *
 * Interacts with ERC-1056 compatible AGIRAILS Identity Registry.
 * Provides key rotation, delegate management, and attribute storage.
 *
 * @example
 * ```typescript
 * const manager = new DIDManager(registryAddress, signer);
 *
 * // Get identity owner
 * const owner = await manager.getOwner(myAddress);
 *
 * // Add delegate (expires in 1 year)
 * await manager.addDelegate(
 *   DelegateType.SIGNING,
 *   delegateAddress,
 *   365 * 24 * 60 * 60
 * );
 *
 * // Set service endpoint
 * await manager.setAttribute(
 *   AttributeName.SERVICE_ENDPOINT,
 *   'https://api.example.com',
 *   365 * 24 * 60 * 60
 * );
 * ```
 *
 * @security
 * - Only identity owner can add/revoke delegates
 * - Only identity owner can set/revoke attributes
 * - All operations wait for 2 confirmations
 * - Gas limits include 20% safety buffer
 */
export declare class DIDManager {
    private readonly registryAddress;
    private contract;
    private readonly gasSettings?;
    /**
     * Create DIDManager instance
     *
     * @param registryAddress - Address of AGIRAILS Identity Registry (ERC-1056)
     * @param signer - Ethers.js signer (must be identity owner for write operations)
     * @param gasSettings - Optional gas price settings
     */
    constructor(registryAddress: string, signer: Signer, gasSettings?: GasOptions);
    /**
     * Get gas buffer multiplier based on operation complexity
     */
    private getGasBufferMultiplier;
    /**
     * Build transaction options with gas settings
     */
    private buildTxOptions;
    /**
     * Get registry contract address
     */
    getAddress(): string;
    /**
     * Get identity owner
     *
     * @param identity - Address to check (if not provided, uses signer address)
     * @returns Current owner address
     *
     * @example
     * ```typescript
     * const owner = await manager.getOwner('0x742d35cc6634c0532925a3b844bc9e7595f0beb');
     * console.log('Identity owner:', owner);
     * ```
     */
    getOwner(identity?: string): Promise<string>;
    /**
     * Change identity owner (key rotation)
     *
     * @param identity - Identity address to update
     * @param newOwner - New owner address
     * @returns Transaction hash
     * @throws TransactionRevertedError if transaction fails
     *
     * @security
     * - Only current owner can change ownership
     * - Waits for 2 confirmations
     * - Validates new owner address
     *
     * @example
     * ```typescript
     * // Rotate key to new address
     * const txHash = await manager.changeOwner(
     *   '0x742d35cc6634c0532925a3b844bc9e7595f0beb',
     *   '0xNewOwnerAddress...'
     * );
     * console.log('Ownership transferred:', txHash);
     * ```
     */
    changeOwner(identity: string, newOwner: string): Promise<string>;
    /**
     * Check if delegate is valid
     *
     * @param identity - Identity address
     * @param delegateType - Type of delegate (e.g., DelegateType.SIGNING)
     * @param delegate - Delegate address
     * @returns True if delegate is currently valid
     *
     * @example
     * ```typescript
     * const isValid = await manager.validDelegate(
     *   '0x742d35cc...',
     *   DelegateType.SIGNING,
     *   '0xDelegateAddress...'
     * );
     * console.log('Delegate valid:', isValid);
     * ```
     */
    validDelegate(identity: string, delegateType: DelegateType | string, delegate: string): Promise<boolean>;
    /**
     * Add delegate (for signing on behalf of identity)
     *
     * @param identity - Identity address
     * @param delegateType - Type of delegate (e.g., DelegateType.SIGNING)
     * @param delegate - Delegate address
     * @param validity - Validity period in seconds
     * @returns Transaction hash
     * @throws TransactionRevertedError if transaction fails
     *
     * @security
     * - Only identity owner can add delegates
     * - Delegate expires after validity period
     * - Waits for 2 confirmations
     *
     * @example
     * ```typescript
     * // Add signing delegate for 1 year
     * const txHash = await manager.addDelegate(
     *   '0x742d35cc...',
     *   DelegateType.SIGNING,
     *   '0xDelegateAddress...',
     *   365 * 24 * 60 * 60  // 1 year in seconds
     * );
     * ```
     */
    addDelegate(identity: string, delegateType: DelegateType | string, delegate: string, validity: number): Promise<string>;
    /**
     * Revoke delegate
     *
     * @param identity - Identity address
     * @param delegateType - Type of delegate
     * @param delegate - Delegate address to revoke
     * @returns Transaction hash
     * @throws TransactionRevertedError if transaction fails
     *
     * @security
     * - Only identity owner can revoke delegates
     * - Waits for 2 confirmations
     *
     * @example
     * ```typescript
     * const txHash = await manager.revokeDelegate(
     *   '0x742d35cc...',
     *   DelegateType.SIGNING,
     *   '0xDelegateAddress...'
     * );
     * ```
     */
    revokeDelegate(identity: string, delegateType: DelegateType | string, delegate: string): Promise<string>;
    /**
     * Set attribute (e.g., service endpoint)
     *
     * @param identity - Identity address
     * @param name - Attribute name (e.g., AttributeName.SERVICE_ENDPOINT)
     * @param value - Attribute value (string, will be encoded to bytes)
     * @param validity - Validity period in seconds
     * @returns Transaction hash
     * @throws TransactionRevertedError if transaction fails
     *
     * @security
     * - Only identity owner can set attributes
     * - Attribute expires after validity period
     * - Waits for 2 confirmations
     *
     * @example
     * ```typescript
     * // Set service endpoint for 1 year
     * const txHash = await manager.setAttribute(
     *   '0x742d35cc...',
     *   AttributeName.SERVICE_ENDPOINT,
     *   'https://api.example.com/v1',
     *   365 * 24 * 60 * 60
     * );
     * ```
     */
    setAttribute(identity: string, name: AttributeName | string, value: string, validity: number): Promise<string>;
    /**
     * Revoke attribute
     *
     * @param identity - Identity address
     * @param name - Attribute name to revoke
     * @param value - Attribute value (must match value set)
     * @returns Transaction hash
     * @throws TransactionRevertedError if transaction fails
     *
     * @security
     * - Only identity owner can revoke attributes
     * - Waits for 2 confirmations
     *
     * @example
     * ```typescript
     * const txHash = await manager.revokeAttribute(
     *   '0x742d35cc...',
     *   AttributeName.SERVICE_ENDPOINT,
     *   'https://api.example.com/v1'
     * );
     * ```
     */
    revokeAttribute(identity: string, name: AttributeName | string, value: string): Promise<string>;
    /**
     * Get timestamp of last change for identity
     *
     * @param identity - Identity address
     * @returns Timestamp of last change (seconds since Unix epoch)
     */
    getChanged(identity: string): Promise<bigint>;
    /**
     * Get nonce for identity (for signed operations)
     *
     * @param identity - Identity address
     * @returns Current nonce
     */
    getNonce(identity: string): Promise<bigint>;
    /**
     * Convert string to bytes32 hash
     *
     * Used for delegate types and attribute names in ERC-1056
     *
     * @param str - String to convert
     * @returns bytes32 hash (0x-prefixed hex string)
     *
     * @example
     * ```typescript
     * const hash = manager.stringToBytes32('veriKey');
     * // Returns: '0x...' (keccak256 hash)
     * ```
     */
    stringToBytes32(str: string): string;
    /**
     * Listen for DIDOwnerChanged events
     *
     * @param callback - Function to call when owner changes
     * @param identity - Optional filter by identity address
     * @returns Cleanup function to stop listening
     *
     * @example
     * ```typescript
     * const unsubscribe = manager.onOwnerChanged((event) => {
     *   console.log('Owner changed:', event);
     * }, '0x742d35cc...');
     *
     * // Later: stop listening
     * unsubscribe();
     * ```
     */
    onOwnerChanged(callback: (event: DIDOwnerChangedEvent) => void, identity?: string): () => void;
    /**
     * Listen for DIDDelegateChanged events
     *
     * @param callback - Function to call when delegate changes
     * @param identity - Optional filter by identity address
     * @returns Cleanup function to stop listening
     */
    onDelegateChanged(callback: (event: DIDDelegateChangedEvent) => void, identity?: string): () => void;
    /**
     * Listen for DIDAttributeChanged events
     *
     * @param callback - Function to call when attribute changes
     * @param identity - Optional filter by identity address
     * @returns Cleanup function to stop listening
     */
    onAttributeChanged(callback: (event: DIDAttributeChangedEvent) => void, identity?: string): () => void;
}
export {};
//# sourceMappingURL=DIDManager.d.ts.map