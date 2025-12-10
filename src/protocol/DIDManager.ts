import { Contract, Signer, keccak256, toUtf8Bytes } from 'ethers';
import IdentityRegistryABI from '../abi/IdentityRegistry.json';
import {
  DelegateType,
  AttributeName,
  DIDOwnerChangedEvent,
  DIDDelegateChangedEvent,
  DIDAttributeChangedEvent
} from '../types/did';
import { TransactionRevertedError, ValidationError } from '../errors';
import { validateAddress } from '../utils/validation';

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
export class DIDManager {
  private contract: Contract;
  private readonly gasSettings?: GasOptions;

  /**
   * Create DIDManager instance
   *
   * @param registryAddress - Address of AGIRAILS Identity Registry (ERC-1056)
   * @param signer - Ethers.js signer (must be identity owner for write operations)
   * @param gasSettings - Optional gas price settings
   */
  constructor(
    private readonly registryAddress: string,
    signer: Signer,
    gasSettings?: GasOptions
  ) {
    validateAddress(registryAddress, 'registryAddress');
    this.contract = new Contract(registryAddress, IdentityRegistryABI, signer);
    this.gasSettings = gasSettings;
  }

  /**
   * Get gas buffer multiplier based on operation complexity
   */
  private getGasBufferMultiplier(operation: string): number {
    const buffers: Record<string, number> = {
      'changeOwner': 1.30,       // 30% - Ownership transfer
      'addDelegate': 1.25,       // 25% - Delegate registration
      'revokeDelegate': 1.20,    // 20% - Delegate removal
      'setAttribute': 1.30,      // 30% - Attribute storage (variable size)
      'revokeAttribute': 1.20    // 20% - Attribute removal
    };

    return buffers[operation] || 1.20;
  }

  /**
   * Build transaction options with gas settings
   */
  private buildTxOptions(estimatedGas: bigint, operation: string = 'default'): any {
    const bufferMultiplier = this.getGasBufferMultiplier(operation);
    let gasLimit = (estimatedGas * BigInt(Math.round(bufferMultiplier * 100))) / 100n;

    // Cap gas limit (Base L2 safety)
    const MAX_GAS_LIMIT = 10_000_000n;
    if (gasLimit > MAX_GAS_LIMIT) {
      throw new ValidationError('gasLimit', `Estimated gas exceeds maximum safe limit (${MAX_GAS_LIMIT})`);
    }

    const options: any = { gasLimit };

    if (this.gasSettings?.maxFeePerGas) {
      options.maxFeePerGas = this.gasSettings.maxFeePerGas;
    }
    if (this.gasSettings?.maxPriorityFeePerGas) {
      options.maxPriorityFeePerGas = this.gasSettings.maxPriorityFeePerGas;
    }

    return options;
  }

  /**
   * Get registry contract address
   */
  getAddress(): string {
    return this.registryAddress;
  }

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
  async getOwner(identity?: string): Promise<string> {
    let addr = identity;

    // If no identity provided, try to get from signer
    if (!addr && this.contract.runner && 'getAddress' in this.contract.runner) {
      addr = await (this.contract.runner as Signer).getAddress();
    }

    if (!addr) {
      throw new ValidationError('identity', 'Must provide identity address or signer');
    }

    validateAddress(addr, 'identity');
    const owner = await this.contract.identityOwner(addr);
    return owner;
  }

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
  async changeOwner(identity: string, newOwner: string): Promise<string> {
    validateAddress(identity, 'identity');
    validateAddress(newOwner, 'newOwner');

    try {
      // Estimate gas
      const estimatedGas = await this.contract.changeOwner.estimateGas(identity, newOwner);
      const options = this.buildTxOptions(estimatedGas, 'changeOwner');

      // Send transaction
      const tx = await this.contract.changeOwner(identity, newOwner, options);

      // Wait for 2 confirmations
      await tx.wait(2);

      return tx.hash;
    } catch (error) {
      throw new TransactionRevertedError(
        'changeOwner',
        error instanceof Error ? error.message : 'Transaction failed'
      );
    }
  }

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
  async validDelegate(
    identity: string,
    delegateType: DelegateType | string,
    delegate: string
  ): Promise<boolean> {
    validateAddress(identity, 'identity');
    validateAddress(delegate, 'delegate');

    const typeHash = this.stringToBytes32(delegateType);
    const isValid = await this.contract.validDelegate(identity, typeHash, delegate);
    return isValid;
  }

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
  async addDelegate(
    identity: string,
    delegateType: DelegateType | string,
    delegate: string,
    validity: number
  ): Promise<string> {
    validateAddress(identity, 'identity');
    validateAddress(delegate, 'delegate');

    if (validity <= 0) {
      throw new ValidationError('validity', 'Validity must be positive');
    }

    const typeHash = this.stringToBytes32(delegateType);

    try {
      // Estimate gas
      const estimatedGas = await this.contract.addDelegate.estimateGas(
        identity,
        typeHash,
        delegate,
        validity
      );
      const options = this.buildTxOptions(estimatedGas, 'addDelegate');

      // Send transaction
      const tx = await this.contract.addDelegate(identity, typeHash, delegate, validity, options);

      // Wait for 2 confirmations
      await tx.wait(2);

      return tx.hash;
    } catch (error) {
      throw new TransactionRevertedError(
        'addDelegate',
        error instanceof Error ? error.message : 'Transaction failed'
      );
    }
  }

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
  async revokeDelegate(
    identity: string,
    delegateType: DelegateType | string,
    delegate: string
  ): Promise<string> {
    validateAddress(identity, 'identity');
    validateAddress(delegate, 'delegate');

    const typeHash = this.stringToBytes32(delegateType);

    try {
      // Estimate gas
      const estimatedGas = await this.contract.revokeDelegate.estimateGas(
        identity,
        typeHash,
        delegate
      );
      const options = this.buildTxOptions(estimatedGas, 'revokeDelegate');

      // Send transaction
      const tx = await this.contract.revokeDelegate(identity, typeHash, delegate, options);

      // Wait for 2 confirmations
      await tx.wait(2);

      return tx.hash;
    } catch (error) {
      throw new TransactionRevertedError(
        'revokeDelegate',
        error instanceof Error ? error.message : 'Transaction failed'
      );
    }
  }

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
  async setAttribute(
    identity: string,
    name: AttributeName | string,
    value: string,
    validity: number
  ): Promise<string> {
    validateAddress(identity, 'identity');

    if (!value || value.length === 0) {
      throw new ValidationError('value', 'Attribute value cannot be empty');
    }

    if (validity <= 0) {
      throw new ValidationError('validity', 'Validity must be positive');
    }

    const nameHash = this.stringToBytes32(name);
    const valueBytes = toUtf8Bytes(value);

    try {
      // Estimate gas
      const estimatedGas = await this.contract.setAttribute.estimateGas(
        identity,
        nameHash,
        valueBytes,
        validity
      );
      const options = this.buildTxOptions(estimatedGas, 'setAttribute');

      // Send transaction
      const tx = await this.contract.setAttribute(identity, nameHash, valueBytes, validity, options);

      // Wait for 2 confirmations
      await tx.wait(2);

      return tx.hash;
    } catch (error) {
      throw new TransactionRevertedError(
        'setAttribute',
        error instanceof Error ? error.message : 'Transaction failed'
      );
    }
  }

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
  async revokeAttribute(
    identity: string,
    name: AttributeName | string,
    value: string
  ): Promise<string> {
    validateAddress(identity, 'identity');

    if (!value || value.length === 0) {
      throw new ValidationError('value', 'Attribute value cannot be empty');
    }

    const nameHash = this.stringToBytes32(name);
    const valueBytes = toUtf8Bytes(value);

    try {
      // Estimate gas
      const estimatedGas = await this.contract.revokeAttribute.estimateGas(
        identity,
        nameHash,
        valueBytes
      );
      const options = this.buildTxOptions(estimatedGas, 'revokeAttribute');

      // Send transaction
      const tx = await this.contract.revokeAttribute(identity, nameHash, valueBytes, options);

      // Wait for 2 confirmations
      await tx.wait(2);

      return tx.hash;
    } catch (error) {
      throw new TransactionRevertedError(
        'revokeAttribute',
        error instanceof Error ? error.message : 'Transaction failed'
      );
    }
  }

  /**
   * Get timestamp of last change for identity
   *
   * @param identity - Identity address
   * @returns Timestamp of last change (seconds since Unix epoch)
   */
  async getChanged(identity: string): Promise<bigint> {
    validateAddress(identity, 'identity');
    const changed = await this.contract.changed(identity);
    return changed;
  }

  /**
   * Get nonce for identity (for signed operations)
   *
   * @param identity - Identity address
   * @returns Current nonce
   */
  async getNonce(identity: string): Promise<bigint> {
    validateAddress(identity, 'identity');
    const nonce = await this.contract.nonce(identity);
    return nonce;
  }

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
  stringToBytes32(str: string): string {
    // If already a bytes32 hash (0x + 64 hex chars), return as-is
    if (/^0x[0-9a-fA-F]{64}$/.test(str)) {
      return str;
    }

    // Otherwise, hash the string
    return keccak256(toUtf8Bytes(str));
  }

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
  onOwnerChanged(
    callback: (event: DIDOwnerChangedEvent) => void,
    identity?: string
  ): () => void {
    const filter = identity
      ? this.contract.filters.DIDOwnerChanged(identity)
      : this.contract.filters.DIDOwnerChanged();

    const listener = (identityAddr: string, owner: string, previousChange: bigint) => {
      callback({ identity: identityAddr, owner, previousChange });
    };

    this.contract.on(filter, listener);

    return () => {
      this.contract.off(filter, listener);
    };
  }

  /**
   * Listen for DIDDelegateChanged events
   *
   * @param callback - Function to call when delegate changes
   * @param identity - Optional filter by identity address
   * @returns Cleanup function to stop listening
   */
  onDelegateChanged(
    callback: (event: DIDDelegateChangedEvent) => void,
    identity?: string
  ): () => void {
    const filter = identity
      ? this.contract.filters.DIDDelegateChanged(identity)
      : this.contract.filters.DIDDelegateChanged();

    const listener = (
      identityAddr: string,
      delegateType: string,
      delegate: string,
      validTo: bigint,
      previousChange: bigint
    ) => {
      callback({ identity: identityAddr, delegateType, delegate, validTo, previousChange });
    };

    this.contract.on(filter, listener);

    return () => {
      this.contract.off(filter, listener);
    };
  }

  /**
   * Listen for DIDAttributeChanged events
   *
   * @param callback - Function to call when attribute changes
   * @param identity - Optional filter by identity address
   * @returns Cleanup function to stop listening
   */
  onAttributeChanged(
    callback: (event: DIDAttributeChangedEvent) => void,
    identity?: string
  ): () => void {
    const filter = identity
      ? this.contract.filters.DIDAttributeChanged(identity)
      : this.contract.filters.DIDAttributeChanged();

    const listener = (
      identityAddr: string,
      name: string,
      value: Uint8Array,
      validTo: bigint,
      previousChange: bigint
    ) => {
      callback({ identity: identityAddr, name, value, validTo, previousChange });
    };

    this.contract.on(filter, listener);

    return () => {
      this.contract.off(filter, listener);
    };
  }
}
