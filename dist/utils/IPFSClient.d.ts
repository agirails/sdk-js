/**
 * IPFS Client Implementation
 * Wrapper around kubo-rpc-client (formerly ipfs-http-client) for AIP-4 delivery proof uploads
 */
/**
 * IPFS Client Interface (from DeliveryProofBuilder)
 */
export interface IPFSClient {
    /**
     * Upload data to IPFS
     * @param data - JSON string or buffer
     * @returns CIDv1 string (base32, e.g., "bafybeig...")
     */
    add(data: string | Buffer): Promise<string>;
    /**
     * Pin content to prevent garbage collection
     * @param cid - IPFS CID
     */
    pin(cid: string): Promise<void>;
    /**
     * Retrieve content from IPFS
     * @param cid - IPFS CID
     * @returns Content as string
     */
    get(cid: string): Promise<string>;
}
/**
 * IPFS Client Configuration
 */
export interface IPFSClientConfig {
    /**
     * IPFS HTTP API endpoint
     * Default: http://localhost:5001 (local IPFS daemon)
     * Production: https://ipfs.infura.io:5001/api/v0 (Infura)
     */
    url?: string;
    /**
     * API authentication (for Infura, Pinata, etc.)
     */
    auth?: {
        username: string;
        password: string;
    };
    /**
     * HTTP headers (for API keys)
     */
    headers?: Record<string, string>;
    /**
     * Request timeout (ms)
     * Default: 60000 (60 seconds)
     */
    timeout?: number;
}
/**
 * Default IPFS configurations
 */
export declare const IPFS_CONFIGS: {
    local: {
        url: string;
    };
    infura: {
        url: string;
    };
    pinata: {
        url: string;
    };
};
/**
 * IPFS HTTP Client Implementation
 * Uses ipfs-http-client library
 */
export declare class IPFSHTTPClientImpl implements IPFSClient {
    private client;
    private config;
    /**
     * Create IPFS client
     * @param config - IPFS client configuration
     */
    constructor(config?: IPFSClientConfig);
    /**
     * Upload data to IPFS
     * @param data - JSON string or buffer
     * @returns CIDv1 string (base32)
     */
    add(data: string | Buffer): Promise<string>;
    /**
     * Pin content to prevent garbage collection
     * @param cid - IPFS CID
     */
    pin(cid: string): Promise<void>;
    /**
     * Retrieve content from IPFS
     * @param cid - IPFS CID
     * @returns Content as string
     */
    get(cid: string): Promise<string>;
    /**
     * Check if IPFS daemon is reachable
     * @returns true if connected, false otherwise
     */
    isOnline(): Promise<boolean>;
    /**
     * Get IPFS node ID
     * @returns IPFS node ID
     */
    getNodeId(): Promise<string>;
}
/**
 * Create IPFS client with environment-based configuration
 * Checks for IPFS_URL, INFURA_PROJECT_ID, PINATA_API_KEY env vars
 */
export declare function createIPFSClient(): IPFSClient;
//# sourceMappingURL=IPFSClient.d.ts.map