/**
 * verifyQuoteOnChain — cross-reference a received QuoteMessage against
 * the hash a provider committed on-chain via `transitionState(QUOTED, …)`.
 *
 * AIP-2.1 §3.6 (legacy compatibility). Two matchers, tried in order:
 *
 *   1. `'aip2'`   — canonical EIP-712 hash: keccak256(canonicalJson(
 *                   QuoteMessage minus signature)). This is what
 *                   AIP-2.1-compliant providers emit.
 *   2. `'legacy'` — ad-hoc hash from Agent.ts:1035-1038 (the
 *                   counter-offer pricing path that shipped before the
 *                   formal AIP-2.1 submitQuote runtime method). Hash is:
 *                     keccak256(JSON.stringify({
 *                       txId, providerIdealPrice, actualEscrow, provider
 *                     }))
 *                   where `providerIdealPrice` is the provider's intended
 *                   sell price in USDC base units (string), `actualEscrow`
 *                   is tx.amount (the buyer-offered amount), and `provider`
 *                   is the provider's EOA address. This path is used
 *                   only when the SDK-authored hash can't be reconstructed
 *                   (e.g. pre-AIP-2.1 agents still running).
 *
 * Both paths return a `{ source, match: true }` tagged result so the
 * orchestrator + telemetry can see how many transactions are still
 * coming through the legacy path. The legacy matcher is
 * observability-tagged technical debt — planned removal in 2 SDK
 * minor releases per the AIP-2.1 migration schedule.
 *
 * @module negotiation/verifyQuoteOnChain
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { QuoteBuilder, QuoteMessage } from '../builders/QuoteBuilder';
import { Wallet as EthersWallet } from 'ethers';
import { InMemoryNonceManager } from '../utils/NonceManager';

export type VerifySource = 'aip2' | 'legacy';

export interface VerifyOnChainResult {
  match: boolean;
  /** Which matcher accepted the hash. Only set when `match === true`. */
  source?: VerifySource;
  /** Expected hash per the canonical matcher, for debugging mismatches. */
  canonicalHash?: string;
  /** Expected legacy hash (same purpose). */
  legacyHash?: string;
}

/**
 * Cross-reference an off-chain QuoteMessage against the hash stored on
 * chain in `tx.metadata` (or equivalent — MockTransaction.quoteHash).
 *
 * Passing `providerAddress` and `actualEscrow` enables the legacy
 * fallback. Omit them on fresh deployments where legacy is impossible.
 *
 * @param quote          - signed QuoteMessage received off-chain
 * @param onChainHash    - hash committed on-chain at QUOTED
 * @param providerAddress - provider's EOA address (needed for legacy)
 * @param actualEscrow   - tx.amount at QUOTED time (needed for legacy)
 */
export function verifyQuoteHashOnChain(
  quote: QuoteMessage,
  onChainHash: string,
  opts: {
    providerAddress?: string;
    actualEscrow?: string;
  } = {},
): VerifyOnChainResult {
  // 1. Canonical AIP-2 match. Hasher is signer-independent so a
  //    throwaway wallet is fine.
  const hasher = new QuoteBuilder(EthersWallet.createRandom(), new InMemoryNonceManager());
  const canonicalHash = hasher.computeHash(quote);
  if (canonicalHash.toLowerCase() === onChainHash.toLowerCase()) {
    return { match: true, source: 'aip2', canonicalHash };
  }

  // 2. Legacy Agent.ts:1033-1038 match. Only attempted when we have
  //    the legacy inputs — without them the fallback is impossible
  //    by construction (which is fine — old providers will simply
  //    fail verification and the orchestrator will cancel the tx).
  let legacyHash: string | undefined;
  if (opts.providerAddress && opts.actualEscrow) {
    // The legacy hash uses `providerIdealPrice` (what provider WANTED
    // to charge) rather than the `quotedAmount` from the off-chain
    // message — at the counter-offer pricing path, those are the same
    // value (see Agent.ts:1034). We reconstruct the legacy shape with
    // the off-chain quote's `quotedAmount` as the ideal price.
    const legacyShape = {
      txId: quote.txId,
      providerIdealPrice: quote.quotedAmount,
      actualEscrow: opts.actualEscrow,
      provider: opts.providerAddress,
    };
    legacyHash = keccak256(toUtf8Bytes(JSON.stringify(legacyShape)));
    if (legacyHash.toLowerCase() === onChainHash.toLowerCase()) {
      return { match: true, source: 'legacy', canonicalHash, legacyHash };
    }
  }

  return { match: false, canonicalHash, legacyHash };
}
