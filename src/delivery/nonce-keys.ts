/**
 * AIP-16 Delivery — Per-Builder Nonce Key Constants
 * ===================================================
 *
 * The AGIRAILS delivery surface (AIP-16 Rev 5) uses two SEPARATE nonce
 * spaces, one for the buyer-signed *setup* message and one for the
 * provider-signed *envelope* message. These are deliberately distinct
 * from the AIP-4 delivery-proof nonce key (`agirails.delivery.v1`) and
 * from each other, so that:
 *
 *   1. A nonce burned for a setup message cannot be replayed as an
 *      envelope message (per-builder replay separation).
 *   2. A nonce burned for an AIP-4 delivery proof cannot collide with
 *      the AIP-16 setup/envelope nonce spaces (cross-feature isolation).
 *   3. The on-disk persistence file (`.actp/nonces.json`) keeps a
 *      clean, auditable per-key monotonic counter.
 *
 * Why per-builder separation matters (audit context):
 * ----------------------------------------------------
 * The existing `NonceManager` (`src/utils/NonceManager.ts`) keys nonces
 * by *message-type string*. There is no central registry of known keys
 * — any string is accepted. This file therefore acts as the canonical,
 * type-safe constant source for AIP-16's two delivery nonce keys, so
 * call sites (setup builder, envelope builder, future replay-cache
 * server) all reach for the SAME literal and the TypeScript `as const`
 * narrowing prevents silent drift.
 *
 * Reuse, NOT replace:
 * -------------------
 * These constants are intended to be passed straight into the existing
 * `NonceManager` API (`getNextNonce`, `getAndIncrementNonce`,
 * `recordNonce`, etc.) — they introduce no new manager, no new storage
 * layer, and no behavioural change. They simply give the delivery layer
 * a single authoritative spelling of its two nonce-key strings.
 *
 * @example Use with the existing nonce manager
 * ```typescript
 * import { createNonceManager } from '../utils/NonceManager';
 * import {
 *   DELIVERY_NONCE_KEY_SETUP,
 *   DELIVERY_NONCE_KEY_ENVELOPE,
 * } from './nonce-keys';
 *
 * const nonces = createNonceManager({ stateDirectory: process.cwd() });
 *
 * // Buyer setup signing path:
 * const setupNonce = await (nonces as any).getAndIncrementNonce(
 *   DELIVERY_NONCE_KEY_SETUP,
 * );
 *
 * // Provider envelope signing path (independent counter):
 * const envelopeNonce = await (nonces as any).getAndIncrementNonce(
 *   DELIVERY_NONCE_KEY_ENVELOPE,
 * );
 * ```
 *
 * Reference: AIP-16 Rev 5 §replay-protection, §nonce-spaces
 *
 * @module delivery/nonce-keys
 */

/**
 * Nonce key for buyer-signed AIP-16 delivery *setup* messages.
 *
 * Distinct from {@link DELIVERY_NONCE_KEY_ENVELOPE} (per-builder
 * separation) and from the AIP-4 delivery-proof key
 * `agirails.delivery.v1` (cross-feature separation).
 *
 * The `.v1` suffix matches the EIP-712 domain version for the v1
 * delivery surface; a future v2 would introduce a new key string
 * rather than incrementing in place.
 */
export const DELIVERY_NONCE_KEY_SETUP = 'agirails.delivery.setup.v1' as const;

/**
 * Nonce key for provider-signed AIP-16 delivery *envelope* messages.
 *
 * Distinct from {@link DELIVERY_NONCE_KEY_SETUP} (per-builder
 * separation) and from the AIP-4 delivery-proof key
 * `agirails.delivery.v1` (cross-feature separation).
 *
 * The `.v1` suffix matches the EIP-712 domain version for the v1
 * delivery surface; a future v2 would introduce a new key string
 * rather than incrementing in place.
 */
export const DELIVERY_NONCE_KEY_ENVELOPE = 'agirails.delivery.envelope.v1' as const;

/**
 * Compile-time-narrowed union of all AIP-16 delivery nonce keys.
 *
 * Useful for typed wrappers that want to accept *only* a known
 * delivery key (and reject e.g. `'agirails.delivery.v1'` which belongs
 * to AIP-4).
 */
export type DeliveryNonceKey =
  | typeof DELIVERY_NONCE_KEY_SETUP
  | typeof DELIVERY_NONCE_KEY_ENVELOPE;
