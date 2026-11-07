import { Contract, EventLog, Log } from 'ethers';
import { State, Transaction } from '../types';
import {
  DisputeSplitRecorded,
  decodeDisputeSplitRecorded,
} from '../dispute/CompositeMediator';

/**
 * Widened transaction returned by getTransactionHistory.
 *
 * `blockNumber` and `logIndex` are sourced from the on-chain event log,
 * not from ACTPKernel state — they exist so consumers (catch-up sweeps)
 * can select the newest `limit` events deterministically and then process
 * the selected batch oldest-first.
 *
 * PRD-event-driven-provider-listening §5.5.
 */
export type TransactionWithLogMeta = Transaction & {
  blockNumber?: number;
  logIndex?: number;
};

/**
 * EventMonitor - Listen to blockchain events
 *
 * ## Confirmation Policy
 *
 * Events received by EventMonitor are already confirmed. ACTPKernel waits
 * for N block confirmations (default 2, configurable via `confirmations`
 * parameter in BlockchainRuntimeConfig) before returning from state-changing
 * operations. On Base L2 (~2 s blocks), the default means events arrive
 * ~4-6 s after submission and are safe from reorgs.
 *
 * Confirmation flow:
 *   User calls ACTPKernel.createTransaction()
 *     → tx.wait(confirmations) blocks until N confirmations
 *     → Event emitted (already confirmed)
 *     → EventMonitor receives event (instant)
 *
 *Security: Corrected event parameter order to match ABI.
 * Per ACTPKernel.json, TransactionCreated signature is:
 *   (bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
 *
 * Previous code had requester/provider swapped which caused wrong filter results.
 */
/**
 * A surfaced dispute-resolution event (PRD P2-5). One of:
 *  - `'DisputeSplitRecorded'`  — CompositeMediator ruling-2 trace (AIP-14b §3.4)
 *  - `'DisputedToCancelled'`    — kernel DISPUTED→CANCELLED transition (split path;
 *                                 includes admin-CANCELLED — OQ-11 counts it)
 *  - `'UMADisputeEscalated'`    — BondEscalation Tier-2 dispute hit UMA's DVM
 *
 * These are exactly the three signals the split-rate indexer (P2-8) consumes.
 */
export type DisputeEvent =
  | ({ type: 'DisputeSplitRecorded' } & DisputeSplitRecorded)
  | { type: 'DisputedToCancelled'; txId: string; blockNumber?: number; logIndex?: number }
  | { type: 'UMADisputeEscalated'; disputeId: string; assertionId: string; blockNumber?: number; logIndex?: number };

export class EventMonitor {
  /**
   * @param kernelContract - ACTPKernel (StateTransitioned / TransactionCreated / EscrowReleased).
   * @param _escrowContract - EscrowVault (currently unused by this monitor).
   * @param mediatorContract - optional CompositeMediator, for `onDisputeSplitRecorded`.
   * @param bondEscalationContract - optional BondEscalation, for `onUMADisputeEscalated`.
   */
  constructor(
    private readonly kernelContract: Contract,
    _escrowContract: Contract,
    private readonly mediatorContract?: Contract,
    private readonly bondEscalationContract?: Contract
  ) {}

  /**
   * Watch transaction state changes
   * Returns cleanup function to stop watching
   */
  watchTransaction(txId: string, callback: (state: State) => void): () => void {
    const filter = this.kernelContract.filters.StateTransitioned(txId);

    const listener = (_eventTxId: string, _from: number, to: number) => {
      callback(to as State);
    };

    this.kernelContract.on(filter, listener);

    // Return cleanup function
    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  /**
   * Wait for specific state
   */
  async waitForState(
    txId: string,
    targetState: State,
    timeoutMs: number = 60000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for state ${State[targetState]}`));
      }, timeoutMs);

      const cleanup = this.watchTransaction(txId, (state) => {
        if (state === targetState) {
          clearTimeout(timer);
          cleanup();
          resolve();
        }
      });
    });
  }

  /**
   * Get all transactions for an address
   *
   *Security: Corrected filter parameter order.
   * Per ACTPKernel.json ABI, TransactionCreated event signature is:
   *   (bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
   *
   * Filter order: TransactionCreated(txId, requester, provider)
   * - To filter by requester: (null, address, null)
   * - To filter by provider: (null, null, address)
   *
   *Security: Use getTransaction() instead of transactions()
   * The kernel contract exposes getTransaction(bytes32) not transactions(bytes32).
   *
   * PRD §5.5: optional `range` lets callers bound the queryFilter scan to a
   * recent block window (e.g., the catch-up sweep in BlockchainRuntime).
   * Returned items are widened with `blockNumber` + `logIndex` from the source
   * event log so consumers can select the newest `limit` deterministically.
   * Backward compatible: `range === undefined` keeps prior genesis→latest scan
   * behavior; existing callers that only read canonical `Transaction` fields
   * compile unchanged.
   */
  async getTransactionHistory(
    address: string,
    role: 'requester' | 'provider' = 'requester',
    range?: { fromBlock?: number; toBlock?: number | 'latest' }
  ): Promise<TransactionWithLogMeta[]> {
    // TransactionCreated event signature per ABI:
    // (bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
    // Filter format: TransactionCreated(txId, requester, provider)
    const filter =
      role === 'requester'
        ? this.kernelContract.filters.TransactionCreated(null, address, null) // Match requester (2nd indexed param)
        : this.kernelContract.filters.TransactionCreated(null, null, address); // Match provider (3rd indexed param)

    // RPCs cap eth_getLogs block ranges (≈2000 on standard tiers, far less on
    // throttled keys). When the caller bounds the scan to a numeric window,
    // query it in ADAPTIVE CHUNKS that split on a range-limit error — so the
    // catch-up sweep works on ANY RPC instead of throwing and (one level up)
    // crashing the agent. Shared by every consumer that reaches here.
    const events =
      range && typeof range.fromBlock === 'number' && typeof range.toBlock === 'number'
        ? await this.queryFilterChunked(filter, range.fromBlock, range.toBlock)
        : range
          ? await this.kernelContract.queryFilter(filter, range.fromBlock, range.toBlock)
          : await this.kernelContract.queryFilter(filter);

    return Promise.all(
      events.map(async (event) => {
        // ethers v6: EventLog has args, Log does not
        if (!('args' in event)) {
          throw new Error('Event does not contain args (not an EventLog)');
        }
        const eventLog = event as EventLog;
        const txId = eventLog.args?.transactionId;

        // Security: Use getTransaction() - the actual ABI function
        // Previous code called transactions(txId) which doesn't exist in ABI
        const txData = await this.kernelContract.getTransaction(txId);

        return {
          txId: txData.transactionId || txId,
          requester: txData.requester,
          provider: txData.provider,
          amount: txData.amount,
          state: (typeof txData.state === 'bigint' ? Number(txData.state) : txData.state) as State,
          createdAt: Number(txData.createdAt),
          updatedAt: Number(txData.updatedAt),
          deadline: Number(txData.deadline),
          disputeWindow: Number(txData.disputeWindow),
          escrowContract: txData.escrowContract,
          escrowId: txData.escrowId,
          serviceHash: txData.serviceHash,
          attestationUID: txData.attestationUID,
          // Use metadata field (quote hash for QUOTED state) if available, fallback to serviceHash
          metadata: txData.metadata || txData.serviceHash,
          platformFeeBpsLocked: Number(txData.platformFeeBpsLocked),
          // PRD §5.5: surface source-log ordering metadata for deterministic newest-first selection
          blockNumber: eventLog.blockNumber,
          logIndex: eventLog.index,
        };
      })
    );
  }

  /**
   * queryFilter over [fromBlock, toBlock], splitting the window in half and
   * retrying whenever the RPC rejects the range as too large. Adapts to ANY
   * provider's eth_getLogs cap (10, 2000, …) with no hardcoded chunk size. A
   * single-block window that still fails is a genuine error — rethrown.
   */
  private async queryFilterChunked(
    filter: Parameters<Contract['queryFilter']>[0],
    fromBlock: number,
    toBlock: number
  ): Promise<(EventLog | Log)[]> {
    try {
      return await this.kernelContract.queryFilter(filter, fromBlock, toBlock);
    } catch (err) {
      if (fromBlock >= toBlock || !EventMonitor.isBlockRangeError(err)) throw err;
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const lower = await this.queryFilterChunked(filter, fromBlock, mid);
      const upper = await this.queryFilterChunked(filter, mid + 1, toBlock);
      return [...lower, ...upper];
    }
  }

  /** Heuristic: does this error mean the eth_getLogs block range was too large? */
  private static isBlockRangeError(err: unknown): boolean {
    const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      m.includes('block range') || m.includes('range is too') || m.includes('range too') ||
      m.includes('up to a') || m.includes('more than') || m.includes('response size') ||
      m.includes('query timeout') || m.includes('limit exceeded') ||
      m.includes('-32600') || m.includes('-32005')
    );
  }

  /**
   * Subscribe to transaction creation events.
   *
   * Optionally filter by requester and/or provider address. Filtering happens
   * at the RPC node level via indexed event parameters — significantly more
   * efficient than filtering in the callback, especially for high-volume agents.
   *
   *Security: Corrected event parameter order.
   * Per ACTPKernel.json ABI:
   *   TransactionCreated(bytes32 indexed transactionId, address indexed requester, address indexed provider, uint256 amount, bytes32 serviceHash)
   *
   * @example
   * ```typescript
   * // Listen to ALL transactions (legacy, inefficient at scale)
   * monitor.onTransactionCreated((tx) => console.log(tx));
   *
   * // Listen only to transactions where I am the provider (recommended for listeners)
   * monitor.onTransactionCreated({ provider: myAddress }, (tx) => handleJob(tx));
   *
   * // Listen only to my outgoing transactions
   * monitor.onTransactionCreated({ requester: myAddress }, (tx) => trackOutbound(tx));
   * ```
   */
  onTransactionCreated(
    callback: (tx: { txId: string; requester: string; provider: string; amount: bigint; serviceHash?: string }) => void
  ): () => void;
  onTransactionCreated(
    filter: { requester?: string; provider?: string },
    callback: (tx: { txId: string; requester: string; provider: string; amount: bigint; serviceHash?: string }) => void
  ): () => void;
  onTransactionCreated(
    filterOrCallback:
      | { requester?: string; provider?: string }
      | ((tx: { txId: string; requester: string; provider: string; amount: bigint; serviceHash?: string }) => void),
    maybeCallback?: (tx: { txId: string; requester: string; provider: string; amount: bigint; serviceHash?: string }) => void
  ): () => void {
    // Resolve overload arguments
    const filterOpts =
      typeof filterOrCallback === 'function' ? {} : filterOrCallback;
    const callback =
      typeof filterOrCallback === 'function' ? filterOrCallback : maybeCallback;

    // Fast-fail: catch missing callback at subscription time, not when first event arrives
    if (typeof callback !== 'function') {
      throw new TypeError(
        'onTransactionCreated: callback is required when a filter is provided',
      );
    }

    // Build indexed filter — null means "any value" for that indexed param
    // Filter order per ABI: TransactionCreated(transactionId, requester, provider, ...)
    const filter = this.kernelContract.filters.TransactionCreated(
      null,
      filterOpts.requester ?? null,
      filterOpts.provider ?? null,
    );

    // Event signature per ABI: (txId, requester, provider, amount, serviceHash)
    const listener = async (
      txId: string,
      requester: string,
      provider: string,
      amount: bigint,
      serviceHash?: string
    ) => {
      callback({ txId, requester, provider, amount, serviceHash });
    };

    this.kernelContract.on(filter, listener);

    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  /**
   * Subscribe to state change events
   */
  onStateChanged(
    callback: (txId: string, from: State, to: State) => void
  ): () => void {
    const filter = this.kernelContract.filters.StateTransitioned();

    const listener = (txId: string, from: number, to: number) => {
      callback(txId, from as State, to as State);
    };

    this.kernelContract.on(filter, listener);

    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  /**
   * Subscribe to escrow release events
   */
  onEscrowReleased(callback: (txId: string, amount: bigint) => void): () => void {
    const filter = this.kernelContract.filters.EscrowReleased();

    const listener = (txId: string, amount: bigint) => {
      callback(txId, amount);
    };

    this.kernelContract.on(filter, listener);

    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  // =========================================================================
  // Dispute surfacing (PRD P2-5 / AIP-14b §3.4)
  // =========================================================================

  /**
   * Subscribe to `DisputeSplitRecorded` (CompositeMediator ruling-2 trace).
   *
   * Requires a `mediatorContract` to have been passed to the constructor —
   * the event lives on CompositeMediator, not the kernel. PARITY: Py
   * `EventMonitor.on_dispute_split_recorded`.
   *
   * @throws if no mediator contract was provided.
   */
  onDisputeSplitRecorded(callback: (event: DisputeSplitRecorded) => void): () => void {
    if (!this.mediatorContract) {
      throw new Error(
        'onDisputeSplitRecorded: EventMonitor was constructed without a CompositeMediator contract'
      );
    }
    const contract = this.mediatorContract;
    const filter = contract.filters.DisputeSplitRecorded();
    const listener = (
      txId: string,
      requester: string,
      provider: string,
      splitBps: bigint
    ) => {
      callback({ txId, requester, provider, splitBps: Number(splitBps) });
    };
    contract.on(filter, listener);
    return () => {
      contract.off(filter, listener);
    };
  }

  /**
   * Subscribe to kernel `DISPUTED → CANCELLED` transitions — the kernel-level
   * split path (admin-CANCELLED disputes route here without touching
   * CompositeMediator). OQ-11 counts these in the headline split-rate at the
   * SAME weight as `DisputeSplitRecorded`. PARITY: Py
   * `EventMonitor.on_disputed_to_cancelled`.
   */
  onDisputedToCancelled(
    callback: (event: { txId: string; blockNumber?: number; logIndex?: number }) => void
  ): () => void {
    const filter = this.kernelContract.filters.StateTransitioned();
    const listener = (txId: string, from: number, to: number, _ev?: EventLog) => {
      if (Number(from) === State.DISPUTED && Number(to) === State.CANCELLED) {
        callback({ txId });
      }
    };
    this.kernelContract.on(filter, listener);
    return () => {
      this.kernelContract.off(filter, listener);
    };
  }

  /**
   * Subscribe to BondEscalation `UMADisputeEscalated` — a Tier-2 assertion was
   * disputed and pushed to UMA's DVM (AIP-14b §8.5).
   *
   * Requires a `bondEscalationContract` to have been passed to the constructor.
   * PARITY: Py `EventMonitor.on_uma_dispute_escalated`.
   *
   * @throws if no BondEscalation contract was provided.
   */
  onUMADisputeEscalated(
    callback: (event: { disputeId: string; assertionId: string }) => void
  ): () => void {
    if (!this.bondEscalationContract) {
      throw new Error(
        'onUMADisputeEscalated: EventMonitor was constructed without a BondEscalation contract'
      );
    }
    const contract = this.bondEscalationContract;
    const filter = contract.filters.UMADisputeEscalated();
    const listener = (disputeId: string, assertionId: string) => {
      callback({ disputeId, assertionId });
    };
    contract.on(filter, listener);
    return () => {
      contract.off(filter, listener);
    };
  }

  /**
   * One-shot historical sweep of all three dispute signals across a block
   * window — the read half the split-rate indexer (P2-8) builds on. Returns a
   * block/log-ordered list of {@link DisputeEvent}. PARITY: Py
   * `EventMonitor.get_dispute_events`.
   */
  async getDisputeEvents(
    fromBlock?: number,
    toBlock?: number | 'latest'
  ): Promise<DisputeEvent[]> {
    const out: DisputeEvent[] = [];

    // Kernel DISPUTED→CANCELLED (always available).
    const stFilter = this.kernelContract.filters.StateTransitioned();
    const stLogs = await this.kernelContract.queryFilter(stFilter, fromBlock, toBlock);
    for (const log of stLogs) {
      if (!('args' in log)) continue;
      const ev = log as EventLog;
      const from = Number(ev.args?.[1]);
      const to = Number(ev.args?.[2]);
      if (from === State.DISPUTED && to === State.CANCELLED) {
        out.push({
          type: 'DisputedToCancelled',
          txId: ev.args?.[0],
          blockNumber: ev.blockNumber,
          logIndex: ev.index,
        });
      }
    }

    // CompositeMediator DisputeSplitRecorded (if wired).
    if (this.mediatorContract) {
      const dsFilter = this.mediatorContract.filters.DisputeSplitRecorded();
      const dsLogs = await this.mediatorContract.queryFilter(dsFilter, fromBlock, toBlock);
      for (const log of dsLogs) {
        if (!('args' in log)) continue;
        out.push({ type: 'DisputeSplitRecorded', ...decodeDisputeSplitRecorded(log as EventLog) });
      }
    }

    // BondEscalation UMADisputeEscalated (if wired).
    if (this.bondEscalationContract) {
      const umaFilter = this.bondEscalationContract.filters.UMADisputeEscalated();
      const umaLogs = await this.bondEscalationContract.queryFilter(umaFilter, fromBlock, toBlock);
      for (const log of umaLogs) {
        if (!('args' in log)) continue;
        const ev = log as EventLog;
        out.push({
          type: 'UMADisputeEscalated',
          disputeId: ev.args?.[0],
          assertionId: ev.args?.[1],
          blockNumber: ev.blockNumber,
          logIndex: ev.index,
        });
      }
    }

    out.sort((a, b) => (a.blockNumber ?? 0) - (b.blockNumber ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
    return out;
  }
}

