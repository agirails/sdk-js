/**
 * runRequest — Level 1 requester flow (PRD §5.6).
 *
 * Shared helper for `actp request` and (via §5.7) `actp test`. Distinct from
 * `src/level0/request.ts`: that function is the Level 0 simple API with one
 * monolithic delivery timeout; runRequest splits the lifecycle into a
 * **quote phase** (capped by `quoteTimeoutMs`, default 30s) and a **delivery
 * phase** (capped by `deliveryTimeoutMs`, default 5min), and reports each
 * state transition so the CLI can show progress.
 *
 * ## Scope (4.0.0): poll-only, autoAccept-friendly path
 *
 * `runRequest` polls `runtime.getTransaction(txId)` to observe state
 * transitions and relies on a provider whose `shouldAutoAccept` returns
 * `true` to drive INITIATED → COMMITTED on its own side (provider calls
 * `linkEscrow` from `Agent.handleIncomingTransaction`). This is the
 * Sentinel onboarding path the PRD targets.
 *
 * It does **not** implement PRD §5.6 step 6's `counteraccept.v1` envelope
 * over `NegotiationChannel`. Multi-round counter-offer negotiation (which
 * BuyerOrchestrator uses) is out of scope here. A future commit on the
 * 4.x track will wire `subscribeTxId` + send the envelope when:
 *   - the provider returns a quote that differs from the requester's offer, or
 *   - the requester wants explicit accept-with-different-amount control.
 *
 * For Sentinel + autoAccept, the polling path is functionally equivalent
 * to the negotiated path and ~80 LOC simpler.
 *
 * ## PRD §5.6 invariants enforced here
 *  - On-chain `serviceDescription` is the bytes32 routing key
 *    `keccak256(toUtf8Bytes(serviceName.trim()))`. Never JSON.
 *  - Requester immediately settles after DELIVERED (kernel allows this
 *    without waiting for the dispute window; ACTPKernel.sol:700-704).
 *  - Quote-timeout exit is non-zero (code 2 at the CLI layer). The TX
 *    remains on-chain INITIATED for the caller to cancel manually.
 *  - `--input` / `--metadata` are out of scope for 4.0.0; provider sees
 *    `job.input = {}`. Future `agirails.request.v1` envelope on
 *    `NegotiationChannel` will restore that path (PRD §11).
 *
 * @module cli/lib/runRequest
 */

import { keccak256, toUtf8Bytes, isAddress, getAddress, Wallet } from 'ethers';
import { ACTPClient } from '../../ACTPClient';
import { resolvePrivateKey } from '../../wallet/keystore';
import { TransactionState } from '../../runtime/types/MockState';
import { Logger } from '../../utils/Logger';

export type RequestNetwork = 'mock' | 'testnet' | 'mainnet';

export interface RunRequestOptions {
  /** Provider — checksummed or lowercase Ethereum address. */
  provider: string;
  /** Amount in USDC, human-readable (e.g. "0.05"). */
  amount: string;
  /** Service name. On-chain key is `keccak256(toUtf8Bytes(name))`. */
  service: string;
  /** Deadline as ISO 8601 string OR unix seconds. Default: now + 1h. */
  deadline?: string | number;
  /** Target network. Default 'testnet'. */
  network?: RequestNetwork;
  /** Quote-phase timeout in milliseconds. Default 30_000 (PRD §5.6). */
  quoteTimeoutMs?: number;
  /** Delivery-phase timeout in milliseconds. Default 300_000 (5min). */
  deliveryTimeoutMs?: number;
  /**
   * Auto-accept any quote without prompting. 4.0.0 has no
   * interactive-confirm UI yet, so this is effectively always true.
   * Reserved for forward compatibility with interactive flows.
   */
  autoAccept?: boolean;
  /** Override requester wallet (testnet/mainnet); resolved via keystore if omitted. */
  privateKey?: string;
  /** Override JSON-RPC URL. Falls back to network default. */
  rpcUrl?: string;
  /** Custom state directory for mock mode. */
  stateDirectory?: string;
  /** Called for every state transition the requester observes. */
  onTransition?: (state: TransactionState, txId: string, ts: Date) => void;
}

export class QuoteTimeoutError extends Error {
  constructor(public readonly txId: string, public readonly timeoutMs: number) {
    super(
      `No quote received within ${timeoutMs}ms. Provider may be offline. ` +
      `TX ${txId} remains on-chain INITIATED — cancel with ` +
      `'actp tx cancel ${txId}' or retry.`
    );
    this.name = 'QuoteTimeoutError';
  }
}

export class DeliveryTimeoutError extends Error {
  constructor(
    public readonly txId: string,
    public readonly timeoutMs: number,
    public readonly lastState: TransactionState
  ) {
    super(
      `No delivery within ${timeoutMs}ms (last state: ${lastState}). ` +
      `TX ${txId} may still be in flight; check 'actp tx status ${txId}'.`
    );
    this.name = 'DeliveryTimeoutError';
  }
}

export interface RunRequestResult {
  /** On-chain transaction id (bytes32 hex). */
  txId: string;
  /** Final state observed before runRequest returned. */
  finalState: TransactionState;
  /** Total time from createTransaction to settle/return, in ms. */
  elapsedMs: number;
  /** Decoded delivery payload, when available. */
  payload?: unknown;
  /** Whether the requester settled the escrow before returning. */
  settled: boolean;
  /**
   * Absolute public receipt URL (https://agirails.app/r/r_...) when the
   * buyer-side V2 push to the AGIRAILS Platform succeeded after SETTLED.
   *
   * null when:
   *   - settle did not complete (no receipt to share)
   *   - the push failed (network error, 422 verify, etc.) — the Platform
   *     indexer cron is the backstop and will mint a row within ~5min,
   *     just no URL handy for the immediate CLI moment
   *   - network is 'mock' (no real chain ⇒ no real receipt to publish)
   */
  receiptUrl: string | null;
}

const TERMINAL_FAILURE: TransactionState[] = ['CANCELLED', 'DISPUTED'];
const POLL_INTERVAL_MS = 1_000;

/**
 * Execute a Level 1 negotiated request end-to-end.
 *
 * @example
 * ```ts
 * const r = await runRequest({
 *   provider: '0x3813...d64',
 *   amount: '0.05',
 *   service: 'onboarding',
 *   network: 'testnet',
 *   onTransition: (state, txId, ts) =>
 *     console.log(`[${ts.toISOString()}] ${state.padEnd(12)} ${txId}`),
 * });
 * console.log(r.payload);
 * ```
 */
export async function runRequest(opts: RunRequestOptions): Promise<RunRequestResult> {
  const logger = new Logger({ source: 'runRequest' });

  // 1. Validate provider address.
  if (!isAddress(opts.provider)) {
    throw new Error(`Invalid provider address: ${opts.provider}`);
  }
  const providerAddress = getAddress(opts.provider);

  // 2. Resolve requester key + address.
  const network: RequestNetwork = opts.network ?? 'testnet';
  let privateKey = opts.privateKey;
  if (!privateKey && (network === 'testnet' || network === 'mainnet')) {
    privateKey = await resolvePrivateKey(opts.stateDirectory, { network });
  }
  const requesterAddress = privateKey
    ? getAddress(new Wallet(privateKey).address)
    : deterministicMockAddress();

  // 3. Resolve RPC URL.
  let rpcUrl = opts.rpcUrl;
  if (!rpcUrl && (network === 'testnet' || network === 'mainnet')) {
    const { getNetwork } = await import('../../config/networks');
    const networkName = network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
    rpcUrl = getNetwork(networkName).rpcUrl;
  }

  // 4. Build client.
  const client = await ACTPClient.create({
    mode: network === 'testnet' ? 'testnet' : network === 'mainnet' ? 'mainnet' : 'mock',
    requesterAddress,
    stateDirectory: opts.stateDirectory,
    privateKey,
    rpcUrl,
  });

  // 5. Compute on-chain inputs.
  //    Service-name normalization: trim incidental whitespace before hashing
  //    so callers passing " onboarding " from a YAML config or shell paste
  //    get the same routing key as `Agent.provide('onboarding')`. Matches
  //    the trimming `level0/request.ts` performs via `validateServiceName`.
  const normalizedService = opts.service.trim();
  if (normalizedService.length === 0) {
    throw new Error('runRequest: `service` must be a non-empty name.');
  }
  const serviceHash = keccak256(toUtf8Bytes(normalizedService));
  const amountWei = humanAmountToUSDCWei(opts.amount);
  const deadlineUnix = resolveDeadline(opts.deadline);

  // 6. Mock-mode requester top-up (mirrors level0/request convenience).
  if (client.runtime && 'mintTokens' in client.runtime) {
    const mockRuntime = client.runtime as unknown as {
      getBalance: (addr: string) => Promise<string>;
      mintTokens: (addr: string, amount: string) => Promise<void>;
    };
    const balance = BigInt(await mockRuntime.getBalance(requesterAddress));
    if (balance < BigInt(amountWei)) {
      const topUp = (BigInt(amountWei) - balance + 10_000_000n).toString();
      await mockRuntime.mintTokens(requesterAddress, topUp);
    }
  }

  // 7. createTransaction → INITIATED.
  //    Route through StandardAdapter so AA-enabled requesters use the
  //    SmartWalletRouter (Paymaster-sponsored UserOps) — `client.runtime`
  //    directly would force-sign with the raw EOA and break the AGIRAILS
  //    gasless model for requesters who hold no ETH.
  //    (Mock + EOA modes fall through to runtime.createTransaction inside
  //    the adapter, so behaviour is preserved.)
  //    `requester` is derived from `this.requesterAddress` inside the
  //    adapter — which ACTPClient.create sets to the smart-wallet address
  //    when AutoWallet is active, or the EOA otherwise.
  //    `amount` is the human-readable USDC string (parseAmount handles
  //    units internally); do NOT pass amountWei here.
  const startedAt = Date.now();
  const txId = await client.standard.createTransaction({
    provider: providerAddress,
    amount: opts.amount,
    deadline: deadlineUnix,
    disputeWindow: 172_800, // 2 days; kernel enforces ≥ 1h.
    serviceDescription: serviceHash, // PRD §5.6
  });
  opts.onTransition?.('INITIATED', txId, new Date());

  // 7b. linkEscrow → COMMITTED.
  //     ACTPKernel.linkEscrow requires `msg.sender == txn.requester`
  //     ("Only requester" — ACTPKernel.sol:328). The kernel will reject
  //     any provider-side attempt to commit the escrow, so the requester
  //     must drive this transition. Pre-4.0.0-beta.3 runRequest skipped
  //     this step and assumed the provider's auto-accept hook would link
  //     escrow on its side; against the redeployed kernel that path
  //     reverts and the tx stays INITIATED until QUOTE_TIMEOUT.
  //
  //     StandardAdapter.linkEscrow batches USDC.approve + kernel.linkEscrow
  //     into a single UserOp when AutoWallet is active, so Paymaster sponsors
  //     the gas. EOA / mock callers fall through to runtime.linkEscrow with
  //     tx.amount read from the on-chain tx.
  if (network === 'testnet' || network === 'mainnet') {
    await client.standard.linkEscrow(txId);
    opts.onTransition?.('COMMITTED', txId, new Date());
  }

  // 8. Quote phase — wait for INITIATED → QUOTED / COMMITTED / IN_PROGRESS / DELIVERED.
  //    On testnet/mainnet the state has already advanced to COMMITTED via
  //    the linkEscrow above, so waitForStateChange returns immediately.
  //    On mock the provider still drives the transition.
  const quoteTimeoutMs = opts.quoteTimeoutMs ?? 30_000;
  let lastState: TransactionState = 'INITIATED';
  const passedQuote = await waitForStateChange(
    client,
    txId,
    'INITIATED',
    quoteTimeoutMs,
    (state) => {
      if (state !== lastState) {
        lastState = state;
        opts.onTransition?.(state, txId, new Date());
      }
    }
  );
  if (!passedQuote) {
    throw new QuoteTimeoutError(txId, quoteTimeoutMs);
  }
  if (TERMINAL_FAILURE.includes(lastState)) {
    throw new Error(`Transaction ${lastState.toLowerCase()} before delivery`);
  }

  // 9. Delivery phase — wait for DELIVERED (or SETTLED, if provider already settled).
  const deliveryTimeoutMs = opts.deliveryTimeoutMs ?? 300_000;
  const reachedDelivery = await waitForTargetState(
    client,
    txId,
    ['DELIVERED', 'SETTLED'],
    deliveryTimeoutMs,
    (state) => {
      if (state !== lastState) {
        lastState = state;
        opts.onTransition?.(state, txId, new Date());
      }
    }
  );
  if (!reachedDelivery) {
    if (TERMINAL_FAILURE.includes(lastState)) {
      throw new Error(`Transaction ${lastState.toLowerCase()} before delivery`);
    }
    throw new DeliveryTimeoutError(txId, deliveryTimeoutMs, lastState);
  }

  // 10. Decode delivery payload, if present.
  const tx = await client.runtime.getTransaction(txId);
  const payload = tx?.deliveryProof ? safeParse(tx.deliveryProof) : undefined;

  // 11. Requester-immediate settle. ACTPKernel allows DELIVERED → SETTLED
  //     by the requester without waiting for the dispute window
  //     (ACTPKernel.sol:700-704). Other parties must wait. We drive the
  //     decision from the freshly-fetched `tx.state` to avoid stale
  //     closure-bound state from the polling callback above.
  let finalState: TransactionState = tx?.state ?? lastState;
  let settled = finalState === 'SETTLED';
  if (!settled && tx && tx.state === 'DELIVERED' && tx.escrowId) {
    try {
      // Route via StandardAdapter so AA requesters settle via Paymaster
      // (sendSettle UserOp), not a raw EOA tx that needs ETH for gas.
      await client.standard.releaseEscrow(tx.escrowId);
      settled = true;
      finalState = 'SETTLED';
      opts.onTransition?.('SETTLED', txId, new Date());
    } catch (err) {
      logger.warn('Requester settle failed; settlement will fall back to dispute-window auto-settle', {
        txId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 12. Buyer-visible settlement receipt push — the wow flow.
  //
  // On SETTLED with a real on-chain network and a real signer, post the
  // requester-side receipt to the AGIRAILS Platform. The Platform verifies
  // the V2 signature, independently confirms with the kernel that the tx
  // matches (forgery defense), then mints a row and returns a clickable
  // public URL.
  //
  // Failure is intentionally non-fatal: the settlement already happened
  // on-chain, and the Platform indexer cron is the backstop. The CLI just
  // can't print a URL for this specific tx if the push failed.
  let receiptUrl: string | null = null;
  if (settled && privateKey && (network === 'testnet' || network === 'mainnet')) {
    try {
      const { pushReceiptOnSettled } = await import('../../receipts/push');
      const { computeDisplayFee } = await import('../../config/defaults');
      const { getNetwork } = await import('../../config/networks');

      const networkName = network === 'testnet' ? 'base-sepolia' : 'base-mainnet';
      const kernelAddress = getNetwork(networkName).contracts.actpKernel;
      const amountWeiBig = BigInt(amountWei);
      const feeWeiBig = computeDisplayFee(amountWeiBig);
      // Clamp net to zero for dust amounts where fee >= amount; matches
      // the Platform-side receipts_net_wei_nonneg CHECK constraint.
      const netWeiBig = amountWeiBig > feeWeiBig ? amountWeiBig - feeWeiBig : 0n;

      // The on-chain requester is `client.info.address` — the smart wallet
      // when AutoWallet is active, or the EOA in Tier 2/3. The local
      // `requesterAddress` var above is always the EOA when privateKey is
      // set, so passing it would mismatch on-chain state and fail the
      // server's assertOnChainMatches check (silently nulling receiptUrl).
      const push = await pushReceiptOnSettled({
        signer: new Wallet(privateKey),
        participantRole: 'requester',
        providerAddress,
        requesterAddress: client.info.address,
        kernelAddress,
        txId,
        network: networkName,
        amountWei: amountWeiBig.toString(),
        feeWei: feeWeiBig.toString(),
        netWei: netWeiBig.toString(),
        serviceHash,
        service: normalizedService,
        durationMs: Date.now() - startedAt,
      });
      receiptUrl = push.receiptUrl;
    } catch (err) {
      // Non-fatal: log and continue. The indexer cron is the backstop.
      logger.warn('Buyer-side receipt push failed; indexer will backfill', {
        txId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    txId,
    finalState,
    elapsedMs: Date.now() - startedAt,
    payload,
    settled,
    receiptUrl,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

function deterministicMockAddress(): string {
  // Mirrors src/level0/request.ts getRequesterAddress() mock fallback so
  // mock-mode runRequest reuses the same default requester slot.
  return '0x' + Buffer.from('requester').toString('hex').padEnd(40, '0');
}

function humanAmountToUSDCWei(amount: string): string {
  const parts = amount.split('.');
  if (parts.length > 2 || !/^\d+$/.test(parts[0]) || (parts[1] !== undefined && !/^\d+$/.test(parts[1]))) {
    throw new Error(`Invalid amount: "${amount}" — expected decimal string like "0.05".`);
  }
  const whole = BigInt(parts[0]) * 1_000_000n;
  const decimal = parts[1] ? BigInt(parts[1].slice(0, 6).padEnd(6, '0')) : 0n;
  const wei = whole + decimal;
  if (wei <= 0n) throw new Error(`Amount must be positive (got "${amount}").`);
  return wei.toString();
}

function resolveDeadline(deadline?: string | number): number {
  if (deadline === undefined) {
    return Math.floor(Date.now() / 1000) + 3600;
  }
  if (typeof deadline === 'number') {
    // Sanity check: any value past year-3000 in seconds is implausible and
    // probably a JS millisecond timestamp passed by accident
    // (`Date.now()` instead of `Math.floor(Date.now()/1000)`). Reject loudly
    // — the kernel would otherwise accept an immortal-deadline TX.
    // 32_503_680_000 ≈ 3000-01-01T00:00:00Z. JS ms timestamps clear this
    // bound from year 2001 onward (1e12 ≈ 2001-09-09).
    if (deadline > 32_503_680_000) {
      throw new Error(
        `Invalid deadline: ${deadline} appears to be a millisecond timestamp. ` +
        `runRequest expects unix seconds — pass Math.floor(Date.now() / 1000) instead.`
      );
    }
    return deadline;
  }
  const parsed = Date.parse(deadline);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid deadline: "${deadline}" — expected ISO 8601 or unix seconds.`);
  }
  return Math.floor(parsed / 1000);
}

async function waitForStateChange(
  client: ACTPClient,
  txId: string,
  initial: TransactionState,
  timeoutMs: number,
  onTick: (state: TransactionState) => void
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx = await client.runtime.getTransaction(txId);
    if (!tx) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    onTick(tx.state);
    if (tx.state !== initial) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function waitForTargetState(
  client: ACTPClient,
  txId: string,
  targets: TransactionState[],
  timeoutMs: number,
  onTick: (state: TransactionState) => void
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx = await client.runtime.getTransaction(txId);
    if (!tx) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    onTick(tx.state);
    if (targets.includes(tx.state)) return true;
    if (TERMINAL_FAILURE.includes(tx.state)) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
