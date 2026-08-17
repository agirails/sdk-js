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

// Registration-v1 projection (off-chain, no transaction side effects)
export {
  buildERC8004RegistrationV1,
  serializeERC8004RegistrationV1,
  validateERC8004RegistrationV1,
  ERC8004_REGISTRATION_V1_TYPE,
} from './registration';
export type {
  BuildERC8004RegistrationOptions,
  ERC8004RegistrationReference,
  ERC8004RegistrationService,
  ERC8004RegistrationV1,
} from './registration';

// Migration planning (read-only; never uploads, signs, or submits)
export {
  createERC8004MigrationLedger,
  createERC8004MigrationRecord,
} from './migration';

// Explicit read-only inventory collection for migration evidence
export {
  collectERC8004MigrationInventory,
  fetchERC8004Artifact,
} from './inventory';
export type {
  ERC8004IdentityReader,
  ERC8004InventoryFailure,
  ERC8004InventoryFile,
  ERC8004InventoryNetwork,
  ERC8004InventoryOptions,
} from './inventory';
export type {
  ERC8004MigrationInput,
  ERC8004MigrationLedger,
  ERC8004MigrationRecord,
  ERC8004MigrationReview,
  ERC8004MigrationReviewStatus,
  ERC8004MigrationStatus,
} from './migration';
