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
export declare const QuoteRequestTypes: {
    QuoteRequest: {
        name: string;
        type: string;
    }[];
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
export declare const QuoteResponseTypes: {
    QuoteResponse: {
        name: string;
        type: string;
    }[];
};
export interface QuoteResponseData {
    from: string;
    to: string;
    timestamp: number;
    nonce: string;
    requestId: string;
    price: string;
    currency: string;
    deliveryTime: number;
    terms: string;
}
/**
 * DeliveryProof (AIP-4) - DEPRECATED
 * @deprecated Use AIP4DeliveryProofTypes instead (AIP-4 v1.1)
 */
export declare const DeliveryProofTypes: {
    DeliveryProof: {
        name: string;
        type: string;
    }[];
};
export interface DeliveryProofData {
    txId: string;
    contentHash: string;
    timestamp: number;
    deliveryUrl: string;
    size: number;
    mimeType: string;
}
export declare function deliveryProofDataFromProof(proof: DeliveryProof): DeliveryProofData;
/**
 * AIP-4 Delivery Proof (v1.1)
 * Reference: AIP-4 §3.3
 */
export declare const AIP4DeliveryProofTypes: {
    DeliveryProof: {
        name: string;
        type: string;
    }[];
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
export declare const ACTPMessageTypes: {
    ACTPMessage: {
        name: string;
        type: string;
    }[];
};
/**
 * Message type registry
 */
export declare const MESSAGE_TYPES: {
    'quote.request': {
        QuoteRequest: {
            name: string;
            type: string;
        }[];
    };
    'quote.response': {
        QuoteResponse: {
            name: string;
            type: string;
        }[];
    };
    'delivery.proof': {
        DeliveryProof: {
            name: string;
            type: string;
        }[];
    };
    default: {
        ACTPMessage: {
            name: string;
            type: string;
        }[];
    };
};
/**
 * Get EIP-712 types for message type
 */
export declare function getMessageTypes(messageType: string): Record<string, any>;
//# sourceMappingURL=eip712.d.ts.map