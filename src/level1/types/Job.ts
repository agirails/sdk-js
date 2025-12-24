/**
 * Job - Represents a work request from requester to provider
 *
 * This is the core data structure passed to service handlers
 * in the Basic and Standard APIs.
 *
 * @packageDocumentation
 */

/**
 * Job interface - work request data
 *
 * @example
 * ```typescript
 * const job: Job = {
 *   id: '0x1234...abcd',
 *   service: 'translation',
 *   input: { text: 'Hello', from: 'en', to: 'de' },
 *   budget: 10,
 *   deadline: new Date('2025-12-14T12:00:00Z'),
 *   requester: '0xRequester...',
 *   metadata: { priority: 'high' }
 * }
 * ```
 */
export interface Job {
  /**
   * Unique job identifier (transaction ID from ACTP protocol)
   */
  id: string;

  /**
   * Service type being requested (e.g., 'translation', 'echo', 'image-gen')
   */
  service: string;

  /**
   * Input data for the service (service-specific)
   *
   * This is the data the requester wants processed.
   * Structure depends on the service type.
   */
  input: any;

  /**
   * Budget in USDC (decimal format, e.g., 10 = $10.00)
   *
   * This is the maximum amount the requester is willing to pay.
   */
  budget: number;

  /**
   * Deadline by which work must be completed
   */
  deadline: Date;

  /**
   * Ethereum address of the requester
   */
  requester: string;

  /**
   * Additional metadata (optional, service-specific)
   */
  metadata: Record<string, any>;
}

/**
 * Job handler function type
 *
 * This is the function signature providers must implement.
 *
 * @param job - The job to process
 * @param context - Job execution context
 * @returns Promise resolving to job result (service-specific)
 *
 * @example
 * ```typescript
 * const handler: JobHandler = async (job, ctx) => {
 *   ctx.progress(50, 'Processing...');
 *   const result = await doWork(job.input);
 *   ctx.progress(100, 'Done!');
 *   return result;
 * };
 * ```
 */
export type JobHandler = (job: Job, context: JobContext) => Promise<any>;

/**
 * JobContext - Execution context passed to job handlers
 *
 * Provides utilities for progress reporting, logging, state management,
 * and cancellation handling.
 */
export interface JobContext {
  /**
   * Reference to the Agent instance processing this job
   */
  agent: any; // Will be typed as Agent once implemented

  /**
   * Report job progress
   *
   * @param percent - Progress percentage (0-100)
   * @param message - Optional progress message
   *
   * @example
   * ```typescript
   * ctx.progress(25, 'Downloaded input file');
   * ctx.progress(50, 'Processing data');
   * ctx.progress(100, 'Complete!');
   * ```
   */
  progress(percent: number, message?: string): void;

  /**
   * Logging utilities
   */
  log: {
    debug(message: string, meta?: any): void;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, meta?: any): void;
  };

  /**
   * Job-scoped state storage
   *
   * Allows handlers to store intermediate state that persists
   * across async operations (e.g., for resumable jobs).
   *
   * @example
   * ```typescript
   * // Store checkpoint
   * ctx.state.set('lastProcessedIndex', 42);
   *
   * // Retrieve checkpoint
   * const lastIndex = ctx.state.get<number>('lastProcessedIndex') || 0;
   * ```
   */
  state: {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
  };

  /**
   * Whether the job has been cancelled
   *
   * Handlers should check this periodically for long-running jobs
   * and exit gracefully if true.
   *
   * @example
   * ```typescript
   * for (let i = 0; i < items.length; i++) {
   *   if (ctx.cancelled) {
   *     throw new Error('Job cancelled by requester');
   *   }
   *   await processItem(items[i]);
   * }
   * ```
   */
  cancelled: boolean;

  /**
   * Register cancellation handler
   *
   * Called when the job is cancelled, allowing cleanup.
   *
   * @example
   * ```typescript
   * const stream = openFileStream();
   * ctx.onCancel(() => {
   *   stream.close();
   *   console.log('Cleaned up resources');
   * });
   * ```
   */
  onCancel(handler: () => void): void;
}
