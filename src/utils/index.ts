/**
 * ACTP SDK Utilities
 *
 * This module exports all utility classes for the ACTP SDK.
 *
 * @module utils
 */

// Error Recovery (HIGH-6)
export {
  ErrorRecoveryGuide,
  withRecoveryGuidance,
  type ErrorRecoveryInfo,
  type ErrorSeverity,
  type ErrorCategory,
} from './ErrorRecoveryGuide';

// Rate Limiting & Circuit Breaker (M-4, M-5)
export {
  RateLimiter,
  CircuitBreaker,
  APIProtector,
  type RateLimiterConfig,
  type RateLimitResult,
  type CircuitBreakerConfig,
  type CircuitBreakerResult,
  type CircuitState,
} from './RateLimiter';

// Logging & Metrics (M-6, M-7)
export {
  Logger,
  MetricsCollector,
  sdkLogger,
  sdkMetrics,
  type LogLevel,
  type LogEntry,
  type LoggerConfig,
  type MetricsHook,
} from './Logger';

// SDK Lifecycle (M-8)
export {
  SDKLifecycle,
  sdkLifecycle,
  onShutdown,
  registerDisposable,
  shutdownSDK,
  type Disposable,
  type ShutdownHandler,
  type LifecycleEvent,
  type LifecycleListener,
} from './SDKLifecycle';

// Nonce Tracking (Security)
export {
  InMemoryReceivedNonceTracker,
  SetBasedReceivedNonceTracker,
  createReceivedNonceTracker,
  type IReceivedNonceTracker,
  type NonceValidationResult,
} from './ReceivedNonceTracker';

// Attestation Tracking (Security)
export {
  InMemoryUsedAttestationTracker,
  FileBasedUsedAttestationTracker,
  createUsedAttestationTracker,
  type IUsedAttestationTracker,
} from './UsedAttestationTracker';

// Helper Utilities (L-7)
export {
  USDC,
  Deadline,
  Address,
  Bytes32,
  State,
  DisputeWindow,
} from './Helpers';
