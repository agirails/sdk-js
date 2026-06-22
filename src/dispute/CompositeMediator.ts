/**
 * CompositeMediator — read-only / event client for the AIP-14b split-outcome
 * mediator (PRD P2-5).
 *
 * The on-chain CompositeMediator (AIP-14b §6) is a *thin* contract: its ONLY
 * mutating entrypoint is `resolve(txId, ruling, splitBps)`, and that function is
 * `onlyBondEscalation` — it reverts for every caller except the BondEscalation
 * contract. There is therefore **no legitimate SDK action** that calls
 * `resolve()`; an agent or indexer can only *observe* what the mediator did.
 *
 * Accordingly this client exposes exactly two read surfaces:
 *  1. `getSplitRecordedEvents()` — pull `DisputeSplitRecorded` (every ruling-2
 *     resolution the mediator executed: finalize, forceResolveStale, UMA
 *     no-winner fallback — AIP-14b §3.4).
 *  2. `decodeDisputeSplitRecorded(log)` — pure decode of one such event.
 *
 * `resolve()` is **deliberately ABSENT** from the public surface. See
 * {@link CompositeMediator} class JSDoc and the parity test
 * `tests/composite-mediator.test.ts` ("resolve is not a public client method")
 * for the normative assertion + rationale.
 *
 * ## ZERO-REMAINING CONSUMER RULE (AIP-14b §6, normative)
 * When on-chain escrow `remaining == 0`, the kernel resolution-proof amounts are
 * a phantom **1-wei sentinel** (placed only to satisfy the kernel's
 * `require(requesterAmount > 0 || providerAmount > 0)` existence check) and are
 * NOT economic payouts. {@link decodeResolutionProof} enforces this: with
 * `remaining == 0` it surfaces a zero payout for BOTH parties — never a 1-wei
 * payout. The drained-dispute test pins this.
 *
 * PARITY: python-sdk-v2/src/agirails/dispute/composite_mediator.py
 * Every public symbol here has a Py twin (same name/arity) and vice-versa.
 *
 * @module dispute/CompositeMediator
 */

import { AbiCoder, Contract, EventLog, Interface, Log, Provider } from 'ethers';
import CompositeMediatorABI from '../abi/CompositeMediator.json';

// PARITY: python-sdk-v2/src/agirails/dispute/composite_mediator.py
// Keep the decode shape, split-rate semantics, and the "resolve is not public"
// rule 1:1 across both SDKs.

// =====================================================================
// Decoded event shapes
// =====================================================================

/**
 * A decoded `DisputeSplitRecorded(bytes32 indexed txId, address indexed
 * requester, address indexed provider, uint16 splitBps)` event — the neutral
 * reputation trace CompositeMediator emits on every ruling-2 resolution
 * (AIP-14b §3.4). Carries NO on-chain penalty.
 */
export interface DisputeSplitRecorded {
  /** The transaction whose dispute resolved to a split (bytes32 txId). */
  txId: string;
  /** Requester address (indexed). */
  requester: string;
  /** Provider address (indexed). */
  provider: string;
  /** Provider share in basis points (0–10000). */
  splitBps: number;
  /** Source block number, when decoded from an on-chain log. */
  blockNumber?: number;
  /** Source log index, when decoded from an on-chain log. */
  logIndex?: number;
  /** Emitting transaction hash, when decoded from an on-chain log. */
  transactionHash?: string;
}

/**
 * Decoded kernel resolution proof, AFTER the zero-remaining consumer rule has
 * been applied. The `payouts` are the ECONOMICALLY REAL amounts — never a
 * phantom 1-wei sentinel.
 *
 * PARITY NOTE (representation differs — values match byte-for-byte under the
 * zero-remaining rule): TS exposes a NESTED `payouts: { requester, provider }`
 * object; the Py twin exposes FLAT `requester_amount` / `provider_amount` ints.
 * Field-access code is NOT portable across SDKs — `.payouts.requester` is
 * TS-only; the Py twin reads `.requester_amount`. This is a locked, documented
 * per-SDK idiom (parity is by type NAME, not field shape); do not assume the
 * nested `payouts` object exists in Python.
 */
export interface DecodedResolutionProof {
  /** True when the kernel path was DISPUTED→CANCELLED (split, AIP-14b §3.3). */
  isSplit: boolean;
  /**
   * Provider-at-fault flag for the SETTLED branch (96-byte proof). `undefined`
   * for the CANCELLED/split branch (64-byte proof, which omits it).
   */
  providerAtFault?: boolean;
  /**
   * The real settlement amounts. When the on-chain escrow `remaining == 0`
   * these are BOTH `0n` (the proof carried only a phantom sentinel).
   */
  payouts: { requester: bigint; provider: bigint };
  /**
   * True when the proof amounts were ignored as a phantom sentinel because
   * `remaining == 0`. Consumers MUST NOT treat the raw proof amount as a payout
   * in this case (AIP-14b §6 CONSUMER RULE).
   */
  phantomSentinel: boolean;
}

// =====================================================================
// Pure decoders (no chain access — usable on a raw log)
// =====================================================================

/** Interface built once from the vendored CompositeMediator ABI. */
const MEDIATOR_INTERFACE = new Interface(CompositeMediatorABI as unknown as any[]);

/**
 * Decode a single `DisputeSplitRecorded` event log.
 *
 * Accepts either an ethers {@link EventLog} (already parsed `.args`) or a raw
 * {@link Log} (topics + data), so it works on both subscription callbacks and
 * `queryFilter`/`getLogs` output. PARITY: Py `decode_dispute_split_recorded`.
 *
 * @throws if the log is not a `DisputeSplitRecorded` event.
 */
export function decodeDisputeSplitRecorded(log: EventLog | Log): DisputeSplitRecorded {
  // Fast path: ethers already parsed the args on an EventLog.
  let args = (log as EventLog).args;
  if (!args) {
    const parsed = MEDIATOR_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed || parsed.name !== 'DisputeSplitRecorded') {
      throw new Error(
        `decodeDisputeSplitRecorded: log is not a DisputeSplitRecorded event (got ${parsed?.name ?? 'unparseable'})`
      );
    }
    args = parsed.args;
  } else if ((log as EventLog).eventName && (log as EventLog).eventName !== 'DisputeSplitRecorded') {
    throw new Error(
      `decodeDisputeSplitRecorded: log is not a DisputeSplitRecorded event (got ${(log as EventLog).eventName})`
    );
  }

  return {
    txId: args.txId,
    requester: args.requester,
    provider: args.provider,
    splitBps: Number(args.splitBps),
    blockNumber: 'blockNumber' in log ? (log as Log).blockNumber : undefined,
    logIndex: 'index' in log ? (log as Log).index : undefined,
    transactionHash: 'transactionHash' in log ? (log as Log).transactionHash : undefined,
  };
}

/**
 * Decode a kernel resolution proof under the ZERO-REMAINING CONSUMER RULE
 * (AIP-14b §6).
 *
 * The CompositeMediator encodes two proof shapes (AIP-14b §6):
 *  - SPLIT  (CANCELLED): `abi.encode(uint256 requesterAmount, uint256 providerAmount)` — 64 bytes
 *  - SETTLE (SETTLED):   `abi.encode(uint256 requesterAmount, uint256 providerAmount, bool providerAtFault)` — 96 bytes
 *
 * When `remaining == 0` the prevailing party's amount field holds an **inert
 * 1-wei sentinel** placed solely to pass the kernel's
 * `require(requesterAmount > 0 || providerAmount > 0)` existence check. It is
 * never transferred (the kernel gates every move behind `if (remaining > 0)`).
 * This decoder therefore ZEROS both payouts when `remaining == 0` and sets
 * {@link DecodedResolutionProof.phantomSentinel}. No 1-wei payout is ever
 * surfaced. PARITY: Py `decode_resolution_proof`.
 *
 * @param proof - the raw proof bytes (0x-hex) passed to `transitionState`.
 * @param remaining - the on-chain escrow `remaining` at resolution time.
 */
export function decodeResolutionProof(proof: string, remaining: bigint): DecodedResolutionProof {
  const coder = AbiCoder.defaultAbiCoder();
  const byteLen = (proof.startsWith('0x') ? proof.length - 2 : proof.length) / 2;

  let isSplit: boolean;
  let providerAtFault: boolean | undefined;
  let rawRequester: bigint;
  let rawProvider: bigint;

  if (byteLen === 96) {
    // SETTLED branch: (requesterAmount, providerAmount, providerAtFault)
    const [r, p, fault] = coder.decode(['uint256', 'uint256', 'bool'], proof);
    isSplit = false;
    providerAtFault = Boolean(fault);
    rawRequester = BigInt(r);
    rawProvider = BigInt(p);
  } else {
    // SPLIT/CANCELLED branch: (requesterAmount, providerAmount) — 64 bytes.
    const [r, p] = coder.decode(['uint256', 'uint256'], proof);
    isSplit = true;
    rawRequester = BigInt(r);
    rawProvider = BigInt(p);
  }

  // ZERO-REMAINING CONSUMER RULE: proof amounts are a phantom sentinel — ignore.
  if (remaining === 0n) {
    return {
      isSplit,
      providerAtFault,
      payouts: { requester: 0n, provider: 0n },
      phantomSentinel: true,
    };
  }

  return {
    isSplit,
    providerAtFault,
    payouts: { requester: rawRequester, provider: rawProvider },
    phantomSentinel: false,
  };
}

/**
 * Compute the per-agent / global split rate over a set of resolved disputes
 * (AIP-14b §3.4, OQ-11 default).
 *
 * OQ-11 (normative default): the numerator counts BOTH
 *  - `DisputeSplitRecorded` events (mediator-executed ruling-2), AND
 *  - kernel `DISPUTED → CANCELLED` transitions (includes admin-CANCELLED),
 * at **identical weight**. Both are split outcomes for split-rate purposes.
 *
 * @param splitRecorded - count of `DisputeSplitRecorded` events.
 * @param kernelDisputedToCancelled - count of kernel DISPUTED→CANCELLED transitions.
 * @param totalDisputes - total disputes observed (denominator).
 * @returns split rate in [0, 1]; `0` when `totalDisputes == 0`.
 *
 * PARITY: Py `compute_split_rate`.
 */
export function computeSplitRate(
  splitRecorded: number,
  kernelDisputedToCancelled: number,
  totalDisputes: number
): number {
  if (totalDisputes <= 0) return 0;
  const splits = splitRecorded + kernelDisputedToCancelled;
  return splits / totalDisputes;
}

// =====================================================================
// Read-only client
// =====================================================================

/**
 * Read/event client for the on-chain CompositeMediator (AIP-14b §6).
 *
 * ## `resolve()` is intentionally not a method
 * The on-chain `resolve(txId, ruling, splitBps)` is guarded by
 * `onlyBondEscalation` — it reverts for any caller other than the
 * BondEscalation contract (AIP-14b §6: *"modifier onlyBondEscalation"*). There
 * is no signer an SDK user could hold that would let `resolve()` succeed, so
 * exposing it would be a footgun: every call would revert with
 * `"Only tier system"`. Resolution is driven exclusively by the bond game
 * (finalize / forceResolveStale / UMA callbacks inside BondEscalation), which
 * then calls the mediator internally. The SDK's job at the mediator boundary is
 * purely observational, so this client is **read-only**. The parity test
 * `"resolve is not a public client method"` pins this absence in both SDKs.
 */
export class CompositeMediator {
  private readonly contract: Contract;

  constructor(
    private readonly address: string,
    providerOrSigner: Provider
  ) {
    this.contract = new Contract(address, CompositeMediatorABI as unknown as any[], providerOrSigner);
  }

  /** Address of the on-chain CompositeMediator. */
  getAddress(): string {
    return this.address;
  }

  /** Underlying ethers Contract (read-only surface). */
  getContract(): Contract {
    return this.contract;
  }

  /**
   * Query historical `DisputeSplitRecorded` events.
   *
   * @param filter - optional indexed filters (txId / requester / provider).
   * @param fromBlock - inclusive start block (default genesis).
   * @param toBlock - inclusive end block (default 'latest').
   */
  async getSplitRecordedEvents(
    filter?: { txId?: string; requester?: string; provider?: string },
    fromBlock?: number,
    toBlock?: number | 'latest'
  ): Promise<DisputeSplitRecorded[]> {
    const eventFilter = this.contract.filters.DisputeSplitRecorded(
      filter?.txId ?? null,
      filter?.requester ?? null,
      filter?.provider ?? null
    );
    const logs = await this.contract.queryFilter(eventFilter, fromBlock, toBlock);
    return logs.map((l) => decodeDisputeSplitRecorded(l as EventLog));
  }

  /**
   * Subscribe to live `DisputeSplitRecorded` events. Returns an unsubscribe fn.
   *
   * PARITY: Py `CompositeMediator.on_dispute_split_recorded` — the Py twin is
   * async/polling and returns an `asyncio.Task` (its unsubscribe handle is
   * `task.cancel()`); this TS twin returns the `() => void` unsubscribe fn.
   */
  onDisputeSplitRecorded(callback: (event: DisputeSplitRecorded) => void): () => void {
    const eventFilter = this.contract.filters.DisputeSplitRecorded();
    const listener = (
      txId: string,
      requester: string,
      provider: string,
      splitBps: bigint
    ) => {
      callback({ txId, requester, provider, splitBps: Number(splitBps) });
    };
    this.contract.on(eventFilter, listener);
    return () => {
      this.contract.off(eventFilter, listener);
    };
  }
}
