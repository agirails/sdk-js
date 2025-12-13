"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MESSAGE_TYPES = exports.ACTPMessageTypes = exports.AIP4DeliveryProofTypes = exports.DeliveryProofTypes = exports.QuoteResponseTypes = exports.QuoteRequestTypes = void 0;
exports.deliveryProofDataFromProof = deliveryProofDataFromProof;
exports.getMessageTypes = getMessageTypes;
/**
 * QuoteRequest (AIP-2)
 * Reference: Yellow Paper §4.2
 */
exports.QuoteRequestTypes = {
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
/**
 * QuoteResponse (AIP-2)
 * Reference: Yellow Paper §4.2
 */
exports.QuoteResponseTypes = {
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
/**
 * DeliveryProof (AIP-4) - DEPRECATED
 * @deprecated Use AIP4DeliveryProofTypes instead (AIP-4 v1.1)
 */
exports.DeliveryProofTypes = {
    DeliveryProof: [
        { name: 'txId', type: 'bytes32' },
        { name: 'contentHash', type: 'bytes32' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'deliveryUrl', type: 'string' },
        { name: 'size', type: 'uint256' },
        { name: 'mimeType', type: 'string' }
    ]
};
function deliveryProofDataFromProof(proof) {
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
exports.AIP4DeliveryProofTypes = {
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
/**
 * Generic ACTPMessage (fallback for custom AIPs)
 */
exports.ACTPMessageTypes = {
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
exports.MESSAGE_TYPES = {
    'quote.request': exports.QuoteRequestTypes,
    'quote.response': exports.QuoteResponseTypes,
    'delivery.proof': exports.DeliveryProofTypes,
    // Fallback for custom/future AIPs
    default: exports.ACTPMessageTypes
};
/**
 * Get EIP-712 types for message type
 */
function getMessageTypes(messageType) {
    return exports.MESSAGE_TYPES[messageType] || exports.MESSAGE_TYPES.default;
}
//# sourceMappingURL=eip712.js.map