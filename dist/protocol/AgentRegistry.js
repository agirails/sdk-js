"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRegistry = void 0;
const ethers_1 = require("ethers");
const AgentRegistry_json_1 = __importDefault(require("../abi/AgentRegistry.json"));
const errors_1 = require("../errors");
const validation_1 = require("../utils/validation");
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
class AgentRegistry {
    constructor(address, signer, gasSettings) {
        this.address = address;
        this.contract = new ethers_1.Contract(address, AgentRegistry_json_1.default, signer);
        this.gasSettings = gasSettings;
    }
    /**
     * Get gas buffer multiplier based on operation complexity
     */
    getGasBufferMultiplier(operation) {
        const buffers = {
            'registerAgent': 1.40, // 40% - Complex storage writes
            'addServiceType': 1.25, // 25% - Storage update
            'removeServiceType': 1.25,
            'updateEndpoint': 1.20, // 20% - Simple storage update
            'setActiveStatus': 1.15 // 15% - Boolean update
        };
        return buffers[operation] || 1.20;
    }
    /**
     * Build transaction options with gas settings
     */
    buildTxOptions(estimatedGas, operation = 'default') {
        const bufferMultiplier = this.getGasBufferMultiplier(operation);
        let gasLimit = (estimatedGas * BigInt(Math.round(bufferMultiplier * 100))) / 100n;
        // Cap gas limit (Base L2 safety)
        const MAX_GAS_LIMIT = 10000000n;
        if (gasLimit > MAX_GAS_LIMIT) {
            throw new errors_1.ValidationError('gasLimit', `Estimated gas exceeds maximum safe limit (${MAX_GAS_LIMIT})`);
        }
        const options = { gasLimit };
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
    getAddress() {
        return this.address;
    }
    /**
     * Compute service type hash
     * Service types must be lowercase with only a-z, 0-9, and hyphens
     *
     * @param serviceType - Human-readable service type (e.g., "text-generation")
     * @returns keccak256 hash of the service type
     */
    computeServiceTypeHash(serviceType) {
        // Validate length
        const MAX_SERVICE_TYPE_LENGTH = 64;
        if (serviceType.length > MAX_SERVICE_TYPE_LENGTH) {
            throw new errors_1.ValidationError('serviceType', `Service type exceeds maximum length (${MAX_SERVICE_TYPE_LENGTH} characters)`);
        }
        // Validate format
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(serviceType)) {
            throw new errors_1.ValidationError('serviceType', 'Must be lowercase alphanumeric with hyphens (e.g., "text-generation")');
        }
        return (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(serviceType));
    }
    // ========== WRITE FUNCTIONS ==========
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
    async registerAgent(params) {
        // C-1: Validate endpoint URL
        (0, validation_1.validateEndpointURL)(params.endpoint, 'endpoint');
        if (!params.serviceDescriptors || params.serviceDescriptors.length === 0) {
            throw new errors_1.ValidationError('serviceDescriptors', 'At least one service descriptor required');
        }
        const MAX_SERVICE_DESCRIPTORS = 100;
        if (params.serviceDescriptors.length > MAX_SERVICE_DESCRIPTORS) {
            throw new errors_1.ValidationError('serviceDescriptors', `Too many service descriptors (max: ${MAX_SERVICE_DESCRIPTORS})`);
        }
        // Validate each service descriptor
        for (const sd of params.serviceDescriptors) {
            const expectedHash = this.computeServiceTypeHash(sd.serviceType);
            if (sd.serviceTypeHash !== expectedHash) {
                throw new errors_1.ValidationError('serviceTypeHash', `Hash mismatch for ${sd.serviceType}. Expected ${expectedHash}`);
            }
            // C-2: Validate price range
            if (sd.minPrice < 0n) {
                throw new errors_1.ValidationError('minPrice', 'Minimum price cannot be negative');
            }
            if (sd.maxPrice < 0n) {
                throw new errors_1.ValidationError('maxPrice', 'Maximum price cannot be negative');
            }
            if (sd.minPrice > sd.maxPrice) {
                throw new errors_1.ValidationError('priceRange', `minPrice (${sd.minPrice}) cannot exceed maxPrice (${sd.maxPrice})`);
            }
            // Sanity check: max $1M USDC
            const MAX_PRICE = 1000000000000n;
            if (sd.maxPrice > MAX_PRICE) {
                throw new errors_1.ValidationError('maxPrice', 'Price exceeds maximum reasonable value ($1M USDC)');
            }
            // Validate completion time
            if (sd.avgCompletionTime <= 0) {
                throw new errors_1.ValidationError('avgCompletionTime', 'Average completion time must be positive');
            }
            const MAX_COMPLETION_TIME = 30 * 24 * 60 * 60; // 30 days
            if (sd.avgCompletionTime > MAX_COMPLETION_TIME) {
                throw new errors_1.ValidationError('avgCompletionTime', 'Completion time exceeds maximum (30 days)');
            }
        }
        try {
            const registerFunc = this.contract.getFunction('registerAgent');
            // Convert to contract format
            const descriptors = params.serviceDescriptors.map(sd => ({
                serviceTypeHash: sd.serviceTypeHash,
                serviceType: sd.serviceType,
                schemaURI: sd.schemaURI,
                minPrice: sd.minPrice,
                maxPrice: sd.maxPrice,
                avgCompletionTime: sd.avgCompletionTime,
                metadataCID: sd.metadataCID
            }));
            const estimatedGas = await registerFunc.estimateGas(params.endpoint, descriptors);
            const txOptions = this.buildTxOptions(estimatedGas, 'registerAgent');
            const tx = await registerFunc(params.endpoint, descriptors, txOptions);
            const receipt = await tx.wait(2); // L-2: Wait for 2 confirmations
            return receipt.hash;
        }
        catch (error) {
            throw new errors_1.TransactionRevertedError(error.transactionHash, `Agent registration failed: ${error.reason || error.message}`);
        }
    }
    /**
     * Update agent endpoint URL
     *
     * @param newEndpoint - New webhook/IPFS gateway URL
     */
    async updateEndpoint(newEndpoint) {
        // C-1: Validate endpoint URL
        (0, validation_1.validateEndpointURL)(newEndpoint, 'newEndpoint');
        try {
            const updateFunc = this.contract.getFunction('updateEndpoint');
            const estimatedGas = await updateFunc.estimateGas(newEndpoint);
            const txOptions = this.buildTxOptions(estimatedGas, 'updateEndpoint');
            const tx = await updateFunc(newEndpoint, txOptions);
            const receipt = await tx.wait(2); // L-2: Wait for 2 confirmations
            return receipt.hash;
        }
        catch (error) {
            throw new errors_1.TransactionRevertedError(error.transactionHash, `Endpoint update failed: ${error.reason || error.message}`);
        }
    }
    /**
     * Add a new service type to agent profile
     *
     * @param serviceType - Lowercase service type (e.g., "code-review")
     */
    async addServiceType(serviceType) {
        // Validate format
        this.computeServiceTypeHash(serviceType);
        try {
            const addFunc = this.contract.getFunction('addServiceType');
            const estimatedGas = await addFunc.estimateGas(serviceType);
            const txOptions = this.buildTxOptions(estimatedGas, 'addServiceType');
            const tx = await addFunc(serviceType, txOptions);
            const receipt = await tx.wait(2); // L-2: Wait for 2 confirmations
            return receipt.hash;
        }
        catch (error) {
            throw new errors_1.TransactionRevertedError(error.transactionHash, `Add service type failed: ${error.reason || error.message}`);
        }
    }
    /**
     * Remove a service type from agent profile
     *
     * @param serviceTypeHash - Hash of service type to remove
     */
    async removeServiceType(serviceTypeHash) {
        // C-3: Validate hash format (bytes32)
        if (!serviceTypeHash || !/^0x[a-fA-F0-9]{64}$/.test(serviceTypeHash)) {
            throw new errors_1.ValidationError('serviceTypeHash', 'Must be valid bytes32 hex string (0x + 64 hex chars)');
        }
        if (serviceTypeHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            throw new errors_1.ValidationError('serviceTypeHash', 'Cannot be zero hash');
        }
        try {
            const removeFunc = this.contract.getFunction('removeServiceType');
            const estimatedGas = await removeFunc.estimateGas(serviceTypeHash);
            const txOptions = this.buildTxOptions(estimatedGas, 'removeServiceType');
            const tx = await removeFunc(serviceTypeHash, txOptions);
            const receipt = await tx.wait(2); // L-2: Wait for 2 confirmations
            return receipt.hash;
        }
        catch (error) {
            throw new errors_1.TransactionRevertedError(error.transactionHash, `Remove service type failed: ${error.reason || error.message}`);
        }
    }
    /**
     * Set agent active/inactive status
     *
     * @param isActive - Whether agent is accepting new requests
     */
    async setActiveStatus(isActive) {
        try {
            const setFunc = this.contract.getFunction('setActiveStatus');
            const estimatedGas = await setFunc.estimateGas(isActive);
            const txOptions = this.buildTxOptions(estimatedGas, 'setActiveStatus');
            const tx = await setFunc(isActive, txOptions);
            const receipt = await tx.wait(2); // L-2: Wait for 2 confirmations
            return receipt.hash;
        }
        catch (error) {
            throw new errors_1.TransactionRevertedError(error.transactionHash, `Set active status failed: ${error.reason || error.message}`);
        }
    }
    // ========== READ FUNCTIONS ==========
    /**
     * Get agent profile by address
     *
     * @param agentAddress - Agent's Ethereum address
     * @returns Agent profile or null if not registered
     */
    async getAgent(agentAddress) {
        (0, validation_1.validateAddress)(agentAddress, 'agentAddress');
        const profile = await this.contract.getAgent(agentAddress);
        // Check if registered (registeredAt > 0)
        if (profile.registeredAt === 0n) {
            return null;
        }
        return this._mapProfile(profile);
    }
    /**
     * Get agent profile by DID
     *
     * @param did - Agent's DID (e.g., "did:ethr:8453:0x...")
     * @returns Agent profile or null if not found
     */
    async getAgentByDID(did) {
        // H-2: Strengthen DID validation
        const didPattern = /^did:ethr:(\d+):(0x[a-fA-F0-9]{40})$/;
        const match = did.match(didPattern);
        if (!match) {
            throw new errors_1.ValidationError('did', 'Invalid DID format. Expected did:ethr:<chainId>:<address> (e.g., did:ethr:84532:0x1234...)');
        }
        const [, chainIdStr] = match;
        // Validate chain ID matches
        const currentChainId = await this.getChainId();
        if (parseInt(chainIdStr, 10) !== currentChainId) {
            throw new errors_1.ValidationError('did', `DID chain ID (${chainIdStr}) does not match registry chain ID (${currentChainId})`);
        }
        const profile = await this.contract.getAgentByDID(did);
        if (profile.registeredAt === 0n) {
            return null;
        }
        return this._mapProfile(profile);
    }
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
    async queryAgentsByService(params) {
        // H-3: Add pagination bounds and validation
        // Validate serviceTypeHash format
        if (!params.serviceTypeHash || !/^0x[a-fA-F0-9]{64}$/.test(params.serviceTypeHash)) {
            throw new errors_1.ValidationError('serviceTypeHash', 'Must be valid bytes32 hex string');
        }
        // Validate reputation bounds (0-10000 scale)
        const reputation = params.minReputation ?? 0;
        if (reputation < 0 || reputation > 10000) {
            throw new errors_1.ValidationError('minReputation', 'Must be between 0 and 10000');
        }
        // Validate offset
        const offset = params.offset ?? 0;
        if (offset < 0) {
            throw new errors_1.ValidationError('offset', 'Cannot be negative');
        }
        // Validate and cap limit
        const MAX_LIMIT = 1000;
        let limit = params.limit ?? 100;
        if (limit <= 0) {
            throw new errors_1.ValidationError('limit', 'Must be positive');
        }
        if (limit > MAX_LIMIT) {
            limit = MAX_LIMIT; // Cap silently
        }
        try {
            const agents = await this.contract.queryAgentsByService(params.serviceTypeHash, reputation, offset, limit);
            return agents;
        }
        catch (error) {
            // [L-4] Catch query cap exceeded revert and throw descriptive error
            const message = error.message || error.reason || '';
            if (message.includes('Too many agents')) {
                // Extract approximate size from error or use default
                throw new errors_1.QueryCapExceededError(1001, 1000);
            }
            throw error;
        }
    }
    /**
     * Get service descriptors for an agent
     *
     * @param agentAddress - Agent's Ethereum address
     * @returns List of service descriptors
     */
    async getServiceDescriptors(agentAddress) {
        (0, validation_1.validateAddress)(agentAddress, 'agentAddress');
        const descriptors = await this.contract.getServiceDescriptors(agentAddress);
        return descriptors.map((d) => ({
            serviceTypeHash: d.serviceTypeHash,
            serviceType: d.serviceType,
            schemaURI: d.schemaURI,
            minPrice: d.minPrice,
            maxPrice: d.maxPrice,
            avgCompletionTime: Number(d.avgCompletionTime),
            metadataCID: d.metadataCID
        }));
    }
    /**
     * Check if agent supports a service type
     *
     * @param agentAddress - Agent's Ethereum address
     * @param serviceTypeHash - Service type hash
     * @returns True if supported
     */
    async supportsService(agentAddress, serviceTypeHash) {
        (0, validation_1.validateAddress)(agentAddress, 'agentAddress');
        return await this.contract.supportsService(agentAddress, serviceTypeHash);
    }
    /**
     * Get the chain ID used for DID generation
     */
    async getChainId() {
        return Number(await this.contract.chainId());
    }
    /**
     * Build a DID for an address on the current chain
     *
     * @param address - Ethereum address
     * @returns DID string (e.g., "did:ethr:8453:0x...")
     */
    async buildDID(address) {
        (0, validation_1.validateAddress)(address, 'address');
        const chainId = await this.getChainId();
        return `did:ethr:${chainId}:${address.toLowerCase()}`;
    }
    // ========== PRIVATE HELPERS ==========
    /**
     * Safely convert bigint to number, throwing if precision would be lost
     */
    safeToNumber(value, fieldName) {
        const bigIntValue = typeof value === 'bigint' ? value : BigInt(value);
        if (bigIntValue > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`${fieldName} exceeds JavaScript MAX_SAFE_INTEGER`);
        }
        if (bigIntValue < BigInt(Number.MIN_SAFE_INTEGER)) {
            throw new Error(`${fieldName} below JavaScript MIN_SAFE_INTEGER`);
        }
        return Number(bigIntValue);
    }
    _mapProfile(profile) {
        return {
            agentAddress: profile.agentAddress,
            did: profile.did,
            endpoint: profile.endpoint,
            serviceTypes: [...profile.serviceTypes], // H-4: Clone array
            stakedAmount: profile.stakedAmount,
            reputationScore: this.safeToNumber(profile.reputationScore, 'reputationScore'),
            totalTransactions: this.safeToNumber(profile.totalTransactions, 'totalTransactions'),
            disputedTransactions: this.safeToNumber(profile.disputedTransactions, 'disputedTransactions'),
            totalVolumeUSDC: profile.totalVolumeUSDC,
            registeredAt: this.safeToNumber(profile.registeredAt, 'registeredAt'),
            updatedAt: this.safeToNumber(profile.updatedAt, 'updatedAt'),
            isActive: Boolean(profile.isActive)
        };
    }
}
exports.AgentRegistry = AgentRegistry;
//# sourceMappingURL=AgentRegistry.js.map