import { Contract, Interface, Signer, ethers } from 'ethers';
import BondEscalationABI from '../abi/BondEscalation.json';
import {
  AIRuling,
  DisputeState,
  Ruling,
  Tier,
  computeEvidenceRefHash,
  computeReasoningRefHash,
} from '../types/dispute';

// PARITY: python-sdk-v2/src/agirails/dispute/bond_escalation.py
// This file and its Python twin MUST stay 1:1 — every public method here has a
// Py twin with the SAME name (snake_case) and arity, and vice-versa. The two
// quote helpers + getDisputeState decode are anchored to the shared cross-SDK
// fixture `DISPUTE SYSTEM/test-vectors/bond-escalation-vectors.json`, which both
// the jest and pytest suites consume byte-identically. Any change here (rename,
// new method, formula tweak) must be mirrored in the twin.

/**
 * BondEscalationClient — typed wrapper for the AIP-14 three-tier dispute
 * engine (`BondEscalation.sol`).
 *
 * Wraps every method of the normative `IBondEscalation` core interface
 * (AIP-14 §7.1) plus the two bond-quote helpers and the on-chain
 * `disputes(...)` reader. This is the dispute counterpart to
 * {@link ACTPKernel} — it does NOT touch the kernel's legacy
 * `raiseDispute`/`resolveDispute` (those settle through the kernel's own
 * SETTLED proof path; the tiered flow here is the AIP-14 successor and the
 * kernel JSDoc steers callers to it).
 *
 * Lifecycle (AIP-14 §3, §7.1):
 * ```
 *   openDispute(txId) ──> disputeId
 *        │
 *        ▼ (confident)              (not confident)
 *   submitAIRuling(ruling,sigs) ── proposeDirectly(ruling,split)  ── Tier 1
 *        │                              │
 *        ▼ challenge(...) (bond doubles, ceiling $500)
 *        │
 *        ├──> finalize()         (liveness expired)         ──> RESOLVED
 *        └──> escalateToUMA(cid) (at ceiling + active)      ──> Tier 2 (UMA)
 *                                                                  │
 *   syncExternalResolution() / forceResolveStale() ─────────> RESOLVED
 *   claimEscalationRefund()   (split refunds, post-resolve)
 * ```
 *
 * Reference: AIP-14 §7 (BondEscalation), §7.1 (IBondEscalation),
 * §7.4 (constants), §7.13 (bond formulas).
 */

// =====================================================================
// Constants (AIP-14 §7.4) — load-bearing, mirror BondEscalation.sol
// =====================================================================

/** Initial bond rate: 2% of escrow (basis points). AIP-14 §7.4. */
export const ESCALATION_INITIAL_BPS = 200n;
/** Floor for the initial bond: $1 USDC (6 decimals). AIP-14 §7.4. */
export const MIN_ESCALATION_BOND = 1_000_000n;
/** Ceiling for any escalation bond: $500 USDC (6 decimals). AIP-14 §7.4. */
export const MAX_ESCALATION_BOND = 500_000_000n;
/** Each challenge doubles the bond. AIP-14 §7.4. */
export const ESCALATION_MULTIPLIER = 2n;
/** Basis-point denominator. */
export const BPS_DENOMINATOR = 10_000n;

// =====================================================================
// Injected-contract surface (for testing without a live chain)
// =====================================================================

/**
 * Minimal ethers transaction-response surface used by the write methods.
 */
interface ContractTxResponse {
  hash: string;
  wait(confirmations?: number): Promise<{ hash: string } | null>;
}

/**
 * Structural interface for the BondEscalation contract. Real usage passes an
 * ethers {@link Contract}; tests inject a mock that records the calldata each
 * method builds (the client always routes writes through
 * `interface.encodeFunctionData`, so a recorded `data` field is the assertion
 * surface — exactly what the Py twin's tests assert too).
 */
export interface IBondEscalationContract {
  readonly interface: Interface;
  getFunction(name: string): {
    (...args: unknown[]): Promise<ContractTxResponse>;
    estimateGas(...args: unknown[]): Promise<bigint>;
  };
  disputes(disputeId: string): Promise<unknown>;
}

/**
 * Configuration for {@link BondEscalationClient}.
 */
export interface BondEscalationClientConfig {
  /** Deployed BondEscalation contract address. */
  address: string;
  /** Signer that pays gas for the write methods. */
  signer: Signer;
  /**
   * Injected contract instance (optional, for testing). When provided, the
   * client uses it verbatim instead of constructing a real ethers Contract.
   */
  contract?: IBondEscalationContract;
  /**
   * Block confirmations to await after each write (default 2 — Base L2 reorg
   * safety, mirrors {@link ACTPKernel}).
   */
  confirmations?: number;
}

// =====================================================================
// Client
// =====================================================================

/**
 * Typed client for the AIP-14 BondEscalation dispute engine.
 */
export class BondEscalationClient {
  private readonly contract: IBondEscalationContract;
  private readonly address: string;
  private readonly confirmations: number;

  constructor(config: BondEscalationClientConfig) {
    const { address, signer, contract, confirmations = 2 } = config;
    if (confirmations < 1) {
      throw new Error(`confirmations must be >= 1, got ${confirmations}`);
    }
    this.address = address;
    this.confirmations = confirmations;
    this.contract =
      contract ??
      (new Contract(address, BondEscalationABI, signer) as unknown as IBondEscalationContract);
  }

  /** Deployed BondEscalation contract address. */
  getAddress(): string {
    return this.address;
  }

  /** Underlying contract instance (parity with `ACTPKernel.getContract()`). */
  getContract(): IBondEscalationContract {
    return this.contract;
  }

  // ===================================================================
  // Pure quote helpers (AIP-14 §7.13) — no chain access
  // ===================================================================

  /**
   * Quote the initial Tier-1 bond for a dispute, given the disputed escrow
   * amount. `min(max(escrowAmount * 2% , $1), $500)` — mirrors
   * `BondEscalation._calculateInitialBond`, including the MAX_ESCALATION_BOND
   * ($500) ceiling the contract clamps to (F-5). AIP-14 §7.13.
   *
   * @param escrowAmount - Disputed escrow remaining (USDC, 6 decimals).
   * @returns Initial bond in USDC base units (6 decimals), capped at $500.
   */
  static quoteInitialBond(escrowAmount: bigint): bigint {
    const percentBond = (escrowAmount * ESCALATION_INITIAL_BPS) / BPS_DENOMINATOR;
    const bond = percentBond > MIN_ESCALATION_BOND ? percentBond : MIN_ESCALATION_BOND;
    return bond > MAX_ESCALATION_BOND ? MAX_ESCALATION_BOND : bond;
  }

  /**
   * Quote the next escalation (challenge) bond, given the current bond.
   * `min(currentBond * 2, $500)` — mirrors the challenge bond rule.
   * AIP-14 §7.8 / §7.4.
   *
   * @param currentBond - The dispute's current bond (USDC, 6 decimals).
   * @returns Next bond in USDC base units, capped at the $500 ceiling.
   */
  static quoteEscalationBond(currentBond: bigint): bigint {
    const next = currentBond * ESCALATION_MULTIPLIER;
    return next > MAX_ESCALATION_BOND ? MAX_ESCALATION_BOND : next;
  }

  // ===================================================================
  // Read helper (decodes the public disputes() tuple)
  // ===================================================================

  /**
   * Read and decode a dispute's on-chain state from the public
   * `disputes(bytes32)` getter into the shared {@link DisputeState} type.
   *
   * The raw getter returns the 13-field `DisputeState` storage struct
   * (AIP-14 §7.3). `tier` is decoded 0-based onto {@link Tier} (0=opened,
   * 1=proposed/challenged, 2=UMA). `ruling`/`splitBps` are surfaced only when
   * meaningful (a still-`tier 0` dispute carries the default 0 ruling, so the
   * caller checks `tier`/`resolved` for context).
   *
   * @param disputeId - keccak256 dispute identifier (bytes32).
   * @returns Decoded {@link DisputeState}.
   */
  async getDisputeState(disputeId: string): Promise<DisputeState> {
    const raw = await this.contract.disputes(disputeId);
    return BondEscalationClient.decodeDisputeState(disputeId, raw);
  }

  /**
   * Decode a raw `disputes()` tuple (array OR named ethers Result) into a
   * {@link DisputeState}. Pure + static so the cross-SDK fixture test can
   * exercise it without a contract. Field order is load-bearing (AIP-14 §7.3):
   * `[transactionId, currentRuling, splitBps, currentBond, accumulatedBonds,
   *   livenessEnd, disputedAt, lastProposer, tier, resolved, winnerPaid,
   *   originalPool, escrowAmount]`.
   */
  static decodeDisputeState(disputeId: string, raw: unknown): DisputeState {
    const r = raw as Record<string | number, unknown>;
    const pick = (idx: number, name: string): unknown =>
      r[name] !== undefined ? r[name] : r[idx];

    const txId = pick(0, 'transactionId') as string;
    const currentRuling = Number(pick(1, 'currentRuling'));
    const splitBps = Number(pick(2, 'splitBps'));
    const tier = Number(pick(8, 'tier'));
    const resolved = Boolean(pick(9, 'resolved'));

    return {
      txId,
      disputeId,
      tier: tier as Tier,
      ruling: currentRuling as Ruling,
      splitBps,
      resolved,
    };
  }

  // ===================================================================
  // IBondEscalation write methods (AIP-14 §7.1) — identical sigs to Py twin
  // ===================================================================

  /**
   * Open a dispute for a kernel transaction already in the DISPUTED state.
   * AIP-14 §7.5.
   *
   * @param txId - kernel transaction id (bytes32).
   * @returns `{ disputeId, ethTxHash }` — disputeId is
   *   `keccak256(abi.encode("ACTP_DISPUTE_V1", txId))` (deterministic), also
   *   surfaced via the `DisputeOpened` event.
   */
  async openDispute(txId: string): Promise<{ disputeId: string; ethTxHash: string }> {
    const receipt = await this.send('openDispute', [txId]);
    // disputeId is deterministic — recompute it rather than parse logs so the
    // value is available even when the injected mock returns no logs.
    const disputeId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], ['ACTP_DISPUTE_V1', txId])
    );
    return { disputeId, ethTxHash: receipt.hash };
  }

  /**
   * Submit an evaluator-signed AIRuling as the Tier-1 proposal. AIP-14c §7.7 /
   * D7 CID-binding.
   *
   * The v2 BondEscalation entrypoint is the 5-arg
   * `submitAIRuling(disputeId, ruling, evidenceCID, reasoningCID, signatures)`
   * (selector `0xca74ab82`); the old 3-arg form is REMOVED. The contract
   * recomputes `evidenceRefHash`/`reasoningRefHash` from the submitted CIDs and
   * requires equality with the signed refs BEFORE any bond transfer. The SDK
   * therefore derives the two ref-hashes from the SAME CIDs it passes, so the
   * on-chain recompute matches the evaluator-signed 9-field ruling.
   *
   * @param ruling - The {@link AIRuling} (its `disputeId` field MUST match).
   * @param evidenceCID - IPFS CID of the canonical evidence bundle (signed).
   * @param reasoningCID - IPFS CID of the evaluator reasoning (signed).
   * @param signatures - Evaluator EIP-712 signatures (`bytes[]`).
   */
  async submitAIRuling(
    ruling: AIRuling,
    evidenceCID: string,
    reasoningCID: string,
    signatures: string[]
  ): Promise<{ ethTxHash: string }> {
    // P2 HARDENING: the ref-hashes are part of the evaluator-SIGNED 9-field
    // ruling. Recompute them from the CIDs and VERIFY they equal the signed
    // refs — do NOT silently overwrite the ruling (that would ship the CIDs'
    // refs under signatures that never covered them, and the on-chain quorum
    // check would then reject the tx). Throw fail-closed on any mismatch.
    const evidenceRefHash = computeEvidenceRefHash(ruling.bundleHash, evidenceCID);
    const reasoningRefHash = computeReasoningRefHash(ruling.reasoningHash, reasoningCID);
    const eq = (a?: string, b?: string) =>
      typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
    if (!eq(ruling.evidenceRefHash, evidenceRefHash)) {
      throw new Error(
        `submitAIRuling: evidenceCID does not match the signed ruling — ` +
          `computed evidenceRefHash ${evidenceRefHash} != signed ${ruling.evidenceRefHash ?? '(unset)'}. ` +
          `Refusing to submit (signatures would be invalid on-chain).`
      );
    }
    if (!eq(ruling.reasoningRefHash, reasoningRefHash)) {
      throw new Error(
        `submitAIRuling: reasoningCID does not match the signed ruling — ` +
          `computed reasoningRefHash ${reasoningRefHash} != signed ${ruling.reasoningRefHash ?? '(unset)'}. ` +
          `Refusing to submit (signatures would be invalid on-chain).`
      );
    }
    // Submit the ORIGINAL signed ruling unchanged (its refs are now verified).
    const tuple = BondEscalationClient.aiRulingToTuple(ruling);
    const receipt = await this.send('submitAIRuling', [
      ruling.disputeId,
      tuple,
      evidenceCID,
      reasoningCID,
      signatures,
    ]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Submit a direct (unsigned) Tier-1 proposal. AIP-14 §7.6.
   *
   * @param disputeId - bytes32 dispute id.
   * @param ruling - 0=provider, 1=requester, 2=split.
   * @param splitBps - provider share (basis points) when `ruling == 2`, else 0.
   */
  async proposeDirectly(
    disputeId: string,
    ruling: Ruling | number,
    splitBps: number
  ): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('proposeDirectly', [disputeId, Number(ruling), splitBps]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Counter an existing proposal with a different outcome + doubled bond.
   * AIP-14 §7.8.
   *
   * @param disputeId - bytes32 dispute id.
   * @param counterRuling - the counter outcome (0/1/2).
   * @param counterSplitBps - provider share (basis points) when split, else 0.
   */
  async challenge(
    disputeId: string,
    counterRuling: Ruling | number,
    counterSplitBps: number
  ): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('challenge', [
      disputeId,
      Number(counterRuling),
      counterSplitBps,
    ]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Finalize a Tier-1 dispute after liveness expiry, distributing the bond
   * pool and routing the ruling to the CompositeMediator. AIP-14 §7.9.
   */
  async finalize(disputeId: string): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('finalize', [disputeId]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Escalate a ceiling-bond, liveness-active dispute to UMA OOV3 (Tier 2),
   * embedding the IPFS evidence-bundle CID in the assertion. AIP-14 §7.1, §8.4.
   *
   * BLOCKER-2 (reasoning reaches the DVM): the v2 entrypoint is the 2-CID
   * `escalateToUMA(disputeId, evidenceCID, reasoningCID)` (selector
   * `0xea487f8a`); the 1-CID form (`0xa3c23734`) is REMOVED. Both CIDs are
   * embedded in the UMA/DVM claim + the `EscalatedToUMA` event.
   *
   * @param disputeId - bytes32 dispute id.
   * @param evidenceCID - IPFS CID of the canonical evidence bundle.
   * @param reasoningCID - IPFS CID of the evaluator reasoning.
   */
  async escalateToUMA(
    disputeId: string,
    evidenceCID: string,
    reasoningCID: string
  ): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('escalateToUMA', [disputeId, evidenceCID, reasoningCID]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Settle a Tier-2 UMA assertion back into BondEscalation once the DVM has
   * resolved: reads the OOV3 result and routes the resolved outcome to the
   * CompositeMediator. AIP-14 §8.2 STAGE 3. Callable by anyone post-resolution.
   *
   * @param disputeId - bytes32 dispute id (must have been escalated to UMA).
   */
  async settleUMAAssertion(disputeId: string): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('settleUMAAssertion', [disputeId]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Retry a mediator resolution that was left pending (e.g. the
   * CompositeMediator call reverted / ran out of gas during settlement). Drives
   * `mediatorRetryPending[disputeId]` to completion. AIP-14 §8.2. Not pausable.
   *
   * @param disputeId - bytes32 dispute id with a pending mediator retry.
   */
  async retryMediatorResolution(disputeId: string): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('retryMediatorResolution', [disputeId]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Claim a proportional split refund after a split (ruling-2) resolution.
   * AIP-14 §7.10. Not pausable.
   */
  async claimEscalationRefund(disputeId: string): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('claimEscalationRefund', [disputeId]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Sync a dispute already resolved in the kernel (admin/external path) into
   * the BondEscalation state. AIP-14 §7.11. Not pausable.
   */
  async syncExternalResolution(disputeId: string): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('syncExternalResolution', [disputeId]);
    return { ethTxHash: receipt.hash };
  }

  /**
   * Force-resolve a dispute that has exceeded MAX_DISPUTE_DURATION (30 days)
   * to a 50/50 split. AIP-14 §7.12. Not pausable.
   */
  async forceResolveStale(disputeId: string): Promise<{ ethTxHash: string }> {
    const receipt = await this.send('forceResolveStale', [disputeId]);
    return { ethTxHash: receipt.hash };
  }

  // ===================================================================
  // Internals
  // ===================================================================

  /**
   * Encode `AIRuling` into the positional tuple the contract ABI expects
   * (struct field order is load-bearing — mirrors DisputeTypes.sol).
   */
  private static aiRulingToTuple(
    ruling: AIRuling
  ): [string, number, number, number, number, string, string, string, string] {
    const ZERO_BYTES32 =
      '0x0000000000000000000000000000000000000000000000000000000000000000';
    return [
      ruling.disputeId,
      Number(ruling.ruling),
      ruling.confidence,
      ruling.splitBps,
      ruling.timestamp,
      ruling.reasoningHash,
      ruling.bundleHash,
      ruling.evidenceRefHash ?? ZERO_BYTES32,
      ruling.reasoningRefHash ?? ZERO_BYTES32,
    ];
  }

  /**
   * Build calldata via `interface.encodeFunctionData` (so tests can assert the
   * exact selector + args), estimate gas, send, and wait for confirmations.
   * Returns the mined receipt (or the response when a mock returns no receipt).
   */
  private async send(method: string, args: unknown[]): Promise<{ hash: string }> {
    // Build (and validate) calldata — this is the assertion surface in tests.
    const data = this.contract.interface.encodeFunctionData(method, args as any);
    void data;

    const fn = this.contract.getFunction(method);
    const tx = await fn(...args);
    const receipt = await tx.wait(this.confirmations);
    return { hash: receipt?.hash ?? tx.hash };
  }
}
