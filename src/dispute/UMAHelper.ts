import { Contract, Interface, Signer } from 'ethers';
import BondEscalationABI from '../abi/BondEscalation.json';
import IOptimisticOracleV3ABI from '../abi/IOptimisticOracleV3.json';
import ERC20ABI from '../abi/ERC20.json';

// PARITY: python-sdk-v2/src/agirails/dispute/uma_helper.py
// This file and its Python twin MUST stay 1:1 — every public method/constant
// here has a Py twin with the SAME name (snake_case) and arity, and vice-versa.
// `quoteSelfDisputeCost` and the `requesterForceDVM` call sequence are anchored
// to the shared cross-SDK fixture
// `DISPUTE SYSTEM/test-vectors/uma-self-dispute-vectors.json`, which both the
// jest and pytest suites consume byte-identically. Any change here (rename, new
// method, amount tweak, or reordering the call sequence) must be mirrored in the
// twin.

/**
 * UMAHelper — the requester-side "self-dispute to DVM" helper (AIP-14b §8.6).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * §8.6 ASYMMETRY WARNING (normative). Tier-2 escalation is provider-directional
 * by construction: the ONLY assertion shape `escalateToUMA()` can post is
 * "Provider delivered" (= ruling 0). `escalateToUMA()` is therefore economically
 * rational only for the PROVIDER side. A requester whose ruling-1 proposal
 * stands unchallenged at the $500 ceiling simply holds position and WINS for
 * free via `finalize()` once liveness expires — they should normally do nothing.
 * This helper exists ONLY for the residual case: a requester who wants DVM
 * FINALITY now rather than continued ceiling ping-pong (every ceiling challenge
 * resets liveness). It is deliberately EXPENSIVE and asymmetric — it does NOT
 * make the requester side cheaper, it bounds the worst-case dispute DURATION.
 * Do not reach for it as a default; reach for `finalize()`.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The self-dispute path (§8.6): the requester posts BOTH sides of a UMA
 * assertion to force the Data Verification Mechanism to vote:
 *
 *   1. `escalateToUMA(disputeId, evidenceCID)` — posts the $500 ASSERTER bond
 *      ("Provider delivered"). The requester is the asserter here.
 *   2. read `assertionId` from `BondEscalation.disputeToAssertion(disputeId)`.
 *   3. `OOV3.disputeAssertion(assertionId, disputer)` — posts a SECOND $500
 *      DISPUTER bond against their own assertion, forcing DVM review.
 *
 * If the DVM rules FALSE ("provider did NOT deliver" → ruling 1), the requester
 * as DISPUTER recovers $750 of the $1,000 posted (§8.2 CASE C / §8.3) and
 * ruling 1 executes locally via the callback. Net cost: $250 (the UMA Store fee
 * = 50% of the losing asserter bond). See {@link quoteSelfDisputeCost}.
 *
 * ⚠ SETTLEMENT WARNING (normative, §8.6 + Appendix B.4): UMA settlement is
 * EXTERNAL. After the DVM resolves you (or anyone) MUST call
 * `OOV3.settleAssertion(assertionId)` yourself to trigger bond distribution and
 * the `assertionResolvedCallback`. If NO ONE calls it, the dispute does not
 * resolve through UMA at all — and once 30 days elapse from `disputedAt`,
 * `BondEscalation.forceResolveStale()` force-resolves it to a 30-DAY FORCED
 * 50/50 SPLIT, which throws away the favorable DVM outcome you paid $250 for.
 * Call `settleAssertion` yourself or risk a 30-day forced 50/50 split.
 *
 * This helper does NOT itself call `settleAssertion` (it cannot know when the
 * DVM has resolved); it exposes {@link settleAssertion} so the caller can settle
 * once the DVM result is available, and {@link getAssertionId} to look the
 * assertion up.
 *
 * Reference: AIP-14b §8.2 (UMA lifecycle), §8.3 (bond accounting), §8.4
 * (escalateToUMA), §8.6 (escalation directionality / self-dispute path).
 */

// =====================================================================
// Constants (AIP-14b §7.4 / §8) — load-bearing, mirror BondEscalation.sol
// =====================================================================

/** UMA Tier-2 stake: $500 USDC (6 decimals). One bond per side. AIP-14b §7.4. */
export const UMA_BOND = 500_000_000n;

/**
 * Total USDC a requester must post to force the DVM (§8.6): the $500 asserter
 * bond (via `escalateToUMA`) PLUS the $500 disputer bond (via
 * `disputeAssertion`). = $1,000.
 */
export const SELF_DISPUTE_TOTAL = UMA_BOND * 2n;

/**
 * Amount the requester recovers if the DVM rules FALSE (§8.2 CASE C / §8.3):
 * $500 (own disputer bond returned) + $250 (half the losing asserter bond) =
 * $750.
 */
export const SELF_DISPUTE_RECOVER = UMA_BOND + UMA_BOND / 2n;

/**
 * Net cost of a successful self-dispute (§8.6): the UMA Store fee, = 50% of the
 * losing asserter bond = $250. `SELF_DISPUTE_TOTAL - SELF_DISPUTE_RECOVER`.
 */
export const SELF_DISPUTE_LOSS = SELF_DISPUTE_TOTAL - SELF_DISPUTE_RECOVER;

// =====================================================================
// Injected-contract surfaces (for testing without a live chain)
// =====================================================================

/** Minimal ethers transaction-response surface used by the write methods. */
interface ContractTxResponse {
  hash: string;
  wait(confirmations?: number): Promise<{ hash: string } | null>;
}

/**
 * Structural surface for a contract the helper writes to / reads from. Real
 * usage passes ethers {@link Contract} instances; tests inject mocks that record
 * the calldata each method builds (writes always route through
 * `interface.encodeFunctionData`, so the recorded `data` is the assertion
 * surface — exactly what the Py twin's tests assert too).
 */
export interface IDisputeContract {
  readonly interface: Interface;
  getFunction(name: string): {
    (...args: unknown[]): Promise<ContractTxResponse>;
    estimateGas(...args: unknown[]): Promise<bigint>;
  };
  disputeToAssertion(disputeId: string): Promise<string>;
}

/** Minimal ERC20 surface for the two `approve` calls. */
export interface IERC20Contract {
  readonly interface: Interface;
  getFunction(name: string): {
    (...args: unknown[]): Promise<ContractTxResponse>;
    estimateGas(...args: unknown[]): Promise<bigint>;
  };
}

/** Minimal UMA OOV3 surface for `disputeAssertion` / `settleAssertion`. */
export interface IOptimisticOracleV3Contract {
  readonly interface: Interface;
  getFunction(name: string): {
    (...args: unknown[]): Promise<ContractTxResponse>;
    estimateGas(...args: unknown[]): Promise<bigint>;
  };
  /**
   * OOV3 `getMinimumBond(currency)` read — the minimum bond the oracle requires
   * for `currency`. A direct read (like {@link IDisputeContract.disputeToAssertion}),
   * NOT a state-changing write.
   */
  getMinimumBond(currency: string): Promise<bigint>;
}

/** Result of a self-dispute cost quote (USDC base units, 6 decimals). */
export interface SelfDisputeCost {
  /** Total posted: $500 asserter bond + $500 disputer bond = $1,000. */
  total: bigint;
  /** Recovered if DVM rules FALSE: $500 own bond + $250 = $750. */
  recover: bigint;
  /** Net cost (UMA Store fee = 50% of losing asserter bond): $250. */
  lose: bigint;
}

/** Configuration for {@link UMAHelper}. */
export interface UMAHelperConfig {
  /** Deployed BondEscalation contract address. */
  bondEscalationAddress: string;
  /** UMA OptimisticOracleV3 address. */
  oov3Address: string;
  /** USDC (bond currency) address. */
  usdcAddress: string;
  /** Signer that pays gas + posts both $500 bonds (the requester). */
  signer: Signer;
  /** Injected BondEscalation contract (optional, for testing). */
  bondEscalation?: IDisputeContract;
  /** Injected OOV3 contract (optional, for testing). */
  oov3?: IOptimisticOracleV3Contract;
  /** Injected USDC contract (optional, for testing). */
  usdc?: IERC20Contract;
  /** Block confirmations to await after each write (default 2 — Base L2). */
  confirmations?: number;
}

// =====================================================================
// Helper
// =====================================================================

/**
 * Typed helper for the requester-side self-dispute-to-DVM path (AIP-14b §8.6).
 */
export class UMAHelper {
  private readonly bondEscalation: IDisputeContract;
  private readonly oov3: IOptimisticOracleV3Contract;
  private readonly usdc: IERC20Contract;
  private readonly bondEscalationAddress: string;
  private readonly oov3Address: string;
  private readonly usdcAddress: string;
  private readonly confirmations: number;

  constructor(config: UMAHelperConfig) {
    const {
      bondEscalationAddress,
      oov3Address,
      usdcAddress,
      signer,
      bondEscalation,
      oov3,
      usdc,
      confirmations = 2,
    } = config;
    if (confirmations < 1) {
      throw new Error(`confirmations must be >= 1, got ${confirmations}`);
    }
    this.bondEscalationAddress = bondEscalationAddress;
    this.oov3Address = oov3Address;
    this.usdcAddress = usdcAddress;
    this.confirmations = confirmations;
    this.bondEscalation =
      bondEscalation ??
      (new Contract(
        bondEscalationAddress,
        BondEscalationABI,
        signer
      ) as unknown as IDisputeContract);
    this.oov3 =
      oov3 ??
      (new Contract(
        oov3Address,
        IOptimisticOracleV3ABI,
        signer
      ) as unknown as IOptimisticOracleV3Contract);
    this.usdc =
      usdc ?? (new Contract(usdcAddress, ERC20ABI, signer) as unknown as IERC20Contract);
  }

  /** BondEscalation contract address. */
  getBondEscalationAddress(): string {
    return this.bondEscalationAddress;
  }

  /** UMA OOV3 contract address. */
  getOOV3Address(): string {
    return this.oov3Address;
  }

  // ===================================================================
  // Pure quote (AIP-14b §8.6 / §8.2 CASE C / §8.3) — no chain access
  // ===================================================================

  /**
   * Quote the cost of the requester self-dispute path (§8.6).
   *
   * The requester posts $500 (asserter bond via `escalateToUMA`) + $500
   * (disputer bond via `disputeAssertion`) = **$1,000 total**. If the DVM rules
   * FALSE (provider did NOT deliver), they recover **$750** ($500 own disputer
   * bond + $250 = half the losing asserter bond, §8.2 CASE C / §8.3) and **lose
   * $250** (the UMA Store fee = 50% of the losing asserter bond).
   *
   * @returns `{ total: $1000, recover: $750, lose: $250 }` in USDC base units.
   */
  static quoteSelfDisputeCost(): SelfDisputeCost {
    return {
      total: SELF_DISPUTE_TOTAL, // $1,000
      recover: SELF_DISPUTE_RECOVER, // $750
      lose: SELF_DISPUTE_LOSS, // $250
    };
  }

  // ===================================================================
  // Reads
  // ===================================================================

  /**
   * Look up the UMA assertionId for a dispute via
   * `BondEscalation.disputeToAssertion(disputeId)`. Returns `bytes32(0)` if the
   * dispute has not been escalated to UMA yet.
   */
  async getAssertionId(disputeId: string): Promise<string> {
    return this.bondEscalation.disputeToAssertion(disputeId);
  }

  /**
   * Read the UMA oracle's minimum bond for USDC (`OOV3.getMinimumBond(usdc)`).
   * A direct read — never recorded as a write.
   */
  async getMinimumBond(): Promise<bigint> {
    return BigInt(await this.oov3.getMinimumBond(this.usdcAddress));
  }

  /**
   * The effective per-side bond the SDK must post to escalate to UMA:
   * `max($500, getMinimumBond(USDC))` (AIP-14b §7.4). BondEscalation.sol posts
   * this exact dynamic value; the SDK matches it so a raised UMA minimum never
   * under-approves and reverts `escalateToUMA`.
   */
  async getEffectiveBond(): Promise<bigint> {
    const min = await this.getMinimumBond();
    return min > UMA_BOND ? min : UMA_BOND;
  }

  // ===================================================================
  // The §8.6 self-dispute flow
  // ===================================================================

  /**
   * Force the dispute to the UMA DVM by self-disputing (AIP-14b §8.6).
   *
   * Issues EXACTLY this call sequence, in order (a call-sequence test pins it):
   *
   *   1. `USDC.approve(bondEscalation, $500)` — so `escalateToUMA` can pull the
   *      asserter bond.
   *   2. `BondEscalation.escalateToUMA(disputeId, evidenceCID, reasoningCID)` —
   *      posts the $500 asserter bond ("Provider delivered").
   *   3. read `assertionId` ← `BondEscalation.disputeToAssertion(disputeId)`.
   *   4. `USDC.approve(oov3, $500)` — so `disputeAssertion` can pull the disputer
   *      bond directly to OOV3.
   *   5. `OOV3.disputeAssertion(assertionId, disputer)` — posts the SECOND $500
   *      bond against the requester's own assertion, forcing DVM review.
   *
   * ⚠ This does NOT settle the assertion. After the DVM resolves you MUST call
   * {@link settleAssertion} yourself or risk a 30-day forced 50/50 split (see the
   * class JSDoc). See {@link quoteSelfDisputeCost} for the $1000/$750/$250
   * economics, and the §8.6 asymmetry warning for why this is provider-directional
   * and expensive.
   *
   * @param disputeId   - bytes32 dispute id (already at the Tier-1 $500 ceiling,
   *                       liveness active — `escalateToUMA`'s preconditions).
   * @param evidenceCID - IPFS CID of the canonical evidence bundle (§8.4).
   * @param reasoningCID - IPFS CID of the evaluator reasoning (BLOCKER-2: both
   *                       CIDs are forwarded into the UMA/DVM claim).
   * @param disputer    - Address that disputes the assertion (the requester
   *                       themself; receives the $750 if the DVM rules FALSE).
   * @returns `{ assertionId, escalateTxHash, disputeTxHash }`.
   */
  async requesterForceDVM(
    disputeId: string,
    evidenceCID: string,
    reasoningCID: string,
    disputer: string
  ): Promise<{ assertionId: string; escalateTxHash: string; disputeTxHash: string }> {
    // 0. read the effective per-side bond = max($500, getMinimumBond(USDC)),
    //    matching BondEscalation.sol's dynamic bond (a pure read, not recorded
    //    as a write). Under the default regime this is $500 (UMA_BOND).
    const bond = await this.getEffectiveBond();

    // 1. approve BondEscalation for the asserter bond.
    await this.sendUsdc('approve', [this.bondEscalationAddress, bond]);

    // 2. escalateToUMA posts the asserter bond ("Provider delivered").
    //    BLOCKER-2: forward BOTH evidence + reasoning CIDs into the DVM claim.
    const escalate = await this.sendBond('escalateToUMA', [
      disputeId,
      evidenceCID,
      reasoningCID,
    ]);

    // 3. read the assertionId the escalation registered.
    const assertionId = await this.bondEscalation.disputeToAssertion(disputeId);

    // 4. approve OOV3 for the disputer bond (same effective amount).
    await this.sendUsdc('approve', [this.oov3Address, bond]);

    // 5. dispute the requester's own assertion, forcing DVM review.
    const dispute = await this.sendOov3('disputeAssertion', [assertionId, disputer]);

    return {
      assertionId,
      escalateTxHash: escalate.hash,
      disputeTxHash: dispute.hash,
    };
  }

  /**
   * Settle a resolved UMA assertion, triggering bond distribution and the
   * `assertionResolvedCallback` (AIP-14b §8.2 STAGE 3, Appendix B.4).
   *
   * Callable by anyone once the DVM has resolved (or liveness expired). You
   * SHOULD call this yourself after winning the DVM — if no one settles and 30
   * days elapse, `forceResolveStale()` overrides the DVM outcome with a forced
   * 50/50 split (see the class JSDoc settlement warning).
   *
   * @param assertionId - bytes32 UMA assertion id (from {@link getAssertionId}
   *                       or {@link requesterForceDVM}).
   */
  async settleAssertion(assertionId: string): Promise<{ ethTxHash: string }> {
    const receipt = await this.sendOov3('settleAssertion', [assertionId]);
    return { ethTxHash: receipt.hash };
  }

  // ===================================================================
  // Internals — one sender per contract (each validates calldata first)
  // ===================================================================

  private async sendUsdc(method: string, args: unknown[]): Promise<{ hash: string }> {
    return this.send(this.usdc, method, args);
  }

  private async sendBond(method: string, args: unknown[]): Promise<{ hash: string }> {
    return this.send(this.bondEscalation, method, args);
  }

  private async sendOov3(method: string, args: unknown[]): Promise<{ hash: string }> {
    return this.send(this.oov3, method, args);
  }

  /**
   * Build calldata via `interface.encodeFunctionData` (so tests can assert the
   * exact selector + args), send, and wait for confirmations. Returns the mined
   * receipt (or the response when a mock returns no receipt).
   */
  private async send(
    contract: IDisputeContract | IERC20Contract | IOptimisticOracleV3Contract,
    method: string,
    args: unknown[]
  ): Promise<{ hash: string }> {
    // Build (and validate) calldata — this is the assertion surface in tests.
    const data = contract.interface.encodeFunctionData(method, args as any);
    void data;

    const fn = contract.getFunction(method);
    const tx = await fn(...args);
    const receipt = await tx.wait(this.confirmations);
    return { hash: receipt?.hash ?? tx.hash };
  }
}
