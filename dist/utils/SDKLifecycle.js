"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.sdkLifecycle = exports.SDKLifecycle = void 0;
exports.onShutdown = onShutdown;
exports.registerDisposable = registerDisposable;
exports.shutdownSDK = shutdownSDK;
const Logger_1 = require("./Logger");
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
class SDKLifecycle {
    constructor(logger) {
        this.state = 'initializing';
        this.shutdownHandlers = [];
        this.disposables = [];
        this.listeners = [];
        this.shutdownPromise = null;
        this.isShuttingDown = false;
        // SECURITY FIX (NEW-HIGH-2): Store handler references for cleanup
        this.processHandlers = {};
        this.processHandlersRegistered = false;
        this.logger = logger ?? Logger_1.sdkLogger.child('Lifecycle');
        // Register process shutdown handlers
        this.registerProcessHandlers();
    }
    /**
     * Get current lifecycle state
     */
    getState() {
        return this.state;
    }
    /**
     * Check if SDK is ready for operations
     */
    isReady() {
        return this.state === 'ready';
    }
    /**
     * Mark SDK as ready
     */
    markReady() {
        this.state = 'ready';
        this.emit('ready');
        this.logger.info('SDK ready');
    }
    /**
     * Register a shutdown handler
     *
     * @param handler - Function to call during shutdown
     * @returns Unregister function
     */
    onShutdown(handler) {
        this.shutdownHandlers.push(handler);
        return () => {
            const index = this.shutdownHandlers.indexOf(handler);
            if (index > -1) {
                this.shutdownHandlers.splice(index, 1);
            }
        };
    }
    /**
     * Register a disposable resource
     *
     * @param disposable - Resource with dispose() method
     * @returns Unregister function
     */
    registerDisposable(disposable) {
        this.disposables.push(disposable);
        return () => {
            const index = this.disposables.indexOf(disposable);
            if (index > -1) {
                this.disposables.splice(index, 1);
            }
        };
    }
    /**
     * Add lifecycle event listener
     *
     * @param listener - Event listener function
     * @returns Unregister function
     */
    addListener(listener) {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index > -1) {
                this.listeners.splice(index, 1);
            }
        };
    }
    /**
     * Emit lifecycle event
     */
    emit(event, data) {
        for (const listener of this.listeners) {
            try {
                listener(event, data);
            }
            catch (error) {
                this.logger.error('Lifecycle listener error', { event }, error);
            }
        }
    }
    /**
     * Initiate graceful shutdown
     *
     * @param timeout - Maximum time to wait for cleanup (ms)
     * @returns Promise that resolves when shutdown is complete
     */
    async shutdown(timeout = 30000) {
        // Prevent multiple shutdown calls
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }
        if (this.isShuttingDown) {
            return;
        }
        this.isShuttingDown = true;
        this.state = 'shutting-down';
        this.emit('shutting-down');
        this.logger.info('SDK shutting down...');
        this.shutdownPromise = this.executeShutdown(timeout);
        return this.shutdownPromise;
    }
    /**
     * Execute shutdown sequence
     */
    async executeShutdown(timeout) {
        const startTime = Date.now();
        const errors = [];
        // Create timeout promise
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Shutdown timed out after ${timeout}ms`));
            }, timeout);
        });
        try {
            // Run shutdown handlers first (in reverse order - LIFO)
            const handlersPromise = (async () => {
                for (let i = this.shutdownHandlers.length - 1; i >= 0; i--) {
                    try {
                        const elapsed = Date.now() - startTime;
                        if (elapsed >= timeout) {
                            this.logger.warn('Shutdown timeout reached, skipping remaining handlers');
                            break;
                        }
                        const handler = this.shutdownHandlers[i];
                        await handler();
                    }
                    catch (error) {
                        this.logger.error('Shutdown handler error', {}, error);
                        errors.push(error);
                    }
                }
                // Dispose resources (in reverse order)
                for (let i = this.disposables.length - 1; i >= 0; i--) {
                    try {
                        const elapsed = Date.now() - startTime;
                        if (elapsed >= timeout) {
                            this.logger.warn('Shutdown timeout reached, skipping remaining disposables');
                            break;
                        }
                        const disposable = this.disposables[i];
                        await disposable.dispose();
                    }
                    catch (error) {
                        this.logger.error('Disposable cleanup error', {}, error);
                        errors.push(error);
                    }
                }
            })();
            // Race against timeout
            await Promise.race([handlersPromise, timeoutPromise]);
        }
        catch (error) {
            if (error.message.includes('timed out')) {
                this.logger.warn('Shutdown timed out, forcing cleanup');
            }
            else {
                errors.push(error);
            }
        }
        // SECURITY FIX (NEW-HIGH-2): Remove process handlers to prevent memory leaks
        this.unregisterProcessHandlers();
        // Clear registrations
        this.shutdownHandlers = [];
        this.disposables = [];
        this.state = 'shutdown';
        this.emit('shutdown');
        this.logger.info('SDK shutdown complete', { errors: errors.length });
        if (errors.length > 0) {
            this.logger.error('Shutdown completed with errors', {
                errorCount: errors.length,
                errors: errors.map((e) => e.message),
            });
        }
    }
    /**
     * Register process-level shutdown handlers
     *
     * SECURITY FIX (NEW-HIGH-2): Store handler references for cleanup
     * to prevent memory leaks when multiple SDKLifecycle instances are created.
     */
    registerProcessHandlers() {
        // Only register in Node.js environment
        if (typeof process === 'undefined') {
            return;
        }
        // SECURITY FIX (NEW-HIGH-2): Prevent duplicate registrations
        if (this.processHandlersRegistered) {
            return;
        }
        // SECURITY FIX (NEW-HIGH-2): Create named handlers we can remove later
        this.processHandlers.sigint = () => {
            this.logger.info('Received SIGINT, initiating shutdown');
            this.shutdown().then(() => {
                process.exit(0);
            }).catch((error) => {
                this.logger.error('Shutdown error', {}, error);
                process.exit(1);
            });
        };
        this.processHandlers.sigterm = () => {
            this.logger.info('Received SIGTERM, initiating shutdown');
            this.shutdown().then(() => {
                process.exit(0);
            }).catch((error) => {
                this.logger.error('Shutdown error', {}, error);
                process.exit(1);
            });
        };
        this.processHandlers.uncaughtException = (error) => {
            this.logger.error('Uncaught exception', {}, error);
            this.emit('error', error);
            this.shutdown().finally(() => {
                process.exit(1);
            });
        };
        this.processHandlers.unhandledRejection = (reason) => {
            const error = reason instanceof Error ? reason : new Error(String(reason));
            this.logger.error('Unhandled rejection', {}, error);
            this.emit('error', error);
        };
        // Handle termination signals
        process.on('SIGINT', this.processHandlers.sigint);
        process.on('SIGTERM', this.processHandlers.sigterm);
        // Handle uncaught errors
        process.on('uncaughtException', this.processHandlers.uncaughtException);
        process.on('unhandledRejection', this.processHandlers.unhandledRejection);
        this.processHandlersRegistered = true;
    }
    /**
     * Unregister process-level shutdown handlers
     *
     * SECURITY FIX (NEW-HIGH-2): Remove handlers to prevent memory leaks
     */
    unregisterProcessHandlers() {
        if (typeof process === 'undefined' || !this.processHandlersRegistered) {
            return;
        }
        if (this.processHandlers.sigint) {
            process.removeListener('SIGINT', this.processHandlers.sigint);
        }
        if (this.processHandlers.sigterm) {
            process.removeListener('SIGTERM', this.processHandlers.sigterm);
        }
        if (this.processHandlers.uncaughtException) {
            process.removeListener('uncaughtException', this.processHandlers.uncaughtException);
        }
        if (this.processHandlers.unhandledRejection) {
            process.removeListener('unhandledRejection', this.processHandlers.unhandledRejection);
        }
        this.processHandlers = {};
        this.processHandlersRegistered = false;
    }
    /**
     * Create a disposable wrapper for any cleanup function
     */
    static createDisposable(cleanup) {
        return {
            dispose: cleanup,
        };
    }
}
exports.SDKLifecycle = SDKLifecycle;
/**
 * Global SDK lifecycle manager instance
 */
exports.sdkLifecycle = new SDKLifecycle();
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
function onShutdown(handler) {
    return exports.sdkLifecycle.onShutdown(handler);
}
/**
 * Convenience function to register disposable
 */
function registerDisposable(disposable) {
    return exports.sdkLifecycle.registerDisposable(disposable);
}
/**
 * Convenience function to shutdown SDK
 */
function shutdownSDK(timeout) {
    return exports.sdkLifecycle.shutdown(timeout);
}
//# sourceMappingURL=SDKLifecycle.js.map