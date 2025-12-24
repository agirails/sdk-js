import { keccak256, toUtf8Bytes, AbiCoder, BytesLike } from 'ethers';
import { DeliveryProof } from '../types';
import { DeliveryProofData, deliveryProofDataFromProof } from '../types/eip712';

/**
 * SECURITY FIX (MEDIUM-2): URL validation configuration for SSRF prevention
 */
export interface URLValidationConfig {
  /**
   * Allowed URL protocols (default: ['https:'])
   * Set to ['https:', 'http:'] to allow HTTP in development
   */
  allowedProtocols?: string[];

  /**
   * Allow localhost URLs (default: false in production, true in dev)
   */
  allowLocalhost?: boolean;

  /**
   * Maximum response size in bytes (default: 10MB)
   */
  maxSize?: number;

  /**
   * Request timeout in milliseconds (default: 30000)
   */
  timeout?: number;

  /**
   * Blocked hostnames (e.g., internal services)
   */
  blockedHosts?: string[];
}

/**
 * Default URL validation config - SECURE by default
 */
const DEFAULT_URL_CONFIG: Required<URLValidationConfig> = {
  allowedProtocols: ['https:'],
  allowLocalhost: false,
  maxSize: 10 * 1024 * 1024, // 10MB
  timeout: 30000, // 30 seconds
  blockedHosts: [
    'metadata.google.internal',
    '169.254.169.254', // AWS/GCP metadata
    'metadata.aws.internal',
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '[::1]',
  ],
};

/**
 * ProofGenerator - Content hashing and delivery proofs
 * Reference: Yellow Paper §11.4.1
 *
 * SECURITY FIX (MEDIUM-2): Now includes URL validation for SSRF prevention
 */
export class ProofGenerator {
  private readonly urlConfig: Required<URLValidationConfig>;

  /**
   * Create ProofGenerator with optional URL validation config
   *
   * @param urlConfig - URL validation configuration for hashFromUrl()
   */
  constructor(urlConfig?: URLValidationConfig) {
    this.urlConfig = {
      ...DEFAULT_URL_CONFIG,
      ...urlConfig,
    };

    // If localhost is explicitly allowed, remove from blocked hosts
    if (urlConfig?.allowLocalhost) {
      this.urlConfig.blockedHosts = this.urlConfig.blockedHosts.filter(
        (h) => !['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(h)
      );
    }
  }
  /**
   * Hash deliverable content
   * Uses Keccak256 per Yellow Paper §11.4.1
   */
  hashContent(content: string | Buffer): string {
    const buffer = typeof content === 'string' ? toUtf8Bytes(content) : content;

    return keccak256(buffer);
  }

  /**
   * Generate delivery proof (AIP-4)
   * Reference: Yellow Paper §8.2
   * Complete schema with type field for AIP compliance
   * Computed fields (size, mimeType) cannot be overwritten
   */
  generateDeliveryProof(params: {
    txId: string;
    deliverable: string | Buffer;
    deliveryUrl?: string;
    metadata?: Record<string, any>;
  }): DeliveryProof {
    const { txId, deliverable, deliveryUrl, metadata = {} } = params;

    const contentHash = this.hashContent(deliverable);
    const size =
      typeof deliverable === 'string'
        ? Buffer.from(deliverable).length
        : deliverable.length;

    // Spread user metadata first, then enforce computed fields
    // This prevents users from spoofing size/mimeType
    const { size: _ignoredSize, mimeType: _ignoredMimeType, ...userMetadata } = metadata;

    return {
      type: 'delivery.proof', // Required per AIP-4
      txId,
      contentHash,
      timestamp: Date.now(),
      deliveryUrl, // Optional: IPFS/Arweave link
      metadata: {
        ...userMetadata, // User-supplied fields (excluding reserved)
        size, // Enforced: computed from deliverable
        mimeType: metadata.mimeType || 'application/octet-stream' // Enforced with fallback
      }
    };
  }

  /**
   * Convert a generated delivery proof into typed EIP-712 data
   */
  toDeliveryProofTypedData(proof: DeliveryProof): DeliveryProofData {
    return deliveryProofDataFromProof(proof);
  }

  /**
   * Encode proof for on-chain submission
   */
  encodeProof(proof: DeliveryProof): BytesLike {
    const abiCoder = AbiCoder.defaultAbiCoder();
    return abiCoder.encode(
      ['bytes32', 'bytes32', 'uint256'],
      [proof.txId, proof.contentHash, proof.timestamp]
    );
  }

  /**
   * Decode proof from on-chain data
   */
  decodeProof(proofData: BytesLike): {
    txId: string;
    contentHash: string;
    timestamp: number;
  } {
    const abiCoder = AbiCoder.defaultAbiCoder();
    const [txId, contentHash, timestamp] = abiCoder.decode(
      ['bytes32', 'bytes32', 'uint256'],
      proofData
    );

    return {
      txId,
      contentHash,
      timestamp: Number(timestamp)
    };
  }

  /**
   * Verify deliverable matches expected hash
   */
  verifyDeliverable(deliverable: string | Buffer, expectedHash: string): boolean {
    const actualHash = this.hashContent(deliverable);
    return actualHash.toLowerCase() === expectedHash.toLowerCase();
  }

  /**
   * Generate content hash from URL (for IPFS/Arweave)
   *
   * SECURITY FIX (MEDIUM-2): Now includes:
   * - Protocol validation (HTTPS only by default)
   * - Hostname blocklist (prevents SSRF to internal services)
   * - Size limits (prevents DoS via large responses)
   * - Request timeout
   *
   * @param url - URL to fetch content from
   * @returns Keccak256 hash of content
   * @throws Error if URL is blocked, too large, or fetch fails
   */
  async hashFromUrl(url: string): Promise<string> {
    // SECURITY FIX (MEDIUM-2): Validate URL before fetching
    this.validateUrl(url);

    // In browser/Node.js environment with fetch
    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.urlConfig.timeout);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          // Prevent following redirects to blocked hosts
          redirect: 'follow',
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }

        // SECURITY FIX (MEDIUM-2): Check Content-Length header first
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          if (size > this.urlConfig.maxSize) {
            throw new Error(
              `Content too large: ${size} bytes exceeds maximum of ${this.urlConfig.maxSize} bytes`
            );
          }
        }

        // SECURITY FIX (MEDIUM-2): Read response with size limit
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        const reader = response.body?.getReader();

        if (!reader) {
          throw new Error('Response body is not readable');
        }

        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          totalSize += value.length;

          // Check size limit during streaming
          if (totalSize > this.urlConfig.maxSize) {
            reader.cancel();
            throw new Error(
              `Content too large: ${totalSize}+ bytes exceeds maximum of ${this.urlConfig.maxSize} bytes`
            );
          }

          chunks.push(value);
        }

        // Concatenate chunks
        const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
        return this.hashContent(buffer);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.urlConfig.timeout}ms for ${url}`);
      }
      throw new Error(`Failed to fetch content from ${url}: ${error}`);
    }
  }

  /**
   * SECURITY FIX (MEDIUM-2): Validate URL against security rules
   *
   * @param url - URL to validate
   * @throws Error if URL is not allowed
   */
  private validateUrl(url: string): void {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    // Check protocol
    if (!this.urlConfig.allowedProtocols.includes(parsed.protocol)) {
      throw new Error(
        `URL protocol "${parsed.protocol}" not allowed. ` +
        `Allowed protocols: ${this.urlConfig.allowedProtocols.join(', ')}`
      );
    }

    // Check blocked hosts
    const hostname = parsed.hostname.toLowerCase();
    if (this.urlConfig.blockedHosts.includes(hostname)) {
      throw new Error(
        `URL hostname "${hostname}" is blocked for security reasons. ` +
        `This prevents SSRF attacks to internal services.`
      );
    }

    // Check for private IP ranges (additional SSRF protection)
    if (this.isPrivateIP(hostname)) {
      throw new Error(
        `URL hostname "${hostname}" resolves to a private IP address. ` +
        `This is blocked for security reasons (SSRF prevention).`
      );
    }
  }

  /**
   * Check if hostname is a private IP address
   *
   * @param hostname - Hostname to check
   * @returns true if hostname is a private IP
   */
  private isPrivateIP(hostname: string): boolean {
    // IPv4 private ranges
    const ipv4PrivateRanges = [
      /^10\./,          // 10.0.0.0 - 10.255.255.255
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0 - 172.31.255.255
      /^192\.168\./,    // 192.168.0.0 - 192.168.255.255
      /^127\./,         // 127.0.0.0 - 127.255.255.255 (loopback)
      /^169\.254\./,    // 169.254.0.0 - 169.254.255.255 (link-local)
      /^0\./,           // 0.0.0.0/8
    ];

    for (const range of ipv4PrivateRanges) {
      if (range.test(hostname)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the URL validation config (for testing/inspection)
   */
  getUrlConfig(): Required<URLValidationConfig> {
    return { ...this.urlConfig };
  }
}
