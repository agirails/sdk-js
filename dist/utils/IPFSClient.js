"use strict";
/**
 * IPFS Client Implementation
 * Wrapper around kubo-rpc-client (formerly ipfs-http-client) for AIP-4 delivery proof uploads
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPFSHTTPClientImpl = exports.IPFS_CONFIGS = void 0;
exports.createIPFSClient = createIPFSClient;
const kubo_rpc_client_1 = require("kubo-rpc-client");
/**
 * Default IPFS configurations
 */
exports.IPFS_CONFIGS = {
    local: {
        url: 'http://localhost:5001'
    },
    infura: {
        url: 'https://ipfs.infura.io:5001/api/v0'
        // Auth required: Set INFURA_PROJECT_ID and INFURA_PROJECT_SECRET
    },
    pinata: {
        url: 'https://api.pinata.cloud'
        // Headers required: Set pinata_api_key and pinata_secret_api_key
    }
};
/**
 * IPFS HTTP Client Implementation
 * Uses ipfs-http-client library
 */
class IPFSHTTPClientImpl {
    /**
     * Create IPFS client
     * @param config - IPFS client configuration
     */
    constructor(config = {}) {
        this.config = {
            url: config.url || 'http://localhost:5001',
            timeout: config.timeout || 60000,
            ...config
        };
        const options = {
            url: this.config.url,
            timeout: this.config.timeout
        };
        // Add authentication if provided
        if (this.config.auth) {
            options.headers = {
                ...this.config.headers,
                authorization: 'Basic ' + Buffer.from(`${this.config.auth.username}:${this.config.auth.password}`).toString('base64')
            };
        }
        else if (this.config.headers) {
            options.headers = this.config.headers;
        }
        this.client = (0, kubo_rpc_client_1.create)(options);
    }
    /**
     * Upload data to IPFS
     * @param data - JSON string or buffer
     * @returns CIDv1 string (base32)
     */
    async add(data) {
        try {
            const content = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
            const result = await this.client.add(content, {
                cidVersion: 1, // Use CIDv1 (base32)
                hashAlg: 'sha2-256',
                pin: true // Auto-pin on upload
            });
            // Convert CID to base32 string (e.g., "bafybeig...")
            return result.cid.toString();
        }
        catch (error) {
            throw new Error(`IPFS upload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Pin content to prevent garbage collection
     * @param cid - IPFS CID
     */
    async pin(cid) {
        try {
            await this.client.pin.add(cid);
        }
        catch (error) {
            throw new Error(`IPFS pin failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Retrieve content from IPFS
     * @param cid - IPFS CID
     * @returns Content as string
     */
    async get(cid) {
        try {
            const chunks = [];
            for await (const chunk of this.client.cat(cid)) {
                chunks.push(chunk);
            }
            // Concatenate all chunks
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            return Buffer.from(result).toString('utf-8');
        }
        catch (error) {
            throw new Error(`IPFS retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Check if IPFS daemon is reachable
     * @returns true if connected, false otherwise
     */
    async isOnline() {
        try {
            await this.client.id();
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Get IPFS node ID
     * @returns IPFS node ID
     */
    async getNodeId() {
        try {
            const id = await this.client.id();
            return id.id.toString();
        }
        catch (error) {
            throw new Error(`Failed to get node ID: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
exports.IPFSHTTPClientImpl = IPFSHTTPClientImpl;
/**
 * Create IPFS client with environment-based configuration
 * Checks for IPFS_URL, INFURA_PROJECT_ID, PINATA_API_KEY env vars
 */
function createIPFSClient() {
    // Check for Infura credentials
    if (process.env.INFURA_PROJECT_ID && process.env.INFURA_PROJECT_SECRET) {
        return new IPFSHTTPClientImpl({
            url: 'https://ipfs.infura.io:5001/api/v0',
            auth: {
                username: process.env.INFURA_PROJECT_ID,
                password: process.env.INFURA_PROJECT_SECRET
            }
        });
    }
    // Check for Pinata credentials
    if (process.env.PINATA_API_KEY && process.env.PINATA_SECRET_API_KEY) {
        return new IPFSHTTPClientImpl({
            url: 'https://api.pinata.cloud',
            headers: {
                pinata_api_key: process.env.PINATA_API_KEY,
                pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY
            }
        });
    }
    // Check for custom IPFS URL
    if (process.env.IPFS_URL) {
        return new IPFSHTTPClientImpl({
            url: process.env.IPFS_URL
        });
    }
    // Default to local IPFS daemon
    return new IPFSHTTPClientImpl({
        url: 'http://localhost:5001'
    });
}
//# sourceMappingURL=IPFSClient.js.map