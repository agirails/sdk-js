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
    from: string;
    to: string;
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
        breakdown: Array<{
            item: string;
            amount: string;
        }>;
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
    version: string;
    txId: string;
    provider: string;
    consumer: string;
    resultCID: string;
    resultHash: string;
    metadata?: {
        executionTime?: number;
        outputFormat?: string;
        outputSize?: number;
        notes?: string;
    };
    easAttestationUID: string;
    deliveredAt: number;
    chainId: number;
    nonce: number;
    signature: string;
}
/**
 * EAS Attestation Data for delivery proofs
 */
export interface EASAttestationData {
    schema: string;
    recipient: string;
    expirationTime: number;
    revocable: boolean;
    refUID: string;
    data: string;
}
/**
 * Quote Message (AIP-2 v1.0)
 * Reference: AIP-2 §2.1, §2.2
 * Price quote submitted by provider for negotiated transactions
 */
export interface QuoteMessageV2 {
    type: 'agirails.quote.v1';
    version: '1.0.0';
    txId: string;
    provider: string;
    consumer: string;
    quotedAmount: string;
    originalAmount: string;
    maxPrice: string;
    currency: string;
    decimals: number;
    quotedAt: number;
    expiresAt: number;
    justification?: {
        reason?: string;
        estimatedTime?: number;
        computeCost?: number;
        breakdown?: Record<string, any>;
    };
    chainId: number;
    nonce: number;
    signature: string;
}
//# sourceMappingURL=message.d.ts.map