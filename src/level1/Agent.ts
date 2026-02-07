/**
 * Agent - Standard API for AI agents
 *
 * Provides agent-level abstractions: lifecycle, service provision,
 * job handling, events, and statistics.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ethers } from 'ethers';
import { ACTPClient } from '../ACTPClient';
import { resolvePrivateKey } from '../wallet/keystore';
import { Job, JobHandler, JobContext } from './types/Job';
import { RequestOptions, RequestResult, NetworkOption } from './types/Options';
import { PricingStrategy } from './pricing/PricingStrategy';
import { AgentLifecycleError, ServiceConfigError, ValidationError } from '../errors';
import { validateServiceName, validatePath, LRUCache } from '../utils/security';
import { Logger } from '../utils/Logger';
import { ServiceHash } from '../utils/Helpers';
import { Semaphore } from '../utils/Semaphore';
import { ProofGenerator } from '../protocol/ProofGenerator';

/**
 * Agent lifecycle states
 */
export type AgentStatus = 'idle' | 'starting' | 'running' | 'paused' | 'stopping' | 'stopped';

/**
 * Service filter configuration
 */
export interface ServiceFilter {
  /**
   * Minimum budget in USDC (e.g., 5.00 for $5)
   */
  minBudget?: number;

  /**
   * Maximum budget in USDC (e.g., 100.00 for $100)
   */
  maxBudget?: number;

  /**
   * Custom filter function
   */
  custom?: (job: Job) => boolean;
}

/**
 * Service configuration
 */
export interface ServiceConfig {
  /**
   * Service name (e.g., 'translation', 'echo')
   */
  name: string;

  /**
   * Human-readable description
   */
  description?: string;

  /**
   * Pricing strategy (cost + margin model)
   */
  pricing?: PricingStrategy;

  /**
   * Service capabilities/tags
   */
  capabilities?: string[];

  /**
   * Job filter (function or filter config)
   */
  filter?: ServiceFilter | ((job: Job) => boolean);

  /**
   * Timeout per job (milliseconds)
   */
  timeout?: number;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  /**
   * Agent name
   */
  name: string;

  /**
   * Agent description
   */
  description?: string;

  /**
   * Wallet configuration
   */
  wallet?: 'auto' | 'connect' | string | { privateKey: string };

  /**
   * Network
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
   * State directory (mock mode only)
   */
  stateDirectory?: string;

  /**
   * Behavior configuration
   */
  behavior?: {
    /**
     * Auto-accept jobs
     */
    autoAccept?: boolean | ((job: Job) => boolean | Promise<boolean>);

    /**
     * Max concurrent jobs
     */
    concurrency?: number;

    /**
     * Retry configuration
     */
    retry?: {
      attempts?: number;
      delay?: number;
      backoff?: 'linear' | 'exponential';
    };
  };

  /**
   * Persistence configuration
   */
  persistence?: {
    enabled?: boolean;
    path?: string;
  };

  /**
   * Logging configuration
   */
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
  };
}

/**
 * Agent statistics
 */
export interface AgentStats {
  jobsReceived: number;
  jobsCompleted: number;
  jobsFailed: number;
  totalEarned: number;
  totalSpent: number;
  averageJobTime: number;
  successRate: number;
}

/**
 * Agent balance information
 */
export interface AgentBalance {
  eth: string;
  usdc: string;
  locked: string;
  pending: string;
}

/**
 * Agent class - Standard API
 *
 * Represents an autonomous AI agent that can provide services,
 * request services from other agents, and manage its lifecycle.
 *
 * @example
 * ```typescript
 * const agent = new Agent({ name: 'Translator', network: 'mock' });
 *
 * agent.provide('translation', async (job, ctx) => {
 *   ctx.progress(50, 'Translating...');
 *   return { translated: translate(job.input.text) };
 * });
 *
 * agent.on('payment:received', (amount) => {
 *   console.log(`Earned ${amount} USDC!`);
 * });
 *
 * await agent.start();
 * ```
 */
export class Agent extends EventEmitter {
  /**
   * Agent name
   */
  public readonly name: string;

  /**
   * Agent description
   */
  public readonly description?: string;

  /**
   * Network the agent operates on
   */
  public readonly network: NetworkOption;

  /**
   * Current agent status
   */
  private _status: AgentStatus = 'idle';

  /**
   * ACTP Client instance
   */
  private _client?: ACTPClient;

  /**
   * Registered services
   */
  private services = new Map<string, { config: ServiceConfig; handler: JobHandler }>();

  /**
   * Active jobs
   *
   * SECURITY FIX (C-2): Changed from Map to LRUCache to prevent unbounded growth
   * Maximum 1000 active jobs with LRU eviction
   */
  private activeJobs = new LRUCache<string, Job>(1000);

  /**
   * Processed job IDs (for deduplication)
   *
   * SECURITY FIX (C-1): Track jobs we've attempted to process
   * This prevents race conditions where the same job is processed multiple times
   * before the state transition completes
   */
  private processedJobs = new LRUCache<string, boolean>(10000);

  /**
   * Processing locks (for atomic locking)
   *
   * SECURITY FIX (C-1): Mutex for job processing.
   * When we see a job, we IMMEDIATELY add to this set (atomic in single-threaded JS).
   * This prevents race conditions where two poll cycles both pass the processedJobs.has()
   * check before either calls processedJobs.set().
   */
  private processingLocks = new Set<string>();

  /**
   * Concurrency semaphore
   *
   * SECURITY FIX (MEDIUM-4): Limits concurrent job execution to prevent
   * resource exhaustion (memory/CPU DoS). Uses behavior.concurrency setting.
   */
  private concurrencySemaphore!: Semaphore;

  /**
   * Statistics
   */
  private _stats: AgentStats = {
    jobsReceived: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    totalEarned: 0,
    totalSpent: 0,
    averageJobTime: 0,
    successRate: 0,
  };

  /**
   * Cached balance (updated periodically during polling)
   */
  private _balance: AgentBalance = {
    eth: '0',
    usdc: '0',
    locked: '0',
    pending: '0',
  };

  /**
   * Configuration
   */
  private config: AgentConfig;

  /**
   * Polling interval ID (for job polling)
   */
  private pollingIntervalId?: NodeJS.Timeout;

  /**
   * Logger instance
   */
  private logger: Logger;

  /**
   * Creates a new Agent instance
   *
   * @param config - Agent configuration
   */
  constructor(config: AgentConfig) {
    super();

    if (!config.name) {
      throw new ServiceConfigError('name', 'Agent name is required');
    }

    // SECURITY FIX (H-6): Use dedicated AGIRAILS directory as base
    // This prevents writes anywhere in the project directory
    const AGIRAILS_BASE = path.join(os.homedir(), '.agirails');

    // Ensure base directory exists
    if (!fs.existsSync(AGIRAILS_BASE)) {
      fs.mkdirSync(AGIRAILS_BASE, { recursive: true });
    }

    // Validate state directory path if provided
    if (config.stateDirectory) {
      try {
        // Validate the path is safe (no traversal, within AGIRAILS_BASE)
        config.stateDirectory = validatePath(config.stateDirectory, AGIRAILS_BASE);
      } catch (error) {
        throw new ServiceConfigError(
          'stateDirectory',
          `Invalid state directory: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.name = config.name;
    this.description = config.description;
    this.network = config.network || 'mock';
    this.config = config;
    this.logger = new Logger({
      source: `Agent:${config.name}`,
      minLevel: config.logging?.level || 'info',
    });

    // SECURITY FIX (MEDIUM-4): Initialize concurrency semaphore
    // Default to 10 concurrent jobs if not specified
    const maxConcurrency = config.behavior?.concurrency || 10;
    this.concurrencySemaphore = new Semaphore(maxConcurrency);
    this.logger.debug('Initialized concurrency semaphore', { maxConcurrency });
  }

  // =========================================================================
  // Lifecycle Methods
  // =========================================================================

  /**
   * Start the agent
   *
   * Initializes ACTP client and begins polling for jobs.
   *
   * @throws {AgentLifecycleError} If agent is not in idle or stopped state
   */
  async start(): Promise<void> {
    if (this._status !== 'idle' && this._status !== 'stopped') {
      throw new AgentLifecycleError(this._status, 'start');
    }

    this._status = 'starting';
    this.emit('starting');

    try {
      // SECURITY FIX (RPCURL): Use rpcUrl from config or fallback to network default
      // This allows Agent to work with testnet/mainnet without requiring explicit rpcUrl
      // if user is okay with public RPC endpoints.
      let rpcUrl = this.config.rpcUrl;
      if (!rpcUrl && (this.network === 'testnet' || this.network === 'mainnet')) {
        // Import getNetwork to get default rpcUrl from network config
        const { getNetwork } = await import('../config/networks');
        const networkName = this.network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
        const networkConfig = getNetwork(networkName);
        rpcUrl = networkConfig.rpcUrl;
        this.logger.info(`Using default RPC URL for ${networkName}: ${rpcUrl}`);
      }

      // Initialize ACTP client
      this._client = await ACTPClient.create({
        mode: this.network === 'testnet' ? 'testnet' : this.network === 'mainnet' ? 'mainnet' : 'mock',
        requesterAddress: this.address || await this.generateAddress(),
        stateDirectory: this.config.stateDirectory,
        privateKey: await this.getPrivateKey(),
        rpcUrl,
      });

      // Start polling for jobs
      this.startPolling();

      this._status = 'running';
      this.emit('started');
    } catch (error) {
      this._status = 'stopped';
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the agent
   *
   * Stops polling and waits for active jobs to complete.
   */
  async stop(): Promise<void> {
    if (this._status === 'stopped' || this._status === 'stopping') {
      return;
    }

    this._status = 'stopping';
    this.emit('stopping');

    // Stop polling
    this.stopPolling();

    // Wait for active jobs to complete (with timeout)
    await this.waitForActiveJobs(30000); // 30s timeout

    this._status = 'stopped';
    this.emit('stopped');
  }

  /**
   * Pause the agent
   *
   * Stops accepting new jobs but keeps active jobs running.
   */
  pause(): void {
    if (this._status !== 'running') {
      throw new AgentLifecycleError(this._status, 'pause');
    }

    this.stopPolling();
    this._status = 'paused';
    this.emit('paused');
  }

  /**
   * Resume the agent
   *
   * Resumes accepting new jobs after being paused.
   */
  resume(): void {
    if (this._status !== 'paused') {
      throw new AgentLifecycleError(this._status, 'resume');
    }

    this.startPolling();
    this._status = 'running';
    this.emit('resumed');
  }

  /**
   * Restart the agent
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // =========================================================================
  // Service Registration
  // =========================================================================

  /**
   * Register a service handler
   *
   * @param serviceOrConfig - Service name or full configuration
   * @param handler - Job handler function
   * @param options - Optional pricing/filter configuration
   *
   * @example
   * ```typescript
   * // Simple
   * agent.provide('echo', async (job) => job.input);
   *
   * // With pricing
   * agent.provide({
   *   name: 'translation',
   *   pricing: {
   *     cost: { base: 0.5, perUnit: { unit: 'word', rate: 0.005 } },
   *     margin: 0.40
   *   }
   * }, async (job, ctx) => {
   *   // ... translation logic
   * });
   * ```
   */
  provide(
    serviceOrConfig: string | ServiceConfig,
    handler: JobHandler,
    options?: Partial<ServiceConfig>
  ): this {
    const config: ServiceConfig =
      typeof serviceOrConfig === 'string'
        ? { name: serviceOrConfig, ...options }
        : serviceOrConfig;

    if (!config.name) {
      throw new ServiceConfigError('name', 'Service name is required');
    }

    // SECURITY FIX (H-2): Validate service name to prevent injection
    try {
      config.name = validateServiceName(config.name);
    } catch (error) {
      throw new ServiceConfigError(
        'name',
        `Invalid service name: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (this.services.has(config.name)) {
      throw new ServiceConfigError('name', `Service "${config.name}" already registered`);
    }

    this.services.set(config.name, { config, handler });
    this.emit('service:registered', config.name);
    this.logger.info('Service registered', { service: config.name });

    return this;
  }

  /**
   * Request a service from another agent
   *
   * @param service - Service name
   * @param options - Request options
   * @returns Promise resolving to result
   */
  async request(service: string, options: Omit<RequestOptions, 'network'>): Promise<RequestResult> {
    if (!this._client) {
      throw new AgentLifecycleError(this._status, 'request (agent not started)');
    }

    // Import Basic API request function
    const { request: basicRequest } = await import('../level0/request');

    // Call Basic API request with agent's network
    const result = await basicRequest(service, {
      ...options,
      network: this.network,
    });

    // Update stats
    this._stats.totalSpent += options.budget;

    return result;
  }

  // =========================================================================
  // Properties
  // =========================================================================

  /**
   * Current agent status
   */
  get status(): AgentStatus {
    return this._status;
  }

  /**
   * Agent's Ethereum address
   */
  get address(): string {
    return this._client?.getAddress() || '';
  }

  /**
   * Registered service names
   */
  get serviceNames(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Active jobs
   *
   * SECURITY FIX (N-2): Now uses LRUCache.values() iterator.
   * Returns a snapshot of currently active jobs.
   */
  get jobs(): Job[] {
    return this.activeJobs.values();
  }

  /**
   * Statistics
   */
  get stats(): AgentStats {
    return { ...this._stats };
  }

  /**
   * Get agent balance
   *
   * Returns current USDC balance plus locked/pending amounts from active transactions.
   * Note: This is an async operation wrapped in a sync getter for convenience.
   * For real-time balance, use getBalanceAsync() instead.
   */
  get balance(): AgentBalance {
    // Return cached balance (updated periodically during polling)
    return { ...this._balance };
  }

  /**
   * Get agent balance asynchronously (real-time)
   *
   * @returns Promise resolving to current balance
   */
  async getBalanceAsync(): Promise<AgentBalance> {
    if (!this._client?.runtime) {
      return {
        eth: '0',
        usdc: '0',
        locked: '0',
        pending: '0',
      };
    }

    try {
      // Get USDC balance (if runtime supports it)
      let usdc = '0';
      if ('getBalance' in this._client.runtime) {
        usdc = await (this._client.runtime as any).getBalance(this.address);
      }

      // Get transactions where this agent is provider
      let locked = BigInt(0);
      let pending = BigInt(0);

      if ('getTransactionsByProvider' in this._client.runtime) {
        // Get all active transactions for this provider
        const allTx = await (this._client.runtime as any).getTransactionsByProvider(
          this.address,
          undefined, // all states
          1000
        );

        for (const tx of allTx) {
          const amount = BigInt(tx.amount || '0');

          // Locked: funds in escrow for active work (COMMITTED, IN_PROGRESS, DELIVERED)
          if (tx.state === 'COMMITTED' || tx.state === 'IN_PROGRESS' || tx.state === 'DELIVERED') {
            locked += amount;
          }

          // Pending: potential earnings waiting to be accepted (INITIATED, QUOTED)
          if (tx.state === 'INITIATED' || tx.state === 'QUOTED') {
            pending += amount;
          }
        }
      }

      this._balance = {
        eth: '0', // ETH balance not tracked in USDC-only system
        usdc: usdc,
        locked: locked.toString(),
        pending: pending.toString(),
      };

      return { ...this._balance };
    } catch (error) {
      this.logger.warn('Failed to fetch balance', { error });
      return { ...this._balance };
    }
  }

  /**
   * ACTP Client reference (for advanced usage)
   */
  get client(): ACTPClient | undefined {
    return this._client;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Start polling for new jobs
   */
  private startPolling(): void {
    if (this.pollingIntervalId) {
      return; // Already polling
    }

    const pollingInterval = 5000; // 5 seconds
    this.pollingIntervalId = setInterval(() => {
      this.pollForJobs().catch((error) => {
        this.emit('error', error);
      });
    }, pollingInterval);
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = undefined;
    }
  }

  /**
   * Poll for new jobs
   *
   * SECURITY FIXES:
   * - C-1: Race condition prevention using processedJobs deduplication
   * - C-2: Memory leak prevention using LRUCache
   * - H-1: DoS prevention by filtering transactions before loading all
   * - H-4: Authorization checks for state transitions
   *
   * Queries runtime for transactions where this agent is the provider
   * and the transaction is in INITIATED state (awaiting acceptance).
   * For each pending transaction, creates a Job object and invokes
   * the appropriate service handler.
   */
  private async pollForJobs(): Promise<void> {
    if (!this._client) {
      return; // Agent not started yet
    }

    try {
      // SECURITY FIX (H-1): Use filtered query instead of getAllTransactions
      // This prevents DoS via memory exhaustion by only fetching relevant transactions
      let pendingJobs: any[] = [];

      // Check if runtime has the filtered query method
      if ('getTransactionsByProvider' in this._client.runtime) {
        // Use optimized filtered query (max 100 jobs per poll)
        pendingJobs = await (this._client.runtime as any).getTransactionsByProvider(
          this.address,
          'INITIATED',
          100
        );
      } else {
        // Fallback to getAllTransactions (for older runtime versions)
        const allTransactions = await this._client.runtime.getAllTransactions();
        pendingJobs = allTransactions.filter(
          (tx) => tx.provider === this.address && tx.state === 'INITIATED'
        );
      }

      this.logger.debug('Polling for jobs', {
        pendingJobs: pendingJobs.length,
      });

      // Process each pending job
      for (const tx of pendingJobs) {
        try {
          // SECURITY FIX (C-1): Check processingLocks first (atomic check)
          // This prevents race conditions where two poll cycles both try to process
          // the same job before either transitions the state
          if (this.processingLocks.has(tx.id) || this.processedJobs.has(tx.id)) {
            continue;
          }

          // IMMEDIATELY acquire lock (atomic in single-threaded JS)
          this.processingLocks.add(tx.id);

          // SECURITY FIX (C-2): Check if already in active jobs (LRUCache handles size limit)
          if (this.activeJobs.has(tx.id)) {
            this.processingLocks.delete(tx.id);
            continue;
          }

          // SECURITY FIX (H-4): Verify this agent is authorized to accept this transaction
          // Check that tx.provider matches our address (prevents unauthorized state transitions)
          if (tx.provider !== this.address) {
            this.logger.warn('Unauthorized transaction detected', {
              txId: tx.id,
              expectedProvider: this.address,
              actualProvider: tx.provider,
            });
            this.processingLocks.delete(tx.id);
            continue;
          }

          // Find matching service handler
          const serviceHandler = this.findServiceHandler(tx);
          if (!serviceHandler) {
            // No handler registered for this service type
            this.logger.debug('No handler for transaction', { txId: tx.id });
            this.processingLocks.delete(tx.id);
            continue;
          }

          // Check auto-accept behavior
          const shouldAccept = await this.shouldAutoAccept(tx);
          if (!shouldAccept) {
            this.logger.debug('Auto-accept declined', { txId: tx.id });
            this.processingLocks.delete(tx.id);
            continue;
          }

          // Create Job object from transaction
          const job = this.createJobFromTransaction(tx);

          // SECURITY FIX (C-2): Add to active jobs (LRUCache prevents unbounded growth)
          this.activeJobs.set(job.id, job);

          // Link escrow immediately to transition out of INITIATED state
          // This prevents polling from picking up this job again
          try {
            if (this._client && tx.state === 'INITIATED') {
              await this._client.runtime.linkEscrow(tx.id, tx.amount);
            }

            // Successfully processed - mark as processed and release lock
            this.processedJobs.set(job.id, true);
          } catch (escrowError) {
            // If linking escrow fails, remove from active jobs and release lock (allow retry)
            this.activeJobs.delete(job.id);
            this.logger.error('Failed to link escrow', { txId: tx.id }, escrowError as Error);
            this.processingLocks.delete(tx.id);
            continue;
          } finally {
            // Always release the lock
            this.processingLocks.delete(tx.id);
          }

          this._stats.jobsReceived++;
          this.emit('job:received', job);
          this.logger.info('Job accepted', { jobId: job.id, service: job.service });

          // Process the job asynchronously (don't await here to continue polling)
          this.processJob(job, serviceHandler.handler).catch((error) => {
            this.logger.error('Job processing failed', { jobId: job.id }, error as Error);
            this.emit('error', error);
          });
        } catch (error) {
          // Log error but continue processing other jobs
          this.logger.error('Error processing pending job', { txId: tx.id }, error as Error);
          this.emit('error', error);
        }
      }

      // Update cached balance (non-blocking, don't await)
      this.getBalanceAsync().catch(() => {
        // Silently ignore balance update errors during polling
      });
    } catch (error) {
      // Polling error - will retry on next interval
      this.logger.error('Polling error', {}, error as Error);
      this.emit('error', error);
    }
  }

  /**
   * Find service handler for a transaction
   *
   * SECURITY FIX (MEDIUM): Use exact field matching instead of substring search
   * to prevent service routing spoofing attacks.
   *
   * Supports multiple formats (in priority order):
   * 1. JSON: {"service":"name","input":...} - new structured format
   * 2. Legacy: "service:name;input:..." - backward compatibility
   * 3. Plain string exact match - simple service name
   * 4. bytes32 hash - on-chain only (requires off-chain lookup)
   */
  private findServiceHandler(
    tx: any
  ): { config: ServiceConfig; handler: JobHandler } | undefined {
    const serviceDesc = tx.serviceDescription;
    if (!serviceDesc) {
      return undefined;
    }

    let parsedService: string | undefined;

    // 1. Try JSON format first (new structured format from request())
    try {
      const jsonMetadata = JSON.parse(serviceDesc);
      if (jsonMetadata && typeof jsonMetadata.service === 'string') {
        parsedService = jsonMetadata.service;
      }
    } catch {
      // Not JSON, try other formats
    }

    // 2. Try legacy "service:NAME;input:JSON" format
    if (!parsedService) {
      const legacyMetadata = ServiceHash.fromLegacy(serviceDesc);
      if (legacyMetadata) {
        parsedService = legacyMetadata.service;
      }
    }

    // 3. If we parsed a service name, do EXACT match
    if (parsedService) {
      const handler = this.services.get(parsedService);
      if (handler) {
        return handler;
      }
    }

    // 4. Check if it's a bytes32 hash (from on-chain BlockchainRuntime)
    // NOTE: For hashed metadata, the original data must be retrieved from
    // event logs or off-chain storage. This is a fallback for hash-only matching.
    if (ServiceHash.isValidHash(serviceDesc)) {
      this.logger.debug('Service description is a hash - cannot extract service name', {
        hash: serviceDesc.slice(0, 18) + '...',
      });
      // Cannot match hashes without original data
      // In production, use event indexing to get original metadata
      return undefined;
    }

    // 5. Fallback: Plain string exact match (service name directly)
    for (const [serviceName, handler] of this.services.entries()) {
      // EXACT match only - prevent substring spoofing
      if (serviceDesc === serviceName) {
        return handler;
      }
    }

    return undefined;
  }

  /**
   * Check if job should be auto-accepted
   *
   * SECURITY FIX (MVP): Added pricing strategy evaluation
   * - Checks service-level filters (budget constraints)
   * - Evaluates pricing strategy if configured
   * - Only accepts jobs that meet pricing requirements
   */
  private async shouldAutoAccept(tx: any): Promise<boolean> {
    // Get the service config for this transaction
    const serviceHandler = this.findServiceHandler(tx);

    // Check service-level filters first (budget constraints)
    if (serviceHandler?.config.filter) {
      const filter = serviceHandler.config.filter;
      const budget = this.convertAmountToNumber(tx.amount);

      // If filter is a ServiceFilter object, check budget constraints
      if (typeof filter === 'object' && !Array.isArray(filter)) {
        // Check minBudget
        if (filter.minBudget !== undefined && budget < filter.minBudget) {
          this.logger.debug('Job rejected: budget below minimum', {
            txId: tx.id,
            budget,
            minBudget: filter.minBudget,
          });
          return false;
        }

        // Check maxBudget
        if (filter.maxBudget !== undefined && budget > filter.maxBudget) {
          this.logger.debug('Job rejected: budget above maximum', {
            txId: tx.id,
            budget,
            maxBudget: filter.maxBudget,
          });
          return false;
        }

        // Check custom filter function
        if (filter.custom && typeof filter.custom === 'function') {
          const job = this.createJobFromTransaction(tx);
          const customResult = filter.custom(job);
          if (!customResult) {
            this.logger.debug('Job rejected: custom filter declined', { txId: tx.id });
            return false;
          }
        }
      }
      // If filter is a function (legacy support)
      else if (typeof filter === 'function') {
        const job = this.createJobFromTransaction(tx);
        const filterResult = filter(job);
        if (!filterResult) {
          this.logger.debug('Job rejected: filter function declined', { txId: tx.id });
          return false;
        }
      }
    }

    // MVP: Check pricing strategy if configured
    if (serviceHandler?.config.pricing) {
      const { calculatePrice } = await import('./pricing/PriceCalculator');
      const job = this.createJobFromTransaction(tx);

      try {
        const calculation = calculatePrice(serviceHandler.config.pricing, job);

        this.logger.debug('Pricing calculation', {
          txId: tx.id,
          cost: calculation.cost,
          price: calculation.price,
          profit: calculation.profit,
          margin: calculation.marginPercent,
          decision: calculation.decision,
          reason: calculation.reason,
        });

        // Only accept if pricing decision is 'accept'
        if (calculation.decision === 'reject') {
          this.logger.info('Job rejected by pricing strategy', {
            txId: tx.id,
            reason: calculation.reason,
          });
          return false;
        }

        // If decision is 'counter-offer', we could implement QUOTED state here
        // For MVP, we treat 'counter-offer' as reject (no automatic negotiation)
        if (calculation.decision === 'counter-offer') {
          this.logger.info('Job requires counter-offer (not implemented in MVP)', {
            txId: tx.id,
            reason: calculation.reason,
          });
          return false;
        }
      } catch (error) {
        // If pricing calculation fails, reject the job for safety
        this.logger.error('Pricing calculation failed, rejecting job', { txId: tx.id }, error as Error);
        return false;
      }
    }

    // Check agent-level autoAccept behavior
    const autoAccept = this.config.behavior?.autoAccept;

    if (autoAccept === undefined || autoAccept === true) {
      return true;
    }

    if (autoAccept === false) {
      return false;
    }

    // It's a function - evaluate it
    if (typeof autoAccept === 'function') {
      const job = this.createJobFromTransaction(tx);
      return await autoAccept(job);
    }

    return false;
  }

  /**
   * Create Job object from MockTransaction
   */
  private createJobFromTransaction(tx: any): Job {
    return {
      id: tx.id,
      service: this.extractServiceName(tx),
      input: this.extractJobInput(tx),
      budget: this.convertAmountToNumber(tx.amount),
      deadline: new Date(tx.deadline * 1000), // Convert unix timestamp to Date
      requester: tx.requester,
      metadata: this.extractMetadata(tx),
    };
  }

  /**
   * Extract service name from transaction
   *
   * Supports multiple formats:
   * 1. JSON: {"service":"name","input":...}
   * 2. Legacy: "service:name;input:..."
   * 3. Plain string (service name directly)
   */
  private extractServiceName(tx: any): string {
    if (!tx.serviceDescription) {
      return 'unknown';
    }

    // Try JSON format first (new structured format)
    try {
      const parsed = JSON.parse(tx.serviceDescription);
      if (parsed && typeof parsed.service === 'string') {
        return parsed.service;
      }
    } catch {
      // Not JSON, try other formats
    }

    // Try legacy format: "service:serviceName;input:..."
    const legacyMatch = tx.serviceDescription.match(/^service:([^;]+)/);
    if (legacyMatch) {
      return legacyMatch[1];
    }

    // Plain string - might be just the service name
    if (typeof tx.serviceDescription === 'string' && tx.serviceDescription.length < 64) {
      return tx.serviceDescription;
    }

    return 'unknown';
  }

  /**
   * Extract job input from transaction
   *
   * Supports multiple formats:
   * 1. JSON: {"service":"name","input":{...}}
   * 2. Legacy: "service:name;input:JSON"
   */
  private extractJobInput(tx: any): any {
    if (!tx.serviceDescription) {
      return {};
    }

    // Try JSON format first (new structured format)
    try {
      const parsed = JSON.parse(tx.serviceDescription);
      if (parsed && parsed.input !== undefined) {
        return parsed.input;
      }
    } catch {
      // Not JSON, try other formats
    }

    // Try legacy format: "service:serviceName;input:JSON"
    const legacyMatch = tx.serviceDescription.match(/;input:(.+)$/);
    if (legacyMatch) {
      try {
        return JSON.parse(legacyMatch[1]);
      } catch {
        return legacyMatch[1]; // Return as string if not valid JSON
      }
    }

    return {};
  }

  /**
   * Extract metadata from transaction
   */
  private extractMetadata(tx: any): Record<string, any> {
    return {
      transactionId: tx.id,
      createdAt: tx.createdAt,
      disputeWindow: tx.disputeWindow,
    };
  }

  /**
   * Convert amount string to number (USDC has 6 decimals)
   */
  private convertAmountToNumber(amount: string): number {
    const amountBigInt = BigInt(amount);
    return Number(amountBigInt) / 1_000_000; // Convert from USDC wei to USDC
  }

  /**
   * Process a job by invoking the handler
   *
   * SECURITY FIX (C-2): Always cleanup activeJobs on completion/failure
   * SECURITY FIX (MEDIUM-4): Uses semaphore to limit concurrent execution
   */
  private async processJob(job: Job, handler: JobHandler): Promise<void> {
    const startTime = Date.now();

    // SECURITY FIX (MEDIUM-4): Check concurrency limit before processing
    // If semaphore is full, wait up to 30 seconds for a slot
    const CONCURRENCY_TIMEOUT_MS = 30000;

    try {
      // Try to acquire semaphore permit (wait if at limit)
      await this.concurrencySemaphore.acquire(CONCURRENCY_TIMEOUT_MS);
    } catch (acquireError) {
      // Timeout waiting for concurrency slot
      this.logger.warn('Job rejected due to concurrency limit', {
        jobId: job.id,
        activeJobs: this.concurrencySemaphore.limit - this.concurrencySemaphore.availablePermits,
        maxConcurrency: this.concurrencySemaphore.limit,
        queueLength: this.concurrencySemaphore.queueLength,
      });

      // Remove from active jobs since we couldn't process it
      this.activeJobs.delete(job.id);
      this.processedJobs.delete(job.id);

      this.emit('job:rejected', job, 'concurrency_limit');
      throw new Error(
        `Job ${job.id} rejected: concurrency limit reached (${this.concurrencySemaphore.limit} concurrent jobs max). ` +
        `Try again later or increase behavior.concurrency.`
      );
    }

    try {
      // Create job context
      const context = this.createJobContext(job);

      // Invoke handler
      const result = await handler(job, context);

      // SECURITY FIX (CRITICAL-2): Use ProofGenerator to create authenticated delivery proof
      // This ensures the proof has proper structure with txId, contentHash, and timestamp
      const proofGenerator = new ProofGenerator();
      const deliverable = typeof result === 'string' ? result : JSON.stringify(result);
      const deliveryProof = proofGenerator.generateDeliveryProof({
        txId: job.id,
        deliverable,
        metadata: {
          service: job.service,
          completedAt: Date.now(),
        },
      });

      // Encode proof with content hash for verification
      const deliveryProofJson = JSON.stringify({
        ...deliveryProof,
        result, // Include original result for convenience
      });

      // Transition transaction through IN_PROGRESS → DELIVERED states
      if (this._client) {
        // Store delivery proof by directly accessing MockRuntime's state
        // This is a workaround - in production, we'd use a proper method
        const runtime = this._client.runtime as any;
        if (runtime.stateManager) {
          await runtime.stateManager.withLock(async (state: any) => {
            const tx = state.transactions[job.id];
            if (tx) {
              tx.deliveryProof = deliveryProofJson;
            }
          });
        }

        // AUDIT FIX (2026-02): Must transition through IN_PROGRESS before DELIVERED
        // Contract rejects COMMITTED → DELIVERED direct transition
        await this._client.runtime.transitionState(job.id, 'IN_PROGRESS');

        // Encode dispute window proof for DELIVERED transition
        // Use transaction's disputeWindow from metadata, fallback to 2 days (172800s) per Options.ts default
        const disputeWindowSeconds = job.metadata?.disputeWindow || 172800;
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const disputeWindowProof = abiCoder.encode(['uint256'], [disputeWindowSeconds]);

        // Transition to DELIVERED with dispute window proof
        await this._client.runtime.transitionState(job.id, 'DELIVERED', disputeWindowProof);
      }

      // SECURITY FIX (C-2): Remove from active jobs on SUCCESS
      this.activeJobs.delete(job.id);

      // Update stats
      this._stats.jobsCompleted++;
      const duration = Date.now() - startTime;
      this._stats.averageJobTime =
        (this._stats.averageJobTime * (this._stats.jobsCompleted - 1) + duration) /
        this._stats.jobsCompleted;
      this._stats.successRate =
        this._stats.jobsCompleted / (this._stats.jobsCompleted + this._stats.jobsFailed);
      this._stats.totalEarned += job.budget;

      // Emit events
      this.logger.info('Job completed', {
        jobId: job.id,
        duration,
        earned: job.budget,
      });
      this.emit('job:completed', job, result);
      this.emit('payment:received', job.budget);
    } catch (error) {
      // SECURITY FIX (C-2): Remove from active jobs on FAILURE
      this.activeJobs.delete(job.id);
      this._stats.jobsFailed++;
      this._stats.successRate =
        this._stats.jobsCompleted / (this._stats.jobsCompleted + this._stats.jobsFailed);

      this.logger.error('Job failed', { jobId: job.id }, error as Error);
      this.emit('job:failed', job, error);
    } finally {
      // SECURITY FIX (MEDIUM-4): Always release semaphore permit
      this.concurrencySemaphore.release();
    }
  }

  /**
   * Create JobContext for handler execution
   */
  private createJobContext(job: Job): JobContext {
    const state = new Map<string, any>();
    let cancelled = false;
    const cancelHandlers: Array<() => void> = [];
    const agent = this; // Capture 'this' for use in closures

    return {
      agent: agent,

      progress(percent: number, message?: string): void {
        // Emit progress event
        agent.emit('job:progress', job.id, percent, message);
      },

      log: {
        debug: (message: string, meta?: any) => {
          if (agent.config.logging?.level === 'debug') {
            console.debug(`[${job.id}] ${message}`, meta);
          }
        },
        info: (message: string, meta?: any) => {
          if (['debug', 'info'].includes(agent.config.logging?.level || 'info')) {
            console.info(`[${job.id}] ${message}`, meta);
          }
        },
        warn: (message: string, meta?: any) => {
          if (['debug', 'info', 'warn'].includes(agent.config.logging?.level || 'info')) {
            console.warn(`[${job.id}] ${message}`, meta);
          }
        },
        error: (message: string, meta?: any) => {
          console.error(`[${job.id}] ${message}`, meta);
        },
      },

      state: {
        get<T>(key: string): T | undefined {
          return state.get(key);
        },
        set<T>(key: string, value: T): void {
          state.set(key, value);
        },
      },

      get cancelled(): boolean {
        return cancelled;
      },

      onCancel(handler: () => void): void {
        cancelHandlers.push(handler);
      },
    };
  }

  /**
   * Wait for active jobs to complete
   */
  private async waitForActiveJobs(timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (this.activeJobs.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        this.logger.warn('Active jobs still running after timeout', {
          activeJobs: this.activeJobs.size,
        });
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Generate address based on wallet configuration
   *
   * SECURITY FIX (HIGH): For testnet/mainnet, MUST derive from private key.
   * For mock mode, can use deterministic address for convenience.
   */
  private async generateAddress(): Promise<string> {
    // If wallet has private key, ALWAYS derive address from it
    const privateKey = await this.getPrivateKey();
    if (privateKey) {
      try {
        const wallet = new ethers.Wallet(privateKey);
        return wallet.address.toLowerCase();
      } catch (error) {
        throw new ValidationError('wallet', 'Invalid private key format');
      }
    }

    // For non-mock networks, require a valid private key or address
    if (this.network === 'testnet' || this.network === 'mainnet') {
      throw new ValidationError(
        'wallet',
        `${this.network} mode requires a valid private key or address in wallet configuration.\n` +
        'Run "actp init" to generate a keystore, or set ACTP_PRIVATE_KEY env var.'
      );
    }

    // For mock mode only: generate deterministic address from agent name
    // This is safe because mock mode doesn't involve real funds
    return `0x${Buffer.from(this.name).toString('hex').padEnd(40, '0').slice(0, 40)}`;
  }

  /**
   * Get private key from configuration
   *
   * SECURITY FIX (HIGH): Validate private key format before use
   */
  private async getPrivateKey(): Promise<string | undefined> {
    // Auto-detect: keystore → env var resolution for testnet/mainnet
    if (!this.config.wallet || this.config.wallet === 'auto') {
      if (this.network === 'testnet' || this.network === 'mainnet') {
        return resolvePrivateKey(this.config.stateDirectory);
      }
      return undefined;
    }

    if (this.config.wallet === 'connect') {
      return undefined;
    }

    if (typeof this.config.wallet === 'string') {
      // Check if it looks like a private key (0x + 64 hex chars)
      if (/^0x[0-9a-fA-F]{64}$/.test(this.config.wallet)) {
        // Validate by trying to create a wallet
        try {
          new ethers.Wallet(this.config.wallet);
          return this.config.wallet;
        } catch {
          throw new ValidationError('wallet', 'Invalid private key format');
        }
      }
      // It's an address, not a private key
      return undefined;
    }

    // Validate private key format
    if (this.config.wallet.privateKey) {
      try {
        new ethers.Wallet(this.config.wallet.privateKey);
        return this.config.wallet.privateKey;
      } catch {
        throw new ValidationError('wallet.privateKey', 'Invalid private key format');
      }
    }

    return undefined;
  }
}
