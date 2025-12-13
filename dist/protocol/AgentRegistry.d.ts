import { Signer } from 'ethers';
import { AgentProfile, ServiceDescriptor, RegisterAgentParams, QueryAgentsParams } from '../types';
/**
 * Gas options for transactions
 */
interface GasOptions {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
}
/**
 * AgentRegistry - Agent Identity & Reputation SDK Module (AIP-7)
 *
 * Provides methods for:
 * - Registering AI agents on-chain
 * - Managing agent profiles and services
 * - Querying agents by service type
 * - Reading reputation scores
 *
 * Reference: AIP-7 Agent Identity, Registry & Storage System
 */
export declare class AgentRegistry {
    private readonly address;
    private contract;
    private readonly gasSettings?;
    constructor(address: string, signer: Signer, gasSettings?: GasOptions);
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
     * Compute service type hash
     * Service types must be lowercase with only a-z, 0-9, and hyphens
     *
     * @param serviceType - Human-readable service type (e.g., "text-generation")
     * @returns keccak256 hash of the service type
     */
    computeServiceTypeHash(serviceType: string): string;
    /**
     * Register a new agent profile
     *
     * @param params - Registration parameters
     * @returns Transaction hash
     *
     * @example
     * ```typescript
     * await registry.registerAgent({
     *   endpoint: 'https://myagent.example.com/webhook',
     *   serviceDescriptors: [{
     *     serviceTypeHash: registry.computeServiceTypeHash('text-generation'),
     *     serviceType: 'text-generation',
     *     schemaURI: 'ipfs://Qm...',
     *     minPrice: 1_000_000n,  // 1 USDC
     *     maxPrice: 100_000_000n, // 100 USDC
     *     avgCompletionTime: 60,
     *     metadataCID: 'Qm...'
     *   }]
     * });
     * ```
     */
    registerAgent(params: RegisterAgentParams): Promise<string>;
    /**
     * Update agent endpoint URL
     *
     * @param newEndpoint - New webhook/IPFS gateway URL
     */
    updateEndpoint(newEndpoint: string): Promise<string>;
    /**
     * Add a new service type to agent profile
     *
     * @param serviceType - Lowercase service type (e.g., "code-review")
     */
    addServiceType(serviceType: string): Promise<string>;
    /**
     * Remove a service type from agent profile
     *
     * @param serviceTypeHash - Hash of service type to remove
     */
    removeServiceType(serviceTypeHash: string): Promise<string>;
    /**
     * Set agent active/inactive status
     *
     * @param isActive - Whether agent is accepting new requests
     */
    setActiveStatus(isActive: boolean): Promise<string>;
    /**
     * Get agent profile by address
     *
     * @param agentAddress - Agent's Ethereum address
     * @returns Agent profile or null if not registered
     */
    getAgent(agentAddress: string): Promise<AgentProfile | null>;
    /**
     * Get agent profile by DID
     *
     * @param did - Agent's DID (e.g., "did:ethr:8453:0x...")
     * @returns Agent profile or null if not found
     */
    getAgentByDID(did: string): Promise<AgentProfile | null>;
    /**
     * Query agents by service type
     *
     * **IMPORTANT - Query Cap Limitation (L-4)**:
     *
     * This method will throw `QueryCapExceededError` when the registry contains
     * more than 1000 agents. This is an intentional DoS prevention measure.
     *
     * When you encounter this error, migrate to an off-chain indexer:
     * - The Graph: https://thegraph.com/
     * - Goldsky: https://goldsky.com/
     * - Alchemy Subgraphs: https://docs.alchemy.com/docs/subgraphs-overview
     *
     * See `QueryCapExceededError` documentation for event schemas to index.
     *
     * @param params - Query parameters
     * @returns List of agent addresses matching criteria
     * @throws {QueryCapExceededError} When registry exceeds 1000 agents
     * @throws {ValidationError} For invalid parameters
     *
     * @example
     * ```typescript
     * try {
     *   const agents = await registry.queryAgentsByService({
     *     serviceTypeHash: registry.computeServiceTypeHash('text-generation'),
     *     minReputation: 5000,
     *     limit: 50
     *   });
     * } catch (error) {
     *   if (error instanceof QueryCapExceededError) {
     *     console.log('Registry too large, use off-chain indexer');
     *     // Fallback to your indexer implementation
     *   }
     * }
     * ```
     */
    queryAgentsByService(params: QueryAgentsParams): Promise<string[]>;
    /**
     * Get service descriptors for an agent
     *
     * @param agentAddress - Agent's Ethereum address
     * @returns List of service descriptors
     */
    getServiceDescriptors(agentAddress: string): Promise<ServiceDescriptor[]>;
    /**
     * Check if agent supports a service type
     *
     * @param agentAddress - Agent's Ethereum address
     * @param serviceTypeHash - Service type hash
     * @returns True if supported
     */
    supportsService(agentAddress: string, serviceTypeHash: string): Promise<boolean>;
    /**
     * Get the chain ID used for DID generation
     */
    getChainId(): Promise<number>;
    /**
     * Build a DID for an address on the current chain
     *
     * @param address - Ethereum address
     * @returns DID string (e.g., "did:ethr:8453:0x...")
     */
    buildDID(address: string): Promise<string>;
    /**
     * Safely convert bigint to number, throwing if precision would be lost
     */
    private safeToNumber;
    private _mapProfile;
}
export {};
//# sourceMappingURL=AgentRegistry.d.ts.map