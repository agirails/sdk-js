/**
 * Adapter Layer - Bridges user-friendly API to protocol-level SDK
 *
 * This module exports all adapter classes and types for the Three-Level API:
 * - BaseAdapter: Abstract base with shared utilities
 * - BeginnerAdapter: High-level, opinionated API
 * - IntermediateAdapter: Balanced control API
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
export { BeginnerAdapter, BeginnerPayParams, BeginnerPayResult } from './BeginnerAdapter';
export { IntermediateAdapter, IntermediateTransactionParams } from './IntermediateAdapter';

// Re-export runtime interface for convenience
export { IACTPRuntime, CreateTransactionParams } from '../runtime/IACTPRuntime';
