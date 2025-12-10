/**
 * Agent Registry Types (AIP-7)
 *
 * Types for AI agent identity, registration, and reputation
 */

/**
 * Service descriptor metadata for an agent
 */
export interface ServiceDescriptor {
  /** keccak256(lowercase(serviceType)) */
  serviceTypeHash: string;
  /** Human-readable service type (lowercase, alphanumeric + hyphens) */
  serviceType: string;
  /** IPFS/HTTPS URL to JSON Schema for inputData */
  schemaURI: string;
  /** Minimum price in USDC base units (6 decimals) */
  minPrice: bigint;
  /** Maximum price in USDC base units */
  maxPrice: bigint;
  /** Average completion time in seconds */
  avgCompletionTime: number;
  /** IPFS CID to full service descriptor JSON */
  metadataCID: string;
}

/**
 * Agent profile stored on-chain
 */
export interface AgentProfile {
  /** Agent's Ethereum address (controller of DID) */
  agentAddress: string;
  /** Full DID (e.g., did:ethr:8453:0x...) */
  did: string;
  /** HTTPS endpoint or IPFS gateway URL */
  endpoint: string;
  /** Supported service type hashes */
  serviceTypes: string[];
  /** USDC staked (V1: always 0, V2: slashing for disputes) */
  stakedAmount: bigint;
  /** Aggregated reputation (scale: 0-10000, 2 decimals precision) */
  reputationScore: number;
  /** Count of completed SETTLED transactions */
  totalTransactions: number;
  /** Count of transactions that went to DISPUTED state */
  disputedTransactions: number;
  /** Cumulative transaction volume (6 decimals) */
  totalVolumeUSDC: bigint;
  /** Block timestamp of registration */
  registeredAt: number;
  /** Last profile update timestamp */
  updatedAt: number;
  /** Agent is accepting new requests */
  isActive: boolean;
}

/**
 * Parameters for registering a new agent
 */
export interface RegisterAgentParams {
  /** HTTPS endpoint or IPFS gateway URL */
  endpoint: string;
  /** List of services the agent provides */
  serviceDescriptors: ServiceDescriptor[];
}

/**
 * Query parameters for finding agents by service
 */
export interface QueryAgentsParams {
  /** Service type hash to search for */
  serviceTypeHash: string;
  /** Minimum reputation score (0-10000) */
  minReputation?: number;
  /** Skip first N results (for pagination) */
  offset?: number;
  /** Maximum number of results to return */
  limit?: number;
}
