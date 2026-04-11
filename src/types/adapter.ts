/**
 * Adapter types for the ACTP SDK adapter routing system.
 *
 * This module defines types and Zod schemas for:
 * - AdapterMetadata: Capabilities and configuration for each adapter
 * - PaymentMetadata: Request-level hints for adapter selection
 * - UnifiedPayParams: Common payment parameters across adapters
 * - UnifiedPayResult: Common result type for all adapters
 *
 * @module types/adapter
 */

import { z } from 'zod';
import type { X402FeeBreakdown } from './x402';

// ============================================================================
// AdapterMetadata - Describes adapter capabilities
// ============================================================================

/**
 * Metadata describing an adapter's capabilities.
 *
 * CRITICAL: All adapters must respect ACTP state machine:
 * - No skipping IN_PROGRESS state
 * - DELIVERED requires proof
 * - releaseEscrow must be called explicitly (NO auto-settle)
 */
export interface AdapterMetadata {
  /** Unique adapter identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Whether adapter uses escrow */
  usesEscrow: boolean;

  /** Whether adapter supports dispute resolution */
  supportsDisputes: boolean;

  /** Whether adapter requires on-chain identity */
  requiresIdentity: boolean;

  /** Supported identity types (erc8004, did, ens) */
  supportedIdentityTypes?: string[];

  /**
   * Settlement mode:
   * - 'explicit': caller must call releaseEscrow (REQUIRED for ACTP compliance)
   * - 'timed': auto-release after dispute window (future, not Phase 1)
   * - 'atomic': instant settlement, no escrow (x402 protocol)
   */
  settlementMode: 'explicit' | 'timed' | 'atomic';

  /** Priority for auto-selection (higher = preferred) */
  priority: number;
}

/**
 * Zod schema for AdapterMetadata runtime validation.
 */
export const AdapterMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  usesEscrow: z.boolean(),
  supportsDisputes: z.boolean(),
  requiresIdentity: z.boolean(),
  supportedIdentityTypes: z.array(z.string()).optional(),
  settlementMode: z.enum(['explicit', 'timed', 'atomic']),
  priority: z.number().int().min(0).max(100),
});

// ============================================================================
// PaymentMetadata - Request-level hints for adapter selection
// ============================================================================

/**
 * Identity information for adapter selection.
 */
export interface PaymentIdentity {
  type: 'erc8004' | 'did' | 'ens' | 'address';
  value: string;
}

/**
 * Payment request metadata for adapter selection.
 */
export interface PaymentMetadata {
  /** Explicitly request specific adapter */
  preferredAdapter?: string;

  /** Require escrow protection */
  requiresEscrow?: boolean;

  /** Require dispute resolution capability */
  requiresDispute?: boolean;

  /** Identity information */
  identity?: PaymentIdentity;

  /** x402 specific: payment method hint */
  paymentMethod?: 'x402' | 'actp' | 'auto';
}

/**
 * Zod schema for PaymentIdentity runtime validation.
 */
export const PaymentIdentitySchema = z.object({
  type: z.enum(['erc8004', 'did', 'ens', 'address']),
  value: z.string().min(1),
});

/**
 * Zod schema for PaymentMetadata runtime validation.
 */
export const PaymentMetadataSchema = z.object({
  preferredAdapter: z.string().optional(),
  requiresEscrow: z.boolean().optional(),
  requiresDispute: z.boolean().optional(),
  identity: PaymentIdentitySchema.optional(),
  paymentMethod: z.enum(['x402', 'actp', 'auto']).optional(),
});

// ============================================================================
// UnifiedPayParams - Common payment parameters
// ============================================================================

/**
 * Unified payment parameters accepted by all adapters.
 */
export interface UnifiedPayParams {
  /** Recipient - address, HTTP endpoint, or ERC-8004 agent ID */
  to: string;

  /**
   * Amount in human-readable format.
   *
   * - REQUIRED for ACTP adapters (basic, standard) — client sets the price
   * - OPTIONAL for x402 URL targets — amount comes from the server's
   *   payment-required response; this field is ignored. The x402 adapter
   *   enforces its own per-tx safety cap via `ACTPClientConfig.x402.maxAmountPerTx`.
   */
  amount?: string | number;

  /** Deadline (relative like '+24h' or unix timestamp) */
  deadline?: string | number;

  /** Dispute window in seconds (min 3600, max 30 days) */
  disputeWindow?: number;

  /** Service description */
  description?: string;

  /** Adapter selection metadata */
  metadata?: PaymentMetadata;

  /**
   * ERC-8004 agent ID (populated when 'to' was resolved from agentId).
   * Set by AdapterRouter when resolving agent ID to wallet address.
   * Used for reputation reporting after settlement.
   */
  erc8004AgentId?: string;
}

/**
 * Minimum dispute window in seconds (1 hour).
 * Ensures requesters have reasonable time to dispute.
 */
const MIN_DISPUTE_WINDOW = 3600;

/**
 * Maximum dispute window in seconds (30 days).
 * Prevents excessively long fund locks.
 */
const MAX_DISPUTE_WINDOW = 30 * 24 * 3600;

/**
 * Zod schema for UnifiedPayParams with strict validation.
 */
export const UnifiedPayParamsSchema = z.object({
  to: z.string().min(1),
  // Optional — x402 URL targets derive amount from server response.
  // ACTP adapters (basic, standard) validate presence at pay() time.
  amount: z.union([z.string().min(1), z.number().positive()]).optional(),
  deadline: z.union([z.string(), z.number()]).optional(),
  disputeWindow: z
    .number()
    .int()
    .min(MIN_DISPUTE_WINDOW)
    .max(MAX_DISPUTE_WINDOW)
    .optional(),
  description: z.string().optional(),
  metadata: PaymentMetadataSchema.optional(),
  erc8004AgentId: z.string().optional(),
});

// ============================================================================
// UnifiedPayResult - Common result type
// ============================================================================

/**
 * Transaction state after payment initiation.
 *
 * Note: 'COMMITTED' means funds are locked but work hasn't started.
 * 'IN_PROGRESS' means provider has acknowledged and started work.
 */
export type InitialTransactionState = 'COMMITTED' | 'IN_PROGRESS';

/**
 * Unified payment result returned by all adapters.
 *
 * NOTE: success=true means payment INITIATED, not settled.
 * Caller must call releaseEscrow() after delivery verification.
 */
export interface UnifiedPayResult {
  /** ACTP transaction ID */
  txId: string;

  /** Escrow ID (for release) - null for non-escrow adapters */
  escrowId: string | null;

  /** Adapter that handled the payment */
  adapter: string;

  /** Current state (COMMITTED, not SETTLED) */
  state: InitialTransactionState;

  /** Whether payment initiation succeeded */
  success: boolean;

  /** Amount locked (formatted) */
  amount: string;

  /** For x402: the HTTP response */
  response?: Response;

  /** Error message if failed */
  error?: string;

  /**
   * IMPORTANT: Payment is NOT complete until you call:
   * await client.release(result.escrowId)
   *
   * Always true for ACTP-compliant adapters.
   */
  releaseRequired: boolean;

  /** Provider address (normalized to lowercase) */
  provider: string;

  /** Requester address (normalized to lowercase) */
  requester: string;

  /** Deadline as ISO 8601 timestamp */
  deadline: string;

  /**
   * ERC-8004 agent ID (if transaction involved ERC-8004 agent).
   * Use with ReputationReporter.reportSettlement() after release.
   */
  erc8004AgentId?: string;

  /**
   * Fee breakdown for x402 payments routed through X402Relay.
   * Present only when relay is configured and payment used the relay path.
   */
  feeBreakdown?: X402FeeBreakdown;
}

/**
 * Zod schema for UnifiedPayResult validation.
 */
export const UnifiedPayResultSchema = z.object({
  txId: z.string().min(1),
  escrowId: z.string().nullable(),
  adapter: z.string().min(1),
  state: z.enum(['COMMITTED', 'IN_PROGRESS']),
  success: z.boolean(),
  amount: z.string().min(1),
  response: z.any().optional(),
  error: z.string().optional(),
  releaseRequired: z.boolean(),
  provider: z.string().min(1),
  requester: z.string().min(1),
  deadline: z.string().min(1),
  erc8004AgentId: z.string().optional(),
  feeBreakdown: z.object({
    grossAmount: z.string(),
    providerNet: z.string(),
    platformFee: z.string(),
    feeBps: z.number(),
    estimated: z.literal(true),
  }).optional(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validates UnifiedPayParams at runtime.
 *
 * @param params - Parameters to validate
 * @returns Validated params
 * @throws {z.ZodError} If validation fails
 */
export function validatePayParams(params: unknown): UnifiedPayParams {
  return UnifiedPayParamsSchema.parse(params);
}

/**
 * Safe parse for UnifiedPayParams (doesn't throw).
 *
 * @param params - Parameters to validate
 * @returns Result with success flag and data or error
 */
export function safeValidatePayParams(params: unknown): z.SafeParseReturnType<unknown, UnifiedPayParams> {
  return UnifiedPayParamsSchema.safeParse(params);
}
