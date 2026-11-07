import { Provider, Signer } from 'ethers';
import {
  BondEscalationClient,
  BondEscalationClientConfig,
  IBondEscalationContract,
} from './BondEscalation';
import { CompositeMediator } from './CompositeMediator';
import { EvaluatorClient, EvaluatorClientConfig } from './EvaluatorClient';
import { UMAHelper, UMAHelperConfig } from './UMAHelper';
import { DisputeSplitIndexer, DisputeOutcome } from '../reputation/DisputeSplitIndexer';
import { DisputeState, Ruling, Tier } from '../types/dispute';

// PARITY: python-sdk-v2/src/agirails/dispute/dispute_client.py
// This file and its Python twin MUST stay 1:1 — every public symbol here
// (DisputeClient + its methods/accessors, DisputeSubState, DisputeStatus,
// decodeDisputeSubState) has a Py twin with the SAME name (snake_case for
// methods) and arity, and vice-versa. The §9 sub-state decode is anchored to the
// shared cross-SDK fixture
// `DISPUTE SYSTEM/test-vectors/dispute-client-status-vectors.json`, which both the
// jest and pytest suites consume byte-identically and from which both derive the
// SAME sub-state string. Any change here (rename, new method, decode tweak) must
// be mirrored in the twin.

/**
 * DisputeClient — the SINGLE facade over the AIP-14b three-tier dispute system
 * (PRD P2-9).
 *
 * It composes the five M1.5 dispute primitives behind one object so an agent
 * touches one surface instead of five:
 *
 * | Accessor      | Underlying client        | Role (AIP-14b)                          |
 * |---------------|--------------------------|-----------------------------------------|
 * | `.bond`       | {@link BondEscalationClient} | Tier-1 bond game + lifecycle (§7)     |
 * | `.mediator`   | {@link CompositeMediator}    | split-trace reads/decoders (§3.4, §6) |
 * | `.evaluator`  | {@link EvaluatorClient}      | Tier-0 off-chain AI handshake (§4)    |
 * | `.uma`        | {@link UMAHelper}            | Tier-2 requester self-dispute (§8.6)  |
 * | `.splitIndexer` | {@link DisputeSplitIndexer} | per-agent split-rate (§3.4, OQ-11)   |
 *
 * Each sub-client is OPTIONAL: the facade is usable with only the pieces a caller
 * configured (e.g. read-only split-rate surfacing needs neither a signer nor the
 * evaluator URL). Accessors throw a clear error when the corresponding piece was
 * not configured, rather than silently no-oping.
 *
 * The facade adds exactly ONE piece of net-new logic over the primitives:
 * {@link getDisputeStatus}, which reads the on-chain dispute and decodes the §9
 * sub-state (UNINITIALIZED / OPENED / PROPOSED / ESCALATED / RESOLVED) — the
 * single decode that both SDKs MUST agree on byte-for-byte. Everything else is
 * pure delegation; the heavy lifting lives in the primitives.
 *
 * ## Relationship to the legacy kernel dispute path
 * `ACTPKernel.raiseDispute` / `resolveDispute` are the PRE-AIP-14 single-shot
 * kernel path (transition straight to DISPUTED, then admin-resolve to
 * SETTLED/CANCELLED). The tiered flow reached through THIS client is their
 * AIP-14b successor: `raiseDispute` still opens the kernel DISPUTED state, but
 * resolution then runs through the bond game here (open → propose/AI → challenge →
 * finalize / escalateToUMA) instead of a privileged `resolveDispute`. The kernel
 * JSDoc steers callers here (grep `DisputeClient` in `protocol/ACTPKernel.ts`).
 *
 * Reference: AIP-14b §3 (architecture), §7 (BondEscalation), §9 (state machine),
 * PRD P2-9.
 *
 * @module dispute/DisputeClient
 */

// =====================================================================
// §9 sub-state model
// =====================================================================

/**
 * The AIP-14b §9 dispute sub-state, decoded from the on-chain `disputes(...)`
 * struct. These are the dispute-engine's OWN states (distinct from the kernel's
 * 8-state transaction machine):
 *
 * - `UNINITIALIZED` — no dispute opened for this id (`disputedAt == 0`).
 * - `OPENED` — `openDispute()` ran; no proposal yet (`tier == 0`).
 * - `PROPOSED` — a direct/AI proposal is live in the challengeable bond game
 *   (`tier == 1`, unresolved). NOTE: §9 draws a CHALLENGED node, but `challenge()`
 *   does NOT change `tier` (it stays 1), so on-chain a challenged dispute is
 *   indistinguishable from a freshly-proposed one — both decode to `PROPOSED`.
 * - `ESCALATED` — escalated to UMA OOV3 (`tier == 2`, unresolved).
 * - `RESOLVED` — finalized on-chain (`resolved == true`), regardless of tier.
 *
 * PARITY: Py `DisputeSubState` (string-literal values identical).
 */
export type DisputeSubState =
  | 'UNINITIALIZED'
  | 'OPENED'
  | 'PROPOSED'
  | 'ESCALATED'
  | 'RESOLVED';

/**
 * Result of {@link DisputeClient.getDisputeStatus}: the decoded
 * {@link DisputeState} PLUS the §9 {@link DisputeSubState} and the raw
 * `disputedAt` timestamp (0 ⇒ never opened). PARITY: Py `DisputeStatus`.
 */
export interface DisputeStatus {
  /** keccak256 dispute identifier (bytes32). */
  disputeId: string;
  /** The §9 sub-state (the single cross-SDK decode). */
  substate: DisputeSubState;
  /** Current escalation tier (0/1/2). */
  tier: Tier | number;
  /** Whether the dispute is finalized on-chain. */
  resolved: boolean;
  /** Current/final ruling (0=provider, 1=requester, 2=split). */
  ruling: Ruling | number;
  /** Provider share in bps (meaningful for `ruling == 2`). */
  splitBps: number;
  /** `disputedAt` from the struct (unix seconds; 0 ⇒ never opened). */
  disputedAt: number;
  /** The base decoded {@link DisputeState} (tier/ruling/splitBps/resolved). */
  state: DisputeState;
}

/**
 * Decode the AIP-14b §9 sub-state from a raw `disputes(bytes32)` tuple.
 *
 * Pure + static so the cross-SDK fixture test exercises it without a chain. The
 * tuple field order is load-bearing (AIP-14b §7.3):
 * `[transactionId, currentRuling, splitBps, currentBond, accumulatedBonds,
 *   livenessEnd, disputedAt, lastProposer, tier, resolved, winnerPaid,
 *   originalPool, escrowAmount]`.
 *
 * Decode order is load-bearing (each branch is mutually exclusive in priority):
 *   1. `disputedAt == 0`  → `UNINITIALIZED` (never opened — checked FIRST).
 *   2. `resolved == true` → `RESOLVED` (dominates tier — a resolved tier-2
 *      dispute is RESOLVED, not ESCALATED).
 *   3. `tier == 2`        → `ESCALATED`.
 *   4. `tier == 1`        → `PROPOSED` (challenge() keeps tier==1, so no
 *      separate CHALLENGED).
 *   5. else (`tier == 0`) → `OPENED`.
 *
 * PARITY: Py `decode_dispute_sub_state` — identical branch order + outputs
 * (anchored to `dispute-client-status-vectors.json`).
 *
 * @param raw - the raw `disputes()` tuple (array OR named ethers Result).
 */
export function decodeDisputeSubState(raw: unknown): DisputeSubState {
  const r = raw as Record<string | number, unknown>;
  const pick = (idx: number, name: string): unknown =>
    r[name] !== undefined ? r[name] : r[idx];

  const disputedAt = Number(pick(6, 'disputedAt'));
  const tier = Number(pick(8, 'tier'));
  const resolved = Boolean(pick(9, 'resolved'));

  if (disputedAt === 0) return 'UNINITIALIZED';
  if (resolved) return 'RESOLVED';
  if (tier === 2) return 'ESCALATED';
  if (tier === 1) return 'PROPOSED';
  return 'OPENED';
}

// =====================================================================
// Facade config
// =====================================================================

/**
 * Configuration for {@link DisputeClient}.
 *
 * Two construction styles (mirrors the primitives):
 *  - Pass `signer` + the three on-chain addresses (`bondEscalationAddress`,
 *    `compositeMediatorAddress`, `umaOptimisticOracleV3Address`, `usdcAddress`)
 *    and the facade builds the underlying clients.
 *  - Pass already-built sub-clients (`bond`, `mediator`, `uma`, `evaluator`,
 *    `splitIndexer`) directly — the unit-test / dependency-injection path.
 *
 * Anything omitted yields an unconfigured accessor that throws on use.
 */
export interface DisputeClientConfig {
  /** Signer for the on-chain write paths (BondEscalation, UMA). */
  signer?: Signer;
  /** Provider for read-only paths (CompositeMediator events). */
  provider?: Provider;
  /** Deployed BondEscalation address (Tier-1 + AIRuling verifier). */
  bondEscalationAddress?: string;
  /** Deployed CompositeMediator address (split-trace reads). */
  compositeMediatorAddress?: string;
  /** UMA OptimisticOracleV3 address (Tier-2). */
  umaOptimisticOracleV3Address?: string;
  /** USDC (bond currency) address — needed for the UMA self-dispute path. */
  usdcAddress?: string;
  /** Block confirmations to await after each write (default 2 — Base L2). */
  confirmations?: number;

  /** Pre-built BondEscalation client (overrides the address path). */
  bond?: BondEscalationClient;
  /** Injected BondEscalation contract (testing without a live chain). */
  bondContract?: IBondEscalationContract;
  /** Pre-built CompositeMediator read client. */
  mediator?: CompositeMediator;
  /** Pre-built UMA self-dispute helper. */
  uma?: UMAHelper;
  /** Pre-built off-chain EvaluatorClient (Tier-0). */
  evaluator?: EvaluatorClient;
  /** Evaluator config — if given (and no `evaluator`), the facade builds one. */
  evaluatorConfig?: EvaluatorClientConfig;
  /** Pre-seeded split indexer (a fresh empty one is created if omitted). */
  splitIndexer?: DisputeSplitIndexer;
}

// =====================================================================
// Facade
// =====================================================================

/**
 * The one-object dispute facade (PRD P2-9). See the module JSDoc for the table
 * of sub-clients. Wired onto {@link ACTPClient} as `client.dispute` iff the three
 * dispute contract addresses are configured for the network.
 */
export class DisputeClient {
  private readonly _bond?: BondEscalationClient;
  private readonly _mediator?: CompositeMediator;
  private readonly _uma?: UMAHelper;
  private readonly _evaluator?: EvaluatorClient;
  private readonly _splitIndexer: DisputeSplitIndexer;

  constructor(config: DisputeClientConfig = {}) {
    const confirmations = config.confirmations ?? 2;

    // --- BondEscalation (Tier-1) ---
    if (config.bond) {
      this._bond = config.bond;
    } else if (config.bondContract || (config.bondEscalationAddress && config.signer)) {
      const bondCfg: BondEscalationClientConfig = {
        address: config.bondEscalationAddress ?? '0x0000000000000000000000000000000000000000',
        signer: config.signer as Signer,
        contract: config.bondContract,
        confirmations,
      };
      this._bond = new BondEscalationClient(bondCfg);
    }

    // --- CompositeMediator (split-trace reads) ---
    if (config.mediator) {
      this._mediator = config.mediator;
    } else if (config.compositeMediatorAddress && (config.provider || config.signer)) {
      this._mediator = new CompositeMediator(
        config.compositeMediatorAddress,
        (config.provider ?? (config.signer as unknown)) as Provider
      );
    }

    // --- UMAHelper (Tier-2 self-dispute) ---
    if (config.uma) {
      this._uma = config.uma;
    } else if (
      config.bondEscalationAddress &&
      config.umaOptimisticOracleV3Address &&
      config.usdcAddress &&
      config.signer
    ) {
      const umaCfg: UMAHelperConfig = {
        bondEscalationAddress: config.bondEscalationAddress,
        oov3Address: config.umaOptimisticOracleV3Address,
        usdcAddress: config.usdcAddress,
        signer: config.signer,
        confirmations,
      };
      this._uma = new UMAHelper(umaCfg);
    }

    // --- EvaluatorClient (Tier-0 off-chain) ---
    if (config.evaluator) {
      this._evaluator = config.evaluator;
    } else if (config.evaluatorConfig) {
      this._evaluator = new EvaluatorClient(config.evaluatorConfig);
    }

    // --- DisputeSplitIndexer (always present; a pure accumulator) ---
    this._splitIndexer = config.splitIndexer ?? new DisputeSplitIndexer();
  }

  // ===================================================================
  // Sub-client accessors (throw a clear error when not configured)
  // ===================================================================

  /** The Tier-1 {@link BondEscalationClient}. @throws if not configured. */
  get bond(): BondEscalationClient {
    if (!this._bond) {
      throw new Error(
        'DisputeClient.bond is not configured (no BondEscalation address/signer/contract). ' +
          'The dispute contracts are not deployed on this network yet, or you constructed ' +
          'the facade without a BondEscalation piece.'
      );
    }
    return this._bond;
  }

  /** The {@link CompositeMediator} split-trace read client. @throws if not configured. */
  get mediator(): CompositeMediator {
    if (!this._mediator) {
      throw new Error(
        'DisputeClient.mediator is not configured (no CompositeMediator address/provider).'
      );
    }
    return this._mediator;
  }

  /** The Tier-2 {@link UMAHelper}. @throws if not configured. */
  get uma(): UMAHelper {
    if (!this._uma) {
      throw new Error(
        'DisputeClient.uma is not configured (needs BondEscalation + UMA OOV3 + USDC addresses + signer).'
      );
    }
    return this._uma;
  }

  /** The Tier-0 off-chain {@link EvaluatorClient}. @throws if not configured. */
  get evaluator(): EvaluatorClient {
    if (!this._evaluator) {
      throw new Error(
        'DisputeClient.evaluator is not configured (pass evaluator or evaluatorConfig with a baseUrl + paymentClient).'
      );
    }
    return this._evaluator;
  }

  /** The {@link DisputeSplitIndexer} — always present (pure accumulator). */
  get splitIndexer(): DisputeSplitIndexer {
    return this._splitIndexer;
  }

  /** True when the Tier-1 bond client is configured. PARITY: Py `has_bond`. */
  hasBond(): boolean {
    return this._bond !== undefined;
  }
  /** True when the mediator read client is configured. PARITY: Py `has_mediator`. */
  hasMediator(): boolean {
    return this._mediator !== undefined;
  }
  /** True when the UMA helper is configured. PARITY: Py `has_uma`. */
  hasUMA(): boolean {
    return this._uma !== undefined;
  }
  /** True when the off-chain evaluator client is configured. PARITY: Py `has_evaluator`. */
  hasEvaluator(): boolean {
    return this._evaluator !== undefined;
  }

  // ===================================================================
  // The one net-new facade method: §9 sub-state
  // ===================================================================

  /**
   * Read a dispute's on-chain state and decode its AIP-14b §9 sub-state.
   *
   * Reads the public `disputes(bytes32)` getter via the configured
   * {@link BondEscalationClient}, then derives the {@link DisputeSubState} with
   * the pure {@link decodeDisputeSubState} (anchored to the cross-SDK golden
   * fixture). The returned {@link DisputeStatus} also carries the base
   * {@link DisputeState} and the raw `disputedAt`. PARITY: Py `get_dispute_status`.
   *
   * @param disputeId - keccak256 dispute identifier (bytes32).
   * @throws if the bond client is not configured (dispute stack not deployed).
   */
  async getDisputeStatus(disputeId: string): Promise<DisputeStatus> {
    const bond = this.bond; // throws with the clear message if unconfigured
    const raw = await bond.getContract().disputes(disputeId);
    const state = BondEscalationClient.decodeDisputeState(disputeId, raw);
    const substate = decodeDisputeSubState(raw);
    const r = raw as Record<string | number, unknown>;
    const disputedAt = Number(r['disputedAt'] !== undefined ? r['disputedAt'] : r[6]);
    return {
      disputeId,
      substate,
      tier: state.tier,
      resolved: state.resolved,
      ruling: state.ruling ?? Ruling.PROVIDER_WINS,
      splitBps: state.splitBps ?? 0,
      disputedAt,
      state,
    };
  }

  /**
   * Convenience: feed already-decoded {@link DisputeOutcome} records to the
   * split indexer (so callers can surface a split rate straight off the facade).
   * Pure delegation to {@link DisputeSplitIndexer.addOutcomes}. PARITY: Py
   * `record_outcomes`.
   */
  recordOutcomes(outcomes: DisputeOutcome[]): void {
    this._splitIndexer.addOutcomes(outcomes);
  }
}
