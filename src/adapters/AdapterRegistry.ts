/**
 * AdapterRegistry - Central registry for payment adapters.
 *
 * Manages the collection of available adapters and provides
 * methods for registration, lookup, and priority-based retrieval.
 *
 * @module adapters/AdapterRegistry
 */

import { IAdapter } from './IAdapter';

/**
 * AdapterRegistry - Central registry for managing available adapters.
 *
 * The registry maintains a collection of adapters indexed by their ID.
 * It provides methods for:
 * - Registration and unregistration
 * - Lookup by ID
 * - Priority-sorted retrieval
 *
 * @example
 * ```typescript
 * const registry = new AdapterRegistry();
 *
 * // Register adapters
 * registry.register(basicAdapter);
 * registry.register(standardAdapter);
 *
 * // Lookup by ID
 * const adapter = registry.get('basic');
 *
 * // Get all adapters sorted by priority
 * const adapters = registry.getByPriority();
 * ```
 */
export class AdapterRegistry {
  /**
   * Internal map of adapters by ID.
   */
  private adapters: Map<string, IAdapter> = new Map();

  /**
   * Register an adapter.
   *
   * If an adapter with the same ID already exists, it will be replaced.
   *
   * @param adapter - Adapter to register
   *
   * @example
   * ```typescript
   * registry.register(new BasicAdapter(runtime, requesterAddress));
   * ```
   */
  register(adapter: IAdapter): void {
    if (!adapter.metadata?.id) {
      throw new Error('Cannot register adapter without metadata.id');
    }
    this.adapters.set(adapter.metadata.id, adapter);
  }

  /**
   * Unregister an adapter by ID.
   *
   * @param id - Adapter ID to remove
   * @returns True if adapter was found and removed, false otherwise
   *
   * @example
   * ```typescript
   * const removed = registry.unregister('custom-adapter');
   * ```
   */
  unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  /**
   * Get an adapter by ID.
   *
   * @param id - Adapter ID to look up
   * @returns The adapter or undefined if not found
   *
   * @example
   * ```typescript
   * const adapter = registry.get('standard');
   * if (adapter) {
   *   await adapter.pay(params);
   * }
   * ```
   */
  get(id: string): IAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Get all registered adapters.
   *
   * Returns adapters in insertion order.
   *
   * @returns Array of all registered adapters
   *
   * @example
   * ```typescript
   * const all = registry.getAll();
   * console.log(`${all.length} adapters registered`);
   * ```
   */
  getAll(): IAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Check if an adapter is registered.
   *
   * @param id - Adapter ID to check
   * @returns True if adapter is registered
   *
   * @example
   * ```typescript
   * if (registry.has('x402')) {
   *   console.log('x402 adapter available');
   * }
   * ```
   */
  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /**
   * Get adapters sorted by priority (highest first).
   *
   * Higher priority adapters are tried first during selection.
   *
   * @returns Array of adapters sorted by priority descending
   *
   * @example
   * ```typescript
   * const byPriority = registry.getByPriority();
   * // byPriority[0] has highest priority
   * ```
   */
  getByPriority(): IAdapter[] {
    return this.getAll().sort(
      (a, b) => b.metadata.priority - a.metadata.priority
    );
  }

  /**
   * Get the number of registered adapters.
   *
   * @returns Number of adapters
   */
  get size(): number {
    return this.adapters.size;
  }

  /**
   * Get all adapter IDs.
   *
   * @returns Array of adapter IDs
   */
  getIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Clear all registered adapters.
   *
   * Primarily useful for testing.
   */
  clear(): void {
    this.adapters.clear();
  }
}
