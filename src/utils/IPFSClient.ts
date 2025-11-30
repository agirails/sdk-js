/**
 * IPFS Client Implementation
 * Wrapper around kubo-rpc-client (formerly ipfs-http-client) for AIP-4 delivery proof uploads
 */

import { create, IPFSHTTPClient, Options } from 'kubo-rpc-client';

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
export const IPFS_CONFIGS = {
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
export class IPFSHTTPClientImpl implements IPFSClient {
  private client: IPFSHTTPClient;
  private config: IPFSClientConfig;

  /**
   * Create IPFS client
   * @param config - IPFS client configuration
   */
  constructor(config: IPFSClientConfig = {}) {
    this.config = {
      url: config.url || 'http://localhost:5001',
      timeout: config.timeout || 60000,
      ...config
    };

    const options: Options = {
      url: this.config.url,
      timeout: this.config.timeout
    };

    // Add authentication if provided
    if (this.config.auth) {
      options.headers = {
        ...this.config.headers,
        authorization: 'Basic ' + Buffer.from(
          `${this.config.auth.username}:${this.config.auth.password}`
        ).toString('base64')
      };
    } else if (this.config.headers) {
      options.headers = this.config.headers;
    }

    this.client = create(options);
  }

  /**
   * Upload data to IPFS
   * @param data - JSON string or buffer
   * @returns CIDv1 string (base32)
   */
  async add(data: string | Buffer): Promise<string> {
    try {
      const content = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

      const result = await this.client.add(content, {
        cidVersion: 1, // Use CIDv1 (base32)
        hashAlg: 'sha2-256',
        pin: true // Auto-pin on upload
      });

      // Convert CID to base32 string (e.g., "bafybeig...")
      return result.cid.toString();
    } catch (error) {
      throw new Error(`IPFS upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Pin content to prevent garbage collection
   * @param cid - IPFS CID
   */
  async pin(cid: string): Promise<void> {
    try {
      await this.client.pin.add(cid);
    } catch (error) {
      throw new Error(`IPFS pin failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Retrieve content from IPFS
   * @param cid - IPFS CID
   * @returns Content as string
   */
  async get(cid: string): Promise<string> {
    try {
      const chunks: Uint8Array[] = [];

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
    } catch (error) {
      throw new Error(`IPFS retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if IPFS daemon is reachable
   * @returns true if connected, false otherwise
   */
  async isOnline(): Promise<boolean> {
    try {
      await this.client.id();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get IPFS node ID
   * @returns IPFS node ID
   */
  async getNodeId(): Promise<string> {
    try {
      const id = await this.client.id();
      return id.id.toString();
    } catch (error) {
      throw new Error(`Failed to get node ID: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Create IPFS client with environment-based configuration
 * Checks for IPFS_URL, INFURA_PROJECT_ID, PINATA_API_KEY env vars
 */
export function createIPFSClient(): IPFSClient {
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
