import { DeliveryProof } from './message';

/**
 * EIP-712 Type Definitions for ACTP Messages
 * Reference: Yellow Paper §11.4.2
 * 
 * Each AIP message has explicit typed data for cross-language compatibility
 */

/**
 * EIP-712 Domain for ACTP
 */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/**
 * QuoteRequest (AIP-2)
 * Reference: Yellow Paper §4.2
 */
export const QuoteRequestTypes = {
  QuoteRequest: [
    { name: 'from', type: 'string' }, // DID
    { name: 'to', type: 'string' }, // DID
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'serviceType', type: 'string' },
    { name: 'requirements', type: 'string' },
    { name: 'deadline', type: 'uint256' },
    { name: 'disputeWindow', type: 'uint256' }
  ]
};

export interface QuoteRequestData {
  from: string;
  to: string;
  timestamp: number;
  nonce: string;
  serviceType: string;
  requirements: string;
  deadline: number;
  disputeWindow: number;
}

/**
 * QuoteResponse (AIP-2)
 * Reference: Yellow Paper §4.2
 */
export const QuoteResponseTypes = {
  QuoteResponse: [
    { name: 'from', type: 'string' },
    { name: 'to', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'requestId', type: 'bytes32' },
    { name: 'price', type: 'uint256' },
    { name: 'currency', type: 'address' },
    { name: 'deliveryTime', type: 'uint256' },
    { name: 'terms', type: 'string' }
  ]
};

export interface QuoteResponseData {
  from: string;
  to: string;
  timestamp: number;
  nonce: string;
  requestId: string;
  price: string; // BigNumber as string
  currency: string;
  deliveryTime: number;
  terms: string;
}

/**
 * DeliveryProof (AIP-4) - DEPRECATED
 * @deprecated Use AIP4DeliveryProofTypes instead (AIP-4 v1.1)
 */
export const DeliveryProofTypes = {
  DeliveryProof: [
    { name: 'txId', type: 'bytes32' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'deliveryUrl', type: 'string' },
    { name: 'size', type: 'uint256' },
    { name: 'mimeType', type: 'string' }
  ]
};

export interface DeliveryProofData {
  txId: string;
  contentHash: string;
  timestamp: number;
  deliveryUrl: string;
  size: number;
  mimeType: string;
}

export function deliveryProofDataFromProof(proof: DeliveryProof): DeliveryProofData {
  return {
    txId: proof.txId,
    contentHash: proof.contentHash,
    timestamp: proof.timestamp,
    deliveryUrl: proof.deliveryUrl || '',
    size: proof.metadata.size,
    mimeType: proof.metadata.mimeType
  };
}

/**
 * AIP-4 Delivery Proof (v1.1)
 * Reference: AIP-4 §3.3
 */
export const AIP4DeliveryProofTypes = {
  DeliveryProof: [
    { name: 'txId', type: 'bytes32' },
    { name: 'provider', type: 'string' },
    { name: 'consumer', type: 'string' },
    { name: 'resultCID', type: 'string' },
    { name: 'resultHash', type: 'bytes32' },
    { name: 'easAttestationUID', type: 'bytes32' },
    { name: 'deliveredAt', type: 'uint256' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ]
};

export interface AIP4DeliveryProofData {
  txId: string;
  provider: string;
  consumer: string;
  resultCID: string;
  resultHash: string;
  easAttestationUID: string;
  deliveredAt: number;
  chainId: number;
  nonce: number;
}

/**
 * Generic ACTPMessage (fallback for custom AIPs)
 */
export const ACTPMessageTypes = {
  ACTPMessage: [
    { name: 'type', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'from', type: 'string' },
    { name: 'to', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'payload', type: 'bytes' }
  ]
};

/**
 * Message type registry
 */
export const MESSAGE_TYPES = {
  'quote.request': QuoteRequestTypes,
  'quote.response': QuoteResponseTypes,
  'delivery.proof': DeliveryProofTypes,
  // Fallback for custom/future AIPs
  default: ACTPMessageTypes
};

/**
 * Get EIP-712 types for message type
 */
export function getMessageTypes(messageType: string): Record<string, any> {
  return MESSAGE_TYPES[messageType as keyof typeof MESSAGE_TYPES] || MESSAGE_TYPES.default;
}

/**
 * Generic EIP-712 typed data structure (for x402 v2, Permit2, etc.).
 *
 * Consumed by `IWalletProvider.signTypedData` and the x402 adapter.
 * Plain objects only — matches the no-library-types-at-interface-boundary
 * convention used by IWalletProvider.
 */
export interface EIP712TypedData {
  /** EIP-712 domain separator fields (name, version, chainId, verifyingContract, etc.) */
  domain: Record<string, unknown>;
  /** Type definitions keyed by type name. EIP712Domain entry may be omitted. */
  types: Record<string, Array<{ name: string; type: string }>>;
  /** Name of the primary type to sign */
  primaryType: string;
  /** The message values to sign */
  message: Record<string, unknown>;
}

