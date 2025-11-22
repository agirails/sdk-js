/**
 * ACTP Message Types
 * Reference: Yellow Paper §4-10 (AIPs)
 */

/**
 * Base ACTP message structure
 */
export interface ACTPMessage {
  type: string;
  version: string;
  from: string; // DID
  to: string; // DID
  timestamp: number;
  nonce: string;
  signature?: string;
  [key: string]: any;
}

/**
 * Quote Request (AIP-2)
 * Reference: Yellow Paper §6.2.1
 */
export interface QuoteRequest extends ACTPMessage {
  type: 'quote.request';
  serviceRequest: {
    capabilityType: string;
    parameters: Record<string, any>;
    deliveryRequirements: {
      deadline: string;
      maxDeliveryTime: string;
    };
  };
  budgetConstraints: {
    maxPrice: string;
    currency: 'USDC';
  };
  expiresAt: string;
}

/**
 * Quote Response (AIP-2)
 * Reference: Yellow Paper §6.2.2
 */
export interface QuoteResponse extends ACTPMessage {
  type: 'quote.response';
  inResponseTo: string;
  quoteId: string;
  pricing: {
    totalPrice: string;
    currency: 'USDC';
    breakdown: Array<{ item: string; amount: string }>;
    platformFee: string;
  };
  sla: {
    successRateGuarantee: number;
    refundPolicy: string;
  };
  expiresAt: string;
}

/**
 * Delivery Proof (AIP-4) - DEPRECATED
 * @deprecated Use DeliveryProofMessage instead (AIP-4 v1.1)
 */
export interface DeliveryProof {
  type: 'delivery.proof';
  txId: string;
  contentHash: string;
  timestamp: number;
  deliveryUrl?: string;
  metadata: {
    size: number;
    mimeType: string;
    [key: string]: any;
  };
}

/**
 * Delivery Proof Message (AIP-4 v1.1)
 * Reference: AIP-4 §3.2, §8.1
 * Complete schema for delivery proofs with EAS attestations
 */
export interface DeliveryProofMessage {
  type: 'agirails.delivery.v1';
  version: string; // Semantic version (e.g., "1.0.0")
  txId: string; // bytes32 (0x-prefixed)
  provider: string; // DID (e.g., "did:ethr:84532:0x...")
  consumer: string; // DID
  resultCID: string; // IPFS CID (CIDv1, base32, e.g., "bafybeig...")
  resultHash: string; // Keccak256 hash of canonical result JSON
  metadata?: {
    executionTime?: number; // Seconds
    outputFormat?: string; // MIME type
    outputSize?: number; // Bytes
    notes?: string; // Max 500 chars
  };
  easAttestationUID: string; // bytes32 (0x-prefixed)
  deliveredAt: number; // Unix timestamp (seconds)
  chainId: number; // 84532 (Base Sepolia) or 8453 (Base Mainnet)
  nonce: number; // Monotonically increasing
  signature: string; // EIP-712 signature (0x-prefixed, 130 chars)
}

/**
 * EAS Attestation Data for delivery proofs
 */
export interface EASAttestationData {
  schema: string; // EAS schema UID
  recipient: string; // Provider address
  expirationTime: number; // Unix timestamp (0 for no expiration)
  revocable: boolean;
  refUID: string; // Reference to transaction
  data: string; // ABI-encoded attestation data
}

/**
 * Quote Message (AIP-2 v1.0)
 * Reference: AIP-2 §2.1, §2.2
 * Price quote submitted by provider for negotiated transactions
 */
export interface QuoteMessageV2 {
  type: 'agirails.quote.v1';
  version: '1.0.0';
  txId: string; // bytes32 (0x-prefixed)
  provider: string; // DID (e.g., "did:ethr:84532:0x...")
  consumer: string; // DID
  quotedAmount: string; // Provider's quoted price (base units, string to avoid JS overflow)
  originalAmount: string; // Consumer's original offer from AIP-1
  maxPrice: string; // Consumer's maximum acceptable price from AIP-1
  currency: string; // Currently "USDC" only
  decimals: number; // Token decimals (6 for USDC)
  quotedAt: number; // Unix timestamp (seconds)
  expiresAt: number; // Unix timestamp (seconds)
  justification?: {
    reason?: string;
    estimatedTime?: number;
    computeCost?: number;
    breakdown?: Record<string, any>;
  };
  chainId: number; // 84532 (Base Sepolia) or 8453 (Base Mainnet)
  nonce: number; // Monotonically increasing per provider + message type
  signature: string; // EIP-712 signature (0x-prefixed, 130 chars)
}

