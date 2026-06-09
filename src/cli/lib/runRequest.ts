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
import {
  CANONICAL_EMPTY_BYTES32,
  DeliverySetupBuilder,
  DeliveryEnvelopeBuilder,
  generateEphemeralKeyPair,
  type DeliveryChannel,
  type DeliveryError,
  type DeliveryEnvelopeWireV1,
  type DeliveryPrivacy,
  type DeliverySubscription,
} from '../../delivery';

export type RequestNetwork = 'mock' | 'testnet' | 'mainnet';

// ============================================================================
// Time helpers (single seam — do NOT inline wall-clock primitives elsewhere)
// ============================================================================
//
// AIP-16 Phase 2e discipline: every wall-clock or monotonic-time read in this
// module flows through these helpers. Tests inject deterministic clocks via
// the helpers in `setupBuilder` / `envelopeBuilder`; this module's own timing
// (envelope grace period, elapsed bookkeeping) sticks to these two named seams
// so a future test harness can swap them without grepping for literals.
//
// `secondsNow()` — integer Unix seconds, used wherever EIP-712 `uint64`
//   timestamps or display-friendly elapsed values are needed.
// `monoMillisNow()` — monotonic milliseconds, used for in-process timers and
//   elapsed-budget checks. Backed by `Date.now()` (Node lacks `process.hrtime`
//   in browser builds, and we don't need sub-ms resolution here).

function secondsNow(): number {
  return Math.floor(Date.now() / 1000);
}

function monoMillisNow(): number {
  return Date.now();
}

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

  // --------------------------------------------------------------------------
  // AIP-16 Phase 2e — Delivery Surface (opt-in, all optional)
  // --------------------------------------------------------------------------

  /**
   * Delivery channel for AIP-16 setup POST + envelope subscription.
   *
   * When omitted, runRequest behaves exactly as before — no setup is posted,
   * no envelope subscription runs, and `payload` falls back to the legacy
   * `tx.deliveryProof` parsing path. Tests and pre-AIP-16 deployments are
   * unaffected.
   *
   * When provided AND `expectedKernelAddress` + `expectedChainId` are also
   * supplied, runRequest:
   *  1. signs and POSTs a `DeliverySetupWireV1` between createTransaction
   *     and linkEscrow,
   *  2. subscribes to envelopes in parallel with state polling,
   *  3. populates `RunRequestResult.payload` from the decrypted (or parsed)
   *     envelope body once one arrives.
   */
  deliveryChannel?: DeliveryChannel;

  /**
   * Trusted ACTP kernel address for EIP-712 setup/envelope binding.
   *
   * Required (alongside `deliveryChannel` + `expectedChainId`) to enable
   * the AIP-16 delivery flow. Used as the EIP-712 `verifyingContract`
   * domain anchor and as the envelope-verifier allowlist anchor.
   */
  expectedKernelAddress?: string;

  /**
   * Trusted EVM chain id for the AIP-16 delivery binding (e.g. 84532 for
   * Base Sepolia, 8453 for Base mainnet).
   *
   * Required (alongside `deliveryChannel` + `expectedKernelAddress`) to
   * enable the AIP-16 delivery flow.
   */
  expectedChainId?: number;

  /**
   * Grace period (in milliseconds) to keep the envelope subscription open
   * AFTER the transaction reaches DELIVERED. Default 30_000 (30s).
   *
   * Settlement is NEVER blocked by the wait — if the envelope arrives
   * before DELIVERED, `payload` is populated and the subscription closes
   * early. If the grace period elapses with no envelope, runRequest
   * proceeds with `payload = undefined` and `deliveryError.code =
   * 'envelope_missing'` set (informational; not fatal).
   */
  envelopeWaitMs?: number;

  /**
   * Privacy posture requested in the buyer setup. Default `"public"`.
   *
   * `"public"`: setup carries `buyerEphemeralPubkey = CANONICAL_EMPTY_BYTES32`;
   *   envelope body is plaintext UTF-8 JSON (`public-v1` scheme); no
   *   ephemeral keypair is generated.
   *
   * `"encrypted"`: an ephemeral X25519 keypair is generated for this
   *   call; the public key is embedded in the signed setup; the private
   *   key is held in this closure ONLY (never persisted, never returned)
   *   and used to decrypt the envelope body once it arrives.
   */
  deliveryPrivacy?: DeliveryPrivacy;

  /**
   * CoinbaseSmartWallet factory nonce used to derive the buyer's
   * `requesterAddress` from the EOA `signerAddress`. Default `0` (the
   * first wallet per owner).
   *
   * H4 fix (AIP-16 Phase 3 HIGH) — high-level surface. Buyers whose
   * Smart Wallet was deployed at a non-zero factory nonce MUST pass that
   * nonce here so the AIP-16 server-side derivation lands on the correct
   * address. Omitting it (or passing `0`) reproduces the legacy behavior
   * and yields byte-identical signing for the vast majority of callers
   * (auto-wallet deploys at nonce=0).
   *
   * Threaded into {@link DeliverySetupBuilder.build}. Negative or
   * non-integer values are rejected by the builder with
   * `BUILDER_INVALID_SMART_WALLET_NONCE` (surfaces as `setup_post_failed`
   * `deliveryError` here — settlement still proceeds).
   */
  smartWalletNonce?: number;
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

  /**
   * Structured non-fatal delivery error if any AIP-16 step failed.
   *
   * Set when:
   *  - the setup POST timed out or failed (`setup_post_failed`),
   *  - the envelope grace period elapsed with no envelope (`envelope_missing`),
   *  - envelope decryption / parsing failed (`envelope_decrypt_failed`).
   *
   * NEVER set when the delivery channel was not provided (AIP-16 was off).
   * Settlement is never blocked by these failures — the channel is a
   * convenience layer, not a fund-flow gate. Callers MAY surface this
   * error in CLI output to help users diagnose channel/relay issues.
   */
  deliveryError?: DeliveryError;
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
  const startedAt = monoMillisNow();
  const txId = await client.standard.createTransaction({
    provider: providerAddress,
    amount: opts.amount,
    deadline: deadlineUnix,
    disputeWindow: 172_800, // 2 days; kernel enforces ≥ 1h.
    serviceDescription: serviceHash, // PRD §5.6
  });
  opts.onTransition?.('INITIATED', txId, new Date());

  // ----------------------------------------------------------------------
  // 7a. AIP-16 Phase 2e — Delivery surface: setup POST + envelope subscribe
  // ----------------------------------------------------------------------
  //
  // Conditions for AIP-16 activation in this call:
  //   - caller passed `deliveryChannel`
  //   - caller passed `expectedKernelAddress`
  //   - caller passed `expectedChainId`
  //   - caller passed a `privateKey` (we need a Signer for the EIP-712
  //     setup signature — Smart Wallet mode is not yet wired here; if a
  //     caller lacks a raw signer, the delivery surface is skipped and
  //     legacy `tx.deliveryProof` decoding is the only payload path).
  //
  // Failure of either the setup POST OR the envelope subscription is
  // STRICTLY non-fatal: settlement always proceeds. Errors are captured
  // into `deliveryError` for caller visibility.
  const deliveryEnabled =
    !!opts.deliveryChannel &&
    !!opts.expectedKernelAddress &&
    typeof opts.expectedChainId === 'number' &&
    !!privateKey;

  // Closure-scoped delivery state. Buyer ephemeral private key is held
  // ONLY in this closure and is never logged, returned, or persisted.
  let deliveryError: DeliveryError | undefined;
  let envelopePayload: unknown = undefined;
  let envelopePayloadResolved = false;
  let envelopeSubscription: DeliverySubscription | undefined;
  let buyerEphemeralPrivKey: Uint8Array | undefined;
  let deliveryScheme: DeliveryPrivacy | undefined;
  const txIdHex = txId as `0x${string}`;

  if (deliveryEnabled) {
    const privacy: DeliveryPrivacy = opts.deliveryPrivacy ?? 'public';
    deliveryScheme = privacy;
    const channel = opts.deliveryChannel as DeliveryChannel;
    const kernelAddr = opts.expectedKernelAddress as `0x${string}`;
    const chainId = opts.expectedChainId as number;

    // Generate ephemeral keypair only for encrypted privacy. Public uses
    // CANONICAL_EMPTY_BYTES32 (EIP-712 has no "absent field" notion).
    let buyerEphemeralPubkey: `0x${string}` = CANONICAL_EMPTY_BYTES32;
    if (privacy === 'encrypted') {
      try {
        const kp = generateEphemeralKeyPair();
        buyerEphemeralPubkey = kp.publicKeyHex;
        buyerEphemeralPrivKey = kp.privateKey;
      } catch (err) {
        deliveryError = {
          code: 'crypto_keygen_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Proceed with setup only if keygen (if attempted) succeeded.
    if (!deliveryError) {
      try {
        const signer = new Wallet(privateKey as string);
        const signerAddress = getAddress(signer.address) as `0x${string}`;
        // `requesterAddress` here is the on-chain participant address. We
        // pass `client.info.address` so smart-wallet flows put the SW
        // address into the signed payload, while EOA flows put the EOA.
        const requesterOnChain = getAddress(client.info.address) as `0x${string}`;

        const builder = new DeliverySetupBuilder(signer);
        const { wire: setupWire } = await builder.build({
          txId: txIdHex,
          chainId,
          kernelAddress: kernelAddr,
          requesterAddress: requesterOnChain,
          signerAddress,
          buyerEphemeralPubkey,
          expectedPrivacy: privacy,
          // H4 (AIP-16 Phase 3): thread caller-supplied Smart Wallet
          // factory nonce. Defaults to 0 to preserve byte-identical
          // signing for the common nonce=0 case.
          smartWalletNonce: opts.smartWalletNonce ?? 0,
        });

        // Non-blocking POST: race against a 3s timeout. Timeout means we
        // proceed with state polling and let the envelope subscription
        // catch up if the setup eventually lands on the relay.
        const SETUP_POST_TIMEOUT_MS = 3_000;
        const postPromise = channel.publishSetup(setupWire);
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timeoutId = setTimeout(() => resolve('timeout'), SETUP_POST_TIMEOUT_MS);
        });
        try {
          const outcome = await Promise.race([
            postPromise.then(() => 'ok' as const),
            timeoutPromise,
          ]);
          if (outcome === 'timeout') {
            deliveryError = {
              code: 'setup_post_failed',
              message: `Delivery setup POST exceeded ${SETUP_POST_TIMEOUT_MS}ms; proceeding without setup.`,
              details: { txId },
            };
            logger.warn('Delivery setup POST timed out; proceeding', {
              txId,
              timeoutMs: SETUP_POST_TIMEOUT_MS,
            });
          }
        } catch (err) {
          deliveryError = {
            code: 'setup_post_failed',
            message: err instanceof Error ? err.message : String(err),
            details: { txId },
          };
          logger.warn('Delivery setup POST failed; proceeding', {
            txId,
            err: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      } catch (err) {
        // Builder-side failure (signer/address mismatch, canonical-empty
        // rule violation, etc.). Treat as setup_post_failed semantically:
        // the buyer's intent to use the delivery surface did not land.
        deliveryError = {
          code: 'setup_post_failed',
          message: err instanceof Error ? err.message : String(err),
          details: { txId, stage: 'build' },
        };
        logger.warn('Delivery setup build failed; proceeding', {
          txId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Envelope subscription: parallel to the state-polling loop. The
    // callback only stores the first envelope it sees; the channel's
    // dedup-after-verify discipline (and the `getEnvelopes` snapshot
    // poll in the grace period below) handle any race against pollForJobs
    // re-delivery on the provider side. We tolerate subscription errors
    // here: if the channel cannot subscribe, we fall through to the
    // legacy `tx.deliveryProof` payload path.
    try {
      envelopeSubscription = await channel.subscribeEnvelopes(
        txIdHex,
        (env: DeliveryEnvelopeWireV1) => {
          // Always keep the FIRST envelope seen — later ones are
          // either dupes (dedup) or out-of-order retries. Mutating
          // the holder is sync and side-effect-free wrt settlement.
          if (envelopePayloadResolved) return;
          envelopePayloadResolved = true;
          // Decode lazily: we only parse/decrypt once we know it's
          // the one we'll surface. Parse happens after DELIVERED so
          // we don't burn cycles for a tx that aborts mid-flight.
          // Stash the wire object onto the holder via a transient
          // closure variable shared with the post-DELIVERED block.
          envelopePayload = env; // wire, decoded later
        },
      );
    } catch (err) {
      // Non-fatal — settlement still proceeds.
      logger.warn('Delivery envelope subscription failed; proceeding', {
        txId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
  //
  // Precedence (DELIVERED → "what bytes does the buyer actually surface?"):
  //   1. AIP-16 envelope payload (when delivery surface was active and an
  //      envelope landed within the grace period). Preferred — it's the
  //      cryptographically-bound, scheme-aware payload.
  //   2. Legacy `tx.deliveryProof` parse. Backward-compat path; covers all
  //      pre-AIP-16 providers (including Sentinel pre-Phase 2f).
  const tx = await client.runtime.getTransaction(txId);
  let payload: unknown = undefined;

  if (deliveryEnabled) {
    // Bounded grace period after DELIVERED to let the channel deliver the
    // envelope. NEVER blocks settlement: even if the wait elapses with no
    // envelope, we proceed with the legacy payload (or none).
    const envelopeWaitMs = opts.envelopeWaitMs ?? 30_000;
    const ENVELOPE_POLL_MS = 250;
    const graceStart = monoMillisNow();
    // If the subscription already fired during state polling, this loop
    // exits immediately on the first iteration.
    while (!envelopePayloadResolved && monoMillisNow() - graceStart < envelopeWaitMs) {
      // Belt-and-suspenders: some channel implementations (mock + relay)
      // expose `getEnvelopes` so we can snapshot in case the subscription
      // missed a write that arrived between subscribe and now.
      if (opts.deliveryChannel?.getEnvelopes) {
        try {
          const snap = await opts.deliveryChannel.getEnvelopes(txIdHex);
          if (snap.length > 0 && !envelopePayloadResolved) {
            envelopePayloadResolved = true;
            envelopePayload = snap[0];
            break;
          }
        } catch {
          // Ignore — subscription path is still active.
        }
      }
      await sleep(ENVELOPE_POLL_MS);
    }

    // Decode the (wire) envelope into a payload, OR fall back.
    if (envelopePayloadResolved && envelopePayload) {
      const wire = envelopePayload as DeliveryEnvelopeWireV1;
      try {
        if (
          wire.signed?.scheme === 'x25519-aes256gcm-v1' &&
          buyerEphemeralPrivKey
        ) {
          payload = await DeliveryEnvelopeBuilder.decryptPayload(
            wire,
            buyerEphemeralPrivKey,
          );
        } else {
          // public-v1: body is hex-encoded UTF-8 JSON OR plaintext JSON
          // (depending on relay vs mock channel). Try parsing as JSON
          // directly first; if the body is hex-prefixed, decode then parse.
          const body = wire.body;
          if (typeof body === 'string' && body.startsWith('0x')) {
            const { bytesFromHex } = await import('../../delivery/crypto');
            const bytes = bytesFromHex(body);
            const decoder = new TextDecoder('utf-8', { fatal: true });
            payload = JSON.parse(decoder.decode(bytes));
          } else if (typeof body === 'string') {
            payload = JSON.parse(body);
          } else {
            payload = body;
          }
        }
      } catch (err) {
        // Decryption / parse failure is non-fatal — settlement still runs.
        deliveryError = {
          code: 'envelope_decrypt_failed',
          message: err instanceof Error ? err.message : String(err),
          details: { txId, scheme: deliveryScheme },
        };
        logger.warn('Delivery envelope decode failed; proceeding', {
          txId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (!deliveryError) {
      // Grace period elapsed with no envelope and no prior error. Mark
      // informational `envelope_missing` so the caller can surface a hint.
      deliveryError = {
        code: 'envelope_missing',
        message: `No envelope received within ${envelopeWaitMs}ms grace period`,
        details: { txId, waitedMs: envelopeWaitMs },
      };
    }
  }

  // Legacy fallback: only consult `tx.deliveryProof` when the AIP-16 path
  // did NOT produce a payload. This keeps Sentinel + pre-AIP-16 callers
  // on the same code path they had before.
  if (payload === undefined) {
    payload = tx?.deliveryProof ? safeParse(tx.deliveryProof) : undefined;
  }

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
        durationMs: monoMillisNow() - startedAt,
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

  // Close the envelope subscription before returning. Idempotent per the
  // DeliverySubscription contract; safe to call even if we never bound one.
  if (envelopeSubscription) {
    try {
      await envelopeSubscription.close();
    } catch (err) {
      // Subscription teardown failure is purely cosmetic — the subscriber
      // callback already won't fire (we have the payload or we don't).
      logger.warn('Delivery envelope subscription close failed', {
        txId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    txId,
    finalState,
    elapsedMs: monoMillisNow() - startedAt,
    payload,
    settled,
    receiptUrl,
    deliveryError,
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
    return secondsNow() + 3600;
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
  const start = monoMillisNow();
  while (monoMillisNow() - start < timeoutMs) {
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
  const start = monoMillisNow();
  while (monoMillisNow() - start < timeoutMs) {
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
