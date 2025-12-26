/**
 * Options for Basic and Standard APIs
 *
 * @packageDocumentation
 */

import { Job } from './Job';

/**
 * Wallet configuration options
 */
export type WalletOption =
  | 'auto'                    // SDK generates managed wallet
  | 'connect'                 // Browser wallet popup (future)
  | string                    // Private key directly
  | { privateKey: string };   // Private key in object form

/**
 * Network options
 */
export type NetworkOption = 'mock' | 'testnet' | 'mainnet';

/**
 * Options for provide() function (Basic API)
 */
export interface ProvideOptions {
  /**
   * Wallet configuration
   *
   * - 'auto': SDK generates and manages a wallet automatically
   * - 'connect': Open browser wallet connection (MetaMask, etc.) - FUTURE
   * - string: Private key (0x-prefixed hex)
   * - object: { privateKey: string }
   *
   * @default 'auto'
   */
  wallet?: WalletOption;

  /**
   * Job filtering criteria
   *
   * Only accept jobs matching these filters.
   */
  filter?: {
    /**
     * Minimum budget in USDC
     *
     * @example
     * filter: { minBudget: 5 } // Only accept jobs with budget >= $5
     */
    minBudget?: number;

    /**
     * Maximum budget in USDC
     *
     * @example
     * filter: { maxBudget: 100 } // Only accept jobs with budget <= $100
     */
    maxBudget?: number;
  };

  /**
   * Auto-accept policy
   *
   * - true: Automatically accept all jobs matching filter
   * - false: Require manual acceptance
   * - function: Custom logic to decide whether to accept
   *
   * @default true
   *
   * @example
   * ```typescript
   * // Auto-accept if budget >= 10
   * autoAccept: (job) => job.budget >= 10
   *
   * // Auto-accept high-priority jobs
   * autoAccept: (job) => job.metadata?.priority === 'high'
   * ```
   */
  autoAccept?: boolean | ((job: Job) => boolean | Promise<boolean>);

  /**
   * Network to operate on
   *
   * @default 'mock'
   */
  network?: NetworkOption;

  /**
   * RPC URL for blockchain connection (required for testnet/mainnet)
   *
   * If not provided, defaults to public RPC from network config:
   * - testnet: https://sepolia.base.org
   * - mainnet: https://mainnet.base.org
   *
   * For production, consider using a dedicated RPC provider (Alchemy, Infura, etc.)
   * for better reliability and rate limits.
   *
   * @example
   * rpcUrl: 'https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY'
   */
  rpcUrl?: string;

  /**
   * State directory for mock mode
   *
   * Where to store mock state file.
   * Only used when network is 'mock'.
   *
   * @default process.cwd()
   */
  stateDirectory?: string;
}

/**
 * Request status updates
 */
export interface RequestStatus {
  /**
   * Current state of the request
   */
  state: 'initiated' | 'quoted' | 'committed' | 'in_progress' | 'delivered' | 'settled' | 'disputed' | 'cancelled';

  /**
   * Progress percentage (0-100) if provider is reporting progress
   */
  progress?: number;

  /**
   * Progress message if available
   */
  message?: string;

  /**
   * Estimated time to completion (seconds)
   */
  eta?: number;
}

/**
 * Options for request() function (Basic API)
 */
export interface RequestOptions {
  /**
   * Input data to send to the service
   */
  input: any;

  /**
   * Budget in USDC (decimal format)
   *
   * @example
   * budget: 10 // $10.00
   */
  budget: number;

  /**
   * Wallet configuration (same as ProvideOptions)
   *
   * @default 'auto'
   */
  wallet?: WalletOption;

  /**
   * Network to operate on
   *
   * @default 'mock'
   */
  network?: NetworkOption;

  /**
   * Timeout in milliseconds
   *
   * @default 300000 (5 minutes)
   */
  timeout?: number;

  /**
   * Deadline for job completion
   *
   * Can be a timestamp (seconds) or Date object.
   * If not specified, defaults to now + timeout.
   *
   * @example
   * deadline: Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
   * deadline: new Date('2025-12-14T12:00:00Z')
   */
  deadline?: number | Date;

  /**
   * Provider selection strategy
   *
   * - string: Specific provider address
   * - 'any': First available provider
   * - 'best': Provider with highest reputation
   * - 'cheapest': Provider with lowest price
   *
   * @default 'any'
   */
  provider?: string | 'any' | 'best' | 'cheapest';

  /**
   * Progress callback
   *
   * Called when provider reports progress updates.
   *
   * @example
   * ```typescript
   * onProgress: (status) => {
   *   console.log(`${status.state}: ${status.progress}% - ${status.message}`);
   * }
   * ```
   */
  onProgress?: (status: RequestStatus) => void;

  /**
   * State directory for mock mode
   *
   * @default process.cwd()
   */
  stateDirectory?: string;

  /**
   * RPC URL for blockchain connection (required for testnet/mainnet)
   *
   * If not provided, defaults to public RPC from network config:
   * - testnet: https://sepolia.base.org
   * - mainnet: https://mainnet.base.org
   *
   * For production, consider using a dedicated RPC provider (Alchemy, Infura, etc.)
   * for better reliability and rate limits.
   *
   * @example
   * rpcUrl: 'https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY'
   */
  rpcUrl?: string;

  /**
   * Dispute window duration in seconds
   *
   * Time after delivery during which requester can dispute.
   *
   * @default 172800 (2 days)
   */
  disputeWindow?: number;
}

/**
 * Result of request() function
 */
export interface RequestResult {
  /**
   * The result returned by the provider's handler
   */
  result: any;

  /**
   * Transaction metadata
   */
  transaction: {
    /**
     * Transaction ID (ACTP protocol)
     */
    id: string;

    /**
     * Provider address
     */
    provider: string;

    /**
     * Amount paid (USDC)
     */
    amount: number;

    /**
     * Platform fee (USDC)
     */
    fee: number;

    /**
     * Job duration (milliseconds)
     */
    duration: number;

    /**
     * Delivery proof hash
     */
    proof: string;
  };
}
