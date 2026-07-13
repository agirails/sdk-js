/**
 * AIP-14c DELIVERED transition proof encoding.
 *
 * The v2 kernel (AIP-14c) requires the `IN_PROGRESS → DELIVERED` proof to be
 * EXACTLY 64 bytes:
 *
 *   abi.encode(uint256 window, bytes32 resultHash)
 *
 * with `MIN_DISPUTE_WINDOW (1h) ≤ window ≤ MAX_DISPUTE_WINDOW (30d)`,
 * `window != 0`, and `resultHash != 0`. The legacy 32-byte window-only proof
 * is REJECTED with `"Delivery proof must be (window,resultHash)"`.
 *
 * `resultHash` MUST be the SAME hash the AIP-4 delivery proof commits to:
 *   - public delivery:   `computeResultHash(result)` (keccak256 of canonical JSON)
 *   - encrypted (AIP-16): the envelope hash
 *
 * Reference: deployments/AIP14C-ABI-FREEZE.md §"DELIVERED proof rule (D1)".
 */

import { AbiCoder } from 'ethers';

/** bytes32(0) — forbidden as a delivery-proof `resultHash` by the v2 kernel. */
export const ZERO_RESULT_HASH = '0x' + '00'.repeat(32);

/**
 * A delivery path MUST commit to the REAL deliverable. There is NO synthetic
 * fallback `resultHash`: `resultHash` is either `computeResultHash(result)` for
 * public delivery or the AIP-16 envelope hash for encrypted delivery. A caller
 * that has NEITHER a result NOR an explicit `resultHash` MUST fail closed
 * BEFORE sending the DELIVERED transition — see `assertRealResultHash`.
 */

/**
 * Fail-closed guard for the DELIVERED transition. Throws when `resultHash` is
 * absent, empty, non-hex, not 32 bytes, or `bytes32(0)` — the delivery path
 * must never fabricate a hash. Returns the validated `resultHash` unchanged.
 *
 * @param resultHash - Caller-supplied bytes32 commitment to the delivered
 *                     result (`computeResultHash(result)` / AIP-16 envelope
 *                     hash). Required.
 * @returns The validated 0x-prefixed bytes32 `resultHash`.
 */
export function assertRealResultHash(resultHash?: string): string {
  if (typeof resultHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(resultHash)) {
    throw new Error(
      'deliver() requires a real deliverable or an explicit resultHash: ' +
        'pass computeResultHash(result) (public) or the AIP-16 envelope hash ' +
        '(encrypted). Refusing to send DELIVERED without a result commitment.'
    );
  }
  if (resultHash.toLowerCase() === ZERO_RESULT_HASH) {
    throw new Error('resultHash must be non-zero (the v2 kernel rejects bytes32(0)).');
  }
  return resultHash;
}

/**
 * Encode the 64-byte AIP-14c DELIVERED transition proof.
 *
 * @param disputeWindowSeconds - Dispute window in seconds (1h..30d, non-zero).
 * @param resultHash - bytes32 commitment to the delivered result (non-zero).
 * @returns 0x-prefixed 64-byte ABI blob `abi.encode(uint256, bytes32)`.
 */
export function encodeDeliveryProof(disputeWindowSeconds: number, resultHash: string): string {
  return AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'bytes32'],
    [disputeWindowSeconds, resultHash]
  );
}
