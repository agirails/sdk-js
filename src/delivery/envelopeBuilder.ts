/**
 * AIP-16 Delivery Surface — Provider Envelope Builder + Verifier + Decryptor (Phase 2b)
 * =======================================================================================
 *
 * Constructs and verifies the provider-signed `DeliveryEnvelopeV1` payload —
 * the load-bearing artifact of the AIP-16 Rev 5 delivery surface. The
 * provider posts this signed object to the delivery channel after the
 * buyer's setup is received (and after the on-chain transaction reaches
 * `COMMITTED`), carrying:
 *
 *  - the EIP-712 binding to a specific kernel, chain, and `txId`,
 *  - the on-chain identity acting as the provider, plus the EOA that
 *    signed (smart-wallet two-step auth),
 *  - the cryptographic scheme used to protect the body (`public-v1` or
 *    `x25519-aes256gcm-v1`),
 *  - the provider's ephemeral X25519 pubkey (encrypted scheme) or
 *    canonical-empty bytes32 (public scheme),
 *  - the AES-256-GCM nonce + tag (encrypted) or canonical-empty
 *    bytes12 / bytes16 (public),
 *  - `payloadHash = keccak256(bodyBytes)` — the on-chain anchor for the
 *    exact bytes the buyer will receive,
 *  - the body bytes themselves (alongside the signed projection, in the
 *    wire envelope).
 *
 * ## Body encoding (SCHEME-AWARE — FIX-1, AIP-16 Phase 3.5)
 *
 * The wire encoding is scheme-dependent so the SDK and the Platform
 * verifier (`Platform/agirails.app/web/lib/delivery/auth.ts`) hash the
 * SAME bytes in BOTH locations:
 *
 *  - `public-v1`: `wire.body = JSON.stringify(payload)` — plaintext
 *    UTF-8 JSON string, NOT hex. `payloadHash = keccak256(utf8Bytes(body))`.
 *    The Platform verifier computes `keccak256(toUtf8Bytes(body))`
 *    directly on the wire body. Hex-encoding the plaintext here would
 *    make the Platform recompute `keccak256(utf8Bytes("0x7b22…"))` —
 *    a different digest — and every public envelope would 400 with
 *    `payload_hash_mismatch`.
 *
 *  - `x25519-aes256gcm-v1`: `wire.body = "0x" + hex(aesGcmCiphertext)`.
 *    `payloadHash = keccak256(rawCiphertextBytes)`. The Platform
 *    verifier hex-decodes `wire.body` and then keccak256s the bytes.
 *    Ciphertext is a byte string that does NOT round-trip through UTF-8
 *    (it contains arbitrary 0..255 bytes incl. 0x00 and high bits),
 *    so hex is the only safe text encoding — base64 would also work but
 *    AIP-16 standardizes on hex for cross-language SDK consistency.
 *
 * Rationale for the asymmetry:
 *  1. **Public payloads are already text.** JSON serializes to valid
 *     UTF-8 — no encoding wrapper needed. The plaintext IS the wire.
 *  2. **Ciphertext is binary.** Cannot travel naked in JSON; hex is the
 *     chosen text encoding (matches `nonce`, `tag`, `payloadHash`,
 *     `providerEphemeralPubkey`).
 *  3. **Spec match.** AIP-16 §6.2 sign-side and the Platform verify-
 *     side both implement this exact rule.
 *
 * ## Builder shape (matches DeliverySetupBuilder)
 *
 *  - `constructor(signer?)` — signer required for `build*()`, optional
 *    for `verify()` / `computeHash()` / `decryptPayload()`. The static
 *    helpers do not consult builder state.
 *  - `buildPublic(params)` / `buildEncrypted(params)` are `async`
 *    because EIP-712 signing on real wallets is async.
 *  - `verify`, `decryptPayload`, `verifyAndDecrypt`, `computeHash` are
 *    `static` — mirrors {@link DeliverySetupBuilder} and the existing
 *    delivery-proof / quote builders.
 *
 * ## Smart-wallet two-step auth (DEC-10 / V2 receipts)
 *
 * `providerAddress` (on-chain participant — possibly a Smart Wallet)
 * and `signerAddress` (the EOA that actually signed) are accepted
 * SEPARATELY. The SDK does NOT derive one from the other; the smart-
 * wallet equality check
 *   computeSmartWalletFromSigner(signerAddress) === providerAddress
 * is the SERVER'S responsibility (cross-vendor factory ABI agnostic).
 *
 * What the SDK enforces in `build*()` is the cheaper invariant:
 *   `signerAddress === await signer.getAddress()`.
 *
 * ## payloadHash defends against body-after-sign tamper
 *
 * Because `payloadHash = keccak256(bodyBytes)` is part of the SIGNED
 * EIP-712 projection, any post-signature mutation of `wire.body`
 * causes `bodyHash(wire.body)` to diverge from `signed.payloadHash`.
 * The verifier short-circuits with `envelope_payload_hash_mismatch`
 * before signature recovery, so a malicious relay cannot swap bodies
 * even within an otherwise valid signed envelope.
 *
 * ## Verification order (first failure short-circuits)
 *
 *   1. `validateEnvelopeWire(wire)` — structural shape, types, lengths,
 *      and scheme/canonical-empty consistency in one pass.
 *   2. `validateSchemeConsistency(signed)` — defense-in-depth re-check
 *      (already covered by step 1 but called explicitly so future
 *      refactors of the validator do not silently weaken the contract).
 *   3. `signed.chainId === expectedChainId` → `envelope_chain_mismatch`.
 *   4. `signed.kernelAddress` (lc) === `expectedKernelAddress` (lc)
 *      → `envelope_kernel_mismatch`.
 *   5. `bodyHash(wire.body) === signed.payloadHash`
 *      → `envelope_payload_hash_mismatch`.
 *   6. `recoverEnvelopeSigner(signed, providerSig, expectedKernel)`
 *      (lc) === `signed.signerAddress` (lc)
 *      → `envelope_signature_invalid`.
 *   7. `|now - signed.createdAt| <= ENVELOPE_TIMESTAMP_SKEW_SEC`
 *      → `envelope_timestamp_skew`.
 *
 * Note that timestamp skew is checked LAST — a forged signature is a
 * more severe error than a stale-but-genuine envelope and we want the
 * caller to see the more severe failure first.
 *
 * @module delivery/envelopeBuilder
 * @see ./types — signed/wire interfaces and {@link BuildEnvelopeResult}.
 * @see ./eip712 — domain, types, and {@link recoverEnvelopeSigner}.
 * @see ./validate — {@link validateEnvelopeWire},
 *      {@link validateSchemeConsistency}.
 * @see ./keys — X25519 keygen + ECDH + HKDF.
 * @see ./crypto — AES-256-GCM seal/open + {@link bodyHash}.
 * @see ./setupBuilder — sibling builder; same shape conventions.
 */

import {
  ethers,
  keccak256,
  toUtf8Bytes,
  type Signer,
} from 'ethers';

import { canonicalJsonStringify } from '../utils/canonicalJson';

import {
  bodyHash,
  bytesFromHex,
  bytesToHex,
  decryptBody,
  encryptBody,
} from './crypto';
import {
  DELIVERY_ENVELOPE_TYPES_V1,
  DeliveryEip712Error,
  buildDeliveryDomain,
  recoverEnvelopeSigner,
} from './eip712';
import {
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  pubkeyFromHex,
  pubkeyToHex,
  type EphemeralKeyPair,
} from './keys';
import {
  CANONICAL_EMPTY_BYTES12,
  CANONICAL_EMPTY_BYTES16,
  CANONICAL_EMPTY_BYTES32,
  type BuildEnvelopeResult,
  type DeliveryEnvelopeSignedV1,
  type DeliveryEnvelopeWireV1,
} from './types';
import { validateEnvelopeWire, validateSchemeConsistency } from './validate';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum tolerated clock-skew, in seconds, between the signed
 * `createdAt` and the verifier's wall clock. Symmetric (past + future).
 *
 * 900s (15 min) matches {@link DeliverySetupBuilder}'s
 * `SETUP_TIMESTAMP_SKEW_SEC`, the receipts-V2 freshness window, and
 * the AIP-3 anchor-receipt skew bound.
 */
export const ENVELOPE_TIMESTAMP_SKEW_SEC = 900;

/**
 * Length (in bytes) of the AES-256-GCM AAD used by the encrypted
 * scheme — `txId_bytes (32) || signerAddress_bytes (20) = 52`.
 *
 * H5 binding: GCM authenticates the AAD; a misrouted envelope (correct
 * ciphertext + nonce + tag + sessionKey, but delivered as if for a
 * different `txId` or `signerAddress`) fails the tag check on decrypt.
 * The hash-input `payloadHash` in the EIP-712 signature already binds
 * the body to a specific `txId` at the signature layer; this AAD adds
 * the same binding INSIDE the GCM authentication, defense-in-depth.
 *
 * Bytes layout (network byte order, no padding):
 *  - [0..32):  `txId` raw 32 bytes (from the 0x + 64 hex chars).
 *  - [32..52): `signerAddress` raw 20 bytes (from the 0x + 40 hex chars).
 */
export const ENVELOPE_AAD_LENGTH = 52 as const;

/**
 * Construct the AES-256-GCM AAD for the `x25519-aes256gcm-v1` scheme.
 *
 * Format: `txId (32 bytes) || signerAddress (20 bytes) = 52 bytes`.
 *
 * Both the build side (in {@link DeliveryEnvelopeBuilder.buildEncrypted})
 * and the decrypt side (in {@link DeliveryEnvelopeBuilder.decryptPayload})
 * call this helper with the SAME txId/signerAddress so the GCM tag
 * commits to identical AAD bytes. Address case is normalized via
 * `bytesFromHex` (which is case-insensitive on the hex characters), so
 * checksum vs lowercase inputs round-trip to the same 20 raw bytes.
 *
 * @param txId - On-chain transaction id, `0x` + 64 hex chars.
 * @param signerAddress - EOA address, `0x` + 40 hex chars.
 * @returns 52-byte AAD buffer (`txId_bytes || signerAddress_bytes`).
 * @throws {DeliveryCryptoError} `crypto_decrypt_failed` if either
 *   parameter has the wrong byte length (decoded via `bytesFromHex`
 *   from `./crypto`); the underlying helper raises this code.
 *
 * @internal Used by the envelope builder; exposed for cross-SDK
 * fixtures and the H5 test suite.
 */
export function buildEnvelopeAad(
  txId: `0x${string}`,
  signerAddress: `0x${string}`,
): Uint8Array {
  const txIdBytes = bytesFromHex(txId);
  if (txIdBytes.length !== 32) {
    throw new DeliveryEip712Error(
      'BUILDER_AAD_TXID_INVALID_LENGTH',
      `txId must decode to 32 bytes, got ${txIdBytes.length}`,
      { actualLength: txIdBytes.length },
    );
  }
  const signerBytes = bytesFromHex(signerAddress);
  if (signerBytes.length !== 20) {
    throw new DeliveryEip712Error(
      'BUILDER_AAD_SIGNER_INVALID_LENGTH',
      `signerAddress must decode to 20 bytes, got ${signerBytes.length}`,
      { actualLength: signerBytes.length },
    );
  }
  const aad = new Uint8Array(ENVELOPE_AAD_LENGTH);
  aad.set(txIdBytes, 0);
  aad.set(signerBytes, 32);
  return aad;
}

// ============================================================================
// secondsNow — Injectable Clock
// ============================================================================
//
// Every timestamp read inside this module flows through `secondsNow()`.
// Tests inject deterministic clocks via {@link setSecondsNowForTests};
// production calls fall through to the real wall clock.
//
// This is the ONLY allowed wall-clock site in this file — the same
// single-seam discipline used by `setupBuilder.ts` and the other
// builders. Forbidden-token lint depends on this.
//

let secondsNowImpl: () => number = (): number => {
  // Single allowed wall-clock site in this module. `Math.floor` produces
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
 * **TEST-ONLY.** Production code MUST NOT call this. Pass `null` (or
 * call {@link resetSecondsNowForTests}) to restore the real-clock
 * implementation.
 *
 * @param impl - Replacement function returning Unix seconds, or `null`
 *   to restore the default real-clock implementation.
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
 * **TEST-ONLY.** Safe to call when no override is active.
 */
export function resetSecondsNowForTests(): void {
  secondsNowImpl = (): number => Math.floor(Date.now() / 1000);
}

// ============================================================================
// Public Parameter Types
// ============================================================================

/**
 * Parameters accepted by {@link DeliveryEnvelopeBuilder.buildPublic}.
 *
 * Every address is passed explicitly — no implicit derivation of one
 * address from another. `providerAddress` and `signerAddress` are
 * separate so the SDK is agnostic to which Smart Wallet factory the
 * caller is using.
 */
export interface BuildPublicEnvelopeParams {
  /**
   * On-chain transaction id this envelope is bound to.
   * 32-byte hex (`0x` + 64 hex chars). MUST equal the corresponding
   * setup's `txId`.
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
   * On-chain identity acting as the provider. Smart-wallet flows pass
   * the Smart Wallet address here; non-smart-wallet flows pass the EOA.
   * The SDK does NOT derive this from `signer`.
   */
  providerAddress: `0x${string}`;

  /**
   * EOA address that will produce the signature. MUST equal
   * `await signer.getAddress()` — `buildPublic()` enforces this and
   * throws on mismatch.
   */
  signerAddress: `0x${string}`;

  /**
   * The actual deliverable payload. Any JSON-serializable value.
   * `buildPublic` will `JSON.stringify(payload)` and treat the UTF-8
   * bytes of the resulting string as the body bytes.
   */
  payload: unknown;

  /**
   * Override the `createdAt` timestamp. Defaults to {@link secondsNow}.
   * Tests SHOULD pass an explicit value here for determinism rather
   * than relying on {@link setSecondsNowForTests}.
   */
  createdAt?: number;

  /**
   * CoinbaseSmartWallet factory nonce used to derive `providerAddress`
   * from `signerAddress`. Defaults to `0` (the first wallet per owner).
   *
   * H4 fix (AIP-16 Phase 3 HIGH): providers whose Smart Wallet was
   * deployed at a non-zero factory nonce MUST pass that nonce here so
   * the server's smart-wallet derivation lands on the correct address.
   *
   * Must be a non-negative integer; `buildPublic()` rejects negatives
   * with `BUILDER_INVALID_SMART_WALLET_NONCE`.
   */
  smartWalletNonce?: number;
}

/**
 * Parameters accepted by {@link DeliveryEnvelopeBuilder.buildEncrypted}.
 *
 * Extends {@link BuildPublicEnvelopeParams} with the buyer's ephemeral
 * pubkey (from the corresponding setup) and an optional override for
 * the provider's own ephemeral keypair (tests use this for determinism;
 * production callers SHOULD omit it).
 */
export interface BuildEncryptedEnvelopeParams {
  /** See {@link BuildPublicEnvelopeParams.txId}. */
  txId: `0x${string}`;

  /** See {@link BuildPublicEnvelopeParams.chainId}. */
  chainId: number;

  /** See {@link BuildPublicEnvelopeParams.kernelAddress}. */
  kernelAddress: `0x${string}`;

  /** See {@link BuildPublicEnvelopeParams.providerAddress}. */
  providerAddress: `0x${string}`;

  /** See {@link BuildPublicEnvelopeParams.signerAddress}. */
  signerAddress: `0x${string}`;

  /**
   * The actual deliverable payload. Any JSON-serializable value.
   * `buildEncrypted` will `JSON.stringify(payload)`, UTF-8 encode, then
   * AES-256-GCM seal under the X25519+HKDF-derived session key.
   */
  payload: unknown;

  /**
   * The buyer's ephemeral X25519 public key (32 bytes, hex), copied
   * from the corresponding `DeliverySetupSignedV1.buyerEphemeralPubkey`.
   * `buildEncrypted` runs ECDH with this and the provider's own
   * ephemeral private key to derive the shared secret.
   *
   * MUST NOT be {@link CANONICAL_EMPTY_BYTES32} — the canonical-empty
   * value is reserved for the public scheme.
   */
  buyerEphemeralPubkey: `0x${string}`;

  /**
   * Override for the provider's ephemeral X25519 keypair. When omitted
   * (the production path), a fresh keypair is generated via
   * {@link generateEphemeralKeyPair}.
   *
   * **TEST-ONLY in practice.** Production callers SHOULD let the
   * builder generate the keypair so the private key never crosses a
   * call boundary; passing one in increases the risk of accidental
   * persistence.
   */
  providerEphemeralKeyPair?: EphemeralKeyPair;

  /**
   * Override the `createdAt` timestamp. Defaults to {@link secondsNow}.
   */
  createdAt?: number;

  /**
   * CoinbaseSmartWallet factory nonce used to derive `providerAddress`
   * from `signerAddress`. Defaults to `0` (the first wallet per owner).
   *
   * H4 fix (AIP-16 Phase 3 HIGH): symmetric to
   * {@link BuildPublicEnvelopeParams.smartWalletNonce}. Allows providers
   * with non-zero-nonce Smart Wallets to authenticate.
   */
  smartWalletNonce?: number;
}

// ============================================================================
// Envelope Builder
// ============================================================================

/**
 * Builder + verifier + decryptor for AIP-16 delivery envelopes.
 *
 * Instances are cheap to construct and have no I/O side effects.
 * `verify()`, `decryptPayload()`, `verifyAndDecrypt()`, and
 * `computeHash()` are static — call them without constructing an
 * instance.
 *
 * @example Provider build (public)
 * ```typescript
 * const builder = new DeliveryEnvelopeBuilder(wallet);
 * const { wire } = await builder.buildPublic({
 *   txId, chainId: 84532, kernelAddress: KERNEL,
 *   providerAddress: SMART_WALLET, signerAddress: EOA,
 *   payload: { result: 'ok' },
 * });
 * await postToRelay(wire);
 * ```
 *
 * @example Provider build (encrypted)
 * ```typescript
 * const { wire, blobKey } = await builder.buildEncrypted({
 *   txId, chainId: 84532, kernelAddress: KERNEL,
 *   providerAddress: SMART_WALLET, signerAddress: EOA,
 *   payload: { secret: 'data' },
 *   buyerEphemeralPubkey: setupSigned.buyerEphemeralPubkey,
 * });
 * ```
 *
 * @example Buyer decrypt
 * ```typescript
 * const result = await DeliveryEnvelopeBuilder.verifyAndDecrypt(
 *   wire,
 *   buyerEphemeralPrivKey,
 *   { expectedKernelAddress: KERNEL, expectedChainId: 84532 },
 * );
 * if (!result.ok) throw new Error(result.code);
 * const payload = result.payload;
 * ```
 */
export class DeliveryEnvelopeBuilder {
  private readonly signer?: Signer;

  /**
   * Construct a new builder.
   *
   * @param signer - EOA signer required for {@link buildPublic} and
   *   {@link buildEncrypted}. Pass `undefined` for a verify-/decrypt-only
   *   instance; all verification / decryption helpers are static and
   *   do not consult builder state.
   */
  constructor(signer?: Signer) {
    this.signer = signer;
  }

  // --------------------------------------------------------------------------
  // buildPublic
  // --------------------------------------------------------------------------

  /**
   * Construct, sign, and return a {@link DeliveryEnvelopeWireV1} using
   * the `public-v1` scheme.
   *
   * Encoding (FIX-1, AIP-16 Phase 3.5):
   *  - `bodyString = JSON.stringify(params.payload)`.
   *  - `wire.body = bodyString` (plaintext UTF-8 JSON, NOT hex).
   *  - `payloadHash = keccak256(utf8Bytes(bodyString))`.
   *  - The Platform verifier recomputes `keccak256(toUtf8Bytes(body))`
   *    on the wire body directly, so the SDK and verifier hash the
   *    same bytes byte-for-byte.
   *
   * Canonical-empty enforcement:
   *  - `providerEphemeralPubkey = CANONICAL_EMPTY_BYTES32`.
   *  - `nonce = CANONICAL_EMPTY_BYTES12`.
   *  - `tag = CANONICAL_EMPTY_BYTES16`.
   *
   * Pre-checks:
   *  - signer MUST be present.
   *  - `signerAddress` MUST equal `await signer.getAddress()`.
   *
   * @param params - {@link BuildPublicEnvelopeParams}.
   * @returns A {@link BuildEnvelopeResult} carrying the signed wire
   *   envelope and the raw plaintext bytes (`bodyBytes`) that the
   *   `payloadHash` was computed over. `blobKey` is `undefined` for
   *   the public scheme.
   * @throws {DeliveryEip712Error} on signer absence or signer/address
   *   mismatch.
   */
  async buildPublic(
    params: BuildPublicEnvelopeParams,
  ): Promise<BuildEnvelopeResult> {
    if (!this.signer) {
      throw new DeliveryEip712Error(
        'BUILDER_NO_SIGNER',
        'DeliveryEnvelopeBuilder.buildPublic requires a signer; construct the builder with a Signer to sign envelopes.',
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

    // ----- Signer-address binding -----
    //
    // Caught at build time so a wrong-EOA bug surfaces here rather than
    // later at relay-side verification (where the error would be much
    // harder to diagnose).
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

    // ----- Smart-wallet nonce (H4 fix) -----
    const smartWalletNonce = params.smartWalletNonce ?? 0;
    if (!Number.isInteger(smartWalletNonce) || smartWalletNonce < 0) {
      throw new DeliveryEip712Error(
        'BUILDER_INVALID_SMART_WALLET_NONCE',
        `smartWalletNonce must be a non-negative integer, got ${String(smartWalletNonce)}`,
        { smartWalletNonce },
      );
    }

    // ----- Encode body -----
    //
    // JSON.stringify is the canonical serializer for the public scheme;
    // we do NOT use canonicalJsonStringify here because the body is a
    // user payload (any JSON value), and the BUYER needs to recover the
    // exact object the provider wrote — sorting keys post-hoc would
    // silently mutate the structure.
    //
    // FIX-1 (AIP-16 Phase 3.5 HIGH): wire.body for public-v1 is the
    // plaintext UTF-8 JSON STRING — NOT hex. Hashing path is
    // `keccak256(utf8Bytes(bodyString))`, which `bodyHash(string)`
    // produces by routing through `toBytes(string, 'body')`. The
    // Platform verifier at `lib/delivery/auth.ts` for `public-v1`
    // computes `keccak256(toUtf8Bytes(body))` — wire-compatible iff
    // `wire.body` is the plaintext string. (Encrypted scheme below
    // remains hex; the encrypted recompute hex-decodes first.)
    const bodyString = JSON.stringify(params.payload);
    const plaintextBytes = new Uint8Array(Buffer.from(bodyString, 'utf8'));
    const wireBody = bodyString; // plaintext UTF-8 JSON, NOT hex
    const payloadHash = bodyHash(bodyString); // bodyHash(string) → utf8 bytes

    // ----- Build signed projection -----
    //
    // Field order in the OBJECT does not matter — EIP-712 hashes by the
    // type schema. We mirror the schema order in the source for
    // readability and to make drift against
    // `DELIVERY_ENVELOPE_TYPES_V1` easy to spot.
    const signed: DeliveryEnvelopeSignedV1 = {
      version: 1,
      txId: params.txId,
      chainId: params.chainId,
      kernelAddress: params.kernelAddress,
      providerAddress: params.providerAddress,
      signerAddress: params.signerAddress,
      scheme: 'public-v1',
      providerEphemeralPubkey: CANONICAL_EMPTY_BYTES32,
      nonce: CANONICAL_EMPTY_BYTES12,
      payloadHash,
      tag: CANONICAL_EMPTY_BYTES16,
      createdAt,
      smartWalletNonce,
    };

    // ----- Sign -----
    const domain = buildDeliveryDomain(params.chainId, params.kernelAddress);
    const providerSig = (await this.signer.signTypedData(
      domain,
      DELIVERY_ENVELOPE_TYPES_V1,
      signed,
    )) as `0x${string}`;

    const wire: DeliveryEnvelopeWireV1 = {
      signed,
      body: wireBody,
      providerSig,
    };

    return {
      wire,
      bodyBytes: plaintextBytes,
      // blobKey intentionally omitted for public scheme.
    };
  }

  // --------------------------------------------------------------------------
  // buildEncrypted
  // --------------------------------------------------------------------------

  /**
   * Construct, sign, and return a {@link DeliveryEnvelopeWireV1} using
   * the `x25519-aes256gcm-v1` scheme.
   *
   * Crypto flow:
   *  1. Generate (or accept) a provider ephemeral X25519 keypair.
   *  2. `shared = X25519(providerPriv, buyerPub)`.
   *  3. `sessionKey = HKDF-SHA256(ikm=shared, salt=txId, info="agirails-delivery-v1", L=32)`.
   *  4. `plaintextBytes = utf8Bytes(JSON.stringify(payload))`.
   *  5. `{ciphertext, nonce, tag} = AES-256-GCM(plaintextBytes, sessionKey)`.
   *  6. `wire.body = bytesToHex(ciphertext)`.
   *  7. `payloadHash = keccak256(ciphertext)`.
   *  8. Sign the EIP-712 projection containing `scheme = "x25519-aes256gcm-v1"`,
   *     the provider's ephemeral pubkey, the AES-GCM nonce + tag, and
   *     `payloadHash`.
   *
   * The provider's ephemeral PRIVATE key is dropped after step 5;
   * forward secrecy w.r.t. provider long-term keys is provided by the
   * fresh keypair per delivery.
   *
   * Pre-checks:
   *  - signer MUST be present.
   *  - `signerAddress` MUST equal `await signer.getAddress()`.
   *  - `buyerEphemeralPubkey` MUST NOT be {@link CANONICAL_EMPTY_BYTES32}.
   *
   * @param params - {@link BuildEncryptedEnvelopeParams}.
   * @returns A {@link BuildEnvelopeResult} carrying the signed wire
   *   envelope, the ciphertext bytes (`bodyBytes`) the `payloadHash`
   *   was computed over, and the symmetric session `blobKey` (for
   *   provider-side observability / future reference-mode flows; the
   *   buyer derives the key independently).
   * @throws {DeliveryEip712Error} on signer absence, signer/address
   *   mismatch, or canonical-empty buyer pubkey.
   */
  async buildEncrypted(
    params: BuildEncryptedEnvelopeParams,
  ): Promise<BuildEnvelopeResult> {
    if (!this.signer) {
      throw new DeliveryEip712Error(
        'BUILDER_NO_SIGNER',
        'DeliveryEnvelopeBuilder.buildEncrypted requires a signer; construct the builder with a Signer to sign envelopes.',
      );
    }

    // ----- Buyer pubkey canonical-empty rejection -----
    if (
      params.buyerEphemeralPubkey.toLowerCase() ===
      CANONICAL_EMPTY_BYTES32.toLowerCase()
    ) {
      throw new DeliveryEip712Error(
        'BUILDER_ENCRYPTED_BUYER_PUBKEY_IS_CANONICAL_EMPTY',
        'x25519-aes256gcm-v1 requires a non-zero X25519 buyer pubkey (RFC 7748 §6.1).',
        { buyerEphemeralPubkey: params.buyerEphemeralPubkey },
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

    // ----- Signer-address binding -----
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

    // ----- Ephemeral keypair (generate or accept) -----
    //
    // Production callers omit `providerEphemeralKeyPair` so the private
    // key never crosses a call boundary. Tests pass an explicit pair
    // for determinism / known-answer-test vectors.
    const providerKp =
      params.providerEphemeralKeyPair ?? generateEphemeralKeyPair();

    // ----- ECDH + HKDF -----
    const peerPubkey = pubkeyFromHex(params.buyerEphemeralPubkey);
    const shared = deriveSharedSecret(providerKp.privateKey, peerPubkey);
    const sessionKey = deriveSessionKey(shared, params.txId);

    // ----- Encrypt (with H5 AAD binding) -----
    //
    // AAD = txId_bytes (32) || signerAddress_bytes (20) = 52 bytes.
    // Bound INSIDE the GCM authentication tag — a misrouted envelope
    // delivered as if for a different txId or signerAddress cannot be
    // opened even if the attacker possesses the ciphertext + nonce +
    // tag + session key. Defense-in-depth on top of the EIP-712
    // signature binding via `payloadHash` and `txId`.
    const aad = buildEnvelopeAad(params.txId, params.signerAddress);
    const bodyString = JSON.stringify(params.payload);
    const plaintextBytes = new Uint8Array(Buffer.from(bodyString, 'utf8'));
    const { ciphertext, nonce, tag } = encryptBody(plaintextBytes, sessionKey, aad);

    // ----- Wire body + payloadHash -----
    //
    // `payloadHash` is computed over the CIPHERTEXT bytes (not the
    // plaintext) so the signature commits to exactly what travels on
    // the wire. See AIP-16 §6.2 and `bodyHash` JSDoc.
    const wireBodyHex = bytesToHex(ciphertext);
    const payloadHash = bodyHash(ciphertext);

    // ----- Smart-wallet nonce (H4 fix) -----
    const smartWalletNonce = params.smartWalletNonce ?? 0;
    if (!Number.isInteger(smartWalletNonce) || smartWalletNonce < 0) {
      throw new DeliveryEip712Error(
        'BUILDER_INVALID_SMART_WALLET_NONCE',
        `smartWalletNonce must be a non-negative integer, got ${String(smartWalletNonce)}`,
        { smartWalletNonce },
      );
    }

    // ----- Build signed projection -----
    const signed: DeliveryEnvelopeSignedV1 = {
      version: 1,
      txId: params.txId,
      chainId: params.chainId,
      kernelAddress: params.kernelAddress,
      providerAddress: params.providerAddress,
      signerAddress: params.signerAddress,
      scheme: 'x25519-aes256gcm-v1',
      providerEphemeralPubkey: pubkeyToHex(providerKp.publicKey),
      nonce: bytesToHex(nonce),
      payloadHash,
      tag: bytesToHex(tag),
      createdAt,
      smartWalletNonce,
    };

    // ----- Sign -----
    const domain = buildDeliveryDomain(params.chainId, params.kernelAddress);
    const providerSig = (await this.signer.signTypedData(
      domain,
      DELIVERY_ENVELOPE_TYPES_V1,
      signed,
    )) as `0x${string}`;

    const wire: DeliveryEnvelopeWireV1 = {
      signed,
      body: wireBodyHex,
      providerSig,
    };

    return {
      wire,
      bodyBytes: ciphertext,
      blobKey: sessionKey,
    };
  }

  // --------------------------------------------------------------------------
  // verify (static)
  // --------------------------------------------------------------------------

  /**
   * Verify a {@link DeliveryEnvelopeWireV1} received from the relay.
   *
   * See the module-level header for the full check ordering and rationale.
   *
   * @param wire - The wire envelope received from the relay.
   * @param opts.expectedKernelAddress - Trusted kernel address for the
   *   target chain (from the verifier's allowlist).
   * @param opts.expectedChainId - Trusted chainId for the target chain.
   * @param opts.now - Override for the verifier's wall clock (Unix
   *   seconds). Tests use this for deterministic timestamp-skew paths;
   *   production callers SHOULD omit.
   * @returns `{ ok: true, signed }` on success, `{ ok: false, code, error }`
   *   on failure.
   */
  static verify(
    wire: DeliveryEnvelopeWireV1,
    opts: {
      expectedKernelAddress: string;
      expectedChainId: number;
      now?: number;
    },
  ):
    | { ok: true; signed: DeliveryEnvelopeSignedV1 }
    | { ok: false; code: string; error: string } {
    // Step 1: structural / shape validation (includes scheme/canonical-
    // empty consistency under the hood via `validateEnvelopeSigned`).
    // Any structural defect surfaces as `envelope_signature_invalid`
    // — see setupBuilder.ts for the same rationale.
    const shapeResult = validateEnvelopeWire(wire);
    if (!shapeResult.ok) {
      return {
        ok: false,
        code: 'envelope_signature_invalid',
        error: shapeResult.error,
      };
    }

    const signed = wire.signed;

    // Step 2: defense-in-depth scheme/canonical-empty re-check. The
    // wire-validator already enforces this, but calling it explicitly
    // here means a future refactor of the validator that accidentally
    // weakens the check is caught by THIS file's tests rather than
    // silently shipping. Cheap enough to be worth the explicitness.
    const consistencyResult = validateSchemeConsistency(signed);
    if (!consistencyResult.ok) {
      return {
        ok: false,
        code: 'envelope_signature_invalid',
        error: consistencyResult.error,
      };
    }

    // Step 3: chainId match (trusted vs payload).
    if (signed.chainId !== opts.expectedChainId) {
      return {
        ok: false,
        code: 'envelope_chain_mismatch',
        error: `expected chainId ${opts.expectedChainId}, got ${signed.chainId}`,
      };
    }

    // Step 4: kernel-address match (allowlist anchor).
    const expectedKernelLc = opts.expectedKernelAddress.toLowerCase();
    const payloadKernelLc = signed.kernelAddress.toLowerCase();
    if (payloadKernelLc !== expectedKernelLc) {
      return {
        ok: false,
        code: 'envelope_kernel_mismatch',
        error: `expected kernel ${expectedKernelLc}, got ${payloadKernelLc}`,
      };
    }

    // Step 5: payloadHash binding. This is THE defense against post-
    // signature body tamper: any change to `wire.body` propagates into
    // `recomputedHash` and diverges from the signed `payloadHash`.
    //
    // Scheme-aware (FIX-1, AIP-16 Phase 3.5 HIGH):
    //  - public-v1: wire.body IS the plaintext UTF-8 JSON string.
    //    `bodyHash(string)` routes through `toBytes(string, 'body')` →
    //    `keccak256(utf8Bytes(body))`. This matches the build path
    //    above AND the Platform verifier in `lib/delivery/auth.ts`.
    //  - x25519-aes256gcm-v1: wire.body is `0x`-prefixed hex of the
    //    raw ciphertext bytes. We hex-decode first, then hash — that
    //    is exactly what `bodyHash(ciphertext)` did on the build side.
    let recomputedHash: string;
    try {
      // Branch on scheme: public-v1 hashes UTF-8 of plaintext string,
      // encrypted hashes hex-decoded ciphertext bytes. The same SDK
      // and Platform paths must agree byte-for-byte.
      if (signed.scheme === 'public-v1') {
        recomputedHash = bodyHash(wire.body);
      } else {
        const bodyBytes = bytesFromHex(wire.body);
        recomputedHash = bodyHash(bodyBytes);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        code: 'envelope_payload_hash_mismatch',
        error: `failed to decode wire.body for payloadHash recomputation: ${msg}`,
      };
    }

    if (recomputedHash.toLowerCase() !== signed.payloadHash.toLowerCase()) {
      return {
        ok: false,
        code: 'envelope_payload_hash_mismatch',
        error: `recomputed ${recomputedHash.toLowerCase()} does not match signed.payloadHash ${signed.payloadHash.toLowerCase()}`,
      };
    }

    // Step 6: signature recovery. We pass the TRUSTED kernel address
    // (already proven to equal the payload's at step 4) so future
    // refactors cannot accidentally let an attacker control the
    // recovery domain.
    let recovered: string;
    try {
      recovered = recoverEnvelopeSigner(
        signed,
        wire.providerSig,
        opts.expectedKernelAddress,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        code: 'envelope_signature_invalid',
        error: msg,
      };
    }

    if (recovered.toLowerCase() !== signed.signerAddress.toLowerCase()) {
      return {
        ok: false,
        code: 'envelope_signature_invalid',
        error: `recovered signer ${recovered.toLowerCase()} does not match signed.signerAddress ${signed.signerAddress.toLowerCase()}`,
      };
    }

    // Step 7: timestamp skew. Symmetric — both past and future. Checked
    // LAST so a forged signature is surfaced first (more severe class
    // of failure).
    const now = opts.now ?? secondsNow();
    if (Math.abs(now - signed.createdAt) > ENVELOPE_TIMESTAMP_SKEW_SEC) {
      return {
        ok: false,
        code: 'envelope_timestamp_skew',
        error: `|now (${now}) - createdAt (${signed.createdAt})| > ${ENVELOPE_TIMESTAMP_SKEW_SEC}s`,
      };
    }

    return { ok: true, signed };
  }

  // --------------------------------------------------------------------------
  // decryptPayload (static)
  // --------------------------------------------------------------------------

  /**
   * Decrypt the payload of an `x25519-aes256gcm-v1` envelope using the
   * buyer's ephemeral private key.
   *
   * Does NOT verify the EIP-712 signature, the chainId / kernel binding,
   * or the payloadHash. Callers that have not already run {@link verify}
   * SHOULD use {@link verifyAndDecrypt} instead.
   *
   * Throws on:
   *  - non-encrypted scheme (`public-v1` envelopes are not decrypted),
   *  - malformed buyerEphemeralPrivKey length,
   *  - ECDH failure (low-order peer pubkey, etc.),
   *  - HKDF failure,
   *  - AES-GCM authentication failure (tag mismatch).
   *
   * @param wire - The envelope to decrypt.
   * @param buyerEphemeralPrivKey - The buyer's 32-byte X25519 private
   *   key (the one whose pubkey was embedded in the setup).
   * @returns The JSON-parsed payload (`unknown`).
   * @throws {DeliveryCryptoError} via the underlying crypto helpers.
   * @throws {DeliveryEip712Error} `BUILDER_PUBLIC_DECRYPT_NOT_APPLICABLE`
   *   when called on a `public-v1` envelope.
   */
  static async decryptPayload(
    wire: DeliveryEnvelopeWireV1,
    buyerEphemeralPrivKey: Uint8Array,
  ): Promise<unknown> {
    const signed = wire.signed;
    if (signed.scheme !== 'x25519-aes256gcm-v1') {
      throw new DeliveryEip712Error(
        'BUILDER_PUBLIC_DECRYPT_NOT_APPLICABLE',
        `decryptPayload requires scheme=x25519-aes256gcm-v1; got ${signed.scheme}`,
        { scheme: signed.scheme },
      );
    }

    // ECDH + HKDF → session key.
    const providerPubkey = pubkeyFromHex(signed.providerEphemeralPubkey);
    const shared = deriveSharedSecret(buyerEphemeralPrivKey, providerPubkey);
    const sessionKey = deriveSessionKey(shared, signed.txId);

    // Decode wire-form values (ciphertext / nonce / tag).
    const ciphertext = bytesFromHex(wire.body);
    const nonce = bytesFromHex(signed.nonce);
    const tag = bytesFromHex(signed.tag);

    // H5 binding: reconstruct the same AAD the encrypt side used.
    // If the envelope was misrouted (txId or signerAddress in
    // `signed` does not match what the encrypt side committed to),
    // the AAD differs and the GCM tag fails to verify — surfaced as
    // `crypto_decrypt_failed`. Both signed.txId and signed.signerAddress
    // are themselves protected by the EIP-712 signature (verified upstream
    // in `verify`), so an attacker cannot lie about them without invalidating
    // the envelope at the signature layer first.
    const aad = buildEnvelopeAad(signed.txId, signed.signerAddress);

    // Authenticated decrypt. `decryptBody` throws on tag mismatch via
    // `crypto_decrypt_failed` — propagated as-is to the caller.
    const plaintextBytes = decryptBody(ciphertext, sessionKey, nonce, tag, aad);

    // Decode UTF-8 and JSON-parse. We use the global TextDecoder so the
    // implementation is portable across Node and Bun.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const json = decoder.decode(plaintextBytes);
    return JSON.parse(json);
  }

  // --------------------------------------------------------------------------
  // verifyAndDecrypt (static)
  // --------------------------------------------------------------------------

  /**
   * Combined {@link verify} + payload extraction.
   *
   * For `public-v1`: after a successful `verify`, the wire body (hex)
   * is decoded to bytes, UTF-8 → string, JSON-parsed, and returned.
   *
   * For `x25519-aes256gcm-v1`: after a successful `verify`,
   * {@link decryptPayload} is invoked with `buyerEphemeralPrivKey`.
   *
   * Verification failures are returned as `{ ok: false, code, error }`
   * — the structured shape matches `verify`. Decryption failures are
   * also returned as `{ ok: false, code: "envelope_decrypt_failed", ...}`
   * (catching the underlying `DeliveryCryptoError`).
   *
   * @param wire - The envelope to verify + decrypt.
   * @param buyerEphemeralPrivKey - 32-byte X25519 private key. Ignored
   *   for `public-v1` envelopes (pass `new Uint8Array(32)` if you do
   *   not have one — the value is never read in that branch).
   * @param opts - Same as {@link verify}.
   * @returns `{ ok: true, payload }` on success, `{ ok: false, code, error }`
   *   on any failure.
   */
  static async verifyAndDecrypt(
    wire: DeliveryEnvelopeWireV1,
    buyerEphemeralPrivKey: Uint8Array,
    opts: {
      expectedKernelAddress: string;
      expectedChainId: number;
      now?: number;
    },
  ): Promise<
    | { ok: true; payload: unknown }
    | { ok: false; code: string; error: string }
  > {
    const verifyResult = DeliveryEnvelopeBuilder.verify(wire, opts);
    if (!verifyResult.ok) {
      return verifyResult;
    }

    const signed = verifyResult.signed;

    if (signed.scheme === 'public-v1') {
      // FIX-1 (AIP-16 Phase 3.5 HIGH): wire.body for public-v1 is the
      // plaintext UTF-8 JSON string itself — JSON.parse directly.
      try {
        const payload: unknown = JSON.parse(wire.body);
        return { ok: true, payload };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          code: 'envelope_decrypt_failed',
          error: `failed to parse public-v1 body as JSON: ${msg}`,
        };
      }
    }

    // Encrypted scheme — run the decrypt helper. Catch the underlying
    // DeliveryCryptoError / TypeError shape and surface as
    // `envelope_decrypt_failed` so the caller's structured-code surface
    // does not have to know about crypto_* codes.
    try {
      const payload = await DeliveryEnvelopeBuilder.decryptPayload(
        wire,
        buyerEphemeralPrivKey,
      );
      return { ok: true, payload };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        code: 'envelope_decrypt_failed',
        error: msg,
      };
    }
  }

  // --------------------------------------------------------------------------
  // computeHash (static)
  // --------------------------------------------------------------------------

  /**
   * Compute a stable, cross-SDK identifier for an envelope wire object.
   *
   * The hash is `keccak256(utf8Bytes(canonicalJsonStringify(wire.signed)))`:
   *
   *  - canonical JSON (sorted keys, no whitespace) guarantees byte-for-
   *    byte identical input across SDK languages,
   *  - `keccak256` matches the on-chain hashing convention,
   *  - hashing the SIGNED projection (not the full wire) excludes the
   *    signature, body, and any `serverMeta` so the hash is stable
   *    across relay-side decoration and signature malleability.
   *
   * This is NOT the EIP-712 signing hash; it is a content-addressing
   * helper for logs, dedup sets, and cross-SDK fixtures.
   *
   * @param wire - The wire envelope to hash.
   * @returns 32-byte hex-encoded keccak256 hash (`0x` + 64 hex chars).
   */
  static computeHash(wire: DeliveryEnvelopeWireV1): string {
    return keccak256(toUtf8Bytes(canonicalJsonStringify(wire.signed)));
  }
}

// ============================================================================
// Re-exports for caller ergonomics
// ============================================================================
//
// Aliases so callers importing from this module directly don't need a
// second import line for the result type. The barrel (`./index.ts`)
// re-exports the same names.
//

export type { BuildEnvelopeResult } from './types';

// Re-affirm ethers import is used. Like setupBuilder.ts, we keep this
// guard so very aggressive tree-shakers do not drop the `ethers` symbol
// while we still depend on its types.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ethersUsed: typeof ethers = ethers;
