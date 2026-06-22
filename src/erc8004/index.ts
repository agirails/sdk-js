/**
 * ERC-8004 Trustless Agents Integration
 *
 * Provides integration with ERC-8004 standard for:
 * - Agent identity resolution (Identity Registry)
 * - Reputation reporting (Reputation Registry)
 *
 * @example
 * ```typescript
 * import {
 *   ERC8004Bridge,
 *   ReputationReporter,
 *   ERC8004Error,
 * } from '@agirails/sdk/erc8004';
 *
 * // Read agent info
 * const bridge = new ERC8004Bridge({ network: 'base-sepolia' });
 * const agent = await bridge.resolveAgent('12345');
 *
 * // Report settlement
 * const reporter = new ReputationReporter({
 *   network: 'base-sepolia',
 *   signer: wallet,
 * });
 * await reporter.reportSettlement({ agentId: '12345', txId });
 * ```
 *
 * @module erc8004
 */

// Bridge (read-only)
export { ERC8004Bridge } from './ERC8004Bridge';
export type { ERC8004BridgeConfig } from './ERC8004Bridge';

// Reporter (write)
export { ReputationReporter } from './ReputationReporter';
export type {
  ReputationReporterConfig,
  ReportSettlementParams,
  ReportDisputeParams,
  ReportDisputeSplitParams,
  ReportResult,
} from './ReputationReporter';

// Re-export types from types/erc8004
export type {
  ERC8004Network,
  ERC8004Agent,
  ERC8004AgentMetadata,
  ReputationFeedback,
  ReputationSummary,
  ACTPFeedbackTag,
} from '../types/erc8004';

export {
  ERC8004Error,
  ERC8004ErrorCode,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  ERC8004_DEFAULT_RPC,
  ACTP_FEEDBACK_TAGS,
} from '../types/erc8004';
