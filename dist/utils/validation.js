"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateAddress = validateAddress;
exports.validateAmount = validateAmount;
exports.validateDeadline = validateDeadline;
exports.validateDisputeWindow = validateDisputeWindow;
exports.validateTxId = validateTxId;
exports.validateEndpointURL = validateEndpointURL;
const ethers_1 = require("ethers");
const errors_1 = require("../errors");
/**
 * Input validation utilities
 */
/**
 * Validate Ethereum address
 */
function validateAddress(address, fieldName = 'address') {
    if (!address || !(0, ethers_1.isAddress)(address)) {
        throw new errors_1.InvalidAddressError(address);
    }
    if (address === (0, ethers_1.getAddress)('0x0000000000000000000000000000000000000000')) {
        throw new errors_1.ValidationError(fieldName, 'Address cannot be zero address');
    }
}
/**
 * Validate amount (must be > 0)
 */
function validateAmount(amount, _fieldName = 'amount') {
    // Handle null/undefined before calling toString()
    if (!amount) {
        throw new errors_1.InvalidAmountError(String(amount)); // Convert safely to string
    }
    if (amount <= 0n) {
        throw new errors_1.InvalidAmountError(amount.toString());
    }
}
/**
 * Validate deadline (must be future timestamp)
 */
function validateDeadline(deadline, fieldName = 'deadline') {
    const now = Math.floor(Date.now() / 1000);
    if (deadline <= now) {
        throw new errors_1.ValidationError(fieldName, `Deadline must be in the future (now: ${now}, deadline: ${deadline})`);
    }
}
/**
 * Validate dispute window (max 30 days per spec)
 */
function validateDisputeWindow(disputeWindow, fieldName = 'disputeWindow') {
    const MAX_DISPUTE_WINDOW = 30 * 24 * 60 * 60; // 30 days in seconds
    if (disputeWindow < 0) {
        throw new errors_1.ValidationError(fieldName, 'Dispute window cannot be negative');
    }
    if (disputeWindow > MAX_DISPUTE_WINDOW) {
        throw new errors_1.ValidationError(fieldName, `Dispute window exceeds maximum (${MAX_DISPUTE_WINDOW}s = 30 days)`);
    }
}
/**
 * Validate transaction ID format
 */
function validateTxId(txId, fieldName = 'txId') {
    if (!txId || !txId.match(/^0x[a-fA-F0-9]{64}$/)) {
        throw new errors_1.ValidationError(fieldName, 'Invalid transaction ID format (expected bytes32)');
    }
}
/**
 * Validate endpoint URL (for AgentRegistry)
 *
 * Security checks:
 * - Valid URL format
 * - HTTPS or IPFS protocols only
 * - No private/local IP addresses (SSRF protection)
 * - Maximum length 256 characters
 */
function validateEndpointURL(endpoint, fieldName = 'endpoint') {
    if (!endpoint || endpoint.length === 0) {
        throw new errors_1.ValidationError(fieldName, 'Endpoint is required');
    }
    const MAX_LENGTH = 256;
    if (endpoint.length > MAX_LENGTH) {
        throw new errors_1.ValidationError(fieldName, `Endpoint exceeds maximum length (${MAX_LENGTH})`);
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(endpoint);
    }
    catch (e) {
        throw new errors_1.ValidationError(fieldName, 'Endpoint must be a valid URL');
    }
    const allowedProtocols = ['https:', 'ipfs:'];
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
        throw new errors_1.ValidationError(fieldName, `Endpoint protocol must be one of: ${allowedProtocols.join(', ')}`);
    }
    // Block private IPs (SSRF protection)
    // Note: For IPv6, URL().hostname includes brackets e.g., "[::1]"
    const hostname = parsedUrl.hostname;
    const privateIPPatterns = [
        // IPv4 private ranges
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^192\.168\./,
        /^169\.254\./,
        /^0\./,
        /^localhost$/i,
        // IPv6 localhost and private ranges (with brackets as returned by URL parser)
        /^\[::1\]$/, // IPv6 localhost
        /^\[::ffff:7f/, // IPv4-mapped IPv6 localhost (127.x.x.x -> 7f in hex)
        /^\[::ffff:a/, // IPv4-mapped IPv6 private (10.x.x.x -> a in hex)
        /^\[::ffff:c0a8:/, // IPv4-mapped IPv6 private (192.168.x.x -> c0a8 in hex)
        /^\[::ffff:ac1[0-9a-f]:/, // IPv4-mapped IPv6 private (172.16-31.x.x -> ac1x in hex)
        /^\[fc00:/, // IPv6 unique local (private) fc00::/7
        /^\[fd/, // IPv6 unique local (private) fd00::/8
        /^\[fe80:/, // IPv6 link-local fe80::/10
    ];
    for (const pattern of privateIPPatterns) {
        if (pattern.test(hostname)) {
            throw new errors_1.ValidationError(fieldName, 'Endpoint cannot point to private/local addresses');
        }
    }
}
//# sourceMappingURL=validation.js.map