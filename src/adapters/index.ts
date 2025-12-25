/**
 * Adapter Layer - Bridges user-friendly API to protocol-level SDK
 *
 * This module exports all adapter classes and types for the Three-Level API:
 * - BaseAdapter: Abstract base with shared utilities
 * - BasicAdapter: High-level, opinionated API
 * - StandardAdapter: Balanced control API
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

// Re-export runtime interface for convenience
export { IACTPRuntime, CreateTransactionParams } from '../runtime/IACTPRuntime';
