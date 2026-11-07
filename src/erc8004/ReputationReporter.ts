/**
 * ERC-8004 Reputation Reporter
 *
 * WRITES to ERC-8004 Reputation Registry after ACTP settlements.
 *
 * CRITICAL SECURITY NOTES:
 * 1. Requires signer (pays gas) - typically the requester
 * 2. Caller MUST NOT be agent owner (ERC-8004 restriction)
 * 3. Uses feedbackHash = keccak256(txId) for replay protection
 * 4. Failures are logged but NEVER block ACTP settlement
 * 5. Local dedup prevents double-reporting in same session
 *
 * WHEN TO CALL:
 * - reportSettlement(): After successful release() (state = SETTLED)
 * - reportDispute(): After dispute resolution
 *
 * FAILURE HANDLING:
 * - All methods return null on failure (never throw)
 * - Settlement/dispute already succeeded - reputation is bonus
 * - Log warnings for debugging
 *
 * @example
 * ```typescript
 * const reporter = new ReputationReporter({
 *   network: 'base-sepolia',
 *   signer: requesterWallet,
 * });
 *
 * // After successful release
 * const txHash = await reporter.reportSettlement({
 *   agentId: '12345',
 *   txId: result.txId,
 *   capability: 'code_generation',
 * });
 *
 * if (txHash) {
 *   console.log('Reputation reported:', txHash);
 * } else {
 *   console.warn('Report failed (settlement still succeeded)');
 * }
 * ```
 *
 * @module erc8004/ReputationReporter
 */

import { ethers, Signer } from 'ethers';
import {
  ERC8004Network,
  ERC8004_REPUTATION_REGISTRY,
  ERC8004_REPUTATION_ABI,
  ACTP_FEEDBACK_TAGS,
} from '../types/erc8004';
import { sdkLogger } from '../utils/Logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Transaction receipt interface for reputation reports.
 */
interface TransactionReceipt {
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
}

/**
 * Transaction response interface.
 */
interface TransactionResponse {
  wait(): Promise<TransactionReceipt>;
}

/**
 * Interface for ERC-8004 Reputation Registry contract.
 * Used for testing with mock implementations.
 */
export interface IERC8004ReputationRegistry {
  giveFeedback(
    agentId: string,
    value: number,
    valueDecimals: number,
    tag1: string,
    tag2: string,
    endpoint: string,
    feedbackURI: string,
    feedbackHash: string,
    txOptions?: { gasLimit?: bigint }
  ): Promise<TransactionResponse>;

  getSummary(
    agentId: string,
    clientAddresses: string[],
    tag1: string,
    tag2: string
  ): Promise<[bigint, bigint, number]>;

  revokeLatest(agentId: string, feedbackIndex: bigint): Promise<TransactionResponse>;
}

/**
 * Configuration for ReputationReporter.
 */
export interface ReputationReporterConfig {
  /** Target network */
  network: ERC8004Network;

  /** Signer for transactions (pays gas) */
  signer: Signer;

  /** Override registry address (optional, for testing) */
  registryAddress?: string;

  /** Gas limit override (optional) */
  gasLimit?: bigint;

  /**
   * Injected contract instance (optional, for testing).
   * If provided, skips creating a real ethers Contract.
   * @internal
   */
  _testContract?: IERC8004ReputationRegistry;
}

/**
 * Parameters for reporting a successful settlement.
 */
export interface ReportSettlementParams {
  /** ERC-8004 agent ID */
  agentId: string;

  /** ACTP transaction ID (used for replay protection) */
  txId: string;

  /** Agent capability (e.g., 'code_generation', 'data_analysis') */
  capability?: string;

  /** Service endpoint (optional) */
  endpoint?: string;

  /** Link to transaction details (optional, IPFS or HTTPS) */
  feedbackURI?: string;
}

/**
 * Parameters for reporting a dispute resolution.
 */
export interface ReportDisputeParams {
  /** ERC-8004 agent ID */
  agentId: string;

  /** ACTP transaction ID */
  txId: string;

  /** true if agent won the dispute, false if requester won */
  agentWon: boolean;

  /** Agent capability (optional) */
  capability?: string;

  /** Dispute reason/details (optional, stored as feedbackURI) */
  reason?: string;
}

/**
 * Parameters for reporting a dispute SPLIT outcome (AIP-14b §3.4, §3.5).
 *
 * A split (CompositeMediator ruling-2 OR kernel DISPUTED→CANCELLED) carries NO
 * reputation penalty for either party — it is written as a NEUTRAL `value: 0`
 * trace — but it is NOT reputation-invisible. The trace lets indexers surface
 * per-agent split rates so systematic dispute-to-split ambiguity griefing is
 * visible to future counterparties (INV-22).
 *
 * PARITY: Py `ReputationReporter.report_dispute_split`.
 */
export interface ReportDisputeSplitParams {
  /** ERC-8004 agent ID */
  agentId: string;

  /** ACTP transaction ID (used for replay protection + dedup) */
  txId: string;

  /** Agent capability (optional, tag2) */
  capability?: string;

  /**
   * Provider share in basis points (0–10000), if known from the
   * `DisputeSplitRecorded` event. Recorded as `feedbackURI` for transparency;
   * does NOT change the neutral `value: 0`. Optional.
   */
  splitBps?: number;
}

/**
 * Result of a reputation report.
 */
export interface ReportResult {
  /** Transaction hash */
  txHash: string;

  /** Block number */
  blockNumber: number;

  /** Gas used */
  gasUsed: bigint;
}

// ============================================================================
// ReputationReporter
// ============================================================================

/**
 * Reporter for submitting ACTP settlement outcomes to ERC-8004 Reputation.
 *
 * Designed to never block or fail the main ACTP flow.
 * All errors are caught and logged, returning null on failure.
 *
 * PARITY: python-sdk-v2/src/agirails/erc8004/reputation_reporter.py — every
 * public method (reportSettlement / reportDispute / reportDisputeSplit /
 * getAgentReputation / isReported / clearReportedCache / getStats) has a Py
 * twin with the same name (snake_case) and arity.
 */
export class ReputationReporter {
  private readonly registry: IERC8004ReputationRegistry;
  private readonly signer: Signer;
  private readonly network: ERC8004Network;
  private readonly gasLimit?: bigint;

  /**
   * Track reported txIds to prevent double-reporting in same session.
   * Note: This is in-memory only, so restarts allow re-reporting.
   * On-chain, feedbackHash provides permanent dedup.
   */
  private readonly reportedTxIds: Set<string> = new Set();

  constructor(config: ReputationReporterConfig) {
    this.network = config.network;
    this.signer = config.signer;
    this.gasLimit = config.gasLimit;

    // Use injected contract for testing
    if (config._testContract) {
      this.registry = config._testContract;
      return;
    }

    const registryAddress =
      config.registryAddress ?? ERC8004_REPUTATION_REGISTRY[config.network];

    if (registryAddress === ethers.ZeroAddress) {
      sdkLogger.warn(
        `[ERC8004] Reputation Registry not deployed on ${config.network}. Reports will fail.`
      );
    }

    this.registry = new ethers.Contract(
      registryAddress,
      ERC8004_REPUTATION_ABI,
      config.signer
    ) as unknown as IERC8004ReputationRegistry;
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Report successful ACTP settlement to ERC-8004 Reputation.
   *
   * Call this AFTER release() succeeds. Failure here does NOT affect settlement.
   *
   * Reports:
   * - value: 1 (positive feedback)
   * - valueDecimals: 0 (binary)
   * - tag1: 'actp_settled'
   * - tag2: capability
   * - feedbackHash: keccak256(txId)
   *
   * @param params - Settlement details
   * @returns ReportResult if successful, null if failed
   */
  async reportSettlement(params: ReportSettlementParams): Promise<ReportResult | null> {
    const {
      agentId,
      txId,
      capability = '',
      endpoint = '',
      feedbackURI = '',
    } = params;

    // Local dedup check
    if (this.reportedTxIds.has(txId)) {
      sdkLogger.warn(`[ERC8004] Already reported txId in this session: ${txId}`);
      return null;
    }

    try {
      // Compute feedbackHash for on-chain replay protection
      const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(txId));

      // Prepare transaction options
      const txOptions: { gasLimit?: bigint } = {};
      if (this.gasLimit) {
        txOptions.gasLimit = this.gasLimit;
      }

      // Submit feedback
      const tx = await this.registry.giveFeedback(
        agentId,
        1, // value: 1 = success
        0, // decimals: 0 (binary)
        ACTP_FEEDBACK_TAGS.SETTLED, // tag1: 'actp_settled'
        capability, // tag2: capability
        endpoint,
        feedbackURI,
        feedbackHash,
        txOptions
      );

      // Wait for confirmation
      const receipt = await tx.wait();

      // Mark as reported
      this.reportedTxIds.add(txId);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      // Log but NEVER throw - settlement already succeeded
      this.logError('reportSettlement', agentId, txId, error);
      return null;
    }
  }

  /**
   * Report ACTP dispute resolution to ERC-8004 Reputation.
   *
   * Call this after dispute is resolved (either party won).
   *
   * Reports:
   * - value: 1 if agent won, -1 if requester won
   * - valueDecimals: 0 (binary)
   * - tag1: 'actp_dispute_won' or 'actp_dispute_lost'
   * - tag2: capability
   * - feedbackHash: keccak256(txId)
   *
   * @param params - Dispute details
   * @returns ReportResult if successful, null if failed
   */
  async reportDispute(params: ReportDisputeParams): Promise<ReportResult | null> {
    const { agentId, txId, agentWon, capability = '', reason = '' } = params;

    // Local dedup check
    if (this.reportedTxIds.has(txId)) {
      sdkLogger.warn(`[ERC8004] Already reported txId in this session: ${txId}`);
      return null;
    }

    try {
      const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(txId));

      // Determine value and tag based on outcome
      const value = agentWon ? 1 : -1;
      const tag1 = agentWon
        ? ACTP_FEEDBACK_TAGS.DISPUTE_WON
        : ACTP_FEEDBACK_TAGS.DISPUTE_LOST;

      const txOptions: { gasLimit?: bigint } = {};
      if (this.gasLimit) {
        txOptions.gasLimit = this.gasLimit;
      }

      const tx = await this.registry.giveFeedback(
        agentId,
        value,
        0, // decimals: 0 (binary)
        tag1,
        capability,
        '', // endpoint
        reason, // feedbackURI (contains dispute reason)
        feedbackHash,
        txOptions
      );

      const receipt = await tx.wait();
      this.reportedTxIds.add(txId);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      this.logError('reportDispute', agentId, txId, error);
      return null;
    }
  }

  /**
   * Report an ACTP dispute SPLIT outcome to ERC-8004 Reputation (AIP-14b §3.4,
   * §3.5, INV-22).
   *
   * Call this after a dispute resolves to a SPLIT — either a CompositeMediator
   * ruling-2 (`DisputeSplitRecorded`) or a kernel `DISPUTED → CANCELLED`
   * transition (admin-CANCELLED). Failure here does NOT affect the resolution.
   *
   * Reports:
   * - value: **0** (NEUTRAL — no penalty for either party; INV-4)
   * - valueDecimals: 0 (binary)
   * - tag1: 'actp_dispute_split' (identical string in both SDKs)
   * - tag2: capability
   * - feedbackURI: `splitBps` (when known) for transparency
   * - feedbackHash: keccak256(txId)
   *
   * The neutral value makes the split rate INDEXABLE without punishing
   * legitimately ambiguous one-off cases. PARITY: Py `report_dispute_split`.
   *
   * @param params - Split details
   * @returns ReportResult if successful, null if failed (NEVER throws)
   */
  async reportDisputeSplit(
    params: ReportDisputeSplitParams
  ): Promise<ReportResult | null> {
    const { agentId, txId, capability = '', splitBps } = params;

    // Local dedup check
    if (this.reportedTxIds.has(txId)) {
      sdkLogger.warn(`[ERC8004] Already reported txId in this session: ${txId}`);
      return null;
    }

    try {
      const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(txId));

      const txOptions: { gasLimit?: bigint } = {};
      if (this.gasLimit) {
        txOptions.gasLimit = this.gasLimit;
      }

      const tx = await this.registry.giveFeedback(
        agentId,
        0, // value: 0 = NEUTRAL split trace (no penalty — AIP-14b §3.4/INV-4)
        0, // decimals: 0 (binary)
        ACTP_FEEDBACK_TAGS.DISPUTE_SPLIT, // tag1: 'actp_dispute_split'
        capability, // tag2: capability
        '', // endpoint
        splitBps !== undefined ? `splitBps:${splitBps}` : '', // feedbackURI
        feedbackHash,
        txOptions
      );

      const receipt = await tx.wait();
      this.reportedTxIds.add(txId);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      // Log but NEVER throw — split resolution already succeeded on-chain.
      this.logError('reportDisputeSplit', agentId, txId, error);
      return null;
    }
  }

  /**
   * Get reputation summary for an agent.
   *
   * This is a READ operation (no gas cost).
   *
   * @param agentId - ERC-8004 agent ID
   * @param tag1 - Filter by tag1 (optional, e.g., 'actp_settled')
   * @returns Summary if successful, null if failed
   */
  async getAgentReputation(
    agentId: string,
    tag1?: string
  ): Promise<{ count: number; score: number } | null> {
    try {
      const [count, summaryValue] = await this.registry.getSummary(
        agentId,
        [], // clientAddresses (empty = all)
        tag1 ?? '',
        '' // tag2
      );

      return {
        count: Number(count),
        score: Number(summaryValue),
      };
    } catch (error) {
      sdkLogger.error(
        `[ERC8004] getAgentReputation failed for ${agentId}: ${error instanceof Error ? error.message : error}`
      );
      return null;
    }
  }

  /**
   * Check if a transaction was already reported in this session.
   *
   * Note: This is local-only. For on-chain check, you'd need to
   * query the feedbackHash mapping (not exposed in standard interface).
   *
   * @param txId - ACTP transaction ID
   */
  isReported(txId: string): boolean {
    return this.reportedTxIds.has(txId);
  }

  /**
   * Clear local dedup cache.
   * Use when starting new session or for testing.
   */
  clearReportedCache(): void {
    this.reportedTxIds.clear();
  }

  /**
   * Get reporter statistics.
   */
  getStats(): { network: ERC8004Network; reportedCount: number } {
    return {
      network: this.network,
      reportedCount: this.reportedTxIds.size,
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Log error in consistent format.
   * NEVER throws - errors are informational only.
   */
  private logError(
    method: string,
    agentId: string,
    txId: string,
    error: unknown
  ): void {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Check for common error cases
    if (errorMessage.includes('insufficient funds')) {
      sdkLogger.error(
        `[ERC8004] ${method} failed for agent ${agentId}: Insufficient funds for gas. Signer needs ETH/native token.`
      );
    } else if (errorMessage.includes('cannot be the agent owner')) {
      sdkLogger.error(
        `[ERC8004] ${method} failed for agent ${agentId}: Caller is agent owner. ERC-8004 requires different address.`
      );
    } else if (errorMessage.includes('user rejected')) {
      sdkLogger.warn(
        `[ERC8004] ${method} cancelled by user for agent ${agentId}`
      );
    } else {
      sdkLogger.error(
        `[ERC8004] ${method} failed for agent ${agentId} (tx: ${txId}): ${errorMessage}`
      );
    }
  }
}
