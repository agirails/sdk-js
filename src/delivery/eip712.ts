/**
 * AIP-16 Delivery Surface — EIP-712 Domain, Types & Recovery (Phase 2a)
 * ======================================================================
 *
 * Canonical EIP-712 contract surface for the AGIRAILS delivery layer
 * (AIP-16 Rev 5). This module is the *single source of truth* for:
 *
 *  - the EIP-712 domain name + version used by all delivery signatures,
 *  - the typed-data schemas (`DeliverySetupSignedV1`,
 *    `DeliveryEnvelopeSignedV1`) — field order is IMMUTABLE,
 *  - network → chainId resolution,
 *  - domain object construction with `verifyingContract` anchored to the
 *    ACTP kernel address (the relay-allowlist anchor — see DEC-10),
 *  - signature recovery helpers wrapping `ethers.verifyTypedData`.
 *
 * ## Domain separation
 *
 * The delivery domain (`"AGIRAILS Delivery"`) is DELIBERATELY distinct
 * from the negotiation domain (`"AGIRAILS"`) and the receipts domain
 * (`"AGIRAILS Receipts"`). Domain reuse across AIP features enables
 * cross-feature signature replay (e.g. a quote signature being replayed
 * as a delivery setup); we keep the three domains strictly partitioned.
 *
 * ## Smart-wallet auth (verification responsibility)
 *
 * Recovery here only returns the EOA that produced the signature. The
 * caller MUST then perform the two-step check:
 *   1. recovered === payload.signerAddress
 *   2. signerAddress === participantAddress OR
 *      computeSmartWalletFromSigner(signerAddress) === participantAddress
 *
 * That second check is intentionally NOT in this module — it's a
 * cross-cutting auth concern shared with receipts V2
 * (`Platform/agirails.app/web/lib/receipts/auth.ts`) and is performed
 * by the dedicated verifier modules in later phases.
 *
 * ## Kernel allowlist (verification responsibility)
 *
 * Recovery helpers take `kernelAddress` directly from the payload so the
 * EIP-712 domain matches what was signed. Callers MUST independently
 * verify the `kernelAddress` against their own allowlist BEFORE trusting
 * the recovered signer; otherwise an attacker could sign against an
 * attacker-controlled kernel and the recovery would succeed trivially.
 *
 * @module delivery/eip712
 * @see {@link https://eips.ethereum.org/EIPS/eip-712 EIP-712}
 * @see ./types — the underlying signed payload interfaces
 */

import { ethers, type TypedDataField } from 'ethers';

import type {
  DeliveryEnvelopeSignedV1,
  DeliveryNetwork,
  DeliverySetupSignedV1,
} from './types';

// ============================================================================
// Domain Constants
// ============================================================================

/**
 * EIP-712 domain `name` for ALL delivery surface signatures.
 *
 * Distinct from `"AGIRAILS"` (negotiation, AIP-2.1) and
 * `"AGIRAILS Receipts"` (AIP-3 receipts) so that a signature produced
 * for one feature cannot be replayed as another. Changing this string
 * is a breaking SDK and Platform change.
 */
export const DELIVERY_DOMAIN_NAME = 'AGIRAILS Delivery';

/**
 * EIP-712 domain `version` for the v1 delivery schemas. The version
 * field is bumped only on incompatible schema changes (e.g. addition
 * of new required fields, reordering, or semantic shifts). Adding a
 * new scheme value via the `string` field does NOT require a version
 * bump.
 */
export const DELIVERY_DOMAIN_VERSION = '1';

// ============================================================================
// EIP-712 Typed-Data Schemas
// ============================================================================
//
// IMMUTABILITY NOTE
// -----------------
// The field order in both `DELIVERY_SETUP_TYPES_V1` and
// `DELIVERY_ENVELOPE_TYPES_V1` is part of the EIP-712 type hash. Both
// the signer (this SDK) and every verifier (Platform server, peer
// SDKs in other languages, the Python SDK) MUST encode byte-for-byte
// identical typed-data structures. Reordering, renaming, or changing
// the Solidity type of any field is a HARD-BREAKING schema change.
// Such changes require a domain version bump and a new exported
// `*_V2` schema.
//
// These arrays mirror the schema documented in
// `src/delivery/types.ts` (search "EIP-712 schema (signed)" in the
// type-level JSDoc) — they are kept in lock-step.
//

/**
 * EIP-712 type schema for {@link DeliverySetupSignedV1}.
 *
 * 11 fields, field order IMMUTABLE. Matches the JSDoc schema documented
 * on `DeliverySetupSignedV1`.
 */
export const DELIVERY_SETUP_TYPES_V1: Record<string, TypedDataField[]> = {
  DeliverySetupSignedV1: [
    { name: 'version', type: 'uint8' },
    { name: 'txId', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'kernelAddress', type: 'address' },
    { name: 'requesterAddress', type: 'address' },
    { name: 'signerAddress', type: 'address' },
    { name: 'buyerEphemeralPubkey', type: 'bytes32' },
    { name: 'acceptedChannels', type: 'string[]' },
    { name: 'expectedPrivacy', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    // H4 fix (AIP-16 Phase 3 HIGH): appended at END of field list so
    // existing field indices stay stable. Default value `0` reproduces
    // the legacy hard-coded nonce-0 smart-wallet derivation.
    { name: 'smartWalletNonce', type: 'uint256' },
  ],
};

/**
 * EIP-712 type schema for {@link DeliveryEnvelopeSignedV1}.
 *
 * 12 fields, field order IMMUTABLE. Matches the JSDoc schema documented
 * on `DeliveryEnvelopeSignedV1`.
 *
 * The encryption-related fields (`providerEphemeralPubkey`, `nonce`,
 * `tag`) are signed under their canonical-empty values for
 * `scheme: "public-v1"`; the type schema itself is invariant across
 * schemes — only the *values* differ.
 */
export const DELIVERY_ENVELOPE_TYPES_V1: Record<string, TypedDataField[]> = {
  DeliveryEnvelopeSignedV1: [
    { name: 'version', type: 'uint8' },
    { name: 'txId', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'kernelAddress', type: 'address' },
    { name: 'providerAddress', type: 'address' },
    { name: 'signerAddress', type: 'address' },
    { name: 'scheme', type: 'string' },
    { name: 'providerEphemeralPubkey', type: 'bytes32' },
    { name: 'nonce', type: 'bytes12' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'tag', type: 'bytes16' },
    { name: 'createdAt', type: 'uint64' },
    // H4 fix (AIP-16 Phase 3 HIGH): appended at END of field list so
    // existing field indices stay stable. Default value `0` reproduces
    // the legacy hard-coded nonce-0 smart-wallet derivation.
    { name: 'smartWalletNonce', type: 'uint256' },
  ],
};

// ============================================================================
// Error Class
// ============================================================================

/**
 * Error thrown by the delivery EIP-712 helpers when inputs are
 * malformed (unknown network, non-address kernel, empty / malformed
 * signature, etc.).
 *
 * Mirrors the {@link SignatureVerificationError} pattern from
 * `src/errors/index.ts` but is intentionally a plain `Error` subclass
 * rather than an `ACTPError` extension — this module is part of the
 * pre-builder foundation layer and we keep its dependency surface
 * minimal (no `ACTPError` import, no `State` import). The higher-level
 * delivery error class extending `ACTPError` is introduced alongside
 * the builders/verifiers in a later phase.
 *
 * `code` mirrors the structured-code style used elsewhere in the SDK
 * so callers can branch on stable identifiers.
 *
 * @example
 * ```typescript
 * try {
 *   const signer = recoverSetupSigner(payload, sig, kernel);
 * } catch (err) {
 *   if (err instanceof DeliveryEip712Error && err.code === 'INVALID_KERNEL_ADDRESS') {
 *     // surface to user
 *   }
 *   throw err;
 * }
 * ```
 */
export class DeliveryEip712Error extends Error {
  /** Stable machine-actionable error code. */
  public readonly code: string;
  /** Optional structured details for debugging (expected vs actual, etc.). */
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DeliveryEip712Error';
    this.code = code;
    this.details = details;
    // Restore prototype chain for `instanceof` after transpilation to ES5.
    Object.setPrototypeOf(this, DeliveryEip712Error.prototype);
  }
}

// ============================================================================
// Network → ChainId
// ============================================================================

/**
 * Resolve an EVM chainId from a {@link DeliveryNetwork}.
 *
 * - `"base-sepolia"` → `84532`
 * - `"base-mainnet"` → `8453`
 * - `"mock"` → throws — the mock runtime has no EIP-712 chain, and
 *   producing a signature against an arbitrary placeholder chainId
 *   could be replayed against a real network if the same signer ever
 *   used the same key there. Callers exercising delivery in mock mode
 *   should branch *before* calling into the EIP-712 layer.
 *
 * @param network - Target delivery network.
 * @returns Numeric chainId suitable for the EIP-712 domain.
 * @throws {DeliveryEip712Error} `UNKNOWN_NETWORK` if `network` is not
 *   one of the recognized delivery networks, or `MOCK_NETWORK_NOT_SUPPORTED`
 *   if the caller passed `"mock"`.
 *
 * @example
 * ```typescript
 * chainIdForNetwork('base-sepolia'); // 84532
 * chainIdForNetwork('base-mainnet'); // 8453
 * chainIdForNetwork('mock');         // throws DeliveryEip712Error
 * ```
 */
export function chainIdForNetwork(network: DeliveryNetwork): number {
  switch (network) {
    case 'base-sepolia':
      return 84532;
    case 'base-mainnet':
      return 8453;
    case 'mock':
      throw new DeliveryEip712Error(
        'MOCK_NETWORK_NOT_SUPPORTED',
        'Delivery EIP-712 signatures are not defined for the mock network; ' +
          'use a real test network (base-sepolia) or branch before reaching ' +
          'the EIP-712 layer.',
        { network },
      );
    default: {
      // Exhaustiveness guard — if a new `DeliveryNetwork` value is added
      // to the union without a matching case here, the compiler will
      // flag this assignment as a type error.
      const exhaustive: never = network;
      throw new DeliveryEip712Error(
        'UNKNOWN_NETWORK',
        `Unknown delivery network: ${String(exhaustive)}`,
        { network: exhaustive },
      );
    }
  }
}

// ============================================================================
// Domain Builder
// ============================================================================

/**
 * Construct the EIP-712 domain object for a delivery signature.
 *
 * Per AIP-16 Rev 5 DEC-10, the domain MUST anchor `verifyingContract`
 * to the ACTP kernel address on the target chain. Relays validate
 * `verifyingContract` against their kernel allowlist before accepting
 * a setup or envelope; this prevents an attacker from registering an
 * attacker-controlled kernel address in the domain and producing
 * signatures the relay would otherwise accept.
 *
 * The returned object is shaped for direct use with
 * `ethers.verifyTypedData` and `ethers.signTypedData`.
 *
 * @param chainId - EVM chainId (see {@link chainIdForNetwork}).
 * @param kernelAddress - Address of the ACTP kernel contract on `chainId`.
 *   Must be a syntactically valid Ethereum address.
 * @returns Fully populated EIP-712 domain object.
 * @throws {DeliveryEip712Error} `INVALID_CHAIN_ID` if `chainId` is
 *   not a positive integer, or `INVALID_KERNEL_ADDRESS` if
 *   `kernelAddress` is not a valid address.
 *
 * @example
 * ```typescript
 * const domain = buildDeliveryDomain(84532, '0x469CBADbACFFE096270594F0a31f0EEC53753411');
 * // {
 * //   name: 'AGIRAILS Delivery',
 * //   version: '1',
 * //   chainId: 84532,
 * //   verifyingContract: '0x469CBADbACFFE096270594F0a31f0EEC53753411',
 * // }
 * ```
 */
export function buildDeliveryDomain(
  chainId: number,
  kernelAddress: string,
): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
} {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new DeliveryEip712Error(
      'INVALID_CHAIN_ID',
      `chainId must be a positive integer, got ${String(chainId)}`,
      { chainId },
    );
  }

  if (typeof kernelAddress !== 'string' || !ethers.isAddress(kernelAddress)) {
    throw new DeliveryEip712Error(
      'INVALID_KERNEL_ADDRESS',
      `kernelAddress is not a valid Ethereum address: ${String(kernelAddress)}`,
      { kernelAddress },
    );
  }

  return {
    name: DELIVERY_DOMAIN_NAME,
    version: DELIVERY_DOMAIN_VERSION,
    chainId,
    verifyingContract: kernelAddress,
  };
}

// ============================================================================
// Signature Recovery
// ============================================================================

/**
 * Internal helper: validate signature shape before handing off to
 * `ethers.verifyTypedData`. Ethers will throw on malformed signatures
 * but with low-level messages; we wrap to produce a consistent
 * structured error.
 */
function assertSignatureShape(signature: string): void {
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new DeliveryEip712Error(
      'INVALID_SIGNATURE',
      'signature must be a non-empty hex string',
      { signature },
    );
  }
  // EIP-712 produces 65-byte signatures: r(32) || s(32) || v(1) = 130 hex + "0x".
  // Some wallets return 64-byte EIP-2098 compact sigs (128 hex + "0x"); accept both.
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new DeliveryEip712Error(
      'INVALID_SIGNATURE',
      `signature is not a valid hex string: ${signature.slice(0, 12)}…`,
      { signature },
    );
  }
  const hexLen = signature.length - 2;
  if (hexLen !== 130 && hexLen !== 128) {
    throw new DeliveryEip712Error(
      'INVALID_SIGNATURE',
      `signature has unexpected length ${hexLen} hex chars (expected 128 or 130)`,
      { signature, hexLength: hexLen },
    );
  }
}

/**
 * Recover the EOA that produced a {@link DeliverySetupSignedV1}
 * signature.
 *
 * Wraps `ethers.verifyTypedData` with the canonical delivery domain
 * (`"AGIRAILS Delivery"` / version `"1"`) anchored to the provided
 * `kernelAddress` and `payload.chainId`.
 *
 * ## Caller responsibilities (NOT performed here)
 *
 *  1. **Allowlist `kernelAddress`** against the set of known ACTP
 *     kernels for the target network. Recovery here uses whatever
 *     address the caller supplies; an attacker controlling
 *     `kernelAddress` could trivially produce valid recoveries.
 *
 *  2. **Compare recovered to `payload.signerAddress`** (case-insensitive).
 *     Mismatch indicates either a forged signature or a buggy signer
 *     that signed a different payload than it claimed.
 *
 *  3. **Smart-wallet equality check** between `payload.signerAddress`
 *     and `payload.requesterAddress`. The recovered EOA may be the
 *     controller of a Smart Wallet contract whose address is the
 *     `requesterAddress`. Use the SDK's `computeSmartWalletFromSigner`
 *     helper (or the platform-side equivalent) to derive the Smart
 *     Wallet address and compare.
 *
 * @param payload - The signed projection (NOT the wire envelope).
 * @param signature - Hex-encoded EIP-712 signature, 0x-prefixed.
 * @param kernelAddress - Kernel address to anchor the EIP-712 domain
 *   to. SHOULD equal `payload.kernelAddress`; passing them separately
 *   here forces the caller to think about the allowlist.
 * @returns The recovered EOA address (checksummed).
 * @throws {DeliveryEip712Error} `INVALID_KERNEL_ADDRESS`,
 *   `INVALID_CHAIN_ID`, or `INVALID_SIGNATURE` on bad inputs.
 * @throws {Error} Re-thrown from ethers if the typed-data hash cannot
 *   be computed (e.g. malformed payload).
 *
 * @example
 * ```typescript
 * const recovered = recoverSetupSigner(payload, sig, KERNEL);
 * if (recovered.toLowerCase() !== payload.signerAddress.toLowerCase()) {
 *   throw new Error('signer_self_mismatch');
 * }
 * ```
 */
export function recoverSetupSigner(
  payload: DeliverySetupSignedV1,
  signature: string,
  kernelAddress: string,
): string {
  assertSignatureShape(signature);
  const domain = buildDeliveryDomain(payload.chainId, kernelAddress);
  // H4 fix: smartWalletNonce is OPTIONAL on the TS interface for backwards
  // compatibility with pre-H4 fixtures. Normalize undefined → 0 before
  // recovery so ethers always sees a complete typed-data structure.
  const normalized: DeliverySetupSignedV1 = {
    ...payload,
    smartWalletNonce: payload.smartWalletNonce ?? 0,
  };
  return ethers.verifyTypedData(
    domain,
    DELIVERY_SETUP_TYPES_V1,
    normalized,
    signature,
  );
}

/**
 * Recover the EOA that produced a {@link DeliveryEnvelopeSignedV1}
 * signature.
 *
 * See {@link recoverSetupSigner} — same shape, same caller
 * responsibilities (allowlist kernel, compare recovered to
 * `payload.signerAddress`, smart-wallet equality between
 * `signerAddress` and `providerAddress`).
 *
 * @param payload - The signed projection (NOT the wire envelope).
 * @param signature - Hex-encoded EIP-712 signature, 0x-prefixed.
 * @param kernelAddress - Kernel address to anchor the EIP-712 domain.
 * @returns The recovered EOA address (checksummed).
 * @throws {DeliveryEip712Error} `INVALID_KERNEL_ADDRESS`,
 *   `INVALID_CHAIN_ID`, or `INVALID_SIGNATURE` on bad inputs.
 */
export function recoverEnvelopeSigner(
  payload: DeliveryEnvelopeSignedV1,
  signature: string,
  kernelAddress: string,
): string {
  assertSignatureShape(signature);
  const domain = buildDeliveryDomain(payload.chainId, kernelAddress);
  // H4 fix: smartWalletNonce is OPTIONAL on the TS interface for backwards
  // compatibility with pre-H4 fixtures. Normalize undefined → 0 before
  // recovery so ethers always sees a complete typed-data structure.
  const normalized: DeliveryEnvelopeSignedV1 = {
    ...payload,
    smartWalletNonce: payload.smartWalletNonce ?? 0,
  };
  return ethers.verifyTypedData(
    domain,
    DELIVERY_ENVELOPE_TYPES_V1,
    normalized,
    signature,
  );
}
