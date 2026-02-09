/**
 * AdapterRouter - Intelligent adapter selection with guard-rails.
 *
 * The router selects the best adapter for each payment based on:
 * - Explicit adapter preference
 * - Required capabilities (escrow, disputes, identity)
 * - Recipient type (address vs HTTP endpoint)
 * - Adapter priority
 *
 * SECURITY: All parameters are validated before selection.
 * SECURITY: All adapters must enforce explicit release (no auto-settle).
 *
 * @module adapters/AdapterRouter
 */

import { AdapterRegistry } from './AdapterRegistry';
import { IAdapter } from './IAdapter';
import {
  UnifiedPayParams,
  safeValidatePayParams,
} from '../types/adapter';
import { ValidationError } from './BaseAdapter';
import { ERC8004Bridge } from '../erc8004/ERC8004Bridge';

/**
 * Result of adapter selection with potential ERC-8004 resolution.
 */
export interface AdapterSelectionResult {
  /** Selected adapter */
  adapter: IAdapter;

  /** Resolved payment parameters (with wallet instead of agentId) */
  resolvedParams: UnifiedPayParams;

  /** Whether an ERC-8004 agent ID was resolved */
  wasAgentIdResolved: boolean;
}

/**
 * AdapterRouter - Intelligent adapter selection with guard-rails.
 *
 * Selection logic (in order):
 * 1. Validate params (throws if invalid)
 * 2. Explicit adapter requested -> use it
 * 3. Escrow/dispute required -> StandardAdapter
 * 4. HTTP endpoint + no escrow -> X402Adapter (when available)
 * 5. ERC-8004 identity -> ERC8004Adapter (when available)
 * 6. Default -> First adapter that can handle (by priority)
 *
 * @example
 * ```typescript
 * const registry = new AdapterRegistry();
 * registry.register(basicAdapter);
 * registry.register(standardAdapter);
 *
 * const router = new AdapterRouter(registry);
 *
 * // Auto-select best adapter
 * const adapter = router.select({ to: '0x...', amount: '100' });
 *
 * // Explicit adapter request
 * const adapter = router.select({
 *   to: '0x...',
 *   amount: '100',
 *   metadata: { preferredAdapter: 'standard' }
 * });
 * ```
 */
export class AdapterRouter {
  private erc8004Bridge?: ERC8004Bridge;

  /**
   * Creates a new AdapterRouter instance.
   *
   * @param registry - AdapterRegistry containing available adapters
   * @param erc8004Bridge - Optional ERC-8004 bridge for agent ID resolution
   */
  constructor(
    private registry: AdapterRegistry,
    erc8004Bridge?: ERC8004Bridge
  ) {
    this.erc8004Bridge = erc8004Bridge;
  }

  /**
   * Set the ERC-8004 bridge for agent ID resolution.
   *
   * @param bridge - ERC8004Bridge instance
   */
  setERC8004Bridge(bridge: ERC8004Bridge): void {
    this.erc8004Bridge = bridge;
  }

  /**
   * Select the best adapter for the given payment parameters.
   *
   * @param params - Unified payment parameters
   * @returns The selected adapter
   * @throws {ValidationError} If params are invalid
   * @throws {Error} If no suitable adapter found
   *
   * @example
   * ```typescript
   * const adapter = router.select({
   *   to: '0xProvider...',
   *   amount: '100',
   * });
   * const result = await adapter.pay(params);
   * ```
   */
  select(params: UnifiedPayParams): IAdapter {
    // GUARD-RAIL: Validate all params first
    this.validateParams(params);

    const metadata = params.metadata || {};

    // 1. Explicit adapter requested
    if (metadata.preferredAdapter) {
      const adapter = this.registry.get(metadata.preferredAdapter);
      if (!adapter) {
        throw new Error(
          `Preferred adapter '${metadata.preferredAdapter}' not found. ` +
            `Available adapters: ${this.registry.getIds().join(', ') || 'none'}`
        );
      }
      // Verify adapter can handle these params
      adapter.validate(params);
      return adapter;
    }

    // 2. Escrow/dispute required -> STRICT enforcement
    if (metadata.requiresEscrow || metadata.requiresDispute) {
      // First try standard adapter
      const standard = this.registry.get('standard');
      if (standard && standard.canHandle(params)) {
        return standard;
      }

      // Find any adapter that meets the capability requirements
      const compatibleAdapters = this.registry.getByPriority().filter((adapter) => {
        const meta = adapter.metadata;
        const meetsEscrow = !metadata.requiresEscrow || meta.usesEscrow;
        const meetsDispute = !metadata.requiresDispute || meta.supportsDisputes;
        return meetsEscrow && meetsDispute && adapter.canHandle(params);
      });

      if (compatibleAdapters.length > 0) {
        return compatibleAdapters[0];
      }

      // STRICT: No compatible adapter found - throw error instead of falling through
      const requirements = [];
      if (metadata.requiresEscrow) requirements.push('escrow');
      if (metadata.requiresDispute) requirements.push('dispute resolution');
      throw new Error(
        `No adapter found that supports required capabilities: ${requirements.join(', ')}. ` +
          `Available adapters: ${this.registry.getIds().join(', ') || 'none'}`
      );
    }

    // 3. HTTP endpoint -> x402 (when registered)
    // NOTE: X402Adapter is ATOMIC (usesEscrow: false) - instant payment, no escrow.
    // Route HTTPS endpoints to x402 for fire-and-forget API payments.
    // If caller needs escrow protection, they should use ACTP with address, not URL.
    if (this.isHttpEndpoint(params.to)) {
      const x402 = this.registry.get('x402');
      if (x402 && x402.canHandle(params)) {
        return x402;
      }
      // HTTP endpoints without x402 adapter will fall through
      // and likely fail with basic/standard adapters
    }

    // 4. ERC-8004 identity -> erc8004 (when registered)
    if (metadata.identity?.type === 'erc8004') {
      const erc8004 = this.registry.get('erc8004');
      if (erc8004 && erc8004.canHandle(params)) {
        return erc8004;
      }
    }

    // 5. Find first adapter that can handle it (by priority)
    for (const adapter of this.registry.getByPriority()) {
      if (adapter.canHandle(params)) {
        return adapter;
      }
    }

    // 6. Default to basic as last resort
    const basic = this.registry.get('basic');
    if (basic) {
      // Try to use basic even if canHandle returned false
      // Let it fail with a proper error message during pay()
      return basic;
    }

    throw new Error(
      `No suitable adapter found for params. ` +
        `Available adapters: ${this.registry.getIds().join(', ') || 'none'}`
    );
  }

  /**
   * Validate payment parameters with Zod schema.
   *
   * GUARD-RAIL: Performs strict validation before any adapter selection.
   *
   * @param params - Parameters to validate
   * @throws {ValidationError} If params are invalid
   */
  private validateParams(params: UnifiedPayParams): void {
    const result = safeValidatePayParams(params);

    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ValidationError(`Invalid payment params: ${issues}`);
    }

    // Additional security checks

    // Check for path traversal attempts in 'to' field
    if (typeof params.to === 'string') {
      if (params.to.includes('..')) {
        throw new ValidationError(
          'Invalid recipient: path traversal characters not allowed'
        );
      }

      // Check for script injection attempts
      if (params.to.includes('<') || params.to.includes('>')) {
        throw new ValidationError(
          'Invalid recipient: HTML/script characters not allowed'
        );
      }

      // Check for null bytes
      if (params.to.includes('\0')) {
        throw new ValidationError(
          'Invalid recipient: null bytes not allowed'
        );
      }
    }

    // Validate description if provided
    if (params.description) {
      if (params.description.length > 1000) {
        throw new ValidationError(
          'Description too long: maximum 1000 characters'
        );
      }
    }
  }

  /**
   * Check if a string is an HTTP/HTTPS endpoint.
   *
   * @param to - Recipient string to check
   * @returns True if it's an HTTP endpoint
   */
  private isHttpEndpoint(to: string): boolean {
    try {
      const url = new URL(to);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Get all adapters that can handle the given params.
   *
   * Useful for debugging or letting users choose from multiple options.
   *
   * @param params - Payment parameters
   * @returns Array of adapters that can handle params
   */
  getCompatibleAdapters(params: UnifiedPayParams): IAdapter[] {
    this.validateParams(params);
    return this.registry.getAll().filter((adapter) => {
      try {
        return adapter.canHandle(params);
      } catch {
        return false;
      }
    });
  }

  /**
   * Check if any adapter can handle the given params.
   *
   * @param params - Payment parameters
   * @returns True if at least one adapter can handle
   */
  canHandle(params: UnifiedPayParams): boolean {
    try {
      this.validateParams(params);
      return this.getCompatibleAdapters(params).length > 0;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // ERC-8004 Agent ID Resolution
  // ==========================================================================

  /**
   * Select adapter AND resolve ERC-8004 agent IDs.
   *
   * This is the recommended method for payment flows. It:
   * 1. Checks if `to` is an ERC-8004 agent ID (numeric string)
   * 2. If so, resolves it to a wallet address via ERC8004Bridge
   * 3. Stores the original agentId in erc8004AgentId field
   * 4. Selects the appropriate adapter
   *
   * @param params - Unified payment parameters
   * @returns Selection result with resolved params
   * @throws {ValidationError} If params invalid or agent not found
   *
   * @example
   * ```typescript
   * const { adapter, resolvedParams } = await router.selectAndResolve({
   *   to: '12345',  // ERC-8004 agent ID
   *   amount: '100',
   * });
   *
   * // resolvedParams.to is now the wallet address
   * // resolvedParams.erc8004AgentId is '12345'
   * const result = await adapter.pay(resolvedParams);
   * ```
   */
  async selectAndResolve(params: UnifiedPayParams): Promise<AdapterSelectionResult> {
    // Check if 'to' is an ERC-8004 agent ID
    if (this.isERC8004AgentId(params.to)) {
      if (!this.erc8004Bridge) {
        throw new ValidationError(
          `Cannot resolve ERC-8004 agent ID '${params.to}': ` +
            'ERC-8004 resolution requires testnet or mainnet mode. ' +
            'Use a wallet address (0x...) in mock mode, or switch to testnet/mainnet.'
        );
      }

      try {
        // Resolve agent ID to wallet address
        const wallet = await this.erc8004Bridge.getAgentWallet(params.to);

        // Create resolved params with wallet and stored agentId
        const resolvedParams: UnifiedPayParams = {
          ...params,
          to: wallet,
          erc8004AgentId: params.to,
        };

        // Select adapter for resolved params
        const adapter = this.select(resolvedParams);

        return {
          adapter,
          resolvedParams,
          wasAgentIdResolved: true,
        };
      } catch (error) {
        // Re-throw with clearer message
        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new ValidationError(
          `Failed to resolve ERC-8004 agent '${params.to}': ${errorMsg}`
        );
      }
    }

    // Not an agent ID - proceed normally
    const adapter = this.select(params);
    return {
      adapter,
      resolvedParams: params,
      wasAgentIdResolved: false,
    };
  }

  /**
   * Check if a string looks like an ERC-8004 agent ID.
   *
   * Agent IDs are numeric strings (uint256) that are:
   * - NOT Ethereum addresses (0x-prefixed)
   * - NOT URLs (http/https)
   * - Valid as BigInt in range [0, 2^256)
   *
   * @param to - Recipient string to check
   * @returns True if it looks like an agent ID
   */
  isERC8004AgentId(to: string): boolean {
    if (!to || typeof to !== 'string') {
      return false;
    }

    // Not an Ethereum address
    if (to.startsWith('0x')) {
      return false;
    }

    // Not a URL
    if (to.includes('://') || to.startsWith('http')) {
      return false;
    }

    // Must be a valid uint256
    try {
      const bn = BigInt(to);
      return bn >= 0n && bn < 2n ** 256n;
    } catch {
      return false;
    }
  }
}
