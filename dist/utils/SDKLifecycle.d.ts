/**
 * SDKLifecycle - Proper cleanup and resource management
 *
 * SECURITY FIX (M-8): Ensures proper cleanup on SDK shutdown:
 * - Connection cleanup
 * - Pending request handling
 * - Memory release
 * - Graceful shutdown
 *
 * @module utils/SDKLifecycle
 */
import { Logger } from './Logger';
/**
 * Disposable resource interface
 */
export interface Disposable {
    /** Cleanup method */
    dispose(): Promise<void> | void;
}
/**
 * Shutdown handler function
 */
export type ShutdownHandler = () => Promise<void> | void;
/**
 * Lifecycle event types
 */
export type LifecycleEvent = 'initializing' | 'ready' | 'shutting-down' | 'shutdown' | 'error';
/**
 * Lifecycle event listener
 */
export type LifecycleListener = (event: LifecycleEvent, data?: unknown) => void;
/**
 * SDK Lifecycle Manager
 *
 * Manages SDK initialization, shutdown, and resource cleanup.
 *
 * @example
 * ```typescript
 * const lifecycle = new SDKLifecycle();
 *
 * // Register cleanup handlers
 * lifecycle.onShutdown(async () => {
 *   await closeConnections();
 * });
 *
 * // Register disposable resources
 * lifecycle.registerDisposable(myResource);
 *
 * // Later, initiate shutdown
 * await lifecycle.shutdown();
 * ```
 */
export declare class SDKLifecycle {
    private state;
    private shutdownHandlers;
    private disposables;
    private listeners;
    private shutdownPromise;
    private readonly logger;
    private isShuttingDown;
    private processHandlers;
    private processHandlersRegistered;
    constructor(logger?: Logger);
    /**
     * Get current lifecycle state
     */
    getState(): LifecycleEvent;
    /**
     * Check if SDK is ready for operations
     */
    isReady(): boolean;
    /**
     * Mark SDK as ready
     */
    markReady(): void;
    /**
     * Register a shutdown handler
     *
     * @param handler - Function to call during shutdown
     * @returns Unregister function
     */
    onShutdown(handler: ShutdownHandler): () => void;
    /**
     * Register a disposable resource
     *
     * @param disposable - Resource with dispose() method
     * @returns Unregister function
     */
    registerDisposable(disposable: Disposable): () => void;
    /**
     * Add lifecycle event listener
     *
     * @param listener - Event listener function
     * @returns Unregister function
     */
    addListener(listener: LifecycleListener): () => void;
    /**
     * Emit lifecycle event
     */
    private emit;
    /**
     * Initiate graceful shutdown
     *
     * @param timeout - Maximum time to wait for cleanup (ms)
     * @returns Promise that resolves when shutdown is complete
     */
    shutdown(timeout?: number): Promise<void>;
    /**
     * Execute shutdown sequence
     */
    private executeShutdown;
    /**
     * Register process-level shutdown handlers
     *
     * SECURITY FIX (NEW-HIGH-2): Store handler references for cleanup
     * to prevent memory leaks when multiple SDKLifecycle instances are created.
     */
    private registerProcessHandlers;
    /**
     * Unregister process-level shutdown handlers
     *
     * SECURITY FIX (NEW-HIGH-2): Remove handlers to prevent memory leaks
     */
    private unregisterProcessHandlers;
    /**
     * Create a disposable wrapper for any cleanup function
     */
    static createDisposable(cleanup: () => Promise<void> | void): Disposable;
}
/**
 * Global SDK lifecycle manager instance
 */
export declare const sdkLifecycle: SDKLifecycle;
/**
 * Convenience function to run cleanup on shutdown
 *
 * @example
 * ```typescript
 * const cleanup = onShutdown(async () => {
 *   await closeDatabase();
 * });
 *
 * // Later, to remove the handler:
 * cleanup();
 * ```
 */
export declare function onShutdown(handler: ShutdownHandler): () => void;
/**
 * Convenience function to register disposable
 */
export declare function registerDisposable(disposable: Disposable): () => void;
/**
 * Convenience function to shutdown SDK
 */
export declare function shutdownSDK(timeout?: number): Promise<void>;
//# sourceMappingURL=SDKLifecycle.d.ts.map