/**
 * Adapter Layer - Bridges user-friendly API to protocol-level SDK
 *
 * This module exports all adapter classes and types for the Three-Level API:
 * - BaseAdapter: Abstract base with shared utilities
 * - BasicAdapter: High-level, opinionated API
 * - StandardAdapter: Balanced control API
 * - AdapterRegistry: Central registry for adapter management
 * - AdapterRouter: Intelligent adapter selection with guard-rails
 * - IAdapter: Common interface for all adapters
 *
 * @module adapters
 */

export {
  BaseAdapter,
  ValidationError,
  DEFAULT_DISPUTE_WINDOW_SECONDS,
  DEFAULT_DEADLINE_SECONDS,
  MIN_AMOUNT_WEI,
  MAX_DEADLINE_HOURS,
  MAX_DEADLINE_DAYS,
} from './BaseAdapter';
export { BasicAdapter, BasicPayParams, BasicPayResult } from './BasicAdapter';
export { StandardAdapter, StandardTransactionParams } from './StandardAdapter';
export { AdapterRegistry } from './AdapterRegistry';
export { AdapterRouter } from './AdapterRouter';
export {
  IAdapter,
  TransactionStatus,
  AdapterTransactionState,
  isAdapter,
} from './IAdapter';

// Re-export runtime interface for convenience
export { IACTPRuntime, CreateTransactionParams } from '../runtime/IACTPRuntime';

// Re-export adapter types for convenience
export {
  AdapterMetadata,
  PaymentMetadata,
  PaymentIdentity,
  UnifiedPayParams,
  UnifiedPayResult,
  InitialTransactionState,
  AdapterMetadataSchema,
  PaymentMetadataSchema,
  UnifiedPayParamsSchema,
  validatePayParams,
  safeValidatePayParams,
} from '../types/adapter';
