/**
 * ServiceDirectory - Hardcoded provider mapping for MVP
 *
 * In MVP, we use hardcoded service-to-provider mapping.
 * In V2+, this will be replaced by on-chain AgentRegistry queries.
 *
 * @packageDocumentation
 */

import { validateServiceName, isValidAddress } from '../utils/security';

/**
 * In-memory service directory
 *
 * Maps service names to provider addresses.
 * This is a singleton that can be updated by provide() calls.
 *
 * Security notes:
 * - H-5: Address validation to prevent poisoning
 * - H-2: Service name validation
 */
class ServiceDirectory {
  /**
   * Service -> Provider address mapping
   */
  private directory = new Map<string, Set<string>>();

  /**
   * Register a provider for a service
   *
   *Security: Validate address format before registration
   *Security: Validate service name
   *
   * @param service - Service name
   * @param provider - Provider address
   * @throws Error if service name or provider address is invalid
   */
  register(service: string, provider: string): void {
    // Security: Validate service name
    const validatedService = validateServiceName(service);

    // Security: Validate Ethereum address format
    if (!isValidAddress(provider)) {
      throw new Error(
        `Invalid provider address: "${provider}". Must be a valid Ethereum address (0x followed by 40 hex characters).`
      );
    }

    if (!this.directory.has(validatedService)) {
      this.directory.set(validatedService, new Set());
    }

    this.directory.get(validatedService)!.add(provider);
  }

  /**
   * Unregister a provider from a service
   *
   *Security: Validate address format
   *Security: Validate service name
   *
   * @param service - Service name
   * @param provider - Provider address
   */
  unregister(service: string, provider: string): void {
    // Security: Validate service name
    const validatedService = validateServiceName(service);

    // Security: Validate address format
    if (!isValidAddress(provider)) {
      throw new Error(`Invalid provider address: "${provider}"`);
    }

    const providers = this.directory.get(validatedService);
    if (providers) {
      providers.delete(provider);
      if (providers.size === 0) {
        this.directory.delete(validatedService);
      }
    }
  }

  /**
   * Find providers for a service
   *
   *Security: Validate service name
   *
   * @param service - Service name
   * @returns Array of provider addresses
   */
  findProviders(service: string): string[] {
    // Security: Validate service name
    try {
      const validatedService = validateServiceName(service);
      const providers = this.directory.get(validatedService);
      return providers ? Array.from(providers) : [];
    } catch (error) {
      // If service name is invalid, return empty array instead of throwing
      // This allows graceful degradation in search scenarios
      return [];
    }
  }

  /**
   * Get all registered services
   *
   * @returns Array of service names
   */
  getServices(): string[] {
    return Array.from(this.directory.keys());
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.directory.clear();
  }

  /**
   * Get directory size (for debugging)
   */
  get size(): number {
    return this.directory.size;
  }
}

/**
 * Singleton instance
 */
export const serviceDirectory = new ServiceDirectory();
