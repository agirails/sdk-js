/**
 * Provider - Return type of provide() function
 *
 * Provides control and observability for a running service provider.
 *
 * @packageDocumentation
 */

import { Job } from '../level1/types/Job';

/**
 * Provider status
 */
export type ProviderStatus = 'starting' | 'running' | 'paused' | 'stopped';

/**
 * Provider statistics
 */
export interface ProviderStats {
  jobsCompleted: number;
  jobsFailed: number;
  totalEarned: number;
  averageJobTime: number;
}

/**
 * Provider balance
 */
export interface ProviderBalance {
  eth: string;
  usdc: string;
}

/**
 * Provider interface
 *
 * Returned by provide() to control the provider lifecycle.
 *
 * @example
 * ```typescript
 * const provider = provide('echo', async (job) => job.input);
 *
 * // Monitor events
 * provider.on('job:received', (job) => {
 *   console.log(`Received job: ${job.id}`);
 * });
 *
 * provider.on('payment:received', (amount) => {
 *   console.log(`Earned ${amount} USDC`);
 * });
 *
 * // Control lifecycle
 * provider.pause();  // Stop accepting new jobs
 * provider.resume(); // Resume
 * await provider.stop(); // Graceful shutdown
 *
 * // Check statistics
 * console.log(`Completed: ${provider.stats.jobsCompleted}`);
 * console.log(`Earned: $${provider.stats.totalEarned}`);
 * ```
 */
export interface Provider {
  /**
   * Promise that resolves when the provider is fully started and registered.
   * Await this before calling request() for the same service.
   */
  ready: Promise<void>;

  /**
   * Current status
   */
  status: ProviderStatus;

  /**
   * Provider's Ethereum address
   */
  address: string;

  /**
   * Balance information
   */
  balance: ProviderBalance;

  /**
   * Pause the provider
   *
   * Stops accepting new jobs but keeps running jobs active.
   */
  pause(): void;

  /**
   * Resume the provider
   *
   * Resumes accepting new jobs after pause.
   */
  resume(): void;

  /**
   * Stop the provider
   *
   * Gracefully shuts down, waiting for active jobs to complete.
   */
  stop(): Promise<void>;

  /**
   * Register event listener
   *
   * Supported events:
   * - 'job:received': (job: Job) => void
   * - 'job:completed': (job: Job, result: any) => void
   * - 'job:failed': (job: Job, error: Error) => void
   * - 'payment:received': (amount: number) => void
   */
  on(event: 'job:received', handler: (job: Job) => void): void;
  on(event: 'job:completed', handler: (job: Job, result: any) => void): void;
  on(event: 'job:failed', handler: (job: Job, error: Error) => void): void;
  on(event: 'payment:received', handler: (amount: number) => void): void;

  /**
   * Statistics
   */
  stats: ProviderStats;
}
