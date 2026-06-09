/**
 * AIP-16 Delivery Surface — Buyer Setup Builder + Verifier (Phase 2b)
 * =====================================================================
 *
 * Constructs and verifies the buyer-signed `DeliverySetupV1` payload —
 * the first artifact of the AIP-16 Rev 5 delivery surface. The buyer
 * (requester) posts this signed object to the delivery channel after
 * the on-chain transaction reaches `COMMITTED`, declaring:
 *
 *  - which kernel + chain the delivery is bound to,
 *  - which on-chain identity is acting as the requester,
 *  - which EOA produced the signature (smart-wallet two-step auth),
 *  - the buyer's ephemeral X25519 pubkey (or canonical-empty for `public`),
 *  - which channels the buyer accepts the envelope on,
 *  - the privacy posture the buyer expects,
 *  - and a creation timestamp + expiry for replay / staleness bounds.
 *
 * ## Builder shape
 *
 * Per the AIP-16 builder convention (and consistent with `QuoteBuilder`,
 * `CounterOfferBuilder`, etc.):
 *
 *  - `constructor(signer?, nonceManager?)` — both optional. A signer is
 *    REQUIRED for `build()`; `verify()` and `computeHash()` need
 *    neither, so verifying SDKs (relays, peer endpoints, dispute
 *    workers) can instantiate a no-arg builder.
 *
 *  - `build()` is `async` because EIP-712 signing is async on real
 *    wallets (`Wallet.signTypedData` returns a `Promise`).
 *
 *  - `verify()` and `computeHash()` are `static` — they take a wire
 *    object and need no builder state. This mirrors the existing
 *    `DeliveryProofBuilder` static-verify pattern.
 *
 * ## Smart-wallet two-step auth (DEC-10 / V2 receipts pattern)
 *
 * `requesterAddress` (the on-chain participant) and `signerAddress`
 * (the EOA that produced the signature) are accepted SEPARATELY and
 * are NOT derived from each other in this layer. When AutoWallet
 * (AIP-12 Tier 1) is active, `requesterAddress` is the Smart Wallet
 * contract and `signerAddress` is the controlling EOA; the SMART-WALLET
 * DERIVATION (`computeSmartWalletFromSigner(signerAddress) ===
 * requesterAddress`) is the SERVER'S responsibility, not the SDK's.
 * Doing it here would silently couple the SDK to the Coinbase Smart
 * Wallet factory ABI and break in cross-vendor flows.
 *
 * What the SDK DOES enforce in `build()` is the cheaper invariant:
 * `signerAddress` MUST equal the address of the supplied `signer`.
 * That catches the most common bug (caller passes the wrong
 * `signerAddress`) without making assumptions about the participant.
 *
 * ## Nonce manager use
 *
 * The signed `DeliverySetupV1` schema has NO `nonce` field — replay
 * binding is provided by `txId` (one tx per setup) and timestamps
 * (`createdAt` / `expiresAt`). The `NonceManager` is still touched
 * here so we have one place to hook future per-builder counters if
 * the spec evolves; we use {@link DELIVERY_NONCE_KEY_SETUP} (distinct
 * from the envelope key and the AIP-4 delivery-proof key) and the
 * returned counter is reported back to the caller via
 * {@link BuildSetupResult.nonceManagerKey} so the caller can audit
 * the path was reached. Because the value is not signed, we tolerate
 * a missing `NonceManager` gracefully — `build()` does NOT throw on
 * undefined `nonceManager`, it simply skips the counter bump.
 *
 * ## Verification order
 *
 * `verify()` is `static` and runs checks in a fixed coarse → fine
 * order, short-circuiting at the first failure with a stable
 * structured code. The order is chosen so that cheap, unambiguous
 * defects are reported BEFORE the more expensive signature recovery,
 * but also so that signature failures are reported before policy
 * failures (timestamp skew, expiry) — a forged signature is a more
 * severe class of error and we want the caller to see it first.
 *
 * @module delivery/setupBuilder
 * @see ./types — signed/wire interfaces and `BuildSetupResult`.
 * @see ./eip712 — domain, types, and `recoverSetupSigner`.
 * @see ./validate — `validateSetupWire` (structural validation).
 * @see ./nonce-keys — `DELIVERY_NONCE_KEY_SETUP`.
 */

import {
  ethers,
  keccak256,
  toUtf8Bytes,
  type Signer,
} from 'ethers';

import { canonicalJsonStringify } from '../utils/canonicalJson';
import type { NonceManager } from '../utils/NonceManager';

import {
  DELIVERY_SETUP_TYPES_V1,
  DeliveryEip712Error,
  buildDeliveryDomain,
  recoverSetupSigner,
} from './eip712';
import { DELIVERY_NONCE_KEY_SETUP } from './nonce-keys';
import {
  CANONICAL_EMPTY_BYTES32,
  type BuildSetupResult,
  type DeliveryPrivacy,
  type DeliverySetupSignedV1,
  type DeliverySetupWireV1,
} from './types';
import { validateSetupWire } from './validate';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default expiry, in seconds, applied when callers omit `expiresInSec`.
 *
 * 3600 (1 hour) matches the negotiation-layer default and is bounded
 * by the relay's accepted-setup TTL. Callers facing high-latency
 * counterparties may pass an explicit larger value, but the relay
 * SHOULD cap at its own policy ceiling.
 */
export const DEFAULT_SETUP_EXPIRY_SEC = 3600;

/**
 * Maximum tolerated clock-skew, in seconds, between the signed
 * `createdAt` and the verifier's wall clock. Symmetric (past + future).
 *
 * 900s (15 min) matches the receipts-V2 freshness window and the
 * AIP-3 anchor-receipt skew bound. Tighter would penalize NTP-skewed
 * client machines; looser would meaningfully extend the replay
 * window an attacker has to work with a leaked setup.
 */
export const SETUP_TIMESTAMP_SKEW_SEC = 900;

/**
 * Default v1 channel list applied when callers omit `acceptedChannels`.
 *
 * The v1 channel registry has exactly one entry; future channels MUST
 * be added by callers explicitly so that channel-selection is always
 * an intentional choice, not a hidden default.
 */
export const DEFAULT_ACCEPTED_CHANNELS: readonly string[] = [
  'agirails-relay-v1',
] as const;

// ============================================================================
// secondsNow — Injectable Clock
// ============================================================================
//
// All timestamp reads inside this module flow through `secondsNow()`.
// Tests inject a deterministic clock via {@link setSecondsNowForTests};
// production calls fall through to the real wall clock.
//
// We do NOT call `Date.now()` directly at any other point in this file
// for the same reason `QuoteBuilder` exists: deterministic builds need
// a single seam to control. The forbidden-token discipline in higher
// PRDs also depends on this seam — there should be ONE place where a
// real clock call lives, behind a name that surfaces in stack traces.
//

/**
 * Reads the real wall clock as Unix seconds (integer).
 *
 * Wrapped in a function (rather than inlined) so tests can replace
 * it via {@link setSecondsNowForTests} and so the forbidden-token
 * lint cares about exactly one site.
 */
let secondsNowImpl: () => number = (): number => {
  // Single allowed wall-clock site in this module. Math.floor produces
  // an integer; integer Unix seconds round-trip cleanly through the
  // EIP-712 `uint64` field.
  return Math.floor(Date.now() / 1000);
};

/**
 * Return the current wall-clock time in Unix seconds.
 *
 * Production: real `Date.now()` via {@link secondsNowImpl}.
 * Tests: injected via {@link setSecondsNowForTests}.
 *
 * @returns Integer seconds since the Unix epoch.
 */
function secondsNow(): number {
  return secondsNowImpl();
}

/**
 * Replace the wall-clock implementation used inside this module.
 *
 * **TEST-ONLY.** Production code MUST NOT call this. The function is
 * exported because Jest spies cannot intercept top-level `let`
 * assignments cleanly across ESM/CJS boundaries; an explicit setter
 * keeps the seam visible and grep-able.
 *
 * Pass `null` (or call {@link resetSecondsNowForTests}) to restore
 * the real wall-clock implementation.
 *
 * @param impl - Replacement function returning Unix seconds, or `null`
 *   to restore the default real-clock implementation.
 *
 * @example
 * ```typescript
 * setSecondsNowForTests(() => 1_750_000_000);
 * try {
 *   const { wire } = await new DeliverySetupBuilder(wallet).build(params);
 *   expect(wire.signed.createdAt).toBe(1_750_000_000);
 * } finally {
 *   resetSecondsNowForTests();
 * }
 * ```
 */
export function setSecondsNowForTests(impl: (() => number) | null): void {
  if (impl === null) {
    resetSecondsNowForTests();
    return;
  }
  secondsNowImpl = impl;
}

/**
 * Restore {@link secondsNow} to its default real-clock implementation.
 *
 * **TEST-ONLY.** Called from `afterEach` blocks; safe to call when no
 * override is active.
 */
export function resetSecondsNowForTests(): void {
  secondsNowImpl = (): number => Math.floor(Date.now() / 1000);
}

// ============================================================================
// Public Parameter Type
// ============================================================================

/**
 * Parameters accepted by {@link DeliverySetupBuilder.build}.
 *
 * Every field is explicit — no implicit derivation of one address
 * from another. In particular, `requesterAddress` and `signerAddress`
 * are passed SEPARATELY so the SDK is agnostic to which Smart Wallet
 * factory the caller is using (see DEC-10 / V2 receipts pattern).
 */
export interface BuildSetupParams {
  /**
   * On-chain transaction id this setup is bound to.
   * 32-byte hex-encoded value (`0x` + 64 hex chars).
   */
  txId: `0x${string}`;

  /**
   * EVM chain id (e.g. `8453` for Base mainnet, `84532` for Base Sepolia).
   * Encoded into BOTH the EIP-712 domain and the signed payload.
   */
  chainId: number;

  /**
   * Address of the ACTP kernel contract on `chainId`. Becomes the
   * EIP-712 `verifyingContract`.
   */
  kernelAddress: `0x${string}`;

  /**
   * On-chain identity acting as the requester. Smart-wallet flows pass
   * the Smart Wallet address here; non-smart-wallet flows pass the EOA.
   * The SDK does NOT derive this from `signer` — callers must supply it.
   */
  requesterAddress: `0x${string}`;

  /**
   * EOA address that will produce the signature. MUST equal
   * `await signer.getAddress()` — `build()` enforces this and throws
   * a {@link DeliveryEip712Error} on mismatch.
   */
  signerAddress: `0x${string}`;

  /**
   * Buyer-side ephemeral X25519 public key as 32-byte hex.
   *
   * For `expectedPrivacy: "encrypted"`: a freshly generated X25519
   * pubkey whose private key is held in memory by the requester
   * (forward secrecy w.r.t. requester long-term keys).
   *
   * For `expectedPrivacy: "public"`: MUST be {@link CANONICAL_EMPTY_BYTES32}.
   * `build()` enforces the canonical-empty rule on this field.
   */
  buyerEphemeralPubkey: `0x${string}`;

  /**
   * Ordered list of delivery channels the buyer is willing to accept
   * the envelope on. Defaults to {@link DEFAULT_ACCEPTED_CHANNELS}
   * (`["agirails-relay-v1"]`) when omitted.
   */
  acceptedChannels?: string[];

  /**
   * Privacy posture the buyer expects. The provider MUST select a
   * `DeliveryScheme` consistent with this value.
   */
  expectedPrivacy: DeliveryPrivacy;

  /**
   * Validity window for this setup, in seconds. Default
   * {@link DEFAULT_SETUP_EXPIRY_SEC} (3600 = 1 hour).
   * `expiresAt` is computed as `createdAt + expiresInSec`.
   */
  expiresInSec?: number;

  /**
   * Override the `createdAt` timestamp. Defaults to {@link secondsNow}.
   * Tests SHOULD pass an explicit value here for determinism rather
   * than relying on {@link setSecondsNowForTests}; the test-clock
   * setter is for callers that cannot reach into the params object
   * (e.g. higher-level helpers that wrap the builder).
   */
  createdAt?: number;

  /**
   * CoinbaseSmartWallet factory nonce used to derive `requesterAddress`
   * from `signerAddress`. Defaults to `0` (the first wallet per owner).
   *
   * H4 fix (AIP-16 Phase 3 HIGH): callers whose Smart Wallet was
   * deployed at a non-zero factory nonce MUST pass that nonce here so
   * the server's smart-wallet derivation lands on the correct address.
   * Omitting it (or passing `0`) reproduces the legacy behavior, which
   * is correct for the vast majority of callers (auto-wallet always
   * deploys at nonce=0).
   *
   * Must be a non-negative integer in the `uint256` range; `build()`
   * rejects negative or non-integer values with `BUILDER_INVALID_SMART_WALLET_NONCE`.
   */
  smartWalletNonce?: number;
}

// ============================================================================
// Setup Builder
// ============================================================================

/**
 * Builder + verifier for AIP-16 delivery setup messages.
 *
 * Instances are cheap to construct and have no I/O side effects.
 * `verify()` and `computeHash()` are static — call them without
 * constructing an instance.
 *
 * @example Buyer signing flow
 * ```typescript
 * const builder = new DeliverySetupBuilder(wallet, nonceManager);
 * const { wire } = await builder.build({
 *   txId,
 *   chainId: 84532,
 *   kernelAddress: KERNEL,
 *   requesterAddress: SMART_WALLET,
 *   signerAddress: EOA,
 *   buyerEphemeralPubkey: '0x' + 'aa'.repeat(32),
 *   expectedPrivacy: 'encrypted',
 * });
 * await postToRelay(wire);
 * ```
 *
 * @example Provider verification flow
 * ```typescript
 * const result = DeliverySetupBuilder.verify(wire, {
 *   expectedKernelAddress: KERNEL,
 *   expectedChainId: 84532,
 * });
 * if (!result.ok) {
 *   throw new Error(`Setup verification failed: ${result.code}`);
 * }
 * const setup = result.signed;
 * ```
 */
export class DeliverySetupBuilder {
  private readonly signer?: Signer;
  private readonly nonceManager?: NonceManager;

  /**
   * Construct a new builder.
   *
   * @param signer - EOA signer required for {@link build}. Pass `undefined`
   *   to construct a verify-only instance; `verify()` and `computeHash()`
   *   are static and do not need a builder instance at all, but a
   *   no-arg constructor is supported for symmetry with peer builders.
   * @param nonceManager - Optional nonce manager. The v1 setup schema
   *   has no `nonce` field, so this is purely an audit hook today;
   *   when supplied, `build()` calls `getNextNonce(DELIVERY_NONCE_KEY_SETUP)`
   *   to advance the counter. Missing manager is tolerated.
   */
  constructor(signer?: Signer, nonceManager?: NonceManager) {
    this.signer = signer;
    this.nonceManager = nonceManager;
  }

  // --------------------------------------------------------------------------
  // build
  // --------------------------------------------------------------------------

  /**
   * Construct, sign, and return a {@link DeliverySetupWireV1}.
   *
   * Pre-checks:
   *  - signer MUST be present (throws `BUILDER_NO_SIGNER` otherwise).
   *  - `signerAddress` MUST equal `await signer.getAddress()`
   *    (throws `BUILDER_SIGNER_ADDRESS_MISMATCH` otherwise).
   *  - For `expectedPrivacy: "public"`, `buyerEphemeralPubkey` MUST equal
   *    {@link CANONICAL_EMPTY_BYTES32}.
   *  - For `expectedPrivacy: "encrypted"`, `buyerEphemeralPubkey` MUST NOT
   *    be {@link CANONICAL_EMPTY_BYTES32} (a zero X25519 public key is
   *    rejected by RFC 7748 §6.1 anyway, but we surface a clearer error).
   *  - `expiresInSec` (when supplied) must be a positive integer.
   *
   * Signing:
   *  - Uses `signer.signTypedData(domain, types, signed)` with the
   *    canonical delivery EIP-712 domain anchored to `kernelAddress`.
   *
   * Nonce manager:
   *  - When supplied, `getNextNonce(DELIVERY_NONCE_KEY_SETUP)` is called
   *    purely for audit / future-compat. The returned counter is NOT
   *    encoded into the signed payload (the v1 schema has no nonce
   *    field) and the caller MAY ignore `nonceManagerKey` in the result.
   *
   * @param params - {@link BuildSetupParams}.
   * @returns A {@link BuildSetupResult} carrying the signed wire object
   *   and the nonce-manager key that was touched (always
   *   {@link DELIVERY_NONCE_KEY_SETUP} for v1).
   * @throws {DeliveryEip712Error} on signer absence, signer/address
   *   mismatch, or canonical-empty rule violation.
   */
  async build(params: BuildSetupParams): Promise<BuildSetupResult> {
    if (!this.signer) {
      throw new DeliveryEip712Error(
        'BUILDER_NO_SIGNER',
        'DeliverySetupBuilder.build requires a signer; construct the builder with a Signer to sign setups.',
      );
    }

    // ----- Privacy / pubkey consistency -----
    //
    // EIP-712 cannot represent "absent field" — we sign canonical-empty
    // for public privacy, and reject canonical-empty for encrypted
    // privacy. The wire-side `validateSchemeConsistency` runs on the
    // ENVELOPE; the setup side does its own check here in the builder
    // because the spec ties `buyerEphemeralPubkey` to `expectedPrivacy`.
    const pubkeyIsEmpty =
      params.buyerEphemeralPubkey.toLowerCase() === CANONICAL_EMPTY_BYTES32.toLowerCase();

    if (params.expectedPrivacy === 'public' && !pubkeyIsEmpty) {
      throw new DeliveryEip712Error(
        'BUILDER_PUBLIC_PUBKEY_NOT_CANONICAL_EMPTY',
        'expectedPrivacy="public" requires buyerEphemeralPubkey === CANONICAL_EMPTY_BYTES32 (32 zero bytes).',
        { expectedPrivacy: params.expectedPrivacy, buyerEphemeralPubkey: params.buyerEphemeralPubkey },
      );
    }

    if (params.expectedPrivacy === 'encrypted' && pubkeyIsEmpty) {
      throw new DeliveryEip712Error(
        'BUILDER_ENCRYPTED_PUBKEY_IS_CANONICAL_EMPTY',
        'expectedPrivacy="encrypted" requires a non-zero X25519 pubkey in buyerEphemeralPubkey (RFC 7748 §6.1).',
        { expectedPrivacy: params.expectedPrivacy },
      );
    }

    // ----- Expiry window -----
    const expiresInSec = params.expiresInSec ?? DEFAULT_SETUP_EXPIRY_SEC;
    if (!Number.isInteger(expiresInSec) || expiresInSec <= 0) {
      throw new DeliveryEip712Error(
        'BUILDER_INVALID_EXPIRES_IN',
        `expiresInSec must be a positive integer, got ${String(expiresInSec)}`,
        { expiresInSec },
      );
    }

    // ----- Smart-wallet nonce (H4 fix) -----
    //
    // Default to 0 to preserve backward-compat with pre-H4 callers; the
    // legacy hard-coded nonce-0 server derivation produces the same
    // on-wire byte pattern, so existing tests continue to pass.
    const smartWalletNonce = params.smartWalletNonce ?? 0;
    if (!Number.isInteger(smartWalletNonce) || smartWalletNonce < 0) {
      throw new DeliveryEip712Error(
        'BUILDER_INVALID_SMART_WALLET_NONCE',
        `smartWalletNonce must be a non-negative integer, got ${String(smartWalletNonce)}`,
        { smartWalletNonce },
      );
    }

    // ----- Timestamps -----
    const createdAt = params.createdAt ?? secondsNow();
    if (!Number.isInteger(createdAt) || createdAt <= 0) {
      throw new DeliveryEip712Error(
        'BUILDER_INVALID_CREATED_AT',
        `createdAt must be a positive integer, got ${String(createdAt)}`,
        { createdAt },
      );
    }
    const expiresAt = createdAt + expiresInSec;

    // ----- Signer-address binding -----
    //
    // We do NOT rely on the signer to produce the right `signerAddress`
    // for us — we cross-check it explicitly so a wrong-EOA bug is
    // caught at build time, not later at relay-side verification.
    const actualSigner = await this.signer.getAddress();
    if (actualSigner.toLowerCase() !== params.signerAddress.toLowerCase()) {
      throw new DeliveryEip712Error(
        'BUILDER_SIGNER_ADDRESS_MISMATCH',
        'params.signerAddress does not match signer.getAddress()',
        {
          expected: actualSigner.toLowerCase(),
          got: params.signerAddress.toLowerCase(),
        },
      );
    }

    // ----- Nonce-manager hook (audit / future-compat) -----
    //
    // The signed v1 schema has no nonce field. The call here exists so
    // a future v2 spec can plug a real counter in without churning the
    // builder surface. `getNextNonce` is sync and returns a number; we
    // intentionally discard the value (it's the manager's
    // `getCurrentNonce` for the same key, +1, and we don't record).
    if (this.nonceManager) {
      // Defensive: a misbehaving manager could throw at the upper bound;
      // we swallow nothing here, propagating as a builder error so the
      // caller sees the actual failure.
      this.nonceManager.getNextNonce(DELIVERY_NONCE_KEY_SETUP);
    }

    // ----- Build signed projection -----
    //
    // Field order in the OBJECT does NOT matter — EIP-712 hashes by
    // the type schema, not by JS key insertion order. We mirror the
    // schema order in the source for readability and to make it
    // easy to spot drift against `DELIVERY_SETUP_TYPES_V1`.
    const acceptedChannels = params.acceptedChannels ?? [...DEFAULT_ACCEPTED_CHANNELS];

    const signed: DeliverySetupSignedV1 = {
      version: 1,
      txId: params.txId,
      chainId: params.chainId,
      kernelAddress: params.kernelAddress,
      requesterAddress: params.requesterAddress,
      signerAddress: params.signerAddress,
      buyerEphemeralPubkey: params.buyerEphemeralPubkey,
      acceptedChannels,
      expectedPrivacy: params.expectedPrivacy,
      createdAt,
      expiresAt,
      smartWalletNonce,
    };

    // ----- Sign -----
    const domain = buildDeliveryDomain(params.chainId, params.kernelAddress);
    const requesterSig = (await this.signer.signTypedData(
      domain,
      DELIVERY_SETUP_TYPES_V1,
      signed,
    )) as `0x${string}`;

    const wire: DeliverySetupWireV1 = {
      signed,
      requesterSig,
    };

    return {
      wire,
      nonceManagerKey: DELIVERY_NONCE_KEY_SETUP,
    };
  }

  // --------------------------------------------------------------------------
  // verify (static)
  // --------------------------------------------------------------------------

  /**
   * Verify a {@link DeliverySetupWireV1} received from the relay.
   *
   * Check order (first failure short-circuits, with a stable code):
   *
   *  1. `validateSetupWire(wire)` — top-level shape + all field-level
   *     invariants (positive chainId, valid addresses, bytes32 shape on
   *     `buyerEphemeralPubkey`, non-empty acceptedChannels, valid
   *     `expectedPrivacy`, positive timestamps, `expiresAt > createdAt`,
   *     valid signature shape). On failure: code = `setup_signature_invalid`,
   *     error = the validator's identifier.
   *
   *  2. `signed.chainId === expectedChainId` — else `setup_chain_mismatch`.
   *
   *  3. `signed.kernelAddress` (lowercased) === `expectedKernelAddress`
   *     (lowercased) — else `setup_kernel_mismatch`. This is the
   *     allowlist anchor: callers MUST pass the kernel address they
   *     trust on the target chain; passing the payload's own kernel
   *     would defeat the allowlist (an attacker could sign under any
   *     kernel).
   *
   *  4. `recoverSetupSigner(signed, requesterSig, expectedKernelAddress)`
   *     (lowercased) === `signed.signerAddress` (lowercased). NOTE:
   *     recovery uses `expectedKernelAddress`, NOT `signed.kernelAddress`
   *     — at this point we've already enforced they match in step 3,
   *     but using the trusted value defends against future code
   *     refactors that might accidentally drop step 3. On failure:
   *     `setup_signature_invalid`.
   *
   *  5. Timestamp skew: `|now - createdAt| <= SETUP_TIMESTAMP_SKEW_SEC`
   *     — else `setup_timestamp_skew`. Symmetric to catch both
   *     past-replays and forward-dated forgeries.
   *
   *  6. Expiry: `expiresAt > now` — else `setup_expired`. Strict `>`
   *     (not `>=`) so a setup exactly at its expiry second is
   *     considered expired.
   *
   * Smart-wallet equality between `signerAddress` and `requesterAddress`
   * is intentionally NOT performed here — that's the verifier's
   * responsibility (server side, V2 receipts pattern, DEC-10).
   *
   * @param wire - The wire object received from the relay.
   * @param opts.expectedKernelAddress - Trusted kernel address for the
   *   target chain (from the verifier's allowlist).
   * @param opts.expectedChainId - Trusted chainId for the target chain.
   * @param opts.now - Override for the verifier's wall clock (Unix
   *   seconds). Tests use this to drive timestamp-skew and expiry paths
   *   deterministically; production callers SHOULD omit it.
   * @returns `{ ok: true, signed }` on success, `{ ok: false, code, error }`
   *   on failure.
   */
  static verify(
    wire: DeliverySetupWireV1,
    opts: {
      expectedKernelAddress: string;
      expectedChainId: number;
      now?: number;
    },
  ):
    | { ok: true; signed: DeliverySetupSignedV1 }
    | { ok: false; code: string; error: string } {
    // Step 1: structural / shape validation. Any failure here we report
    // under `setup_signature_invalid` since downstream signature
    // recovery would either crash or silently misbehave on malformed
    // input — the structured-code surface treats both as "the buyer's
    // setup is unusable" without leaking validator-internal labels.
    const shapeResult = validateSetupWire(wire);
    if (!shapeResult.ok) {
      return {
        ok: false,
        code: 'setup_signature_invalid',
        error: shapeResult.error,
      };
    }

    const signed = wire.signed;

    // Step 2: chainId match (trusted vs payload).
    if (signed.chainId !== opts.expectedChainId) {
      return {
        ok: false,
        code: 'setup_chain_mismatch',
        error: `expected chainId ${opts.expectedChainId}, got ${signed.chainId}`,
      };
    }

    // Step 3: kernel-address match (allowlist anchor).
    const expectedKernelLc = opts.expectedKernelAddress.toLowerCase();
    const payloadKernelLc = signed.kernelAddress.toLowerCase();
    if (payloadKernelLc !== expectedKernelLc) {
      return {
        ok: false,
        code: 'setup_kernel_mismatch',
        error: `expected kernel ${expectedKernelLc}, got ${payloadKernelLc}`,
      };
    }

    // Step 4: signature recovery. We pass the TRUSTED kernel address
    // (already proven to equal the payload's) so future refactors of
    // this function cannot accidentally let an attacker control the
    // recovery domain.
    let recovered: string;
    try {
      recovered = recoverSetupSigner(
        signed,
        wire.requesterSig,
        opts.expectedKernelAddress,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        code: 'setup_signature_invalid',
        error: msg,
      };
    }

    if (recovered.toLowerCase() !== signed.signerAddress.toLowerCase()) {
      return {
        ok: false,
        code: 'setup_signature_invalid',
        error: `recovered signer ${recovered.toLowerCase()} does not match signed.signerAddress ${signed.signerAddress.toLowerCase()}`,
      };
    }

    // Step 5: timestamp skew. Symmetric — both past and future.
    const now = opts.now ?? secondsNow();
    if (Math.abs(now - signed.createdAt) > SETUP_TIMESTAMP_SKEW_SEC) {
      return {
        ok: false,
        code: 'setup_timestamp_skew',
        error: `|now (${now}) - createdAt (${signed.createdAt})| > ${SETUP_TIMESTAMP_SKEW_SEC}s`,
      };
    }

    // Step 6: expiry. Strict greater-than — setup exactly at expiresAt
    // is considered expired.
    if (!(signed.expiresAt > now)) {
      return {
        ok: false,
        code: 'setup_expired',
        error: `expiresAt (${signed.expiresAt}) <= now (${now})`,
      };
    }

    return { ok: true, signed };
  }

  // --------------------------------------------------------------------------
  // computeHash (static)
  // --------------------------------------------------------------------------

  /**
   * Compute a stable, cross-SDK identifier for a setup wire object.
   *
   * The hash is `keccak256(utf8Bytes(canonicalJsonStringify(wire.signed)))`:
   *
   *  - canonical JSON (sorted keys, no whitespace) guarantees
   *    byte-for-byte identical input across SDK languages,
   *  - `keccak256` matches the on-chain hashing convention,
   *  - hashing the SIGNED projection (not the full wire) excludes the
   *    signature and any `serverMeta` so the hash is stable across
   *    relay-side decoration. The signature is recoverable from the
   *    signed bytes; including it in the hash would make the hash
   *    depend on signature malleability.
   *
   * This is not part of the EIP-712 signature path — it is purely a
   * content-addressing helper for logs, dedup sets, and cross-SDK
   * test fixtures. The EIP-712 hash (the one the wallet signs) is
   * computed by ethers internally and is NOT exposed here.
   *
   * @param wire - The wire object to hash.
   * @returns 32-byte hex-encoded keccak256 hash (`0x` + 64 hex chars).
   */
  static computeHash(wire: DeliverySetupWireV1): string {
    return keccak256(toUtf8Bytes(canonicalJsonStringify(wire.signed)));
  }
}

// ============================================================================
// Re-exports for caller ergonomics
// ============================================================================
//
// Tiny aliases so callers importing from this module directly don't
// need a second import line for the result type. The barrel
// (`./index.ts`) re-exports the same names — both paths are stable.
//

export type { BuildSetupResult } from './types';

// Re-affirm ethers import is used (suppresses the rare unused-symbol
// lint when the file is built with very aggressive tree-shaking
// rules; ethers stays imported above for the `Signer` type and as the
// canonical entry point even if no runtime symbol is consumed).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ethersUsed: typeof ethers = ethers;
