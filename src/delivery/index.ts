/**
 * AIP-16 Delivery Surface — Module Barrel
 * ========================================
 *
 * Public re-export surface for the AGIRAILS delivery layer (AIP-16 Rev 5).
 *
 * Phase 2a foundation: types + EIP-712 domain/types/recovery helpers.
 * Later phases add cryptographic primitives (`crypto.ts`), builders
 * (`setupBuilder.ts`, `envelopeBuilder.ts`), verifiers, the channel
 * client, and a structured error class extending `ACTPError`.
 *
 * Consumers SHOULD import from this barrel rather than reaching into
 * individual files, so future internal refactors do not break call
 * sites:
 *
 * @example
 * ```typescript
 * import {
 *   DeliveryScheme,
 *   DeliverySetupSignedV1,
 *   DeliveryEnvelopeWireV1,
 *   CANONICAL_EMPTY_BYTES32,
 *   DELIVERY_DOMAIN_NAME,
 *   buildDeliveryDomain,
 *   recoverSetupSigner,
 * } from '@agirails/sdk/delivery';
 * ```
 */

export type {
  // Discriminator unions
  DeliveryScheme,
  DeliveryMode,
  DeliveryPrivacy,
  ParticipantRole,
  DeliveryNetwork,
  // Buyer setup
  DeliverySetupSignedV1,
  DeliverySetupWireV1,
  // Provider envelope
  DeliveryEnvelopeSignedV1,
  DeliveryEnvelopeWireV1,
  // Builder result types
  BuildSetupResult,
  BuildEnvelopeResult,
  // Errors
  DeliveryErrorCode,
  DeliveryError,
} from './types';

export {
  // Canonical empty value constants
  CANONICAL_EMPTY_BYTES32,
  CANONICAL_EMPTY_BYTES12,
  CANONICAL_EMPTY_BYTES16,
} from './types';

// ---------------------------------------------------------------------------
// EIP-712 domain, types, and recovery helpers (Phase 2a)
// ---------------------------------------------------------------------------

export {
  // Domain constants
  DELIVERY_DOMAIN_NAME,
  DELIVERY_DOMAIN_VERSION,
  // EIP-712 typed-data schemas (field order IMMUTABLE)
  DELIVERY_SETUP_TYPES_V1,
  DELIVERY_ENVELOPE_TYPES_V1,
  // Network + domain helpers
  chainIdForNetwork,
  buildDeliveryDomain,
  // Recovery helpers
  recoverSetupSigner,
  recoverEnvelopeSigner,
  // Error class
  DeliveryEip712Error,
} from './eip712';

// ---------------------------------------------------------------------------
// X25519 ephemeral keys, ECDH, HKDF (Phase 2a foundation)
// ---------------------------------------------------------------------------

export type { EphemeralKeyPair } from './keys';

export {
  // Length constants
  X25519_PUBLIC_KEY_LENGTH,
  X25519_PRIVATE_KEY_LENGTH,
  X25519_SHARED_SECRET_LENGTH,
  DELIVERY_SESSION_KEY_LENGTH,
  TX_ID_BYTES,
  // HKDF info string for v1
  DELIVERY_HKDF_INFO_V1,
  // Core primitives
  generateEphemeralKeyPair,
  deriveSharedSecret,
  deriveSessionKey,
  // Hex format helpers
  pubkeyToHex,
  pubkeyFromHex,
  // Error class
  DeliveryCryptoError,
} from './keys';

// ---------------------------------------------------------------------------
// AES-256-GCM AEAD + body hashing (Phase 2a foundation)
// ---------------------------------------------------------------------------

export type { EncryptResult } from './crypto';

export {
  // Length constants
  AES_GCM_NONCE_LENGTH,
  AES_GCM_TAG_LENGTH,
  AES_KEY_LENGTH,
  // AEAD primitives
  encryptBody,
  decryptBody,
  // keccak256 body hash (for payloadHash binding)
  bodyHash,
  // Hex format helpers (wire-boundary serialization)
  bytesToHex,
  bytesFromHex,
} from './crypto';

// ---------------------------------------------------------------------------
// Runtime validation for setup + envelope shapes (Phase 2a foundation)
// ---------------------------------------------------------------------------

export type { ValidationResult } from './validate';

export {
  // Primitive validators
  isValidBytes32,
  isValidBytes12,
  isValidBytes16,
  isValidAddress,
  isValidUintString,
  isValidScheme,
  isValidPrivacy,
  isValidRole,
  // Canonical-empty checks
  isCanonicalEmptyBytes32,
  isCanonicalEmptyBytes12,
  isCanonicalEmptyBytes16,
  // Schema validators
  validateSetupSigned,
  validateSetupWire,
  validateEnvelopeSigned,
  validateEnvelopeWire,
  // Cross-field consistency
  validateSchemeConsistency,
} from './validate';

// ============================================================================
// Nonce key constants (AIP-16 Rev5 — per-builder key separation)
// ============================================================================

export {
  DELIVERY_NONCE_KEY_SETUP,
  DELIVERY_NONCE_KEY_ENVELOPE,
} from './nonce-keys';

export type { DeliveryNonceKey } from './nonce-keys';

// ============================================================================
// Buyer setup builder + verifier (Phase 2b)
// ============================================================================

export { DeliverySetupBuilder } from './setupBuilder';

export type { BuildSetupParams } from './setupBuilder';

export {
  DEFAULT_SETUP_EXPIRY_SEC,
  SETUP_TIMESTAMP_SKEW_SEC,
  DEFAULT_ACCEPTED_CHANNELS,
} from './setupBuilder';

// ============================================================================
// Provider envelope builder + verifier + decryptor (Phase 2b)
// ============================================================================

export { DeliveryEnvelopeBuilder } from './envelopeBuilder';

export type {
  BuildPublicEnvelopeParams,
  BuildEncryptedEnvelopeParams,
} from './envelopeBuilder';

export {
  ENVELOPE_TIMESTAMP_SKEW_SEC,
  ENVELOPE_AAD_LENGTH,
  buildEnvelopeAad,
} from './envelopeBuilder';

// ============================================================================
// Delivery channel abstraction (Phase 2b)
// ============================================================================

export type {
  DeliveryChannel,
  DeliverySubscription,
  SetupCallback,
  EnvelopeCallback,
} from './channel';

// ============================================================================
// Pluggable channel logger (Phase 2b)
// ============================================================================

export type { LogFn } from './channelLog';

export { noopLog } from './channelLog';

// ============================================================================
// Channel implementations (Phase 2b)
// ============================================================================

export { MockDeliveryChannel } from './MockDeliveryChannel';
export type { MockDeliveryChannelOptions } from './MockDeliveryChannel';

export {
  RelayDeliveryChannel,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from './RelayDeliveryChannel';
export type { RelayDeliveryChannelOptions } from './RelayDeliveryChannel';
