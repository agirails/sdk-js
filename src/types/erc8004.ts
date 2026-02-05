/**
 * ERC-8004 Trustless Agents - SDK Types
 *
 * Types and constants for ERC-8004 integration.
 *
 * SECURITY NOTES:
 * - Identity Registry is read-only (safe, no gas)
 * - Reputation Registry writes require gas (requester pays)
 * - Replay protection via feedbackHash = keccak256(txId)
 * - ERC-8004 restriction: feedback submitter ≠ agent owner
 *
 * @see https://eips.ethereum.org/EIPS/eip-8004
 * @module types/erc8004
 */

// ============================================================================
// Networks
// ============================================================================

/**
 * Networks with ERC-8004 registry deployments.
 */
export type ERC8004Network = 'ethereum' | 'base' | 'base-sepolia';

// ============================================================================
// Identity Types (from Identity Registry)
// ============================================================================

/**
 * Agent identity resolved from ERC-8004 Identity Registry.
 */
export interface ERC8004Agent {
  /** ERC-8004 agent ID (uint256 as string) */
  agentId: string;

  /** Owner address (EOA that controls the NFT) */
  owner: string;

  /** Payment wallet address (checksummed) */
  wallet: string;

  /** Agent URI (IPFS or HTTPS, points to metadata JSON) */
  agentURI: string;

  /** Parsed metadata from agentURI (may be undefined if fetch fails) */
  metadata?: ERC8004AgentMetadata;

  /** Network where agent is registered */
  network: ERC8004Network;
}

/**
 * Agent metadata schema from ERC-8004 agentURI.
 *
 * Standard fields defined by ERC-8004, plus arbitrary extensions.
 */
export interface ERC8004AgentMetadata {
  /** Human-readable agent name */
  name?: string;

  /** Agent description */
  description?: string;

  /** Agent avatar/logo URL */
  image?: string;

  /** Wallet address for receiving payments (overrides owner) */
  paymentAddress?: string;

  /** Alternative field name for payment address */
  wallet?: string;

  /** List of agent capabilities */
  capabilities?: string[];

  /** Service endpoints */
  endpoints?: {
    api?: string;
    webhook?: string;
  };

  /** Allow arbitrary extensions */
  [key: string]: unknown;
}

// ============================================================================
// Reputation Types (from Reputation Registry)
// ============================================================================

/**
 * Feedback entry for ERC-8004 Reputation Registry.
 *
 * For ACTP settlements, we use binary values:
 * - value: 1 (success) or -1 (dispute lost)
 * - valueDecimals: 0 (no fractional part)
 */
export interface ReputationFeedback {
  /** ERC-8004 agent ID */
  agentId: string;

  /**
   * Feedback value.
   * For ACTP: 1 = successful settlement, -1 = dispute lost
   */
  value: number;

  /**
   * Decimal precision for value.
   * For ACTP: always 0 (binary)
   */
  valueDecimals: number;

  /**
   * Primary tag for categorization.
   * ACTP uses: 'actp_settled', 'actp_dispute_won', 'actp_dispute_lost'
   */
  tag1: string;

  /**
   * Secondary tag for filtering.
   * ACTP uses: capability (e.g., 'code_generation', 'data_analysis')
   */
  tag2: string;

  /** Service endpoint (optional) */
  endpoint?: string;

  /** Link to detailed feedback (optional, IPFS or HTTPS) */
  feedbackURI?: string;

  /**
   * Hash for replay protection.
   * ACTP uses: keccak256(txId)
   */
  feedbackHash: string;
}

/**
 * Aggregated reputation summary for an agent.
 */
export interface ReputationSummary {
  /** ERC-8004 agent ID */
  agentId: string;

  /** Total feedback count */
  feedbackCount: number;

  /** Count of positive feedback (value > 0) */
  positiveCount: number;

  /** Count of negative feedback (value < 0) */
  negativeCount: number;

  /** Aggregated score (sum of values) */
  score: number;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * ERC-8004 error codes.
 */
export enum ERC8004ErrorCode {
  // Identity errors
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  INVALID_AGENT_ID = 'INVALID_AGENT_ID',
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  METADATA_FETCH_FAILED = 'METADATA_FETCH_FAILED',

  // Reputation errors
  REPORT_FAILED = 'REPORT_FAILED',
  ALREADY_REPORTED = 'ALREADY_REPORTED',
  NOT_AUTHORIZED = 'NOT_AUTHORIZED',

  // Network errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  INVALID_NETWORK = 'INVALID_NETWORK',
}

/**
 * Custom error for ERC-8004 operations.
 */
export class ERC8004Error extends Error {
  constructor(
    message: string,
    public readonly code: ERC8004ErrorCode,
    public readonly agentId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ERC8004Error';

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ERC8004Error);
    }
  }
}

// ============================================================================
// Registry Addresses
// ============================================================================

/**
 * ERC-8004 Identity Registry addresses per network.
 *
 * NOTE: Update with canonical addresses when available.
 * Zero addresses indicate registry not yet deployed.
 */
export const ERC8004_IDENTITY_REGISTRY: Record<ERC8004Network, string> = {
  ethereum: '0x0000000000000000000000000000000000000000', // TBD - Mainnet
  base: '0x0000000000000000000000000000000000000000', // TBD - Base Mainnet
  'base-sepolia': '0x0000000000000000000000000000000000000000', // TBD - Testnet
};

/**
 * ERC-8004 Reputation Registry addresses per network.
 *
 * NOTE: Update with canonical addresses when available.
 * Zero addresses indicate registry not yet deployed.
 */
export const ERC8004_REPUTATION_REGISTRY: Record<ERC8004Network, string> = {
  ethereum: '0x0000000000000000000000000000000000000000', // TBD - Mainnet
  base: '0x0000000000000000000000000000000000000000', // TBD - Base Mainnet
  'base-sepolia': '0x0000000000000000000000000000000000000000', // TBD - Testnet
};

// ============================================================================
// ABI Fragments (minimal, view-only for Bridge)
// ============================================================================

/**
 * Minimal ABI for ERC-8004 Identity Registry.
 * Only includes view functions needed by ERC8004Bridge.
 */
export const ERC8004_IDENTITY_ABI = [
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentURI(uint256 agentId) view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
] as const;

/**
 * Minimal ABI for ERC-8004 Reputation Registry.
 * Includes both read and write functions.
 */
export const ERC8004_REPUTATION_ABI = [
  // Write
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external',
  'function revokeLatest(uint256 agentId, uint64 feedbackIndex) external',
  // Read
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint256 count, int256 summaryValue, uint8 summaryValueDecimals)',
  'function readFeedback(uint256 agentId, uint64 feedbackIndex) view returns (tuple(int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked, uint64 feedbackIndex))',
] as const;

// ============================================================================
// Default RPC URLs
// ============================================================================

/**
 * Default RPC URLs for each network.
 * Used when no custom RPC is provided.
 */
export const ERC8004_DEFAULT_RPC: Record<ERC8004Network, string> = {
  ethereum: 'https://eth.llamarpc.com',
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
};

// ============================================================================
// ACTP-specific constants
// ============================================================================

/**
 * ACTP feedback tags for ERC-8004 Reputation.
 */
export const ACTP_FEEDBACK_TAGS = {
  /** Successful settlement */
  SETTLED: 'actp_settled',

  /** Agent won dispute */
  DISPUTE_WON: 'actp_dispute_won',

  /** Agent lost dispute (requester won) */
  DISPUTE_LOST: 'actp_dispute_lost',
} as const;

/**
 * Type for ACTP feedback tags.
 */
export type ACTPFeedbackTag = (typeof ACTP_FEEDBACK_TAGS)[keyof typeof ACTP_FEEDBACK_TAGS];
