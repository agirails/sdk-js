/**
 * IPFS Client Implementation
 * Wrapper around kubo-rpc-client (formerly ipfs-http-client) for AIP-4 delivery proof uploads
 */

import { create, IPFSHTTPClient, Options } from 'kubo-rpc-client';
import { sdkLogger } from './Logger';

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

  /**
   * SECURITY FIX (MEDIUM-3): Maximum content size in bytes
   * Default: 50MB (50 * 1024 * 1024)
   */
  maxSize?: number;

  /**
   * SECURITY FIX (MEDIUM-3): Allowed URL protocols
   * Default: ['http:', 'https:'] (http for localhost, https for remote)
   */
  allowedProtocols?: string[];

  /**
   * SECURITY FIX (MEDIUM-3): Allow localhost URLs
   * Default: true (required for local IPFS daemon)
   */
  allowLocalhost?: boolean;
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
 *
 * SECURITY FIX (MEDIUM-3): Now includes URL and size validation
 */
export class IPFSHTTPClientImpl implements IPFSClient {
  private client: IPFSHTTPClient;
  private config: Required<IPFSClientConfig>;

  // SECURITY FIX (MEDIUM-3): Default security settings
  private static readonly DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50MB
  private static readonly DEFAULT_ALLOWED_PROTOCOLS = ['http:', 'https:'];
  private static readonly BLOCKED_HOSTS = [
    'metadata.google.internal',
    '169.254.169.254',
    'metadata.aws.internal',
  ];

  /**
   * Create IPFS client
   *
   * SECURITY FIX (MEDIUM-3): Validates URL and adds size limits
   *
   * @param config - IPFS client configuration
   * @throws Error if URL is invalid or blocked
   */
  constructor(config: IPFSClientConfig = {}) {
    const url = config.url || 'http://localhost:5001';

    // SECURITY FIX (MEDIUM-3): Validate URL
    this.validateUrl(url, config.allowLocalhost ?? true, config.allowedProtocols);

    this.config = {
      url,
      timeout: config.timeout || 60000,
      maxSize: config.maxSize || IPFSHTTPClientImpl.DEFAULT_MAX_SIZE,
      allowedProtocols: config.allowedProtocols || IPFSHTTPClientImpl.DEFAULT_ALLOWED_PROTOCOLS,
      allowLocalhost: config.allowLocalhost ?? true,
      auth: config.auth,
      headers: config.headers,
    } as Required<IPFSClientConfig>;

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
   * SECURITY FIX (MEDIUM-3): Validate IPFS endpoint URL
   */
  private validateUrl(
    url: string,
    allowLocalhost: boolean,
    allowedProtocols?: string[]
  ): void {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid IPFS endpoint URL: ${url}`);
    }

    const protocols = allowedProtocols || IPFSHTTPClientImpl.DEFAULT_ALLOWED_PROTOCOLS;
    if (!protocols.includes(parsed.protocol)) {
      throw new Error(
        `IPFS endpoint protocol "${parsed.protocol}" not allowed. ` +
        `Allowed protocols: ${protocols.join(', ')}`
      );
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check blocked hosts (cloud metadata endpoints)
    if (IPFSHTTPClientImpl.BLOCKED_HOSTS.includes(hostname)) {
      throw new Error(
        `IPFS endpoint hostname "${hostname}" is blocked for security reasons.`
      );
    }

    // Check localhost
    const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(hostname);
    if (isLocalhost && !allowLocalhost) {
      throw new Error(
        `Localhost IPFS endpoints are disabled. Set allowLocalhost: true to enable.`
      );
    }

    // For remote hosts, require HTTPS
    if (!isLocalhost && parsed.protocol !== 'https:') {
      sdkLogger.warn('Using non-HTTPS protocol for remote IPFS endpoint - data may be exposed in transit', {
        protocol: parsed.protocol,
        hostname,
      });
    }
  }

  /**
   * Upload data to IPFS
   *
   * SECURITY FIX (MEDIUM-3): Validates size before upload
   *
   * @param data - JSON string or buffer
   * @returns CIDv1 string (base32)
   * @throws Error if data exceeds maxSize
   */
  async add(data: string | Buffer): Promise<string> {
    try {
      const content = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;

      // SECURITY FIX (MEDIUM-3): Check size before upload
      if (content.length > this.config.maxSize) {
        throw new Error(
          `Content too large: ${content.length} bytes exceeds maximum of ${this.config.maxSize} bytes`
        );
      }

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
   *
   * SECURITY FIX (MEDIUM-3): Validates size during retrieval
   *
   * @param cid - IPFS CID
   * @returns Content as string
   * @throws Error if content exceeds maxSize
   */
  async get(cid: string): Promise<string> {
    try {
      const chunks: Uint8Array[] = [];
      let totalLength = 0;

      for await (const chunk of this.client.cat(cid)) {
        totalLength += chunk.length;

        // SECURITY FIX (MEDIUM-3): Check size during streaming to prevent DoS
        if (totalLength > this.config.maxSize) {
          throw new Error(
            `Content too large: ${totalLength}+ bytes exceeds maximum of ${this.config.maxSize} bytes. ` +
            `Consider increasing maxSize in IPFSClientConfig if this is expected.`
          );
        }

        chunks.push(chunk);
      }

      // Concatenate all chunks
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
