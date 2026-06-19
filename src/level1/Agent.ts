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
import { ethers, type Signer } from 'ethers';
import { ACTPClient } from '../ACTPClient';
import type { ProviderOrchestrator } from '../negotiation/ProviderOrchestrator';
import { resolvePrivateKey } from '../wallet/keystore';
import { Job, JobHandler, JobContext } from './types/Job';
import { RequestOptions, RequestResult, NetworkOption } from './types/Options';
import { DEFAULT_DELIVERY_CONFIG } from './types/Options';
import { PricingStrategy } from './pricing/PricingStrategy';
import { AgentLifecycleError, ServiceConfigError, ValidationError } from '../errors';
import { validateServiceName, validatePath, LRUCache } from '../utils/security';
import { Logger, sdkLogger } from '../utils/Logger';
import { ServiceHash } from '../utils/Helpers';
import { Semaphore } from '../utils/Semaphore';
import { ProofGenerator } from '../protocol/ProofGenerator';
import { DeliveryEnvelopeBuilder } from '../delivery/envelopeBuilder';
import type { DeliveryChannel } from '../delivery/channel';

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
  custom?: (job: Job) => boolean | Promise<boolean>;
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
   * ethers provider polling interval in milliseconds for live on-chain
   * event / block polling (testnet / mainnet only; ignored in 'mock').
   *
   * Lower values tighten job-pickup latency but multiply the agent's
   * `eth_blockNumber` / `eth_getLogs` RPC load — a long-running provider on
   * a metered RPC (Alchemy / Infura / QuickNode free tier) burns compute
   * units proportionally. Defaults to the SDK runtime default (1000 ms / 1s).
   * Always-on daemons should raise this to 5000–8000.
   *
   * @default 1000
   * @example pollingInterval: 6000
   */
  pollingInterval?: number;

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

  // ===========================================================================
  // AIP-16 Phase 2e — Delivery surface (Agent.processJob hook)
  // ===========================================================================
  //
  // All four fields below are OPTIONAL. The processJob delivery hook only
  // activates when ALL of (deliveryChannel, deliverySigner, kernelAddress,
  // chainId) are provided AND the `ACTP_DELIVERY_CHANNEL=v1` environment
  // variable is set. Missing any one of them — the hook is a no-op and the
  // pre-AIP-16 settlement path runs verbatim.
  //
  // This keeps the existing 2730+ test suite green: tests that construct an
  // Agent without these fields see exactly the prior behavior.

  /**
   * AIP-16 delivery channel transport. When provided together with
   * {@link deliverySigner}, {@link kernelAddress}, and {@link chainId},
   * `Agent.processJob` will (after the handler returns and before the
   * `transitionState(DELIVERED)` hop) build a `DeliveryEnvelopeWireV1` for
   * the handler result and publish it on this channel.
   *
   * Pass a {@link MockDeliveryChannel} for tests / in-process flows or a
   * {@link RelayDeliveryChannel} for production HTTP relay transport.
   *
   * Optional. When omitted (or any sibling field below is omitted) the
   * hook is a no-op. Channel publish failures are logged and swallowed —
   * they MUST NOT block the on-chain settlement path.
   */
  deliveryChannel?: DeliveryChannel;

  /**
   * EOA signer used to sign delivery envelopes (AIP-16 EIP-712 payload).
   *
   * For smart-wallet flows this is the underlying EOA — not the smart-
   * wallet address. The envelope's `providerAddress` is the on-chain
   * identity acting as the provider (e.g. this agent's `address`), and
   * `signerAddress` is the EOA address derived from this signer.
   *
   * Optional. When omitted the delivery hook is a no-op.
   */
  deliverySigner?: Signer;

  /**
   * ACTP kernel contract address on {@link chainId}. Used as the EIP-712
   * `verifyingContract` for the envelope domain.
   *
   * Optional. When omitted the delivery hook is a no-op.
   */
  kernelAddress?: string;

  /**
   * EVM chain id for the kernel (e.g. 8453 Base mainnet, 84532 Base
   * Sepolia). Used in both the EIP-712 domain and the signed envelope
   * payload.
   *
   * Optional. When omitted the delivery hook is a no-op.
   */
  chainId?: number;

  /**
   * CoinbaseSmartWallet factory nonce used to derive this agent's
   * (provider's) on-chain `providerAddress` from the EOA backing
   * {@link deliverySigner}. Defaults to `0` (the first wallet per owner).
   *
   * H4 fix (AIP-16 Phase 3 HIGH) — high-level surface. Providers whose
   * Smart Wallet was deployed at a non-zero factory nonce MUST pass that
   * nonce here so the AIP-16 server-side derivation lands on the correct
   * address. Omitting it (or passing `0`) reproduces the legacy behavior
   * and yields byte-identical signing for the vast majority of providers
   * (auto-wallet deploys at nonce=0).
   *
   * Threaded into {@link DeliveryEnvelopeBuilder.buildPublic} and
   * {@link DeliveryEnvelopeBuilder.buildEncrypted}. Negative or
   * non-integer values cause the builder to throw
   * `BUILDER_INVALID_SMART_WALLET_NONCE`, which the `processJob` hook
   * logs at `warn` and swallows — settlement is unaffected.
   */
  smartWalletNonce?: number;

  /**
   * Render a ceremonial V3 framed receipt to stdout on the agent's first
   * completed job ("FIRST TRANSACTION RECEIPT — your-agent earned …").
   * Provides the wow moment for earn-side onboarding parallel to
   * `actp test`'s buyer-side ceremony.
   *
   * Defaults to `true` on testnet/mainnet, suppressed on `mock` and when
   * the env var `ACTP_NO_FIRST_JOB_RECEIPT=1` is set. Pass `false` to
   * opt out unconditionally (CI / structured-logging deployments).
   *
   * Only renders ONCE per process — gated on `stats.jobsCompleted === 1`.
   */
  showFirstJobReceipt?: boolean;
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
   * AIP-2.1 ProviderOrchestrator. When set via setProviderOrchestrator(),
   * the counter-offer pricing path emits canonical AIP-2 quote messages
   * instead of the legacy ad-hoc hash. Optional — agents that don't
   * opt in continue with the historical hash format which the
   * buyer-side verifier still accepts via §3.6 legacy fallback.
   */
  private _providerOrchestrator?: ProviderOrchestrator;

  /**
   * Registered services
   */
  private services = new Map<string, { config: ServiceConfig; handler: JobHandler }>();
  /**
   * Hash-keyed mirror of `services`, populated alongside it in `provide()`.
   * Key: `keccak256(toUtf8Bytes(name)).toLowerCase()`. Lookups match
   * on-chain `tx.serviceHash` directly so BlockchainRuntime-sourced jobs
   * route without depending on string `serviceDescription`. PRD §5.4.
   */
  private handlersByHash = new Map<string, { config: ServiceConfig; handler: JobHandler }>();

  /**
   * Active jobs
   *
   *Security: Changed from Map to LRUCache to prevent unbounded growth
   * Maximum 1000 active jobs with LRU eviction
   */
  private activeJobs = new LRUCache<string, Job>(1000);

  /**
   * Processed job IDs (for deduplication)
   *
   *Security: Track jobs we've attempted to process
   * This prevents race conditions where the same job is processed multiple times
   * before the state transition completes
   */
  private processedJobs = new LRUCache<string, boolean>(10000);

  /**
   * Per-job failure counter for bounded retry. A non-kernel failure (e.g. the
   * user's handler throwing on bad input) is retried as if transient; after
   * MAX_JOB_ATTEMPTS recurrences it is treated as effectively permanent and
   * marked processed, so polling does not retry it forever. In-memory → resets
   * on restart (same blast radius as the permanent-failure skip set).
   */
  private jobAttempts = new LRUCache<string, number>(10000);
  private static readonly MAX_JOB_ATTEMPTS = 3;

  /**
   * Processing locks (for atomic locking)
   *
   *Security: Mutex for job processing.
   * When we see a job, we IMMEDIATELY add to this set (atomic in single-threaded JS).
   * This prevents race conditions where two poll cycles both pass the processedJobs.has()
   * check before either calls processedJobs.set().
   */
  private processingLocks = new Set<string>();

  /**
   * Concurrency semaphore
   *
   *Security: Limits concurrent job execution to prevent
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
   * Cleanup function returned by `BlockchainRuntime.subscribeProviderJobs`,
   * set by `subscribeIfBlockchain()` and cleared by `unsubscribe()`. Undefined
   * means no live subscription. PRD §5.3.
   */
  private jobSubscriptionCleanup?: () => void;

  /**
   * Logger instance
   */
  private logger: Logger;

  /**
   * AIP-16 Phase 2e — delivery channel transport. Captured from
   * {@link AgentConfig.deliveryChannel} at construction time. Read by
   * the `processJob` delivery hook. `undefined` disables the hook.
   */
  // AIP-16 4.6.1 — mutable so `ensureAip16AutoWire()` can lazy-fill
  // missing deps when ACTP_DELIVERY_CHANNEL=v1 is set process-wide.
  // Public API unchanged (these are still `private`).
  private deliveryChannel?: DeliveryChannel;

  /**
   * AIP-16 Phase 2e — EOA signer for delivery envelopes. Captured from
   * {@link AgentConfig.deliverySigner} at construction time. Read by
   * the `processJob` delivery hook. `undefined` disables the hook.
   */
  // See note on deliveryChannel above (AIP-16 4.6.1 auto-wire mutability).
  private deliverySigner?: Signer;

  /**
   * AIP-16 Phase 2e — kernel address for the EIP-712 verifying contract.
   * Captured from {@link AgentConfig.kernelAddress}. `undefined` disables
   * the hook.
   */
  // See note on deliveryChannel above (AIP-16 4.6.1 auto-wire mutability).
  private kernelAddress?: string;

  /**
   * AIP-16 Phase 2e — chain id for the EIP-712 domain. Captured from
   * {@link AgentConfig.chainId}. `undefined` disables the hook.
   */
  // See note on deliveryChannel above (AIP-16 4.6.1 auto-wire mutability).
  private chainId?: number;

  /**
   * AIP-16 Phase 3 (H4 fix) — CoinbaseSmartWallet factory nonce used to
   * derive `providerAddress` from `signerAddress` server-side. Captured
   * from {@link AgentConfig.smartWalletNonce}. Defaults to `0` when the
   * caller omits the field at construction.
   *
   * Threaded into every envelope build inside `maybePublishDeliveryEnvelope`.
   */
  private readonly smartWalletNonce?: number;

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

    // Security: Use dedicated AGIRAILS directory as base
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

    // Security: Initialize concurrency semaphore
    // Default to 10 concurrent jobs if not specified
    const maxConcurrency = config.behavior?.concurrency || 10;
    this.concurrencySemaphore = new Semaphore(maxConcurrency);
    this.logger.debug('Initialized concurrency semaphore', { maxConcurrency });

    // AIP-16 Phase 2e — capture optional delivery hook dependencies. The
    // hook activates only when ALL four are present AND the
    // `ACTP_DELIVERY_CHANNEL=v1` env flag is set; otherwise it is a
    // no-op and the legacy settlement path runs verbatim.
    this.deliveryChannel = config.deliveryChannel;
    this.deliverySigner = config.deliverySigner;
    this.kernelAddress = config.kernelAddress;
    this.chainId = config.chainId;
    // H4 (AIP-16 Phase 3) — capture optional Smart Wallet factory nonce.
    // Defaults to undefined → `this.smartWalletNonce ?? 0` at the build
    // call sites preserves byte-identical signing for pre-H4 callers.
    this.smartWalletNonce = config.smartWalletNonce;
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
    // PRD §5.3: idempotent start. Calling start() on a running or paused
    // agent is a logged noop instead of a thrown AgentLifecycleError. This
    // is a behavior change from 3.5.3 — see CHANGELOG / MIGRATION-4.0.
    if (this._status === 'running' || this._status === 'paused') {
      this.logger.warn('Agent.start() called on already-started agent — noop', {
        status: this._status,
      });
      return;
    }
    if (this._status !== 'idle' && this._status !== 'stopped') {
      throw new AgentLifecycleError(this._status, 'start');
    }

    this._status = 'starting';
    this.emit('starting');

    try {
      let rpcUrl = this.config.rpcUrl;
      if (!rpcUrl && (this.network === 'testnet' || this.network === 'mainnet')) {
        const { getNetwork } = await import('../config/networks');
        const networkName = this.network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
        const networkConfig = getNetwork(networkName);
        rpcUrl = networkConfig.rpcUrl;
        this.logger.info(`Using default RPC URL for ${networkName}: ${rpcUrl}`);
      }

      this._client = await ACTPClient.create({
        mode: this.network === 'testnet' ? 'testnet' : this.network === 'mainnet' ? 'mainnet' : 'mock',
        requesterAddress: this.address || await this.generateAddress(),
        stateDirectory: this.config.stateDirectory,
        privateKey: await this.getPrivateKey(),
        rpcUrl,
        pollingInterval: this.config.pollingInterval,
      });

      this.startPolling();
      this.subscribeIfBlockchain();

      this._status = 'running';
      this.emit('started');
    } catch (error) {
      // PRD §5.3: a partial start (e.g. polling started, subscription threw,
      // or ACTPClient.create rejected) must not leak the polling timer or
      // a live subscription. Clean both before propagating.
      this.stopPolling();
      this.unsubscribe();
      this._status = 'stopped';
      this.safeEmitError(error);
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

    // Stop polling + tear down subscription. PRD §5.3.
    this.stopPolling();
    this.unsubscribe();

    // Wait for active jobs to complete (with timeout)
    await this.waitForActiveJobs(30000); // 30s timeout

    this._status = 'stopped';
    this.emit('stopped');
    this.removeAllListeners();
  }

  /**
   * Pause the agent
   *
   * Stops accepting new jobs but keeps active jobs running. PRD §5.3:
   * pause() now tears down the on-chain subscription as well — a paused
   * agent must not silently keep dispatching jobs via the live event path.
   * Behavior change from 3.5.3 (was a silent bug); see CHANGELOG /
   * MIGRATION-4.0 bullet 4 for drain-on-pause migration guidance.
   */
  pause(): void {
    if (this._status !== 'running') {
      throw new AgentLifecycleError(this._status, 'pause');
    }

    this.stopPolling();
    this.unsubscribe();
    this._status = 'paused';
    this.emit('paused');
  }

  /**
   * Resume the agent
   *
   * Resumes accepting new jobs after being paused. PRD §5.3: re-establishes
   * the on-chain subscription that pause() tore down.
   */
  resume(): void {
    if (this._status !== 'paused') {
      throw new AgentLifecycleError(this._status, 'resume');
    }

    // PRD §5.3.1: same partial-failure shape as start() — if subscription
    // wiring throws after the polling timer is armed, tear both down before
    // propagating so the agent doesn't leak a live timer while still in
    // 'paused' status. Without this, the next resume() call would short-
    // circuit on the state check and the orphaned timer would survive.
    try {
      this.startPolling();
      this.subscribeIfBlockchain();
    } catch (err) {
      this.stopPolling();
      this.unsubscribe();
      throw err;
    }
    this._status = 'running';
    this.emit('resumed');
  }

  /**
   * Subscribe to live TransactionCreated events when the underlying runtime
   * supports it (currently `BlockchainRuntime` only — `MockRuntime` providers
   * receive jobs through polling). Idempotent: if a subscription is already
   * active, this is a logged noop so a second `start()` on an already-running
   * agent doesn't leak event listeners. PRD §5.3.
   */
  private subscribeIfBlockchain(): void {
    if (this.jobSubscriptionCleanup) {
      this.logger.warn('Agent: subscription already active, refusing to double-subscribe');
      return;
    }
    const runtime = this._client?.runtime as
      | { subscribeProviderJobs?: (
            provider: string,
            onJob: (tx: import('../runtime/types/MockState').MockTransaction) => void
          ) => () => void }
      | undefined;
    if (!runtime || typeof runtime.subscribeProviderJobs !== 'function') {
      return;
    }
    this.jobSubscriptionCleanup = runtime.subscribeProviderJobs(
      this.address,
      (tx) => {
        this.handleIncomingTransaction(tx).catch((err) => this.safeEmitError(err));
      }
    );
    this.logger.info('Subscribed to on-chain TransactionCreated events', {
      provider: this.address,
    });
  }

  /**
   * Tear down a live subscription if one is active. Idempotent. PRD §5.3.
   */
  private unsubscribe(): void {
    if (this.jobSubscriptionCleanup) {
      try {
        this.jobSubscriptionCleanup();
      } catch (err) {
        this.logger.warn('Subscription cleanup threw — continuing', { err });
      }
      this.jobSubscriptionCleanup = undefined;
    }
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

    // Security: Validate service name to prevent injection
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

    // PRD §5.4: derive the on-chain routing key alongside the string key.
    // Same formula used by `actp request --service <name>` (see PRD §A.1 +
    // AgentRegistry.computeServiceTypeHash), so BlockchainRuntime jobs match
    // the same handler that MockRuntime tests register.
    const hashKey = ethers.keccak256(ethers.toUtf8Bytes(config.name)).toLowerCase();
    this.services.set(config.name, { config, handler });
    this.handlersByHash.set(hashKey, { config, handler });
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

    // Import Simple-tier request function
    const { request: basicRequest } = await import('../level0/request');

    // Call Simple-tier request with agent's network
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
   *Security: Now uses LRUCache.values() iterator.
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

  /**
   * Attach an AIP-2.1 ProviderOrchestrator. Once set, the counter-offer
   * pricing path emits canonical signed QuoteMessages and submits via
   * the runtime's submitQuote (instead of the legacy ad-hoc hash).
   *
   * Optional — agents that never call this keep the pre-AIP-2.1 hash
   * format which the buyer-side verifier still accepts via §3.6
   * legacy fallback during the migration grace window.
   */
  setProviderOrchestrator(orchestrator: ProviderOrchestrator): void {
    this._providerOrchestrator = orchestrator;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Best-effort service-type extraction for a counter-offer routed
   * through ProviderOrchestrator. The transaction record doesn't
   * formally carry a service-type field; we look at the matched
   * handler if any, else fall back to the first registered service
   * the agent advertises, else 'general'.
   */
  private findServiceTypeForTx(tx: import('../runtime/types/MockState').MockTransaction): string {
    const matched = this.findServiceHandler(tx);
    if (matched) return matched.config.name;
    const firstRegistered = this.services.keys().next().value;
    if (firstRegistered) return firstRegistered;
    return 'general';
  }

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
        this.safeEmitError(error);
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
   * Emit an 'error' event only when a consumer is listening; otherwise log it.
   * A long-running provider agent must NOT crash the process on a transient or
   * per-job failure just because no 'error' listener was attached — Node throws
   * on an unhandled 'error' event. Poll/job errors are retried on the next
   * cycle, so swallowing-to-log here keeps the daemon alive; callers that DO
   * attach an 'error' listener still receive every error unchanged.
   */
  private safeEmitError(error: unknown): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      this.logger.error('Agent error (no error listener attached; not crashing)', {}, error as Error);
    }
  }

  /**
   * Poll for new jobs
   *
   * Security notes:
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
      // Security: Use filtered query instead of getAllTransactions
      // This prevents DoS via memory exhaustion by only fetching relevant transactions.
      // PRD §5.1: getTransactionsByProvider is now required on IACTPRuntime —
      // the prior duck-type fallback to getAllTransactions is gone.
      //
      // State filter is mode-dependent:
      //   - mock: poll INITIATED. The mock runtime has no "Only requester"
      //     guard on linkEscrow, so the legacy pattern of the provider
      //     driving INITIATED → COMMITTED still works there. Existing
      //     mock-only tests rely on this.
      //   - testnet / mainnet: poll COMMITTED + IN_PROGRESS. ACTPKernel.linkEscrow
      //     (≥ 2026-04-15) requires `msg.sender == txn.requester`, so we don't
      //     poll INITIATED (kernel rejects any provider linkEscrow). COMMITTED
      //     is the normal entry point. IN_PROGRESS is the orphan-recovery
      //     entry: if a previous processJob completed the IN_PROGRESS
      //     transition on-chain but then crashed / paymaster-failed before
      //     the DELIVERED transition, the tx would be stuck in IN_PROGRESS
      //     forever without a COMMITTED snapshot in the sweep window.
      //     Re-entering through handleIncomingTransaction lets processJob
      //     retry the DELIVERED step. processJob's state-gated transition
      //     logic skips the IN_PROGRESS hop when the tx is already past it.
      const isBlockchain = this.network === 'testnet' || this.network === 'mainnet';
      const states: import('../runtime/types/MockState').TransactionState[] =
        isBlockchain ? ['COMMITTED', 'IN_PROGRESS'] : ['INITIATED'];
      const perStateResults = await Promise.all(
        states.map((s) =>
          this._client!.runtime.getTransactionsByProvider(this.address, s, 100)
        )
      );
      const pendingJobs = perStateResults.flat();

      this.logger.debug('Polling for jobs', {
        pendingJobs: pendingJobs.length,
      });

      // Process each pending job through the shared acceptance pipeline so
      // poll and subscription paths converge on identical semantics
      // (dedup, provider check, routing, auto-accept, linkEscrow, emit).
      for (const tx of pendingJobs) {
        await this.handleIncomingTransaction(tx);
      }

      // Update cached balance (non-blocking, don't await)
      this.getBalanceAsync().catch(() => {
        // Silently ignore balance update errors during polling
      });
    } catch (error) {
      // Polling error - will retry on next interval
      this.logger.error('Polling error', {}, error as Error);
      this.safeEmitError(error);
    }
  }

  /**
   * Shared per-transaction acceptance pipeline. Reached from two sources:
   *   - `pollForJobs` — bounded sweep over INITIATED transactions
   *   - `subscribeIfBlockchain` — live `TransactionCreated` events
   *
   * Atomic in single-threaded JS via `processingLocks` (Set). The lock
   * release is in a `finally` so any error/throw — handler dispatch
   * failure, linkEscrow revert, malformed payload — does not permanently
   * occupy the slot. Poison TXs become re-tryable on the next sweep.
   *
   * Errors are emitted to consumers but never propagated; the caller loop
   * must not be killed by a single bad TX. PRD §5.3.
   */
  private async handleIncomingTransaction(
    tx: import('../runtime/types/MockState').MockTransaction
  ): Promise<void> {
    // PRD §5.3.1: lifecycle status guard. Async polls and queued subscription
    // callbacks can race with pause() / stop(). Drop the TX rather than
    // accepting a new job into a paused or terminating agent.
    //
    // 'starting' is allowed: the subscription is wired inside start() before
    // _status flips to 'running', and a fast on-chain event could fire in
    // that window — dropping it would lose work.
    if (
      this._status !== 'running' &&
      this._status !== 'starting'
    ) {
      this.logger.debug('Agent not accepting jobs, dropping incoming tx', {
        txId: tx.id,
        status: this._status,
      });
      return;
    }

    // Security: check dedup before acquiring the lock so a TX that finished
    // on a prior pass returns immediately without disturbing state.
    if (this.processingLocks.has(tx.id) || this.processedJobs.has(tx.id)) return;
    if (this.activeJobs.has(tx.id)) return;

    // Acquire lock (atomic in single-threaded JS). Released in finally below.
    this.processingLocks.add(tx.id);
    try {
      // Authorization: TX provider must match this agent. Case-insensitive
      // (PRD §5.3 carry-forward from §5.1 review): EventMonitor + runtime
      // already normalize, but checksummed and lowercase forms can both
      // reach here legitimately.
      if (tx.provider.toLowerCase() !== this.address.toLowerCase()) {
        this.logger.warn('Unauthorized transaction detected', {
          txId: tx.id,
          expectedProvider: this.address,
          actualProvider: tx.provider,
        });
        return;
      }

      // Routing (PRD §5.4): hash-first, string fallback.
      const serviceHandler = this.findServiceHandler(tx);
      if (!serviceHandler) {
        this.logger.debug('No handler for transaction', { txId: tx.id });
        return;
      }

      // Auto-accept evaluation. PRD §5.4.1: thread the matched handler so
      // every Job built inside filter/pricing/autoAccept paths carries the
      // correct service name.
      const shouldAccept = await this.shouldAutoAccept(tx, serviceHandler);
      if (!shouldAccept) {
        this.logger.debug('Auto-accept declined', { txId: tx.id });
        return;
      }

      // Build Job using the matched handler so hash-only TXs carry the
      // registered service name. PRD §5.4.1.
      const job = this.createJobFromTransaction(tx, serviceHandler);
      this.activeJobs.set(job.id, job);

      // Link escrow immediately to transition out of INITIATED state.
      // This prevents the next poll / event from picking up this job again.
      //
      // Mode gating: ACTPKernel ≥ 2026-04-15 enforces
      // `msg.sender == txn.requester` on linkEscrow, so on testnet /
      // mainnet a provider-side linkEscrow attempt is guaranteed to
      // revert with "Only requester". On blockchain modes we skip the
      // attempt and wait for the requester to drive INITIATED → COMMITTED
      // themselves (via runRequest / level0.request / BuyerOrchestrator).
      // Mock mode has no such guard — the legacy provider-drives-linkEscrow
      // pattern still works there, and existing tests depend on it.
      //
      // The adapter route below preserves the AA-aware Paymaster path
      // when active and falls through to runtime.linkEscrow on EOA / mock.
      const isBlockchain = this.network === 'testnet' || this.network === 'mainnet';
      try {
        if (this._client && tx.state === 'INITIATED' && !isBlockchain) {
          await this._client.standard.linkEscrow(tx.id);
        } else if (this._client && tx.state === 'INITIATED' && isBlockchain) {
          // Subscription path can deliver an INITIATED tx before the
          // requester has linkEscrow'd. Skip and rely on pollForJobs to
          // pick it up once it's COMMITTED. The outer `finally` clears
          // processingLocks; the early return leaves activeJobs cleaned up.
          this.logger.debug(
            'Skipping provider-side linkEscrow on blockchain mode; ' +
            'awaiting requester-driven INITIATED → COMMITTED transition',
            { txId: tx.id }
          );
          this.activeJobs.delete(job.id);
          return;
        }
        this.processedJobs.set(job.id, true);
      } catch (escrowError) {
        this.activeJobs.delete(job.id);
        this.logger.error('Failed to link escrow', { txId: tx.id }, escrowError as Error);
        return;
      }

      this._stats.jobsReceived++;
      this.emit('job:received', job);
      this.logger.info('Job accepted', { jobId: job.id, service: job.service });

      // Process the job asynchronously (don't await — handler runs out-of-band).
      this.processJob(job, serviceHandler.handler).catch((error) => {
        this.logger.error('Job processing failed', { jobId: job.id }, error as Error);
        this.safeEmitError(error);
      });
    } catch (error) {
      this.logger.error('Error processing pending job', { txId: tx.id }, error as Error);
      this.safeEmitError(error);
    } finally {
      this.processingLocks.delete(tx.id);
    }
  }

  /**
   * Find service handler for a transaction
   *
   *Security: Use exact field matching instead of substring search
   * to prevent service routing spoofing attacks.
   *
   * Dispatch order:
   *   PRIMARY (PRD §5.4 — on-chain Layer B):
   *     Match by `tx.serviceHash` against the `handlersByHash` map.
   *   ZEROHASH SOLE-HANDLER FALLBACK (raw-pay routing):
   *     When `serviceHash === ZeroHash` and exactly one handler is
   *     registered, route to it (Level 0 `pay` to a single-service
   *     provider). 0 or 2+ handlers → fall through (ambiguous, not routed).
   *   FALLBACK (preserves MockRuntime test fixtures + legacy clients):
   *     5-step `serviceDescription` dispatch — JSON / legacy /
   *     hash-only / string exact match.
   */
  private findServiceHandler(
    tx: any
  ): { config: ServiceConfig; handler: JobHandler } | undefined {
    // PRIMARY: on-chain hash routing (PRD §5.4).
    const hash =
      typeof tx?.serviceHash === 'string' ? tx.serviceHash.toLowerCase() : undefined;
    if (hash && hash !== ethers.ZeroHash.toLowerCase()) {
      const byHash = this.handlersByHash.get(hash);
      if (byHash) return byHash;
    }

    // ZeroHash / missing-hash sole-handler fallback (raw-pay routing).
    //
    // A Level 0 `client.pay(provider, amount)` creates an on-chain tx with
    // `serviceHash === ZeroHash` and no `serviceDescription`. Before this
    // branch such a tx fell through to the string dispatch below, found
    // nothing, and was silently dropped — the requester paid a single-service
    // provider but the job never ran (it stayed COMMITTED forever).
    //
    // `noRoutableHash` is true when the hash is the literal ZeroHash OR when it
    // is absent / non-string (some runtimes surface a raw pay with no
    // serviceHash field at all). Both are the same "payer named no service"
    // case. This deliberately matches the behavior of the agent-side monkeypatch
    // this fix replaces (Sentinel used `!hash || hash === ZeroHash`), so an
    // agent that drops its monkeypatch sees byte-identical routing.
    //
    // When there is no routable hash AND the agent has EXACTLY ONE registered
    // handler, the routing is unambiguous — route to that sole handler.
    //
    // Guards (deliberately conservative — never guess):
    //   * 0 handlers  → fall through, returns undefined (unchanged).
    //   * 2+ handlers → ambiguous, fall through, returns undefined (unchanged).
    //   * exactly 1   → route, with a warn-level log so operators can see
    //                   raw-pay activations in production.
    const noRoutableHash = !hash || hash === ethers.ZeroHash.toLowerCase();
    if (noRoutableHash && this.handlersByHash.size === 1) {
      this.logger.warn(
        'ZeroHash (raw-pay) tx routed to the sole registered handler',
        { txId: tx?.id }
      );
      return this.handlersByHash.values().next().value;
    }

    // FALLBACK: existing 5-step string dispatch.
    return this.findServiceHandlerByString(tx);
  }

  /**
   * Legacy string-based service dispatch — kept as a fallback for
   * MockRuntime-style transactions where `serviceDescription` still carries
   * the JSON / legacy / plain-name shape. PRD §5.4 routes by hash first;
   * this method is only reached when the hash branch misses or the TX has
   * `serviceHash === ZeroHash`.
   */
  private findServiceHandlerByString(
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
   *Security: Added pricing strategy evaluation
   * - Checks service-level filters (budget constraints)
   * - Evaluates pricing strategy if configured
   * - Only accepts jobs that meet pricing requirements
   */
  private async shouldAutoAccept(
    tx: any,
    matched?: { config: ServiceConfig; handler: JobHandler }
  ): Promise<boolean> {
    // PRD §5.4.1: prefer the matched handler supplied by the caller so the
    // hash-routed `config.name` flows into every internal Job object built
    // below. Re-derive only when caller didn't pass it.
    const serviceHandler = matched ?? this.findServiceHandler(tx);

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
          this.emitJobDecision('job:declined', tx, serviceHandler, {
            reason: 'budget_below_minimum',
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
          this.emitJobDecision('job:declined', tx, serviceHandler, {
            reason: 'budget_above_maximum',
            maxBudget: filter.maxBudget,
          });
          return false;
        }

        // Check custom filter function
        if (filter.custom && typeof filter.custom === 'function') {
          const job = this.createJobFromTransaction(tx, serviceHandler);
          const customResult = await filter.custom(job);
          if (!customResult) {
            this.logger.debug('Job rejected: custom filter declined', { txId: tx.id });
            this.emitJobDecision('job:filtered', tx, serviceHandler, {
              reason: 'custom_filter',
              filter: 'custom',
            });
            return false;
          }
        }
      }
      // If filter is a function (legacy support)
      else if (typeof filter === 'function') {
        const job = this.createJobFromTransaction(tx, serviceHandler);
        const filterResult = filter(job);
        if (!filterResult) {
          this.logger.debug('Job rejected: filter function declined', { txId: tx.id });
          this.emitJobDecision('job:filtered', tx, serviceHandler, {
            reason: 'function_filter',
            filter: 'legacy_function',
          });
          return false;
        }
      }
    }

    // MVP: Check pricing strategy if configured
    if (serviceHandler?.config.pricing) {
      const { calculatePrice } = await import('./pricing/PriceCalculator');
      const job = this.createJobFromTransaction(tx, serviceHandler);

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
          this.emitJobDecision('job:declined', tx, serviceHandler, {
            reason: 'pricing_rejected',
            detail: calculation.reason,
          });
          return false;
        }

        // Counter-offer: provider accepts at reduced margin (budget >= cost
        // but < ideal price).
        //
        // Two paths:
        //  1. AIP-2.1 canonical (preferred) — owner attached a configured
        //     `providerOrchestrator` via setProviderOrchestrator(). We
        //     route the quote through it so it builds a signed
        //     AIP-2 QuoteMessage, computes the canonical hash, and
        //     submits via runtime.submitQuote (state transition + hash
        //     storage in one). Buyer-side BuyerOrchestrator can verify
        //     end-to-end.
        //  2. Legacy ad-hoc hash (fallback) — when no orchestrator is
        //     configured, emit the historical
        //     keccak256(JSON.stringify({txId, providerIdealPrice,
        //     actualEscrow, provider})) shape. The buyer's
        //     verifyQuoteHashOnChain has a `legacy` matcher that
        //     accepts this shape for migration grace (§3.6).
        //
        // ACTP invariant either way: tx.amount is immutable. The QUOTED
        // proof documents the provider's ideal price for audit trail
        // but does NOT change the on-chain escrow amount.
        if (calculation.decision === 'counter-offer') {
          try {
            const providerIdealPrice = String(Math.round(calculation.price * 1_000_000));

            if (this._providerOrchestrator) {
              const chainId = (this._client!.runtime as unknown as { networkConfig?: { chainId?: number } })
                .networkConfig?.chainId ?? 84532;
              const result = await this._providerOrchestrator.quote(
                {
                  txId: tx.id,
                  consumer: `did:ethr:${chainId}:${tx.requester}`,
                  offeredAmount: tx.amount,
                  // No separate ceiling on Transaction — set max to
                  // provider's quoted price so the orchestrator's
                  // policy band check passes.
                  maxPrice: providerIdealPrice,
                  deadline: tx.deadline,
                  serviceType: this.findServiceTypeForTx(tx),
                  currency: 'USDC',
                  unit: 'job',
                },
                `did:ethr:${chainId}:${this.address}`,
              );
              this.logger.info('AIP-2.1 quote submitted via ProviderOrchestrator', {
                txId: tx.id,
                action: result.decision.action,
                reason: result.decision.reason,
                channelError: result.channelError,
              });
              return false;
            }

            // Legacy ad-hoc hash path. Buyer's verifier matches via §3.6
            // legacy fallback. Existing pre-AIP-2.1 agents continue to
            // function unchanged.
            //
            // Route through StandardAdapter so AA-enabled providers
            // (Smart Wallet on testnet/mainnet) get Paymaster-sponsored
            // UserOps for the INITIATED → QUOTED transition. Without this,
            // counter-offer providers running on AA would revert on raw
            // EOA gas (the signer has 0 ETH under the gasless model).
            // EOA / mock callers fall through to runtime.transitionState
            // inside the adapter.
            const { keccak256, toUtf8Bytes, AbiCoder } = await import('ethers');
            const quoteHash = keccak256(toUtf8Bytes(
              JSON.stringify({ txId: tx.id, providerIdealPrice, actualEscrow: tx.amount, provider: this.address })
            ));
            const proof = AbiCoder.defaultAbiCoder().encode(['bytes32'], [quoteHash]);
            await this._client!.standard.transitionState(tx.id, 'QUOTED', proof);

            this.logger.info('Counter-offer quoted via legacy hash (no providerOrchestrator configured)', {
              txId: tx.id,
              providerIdealPrice,
              actualEscrow: tx.amount,
              reason: calculation.reason,
            });
            return false;
          } catch (quoteError) {
            this.logger.error('Counter-offer submission failed', { txId: tx.id }, quoteError as Error);
            return false;
          }
        }
      } catch (error) {
        // If pricing calculation fails, reject the job for safety
        this.logger.error('Pricing calculation failed, rejecting job', { txId: tx.id }, error as Error);
        this.emitJobDecision('job:declined', tx, serviceHandler, {
          reason: 'pricing_error',
          detail: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    // Check agent-level autoAccept behavior
    const autoAccept = this.config.behavior?.autoAccept;

    if (autoAccept === undefined || autoAccept === true) {
      return true;
    }

    // Blanket opt-out: the agent is not auto-accepting anything. This is a mode,
    // not a per-job judgement, but we still surface it so a consumer counting
    // "every job we didn't take" (e.g. Sentinel's decline counter) sees it.
    if (autoAccept === false) {
      this.emitJobDecision('job:filtered', tx, serviceHandler, {
        reason: 'auto_accept_disabled',
        filter: 'auto_accept',
      });
      return false;
    }

    // It's a function - evaluate it (per-job programmatic gate).
    if (typeof autoAccept === 'function') {
      const job = this.createJobFromTransaction(tx, serviceHandler);
      const decision = await autoAccept(job);
      if (!decision) {
        this.emitJobDecision('job:filtered', tx, serviceHandler, {
          reason: 'auto_accept_callback',
          filter: 'auto_accept',
        });
      }
      return decision;
    }

    return false;
  }

  // NOTE: the pricing "counter-offer" path is intentionally NOT a decline/filter
  // event — there the agent RESPONDED with a signed counter price (a QUOTED
  // transition), it did not refuse the job. Emitting a decline there would
  // mislabel a negotiation as a rejection.

  /**
   * Create Job object from MockTransaction.
   *
   * `matched` is the handler entry returned by `findServiceHandler(tx)`.
   * When supplied, `job.service` is taken from `matched.config.name` —
   * this is the only correct source for hash-only TXs (BlockchainRuntime),
   * where `serviceDescription` is empty and `extractServiceName(tx)` would
   * return `'unknown'`. PRD §5.4.1.
   *
   * When `matched` is not supplied (e.g. shouldAutoAccept's autoAccept
   * callback path before this commit, MockRuntime-only test fixtures),
   * fall back to the legacy `extractServiceName` so behavior is unchanged.
   */
  /**
   * Emit a `job:declined` (economic) or `job:filtered` (policy) event when a
   * polled job is rejected before acceptance.
   *
   * Before this, both rejection classes were swallowed into a single debug log
   * inside {@link shouldAutoAccept}, so a provider could only see "a job was
   * rejected" by parsing logs — consumers (e.g. Sentinel) had to monkeypatch
   * the agent to count declines. These events surface the decision with a
   * machine-readable `reason`.
   *
   * Semantics:
   *   - `job:declined`  — economic: budget/price out of band. The agent would
   *                       take it at a different price.
   *   - `job:filtered`  — policy: a custom predicate / rate-limit / legacy
   *                       filter rejected it. Price is irrelevant.
   *
   * Payload (second arg; first arg is the {@link Job} like other job:* events):
   *   `{ jobId, requester, amount, reason, ...extra }`
   *
   * Best-effort: wrapped in try/catch so a throwing listener can NEVER break
   * the accept/decline decision path (which would wrongly drop or take a job).
   */
  private emitJobDecision(
    event: 'job:declined' | 'job:filtered',
    tx: any,
    serviceHandler: { config: ServiceConfig; handler: JobHandler } | undefined,
    detail: { reason: string } & Record<string, unknown>
  ): void {
    // These two events fire MID-DECISION (right before `shouldAutoAccept`
    // returns), so a misbehaving listener must never affect the accept/decline
    // outcome — neither by a synchronous throw nor by a rejected Promise from
    // an `async` listener (which a plain EventEmitter.emit would surface as an
    // unhandledRejection and could crash a long-running agent).
    //
    // We therefore dispatch manually over `rawListeners` (which preserves
    // `once()` self-removal semantics) and swallow BOTH failure modes:
    //   * sync throw   → caught by the try/catch around the call
    //   * async reject → caught via `.catch()` on the returned thenable
    let job: Job | undefined;
    try {
      job = serviceHandler ? this.createJobFromTransaction(tx, serviceHandler) : undefined;
    } catch {
      job = undefined;
    }
    const payload = {
      jobId: tx?.id,
      requester: tx?.requester,
      amount: this.convertAmountToNumber(tx?.amount),
      ...detail,
    };
    for (const listener of this.rawListeners(event)) {
      try {
        const result = (listener as (...args: unknown[]) => unknown)(job, payload);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          (result as Promise<unknown>).catch(() => {
            /* async listener rejection — never propagates past the decision */
          });
        }
      } catch {
        /* sync listener throw — swallowed; the decision continues unaffected */
      }
    }
  }

  private createJobFromTransaction(
    tx: any,
    matched?: { config: ServiceConfig; handler: JobHandler }
  ): Job {
    return {
      id: tx.id,
      service: matched?.config.name ?? this.extractServiceName(tx),
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
   *Security: Always cleanup activeJobs on completion/failure
   *Security: Uses semaphore to limit concurrent execution
   */
  private async processJob(job: Job, handler: JobHandler): Promise<void> {
    const startTime = Date.now();

    // Security: Check concurrency limit before processing
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

      // Security: Use ProofGenerator to create authenticated delivery proof
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

      // ---------------------------------------------------------------------
      // AIP-16 Phase 2e — Delivery envelope hook
      // ---------------------------------------------------------------------
      //
      // Build + publish a DeliveryEnvelopeWireV1 between the handler result
      // and the on-chain `transitionState(DELIVERED)` hop. Strictly opt-in:
      //
      //   * Gated by `ACTP_DELIVERY_CHANNEL=v1` env flag (off in tests by
      //     default; flipped on once Sentinel migrates in Phase 2f).
      //   * Requires ALL four constructor fields: deliveryChannel,
      //     deliverySigner, kernelAddress, chainId.
      //   * Service config opts in via `delivery.mode === "channel"`
      //     (default for backward compatibility — see
      //     DEFAULT_DELIVERY_CONFIG).
      //
      // Idempotency: pollForJobs can re-deliver the same job. We read the
      // current on-chain state and only publish when it is still
      // `COMMITTED`. After we have transitioned to IN_PROGRESS the
      // envelope has already been (or is being) published — a second
      // call would just produce a redundant envelope. A no-op here keeps
      // the surface stable.
      //
      // Failure handling: channel publish failures are logged and SWALLOWED.
      // The on-chain settlement path is the source of truth for state
      // transitions; an envelope publish failure must NEVER block
      // `transitionState(DELIVERED)`. The provider may republish later or
      // the buyer may fall back to the on-chain `deliveryProof`.
      await this.maybePublishDeliveryEnvelope(job, result);

      // Transition transaction through IN_PROGRESS → DELIVERED states
      if (this._client) {
        // MockRuntime exposes its in-memory state directly so the agent can
        // attach the delivery proof for later verification. Real BlockchainRuntime
        // submits the proof on-chain via the kernel — no equivalent local poke
        // is needed there. The `as any` is intentional: the runtime interface
        // doesn't expose stateManager publicly, but MockRuntime's
        // implementation does for exactly this off-chain test path.
        const runtime = this._client.runtime as any;
        if (runtime.stateManager) {
          await runtime.stateManager.withLock(async (state: any) => {
            const tx = state.transactions[job.id];
            if (tx) {
              tx.deliveryProof = deliveryProofJson;
            }
          });
        }

        // The kernel rejects COMMITTED → DELIVERED direct transitions, so we
        // step through IN_PROGRESS first. Route via StandardAdapter so AA
        // providers send Paymaster-sponsored UserOps; EOA / mock paths
        // fall through to runtime.transitionState inside the adapter.
        //
        // Re-entry safety (PRD §5.5 orphan recovery): the orphan-IN_PROGRESS
        // recovery path in `pollForJobs` (blockchain mode also polls
        // IN_PROGRESS) re-delivers a tx that already advanced past
        // COMMITTED on-chain. In that case the IN_PROGRESS transition has
        // already happened and the kernel would reject a second
        // `transitionState(IN_PROGRESS)` with "Invalid transition". Skip
        // the hop when the tx is already in IN_PROGRESS or further.
        //
        // We re-read the tx state right before transitioning to avoid
        // racing with a concurrent admin/dispute pathway that may have
        // moved the tx since pollForJobs returned. The check is cheap
        // (one RPC read; the runtime caches recent reads). For test
        // stubs that don't provide getTransaction, default to COMMITTED —
        // matches both the canonical mock entry state (post-linkEscrow)
        // and the blockchain canonical entry state from pollForJobs.
        const currentTx = await this._client.runtime.getTransaction(job.id).catch(() => null);
        const currentState = currentTx?.state ?? 'COMMITTED';
        if (currentState === 'COMMITTED') {
          await this._client.standard.transitionState(job.id, 'IN_PROGRESS');
        } else if (currentState !== 'IN_PROGRESS') {
          // Tx is in some other state (CANCELLED, DISPUTED, etc.) — bail.
          this.logger.warn('Skipping DELIVERED transition; tx no longer in workable state', {
            jobId: job.id,
            currentState,
          });
          this.activeJobs.delete(job.id);
          return;
        }

        // Encode dispute window proof for DELIVERED transition
        // Use transaction's disputeWindow from metadata, fallback to 2 days (172800s) per Options.ts default
        const disputeWindowSeconds = job.metadata?.disputeWindow || 172800;
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const disputeWindowProof = abiCoder.encode(['uint256'], [disputeWindowSeconds]);

        // Transition to DELIVERED with dispute window proof.
        await this._client.standard.transitionState(job.id, 'DELIVERED', disputeWindowProof);
      }

      // Security: Remove from active jobs on SUCCESS
      this.activeJobs.delete(job.id);
      this.jobAttempts.delete(job.id);

      // Update stats
      this._stats.jobsCompleted++;
      const duration = Date.now() - startTime;
      this._stats.averageJobTime =
        (this._stats.averageJobTime * (this._stats.jobsCompleted - 1) + duration) /
        this._stats.jobsCompleted;
      this._stats.successRate =
        this._stats.jobsCompleted / (this._stats.jobsCompleted + this._stats.jobsFailed);
      this._stats.totalEarned += job.budget;

      // First-job ceremonial receipt (parallel to `actp test`'s buyer-side
      // wow). Opt-out via config or ACTP_NO_FIRST_JOB_RECEIPT=1; suppressed
      // on mock. Render is best-effort and silently swallowed on error so a
      // render failure can never block job:completed event emission.
      const showReceipt =
        this.config.showFirstJobReceipt !== false &&
        process.env.ACTP_NO_FIRST_JOB_RECEIPT !== '1' &&
        (this.network === 'testnet' || this.network === 'mainnet') &&
        this._stats.jobsCompleted === 1;
      if (showReceipt) {
        try {
          const { renderReceiptV3 } = await import('../cli/commands/receipt');
          const { Output } = await import('../cli/utils/output');
          const networkLabel =
            this.network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
          // Convert human-readable USDC budget ("0.05", "10") to 6-decimal
          // base units. Falls back to 0n on a non-finite parse (degraded
          // but non-crashing).
          const amountWei = Number.isFinite(job.budget)
            ? BigInt(Math.round(job.budget * 1_000_000))
            : 0n;
          const out = new Output('human');
          out.print('');
          renderReceiptV3(
            {
              agent: this.name,
              // counterparty intentionally undefined for raw addresses —
              // a 42-char hex would overflow the inner card. The renderer
              // shortAddr-s `requester` for us when counterparty is unset.
              perspective: 'provider',
              service: job.service,
              amountWei,
              network: networkLabel,
              txId: job.id,
              timing: { totalMs: duration, escrowLockMs: 0, settlementMs: 0 },
              requester: job.requester,
            },
            out,
          );
        } catch (err) {
          this.logger.warn('First-job ceremonial receipt render failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Emit events
      this.logger.info('Job completed', {
        jobId: job.id,
        duration,
        earned: job.budget,
      });
      this.emit('job:completed', job, result);
      this.emit('payment:received', job.budget);
    } catch (error) {
      // Default policy: remove from activeJobs + processedJobs so the next
      // poll re-attempts the job. Right for transient failures (RPC blip,
      // bundler timeout, paymaster denied a single attempt).
      //
      // Exception: kernel revert reasons that signal a PERMANENT failure
      // mode (the tx can never make forward progress) must NOT trigger
      // retry — that would spin every poll cycle, burning bundler quota
      // and filling logs. Keep job.id in processedJobs so the same tx
      // is skipped on subsequent sweeps. The set is in-memory and reset
      // on agent restart, which is the right blast radius: an operator
      // who intentionally rotates the kernel can clear it by restarting.
      const errorMessage = error instanceof Error ? error.message : String(error);
      const permanentRevertReasons = [
        'Transaction expired',  // ACTPKernel _enforceTiming after deadline
        'Invalid transition',   // _isValidTransition reject (no recovery path)
        'Only requester',       // wrong msg.sender for requester-only fn
        'Only provider',        // wrong msg.sender for provider-only fn
        'Not authorized',       // settle-before-window or wrong party
        'Not participant',      // attestation anchoring without standing
      ];
      // Bundler simulation reverts surface the kernel reason ABI-encoded —
      // the `Error(string)` selector `0x08c379a0` plus a length + the
      // UTF-8 bytes of the reason. Match plaintext AND hex form so we
      // catch both raw runtime reverts and UserOp simulation reverts.
      const errorMessageLower = errorMessage.toLowerCase();
      const isPermanentFailure = permanentRevertReasons.some((reason) => {
        if (errorMessage.includes(reason)) return true;
        const hexReason = Buffer.from(reason, 'utf-8').toString('hex').toLowerCase();
        return errorMessageLower.includes(hexReason);
      });

      this.activeJobs.delete(job.id);
      if (isPermanentFailure) {
        // Treat as processed so subsequent polls skip it. We don't emit
        // job:rejected because the job was already accepted upstream;
        // the operator's monitoring should rely on the job:failed signal
        // plus the explicit warning below.
        this.processedJobs.set(job.id, true);
        this.logger.warn(
          'Job failed with a permanent kernel revert — marking processed so polling does not retry forever',
          { jobId: job.id, reason: errorMessage.slice(0, 200) }
        );
      } else {
        // Transient by default — retry on the next poll. But a non-kernel
        // failure that keeps recurring (e.g. the handler throwing on bad input)
        // is effectively permanent; after MAX_JOB_ATTEMPTS, stop retrying so we
        // don't spin every poll cycle. The buyer stays protected by escrow
        // (dispute / deadline refunds).
        const attempts = (this.jobAttempts.get(job.id) ?? 0) + 1;
        if (attempts >= Agent.MAX_JOB_ATTEMPTS) {
          this.processedJobs.set(job.id, true);
          this.jobAttempts.delete(job.id);
          this.logger.warn(
            'Job failed repeatedly — marking processed after max attempts so polling does not retry forever',
            { jobId: job.id, attempts, reason: errorMessage.slice(0, 200) }
          );
        } else {
          this.jobAttempts.set(job.id, attempts);
          this.processedJobs.delete(job.id);
        }
      }
      this._stats.jobsFailed++;
      this._stats.successRate =
        this._stats.jobsCompleted / (this._stats.jobsCompleted + this._stats.jobsFailed);

      this.logger.error('Job failed', { jobId: job.id }, error as Error);
      this.emit('job:failed', job, error);
    } finally {
      // Security: Always release semaphore permit
      this.concurrencySemaphore.release();
    }
  }

  /**
   * AIP-16 Phase 2e — Publish a `DeliveryEnvelopeWireV1` for `job` on the
   * configured delivery channel, between handler completion and the
   * on-chain `transitionState(DELIVERED)` hop.
   *
   * Behavior:
   *  * Returns immediately (no-op) unless ALL of the following hold:
   *      - `process.env.ACTP_DELIVERY_CHANNEL === 'v1'`
   *      - `this.deliveryChannel`, `this.deliverySigner`,
   *        `this.kernelAddress`, and `this.chainId` are all present
   *      - the service's `delivery.mode === 'channel'` (default per
   *        {@link DEFAULT_DELIVERY_CONFIG})
   *      - the on-chain tx state is `COMMITTED` (idempotency guard
   *        against poll re-delivery)
   *  * For `delivery.privacy === 'encrypted'`: requires the buyer's
   *    setup to already be visible on the channel (otherwise the
   *    encrypted path cannot derive the shared secret); when missing
   *    the call logs a warning and returns without publishing.
   *  * Channel publish failures are caught, logged at `warn`, and
   *    swallowed. They MUST NOT throw out of this method.
   *  * Any unexpected failure (signer error, builder error, etc.) is
   *    caught and logged. The on-chain settlement path continues
   *    unaffected.
   *
   * The hook is a single seam — every wall-clock read inside the
   * envelope builder flows through `secondsNow()` per the timing-
   * discipline rule.
   *
   * @param job The job whose handler just returned. Its `service` field
   *   selects the {@link DeliveryServiceConfig}.
   * @param result The handler's return value. JSON-serialized into the
   *   envelope body (UTF-8 for `public-v1`, AES-GCM ciphertext for
   *   `x25519-aes256gcm-v1`).
   */
  /**
   * AIP-16 4.6.1: lazy zero-config wire-up of channel delivery deps.
   *
   * Pre-4.6.1, providers had to construct `Agent` with all four delivery
   * fields explicitly (deliveryChannel, deliverySigner, kernelAddress,
   * chainId). Sentinel — the canonical reference provider — never adopted
   * that boilerplate, so even with `ACTP_DELIVERY_CHANNEL=v1` set process-
   * wide its provide() handlers never POSTed an envelope. Buyers fell back
   * to the vendored local-reflection cache (`reflectionSource: local-
   * fallback`).
   *
   * This method auto-resolves any missing dep when the flag is on:
   *  * `deliveryChannel`  → new RelayDeliveryChannel({ baseUrl })
   *  * `kernelAddress`    → networkConfig.contracts.actpKernel
   *  * `chainId`          → networkConfig.chainId
   *  * `deliverySigner`   → ethers Wallet built from the resolved private
   *                         key (keystore/env, same path resolveBaseSigner
   *                         already uses on line 2185).
   *
   * Idempotent — only fills what's missing. Any failure (e.g. no private
   * key on mock mode) logs and leaves the field unset; the dependency
   * gate below will then no-op the publish, matching prior behavior.
   */
  private async ensureAip16AutoWire(): Promise<void> {
    if (process.env.ACTP_DELIVERY_CHANNEL !== 'v1') return;

    if (!this.deliveryChannel) {
      try {
        const { RelayDeliveryChannel } = await import('../delivery/RelayDeliveryChannel');
        this.deliveryChannel = new RelayDeliveryChannel({
          baseUrl: process.env.AGIRAILS_RELAY_URL || 'https://www.agirails.app',
        });
      } catch (err) {
        this.logger.warn('AIP-16 auto-wire: RelayDeliveryChannel import failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!this.kernelAddress || typeof this.chainId !== 'number') {
      try {
        const { getNetwork } = await import('../config/networks');
        const networkName = this.network === 'testnet' ? 'base-sepolia'
          : this.network === 'mainnet' ? 'base-mainnet'
          : this.network;
        const net = getNetwork(networkName);
        if (!this.kernelAddress) this.kernelAddress = net.contracts.actpKernel;
        if (typeof this.chainId !== 'number') this.chainId = net.chainId;
      } catch (err) {
        this.logger.warn('AIP-16 auto-wire: failed to derive kernel/chainId', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!this.deliverySigner && (this.network === 'testnet' || this.network === 'mainnet')) {
      try {
        const { resolvePrivateKey } = await import('../wallet/keystore');
        const pk = await resolvePrivateKey(this.config.stateDirectory, { network: this.network });
        if (pk) {
          const { Wallet } = await import('ethers');
          this.deliverySigner = new Wallet(pk);
        }
      } catch (err) {
        this.logger.warn('AIP-16 auto-wire: failed to resolve deliverySigner', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async maybePublishDeliveryEnvelope(
    job: Job,
    result: unknown,
  ): Promise<void> {
    // --- Feature flag gate ---
    //
    // The flag is read on every call (rather than at construction time)
    // so test suites can flip it per-test without re-constructing the
    // agent. Sentinel migration in Phase 2f will set it process-wide.
    if (process.env.ACTP_DELIVERY_CHANNEL !== 'v1') {
      return;
    }

    // --- Zero-config auto-wire (AIP-16 4.6.1) ---
    //
    // Lazy-resolve any missing delivery dep when the flag is on. Idempotent
    // — only fills holes. Providers that pass deps explicitly keep their
    // exact prior behavior.
    await this.ensureAip16AutoWire();

    // --- Constructor-side dependency gate ---
    //
    // Pre-AIP-16 callers do not pass these fields. Missing any one of
    // them disables the hook entirely — the agent behaves exactly like
    // the prior SDK.
    if (
      !this.deliveryChannel ||
      !this.deliverySigner ||
      !this.kernelAddress ||
      typeof this.chainId !== 'number'
    ) {
      return;
    }

    // --- Service config gate ---
    //
    // Read the per-service delivery config; fall back to the canonical
    // default (channel + public) so a service that does NOT specify
    // `delivery` still uses the channel mode. Sentinel + smoke flows
    // that want to skip the envelope set `delivery.mode = 'none'`.
    const service = this.services.get(job.service);
    const deliveryCfg = service?.config.delivery ?? DEFAULT_DELIVERY_CONFIG;
    if (deliveryCfg.mode !== 'channel') {
      return;
    }

    // --- Idempotency: current tx state MUST be COMMITTED ---
    //
    // pollForJobs may re-deliver the same job (e.g. orphan-recovery
    // path). When the tx has already advanced past COMMITTED, an
    // envelope publish at this point would either duplicate an
    // already-posted envelope or arrive after the buyer has stopped
    // listening — neither is useful. Best-effort read; if the runtime
    // cannot answer, skip the publish (the next poll's settlement path
    // will still run).
    try {
      const currentTx = await this._client?.runtime
        .getTransaction(job.id)
        .catch(() => null);
      if (!currentTx || currentTx.state !== 'COMMITTED') {
        this.logger.debug(
          'AIP-16: skipping envelope publish (tx not in COMMITTED)',
          { jobId: job.id, state: currentTx?.state },
        );
        return;
      }
    } catch (stateErr) {
      // A failure to *read* the state is non-fatal. Log + bail rather
      // than risk a duplicate publish.
      this.logger.warn(
        'AIP-16: failed to read tx state before envelope publish; skipping hook',
        {
          jobId: job.id,
          error: stateErr instanceof Error ? stateErr.message : String(stateErr),
        },
      );
      return;
    }

    // --- Resolve addresses ---
    //
    // providerAddress is the on-chain identity acting as the provider
    // (this agent). signerAddress is the EOA backing this.deliverySigner.
    // Smart-wallet flows pass a distinct provider address; non-smart-
    // wallet flows have providerAddress === signerAddress. The SDK does
    // NOT derive one from the other — both are sourced explicitly.
    let signerAddress: string;
    try {
      signerAddress = await this.deliverySigner.getAddress();
    } catch (signerErr) {
      this.logger.warn(
        'AIP-16: deliverySigner.getAddress() failed; skipping envelope publish',
        {
          jobId: job.id,
          error: signerErr instanceof Error ? signerErr.message : String(signerErr),
        },
      );
      return;
    }

    // Default providerAddress: the agent's on-chain address (this.address).
    // For smart-wallet flows where providerAddress != signerAddress the
    // caller should override via the deliverySigner-side address — but
    // for the common single-EOA case the agent address IS the signer.
    const providerAddress = (this.address || signerAddress) as `0x${string}`;
    if (
      !providerAddress ||
      !providerAddress.startsWith('0x') ||
      providerAddress.length !== 42
    ) {
      this.logger.warn(
        'AIP-16: unable to resolve providerAddress; skipping envelope publish',
        { jobId: job.id, providerAddress },
      );
      return;
    }

    // --- Build + publish ---
    //
    // The whole block is wrapped in a try/catch: per the contract,
    // channel publish failures and builder errors NEVER throw out of
    // this hook. They are logged at `warn` and swallowed so the
    // on-chain settlement path continues unaffected.
    try {
      const builder = new DeliveryEnvelopeBuilder(this.deliverySigner);
      const txIdHex = job.id as `0x${string}`;
      const kernelHex = this.kernelAddress as `0x${string}`;
      const signerHex = signerAddress as `0x${string}`;

      if (deliveryCfg.privacy === 'encrypted') {
        // Encrypted path requires the buyer's setup (carrying their
        // ephemeral X25519 pubkey). If the channel cannot enumerate
        // prior setups, or no setup has been posted yet, we cannot
        // derive the shared secret — log and skip. The buyer will
        // either re-post setup or fall back to on-chain dispute.
        if (!this.deliveryChannel.getSetups) {
          this.logger.warn(
            'AIP-16: encrypted service requires channel.getSetups; skipping envelope publish',
            { jobId: job.id },
          );
          return;
        }

        const setups = await this.deliveryChannel
          .getSetups(txIdHex)
          .catch(() => [] as unknown[]);
        // `setups[0]` is the canonical first setup. The dedup-after-
        // verify discipline on the channel side guarantees order
        // stability across multiple poll cycles.
        const setup = (setups as Array<{
          signed?: { buyerEphemeralPubkey?: `0x${string}` };
        }>)[0];
        const buyerPubkey = setup?.signed?.buyerEphemeralPubkey;
        if (!buyerPubkey) {
          this.logger.warn(
            'AIP-16: encrypted service has no setup on channel; skipping envelope publish',
            { jobId: job.id, setupsFound: setups.length },
          );
          return;
        }

        const { wire } = await builder.buildEncrypted({
          txId: txIdHex,
          chainId: this.chainId,
          kernelAddress: kernelHex,
          providerAddress,
          signerAddress: signerHex,
          payload: result,
          buyerEphemeralPubkey: buyerPubkey,
          // H4 (AIP-16 Phase 3): thread the constructor-supplied Smart
          // Wallet factory nonce. Defaults to 0 → byte-identical signing
          // vs. pre-H4 SDK builds.
          smartWalletNonce: this.smartWalletNonce ?? 0,
        });
        await this.deliveryChannel.publishEnvelope(wire);
        this.logger.info('AIP-16: encrypted envelope published', {
          jobId: job.id,
          scheme: wire.signed.scheme,
        });
      } else {
        // Public scheme — no setup lookup required. The body travels
        // as plaintext UTF-8 JSON; verification on the buyer side is
        // signature + payloadHash binding only.
        const { wire } = await builder.buildPublic({
          txId: txIdHex,
          chainId: this.chainId,
          kernelAddress: kernelHex,
          providerAddress,
          signerAddress: signerHex,
          payload: result,
          // H4 (AIP-16 Phase 3): thread the constructor-supplied Smart
          // Wallet factory nonce. Defaults to 0 → byte-identical signing
          // vs. pre-H4 SDK builds.
          smartWalletNonce: this.smartWalletNonce ?? 0,
        });
        await this.deliveryChannel.publishEnvelope(wire);
        this.logger.info('AIP-16: public envelope published', {
          jobId: job.id,
          scheme: wire.signed.scheme,
        });
      }
    } catch (publishErr) {
      // CRITICAL: must NOT re-throw. Settlement is the source of truth;
      // the envelope is an optimization on top. Log at `warn` so the
      // operator sees the problem without an outage signal.
      this.logger.warn(
        'AIP-16: envelope publish failed; settlement continues',
        {
          jobId: job.id,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        },
      );
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
            sdkLogger.debug(`[${job.id}] ${message}`, meta);
          }
        },
        info: (message: string, meta?: any) => {
          if (['debug', 'info'].includes(agent.config.logging?.level || 'info')) {
            sdkLogger.info(`[${job.id}] ${message}`, meta);
          }
        },
        warn: (message: string, meta?: any) => {
          if (['debug', 'info', 'warn'].includes(agent.config.logging?.level || 'info')) {
            sdkLogger.warn(`[${job.id}] ${message}`, meta);
          }
        },
        error: (message: string, meta?: any) => {
          sdkLogger.error(`[${job.id}] ${message}`, meta);
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

  private async generateAddress(): Promise<string> {
    const privateKey = await this.getPrivateKey();
    if (privateKey) {
      try {
        const wallet = new ethers.Wallet(privateKey);
        return wallet.address.toLowerCase();
      } catch (error) {
        throw new ValidationError('wallet', 'Invalid private key format');
      }
    }

    if (this.network === 'testnet' || this.network === 'mainnet') {
      throw new ValidationError(
        'wallet',
        `${this.network} mode requires a valid private key or address in wallet configuration.\n` +
        'Run "actp init" to generate a keystore, or set ACTP_PRIVATE_KEY env var.'
      );
    }

    return `0x${Buffer.from(this.name).toString('hex').padEnd(40, '0').slice(0, 40)}`;
  }

  private async getPrivateKey(): Promise<string | undefined> {
    if (!this.config.wallet || this.config.wallet === 'auto') {
      if (this.network === 'testnet' || this.network === 'mainnet') {
        return resolvePrivateKey(this.config.stateDirectory, { network: this.network });
      }
      return undefined;
    }

    if (this.config.wallet === 'connect') {
      return undefined;
    }

    if (typeof this.config.wallet === 'string') {
      if (/^0x[0-9a-fA-F]{64}$/.test(this.config.wallet)) {
        try {
          new ethers.Wallet(this.config.wallet);
          return this.config.wallet;
        } catch {
          throw new ValidationError('wallet', 'Invalid private key format');
        }
      }
      return undefined;
    }

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
