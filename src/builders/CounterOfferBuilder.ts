/**
 * CounterOfferBuilder — AIP-2.1 counter-offer message construction.
 *
 * AIP-2 covers the provider's first quote (`agirails.quote.v1`). AIP-2.1
 * adds the buyer's reply: a signed counter-offer message that proposes a
 * different price than what the provider quoted. The buyer can ping-pong
 * counter-offers with the provider off-chain; the final agreed amount is
 * pinned on-chain when the buyer eventually calls `acceptQuote(txId, amount)`
 * followed by `linkEscrow`.
 *
 * Mirrors QuoteBuilder.ts shape so the verification path is symmetric:
 *  - EIP-712 signed message (buyer signs)
 *  - Canonical JSON hash (deterministic across implementations)
 *  - Same DID extraction + signature recovery pattern
 *
 * @module builders/CounterOfferBuilder
 * @see Protocol/aips/AIP-2.1-DRAFT.md §8 (security model + transport)
 * @see src/builders/QuoteBuilder.ts (sibling, provider side)
 */

import { Signer, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { canonicalJsonStringify } from '../utils/canonicalJson';
import { NonceManager } from '../utils/NonceManager';
import { EIP712Domain } from '../types/eip712';
import { SignatureVerificationError } from '../errors';

// ============================================================================
// Types
// ============================================================================

/**
 * Counter-offer message — the buyer's reply to a provider quote.
 *
 * Field shape mirrors QuoteMessage where it makes sense (txId, currency,
 * decimals, chainId, nonce, signature) but flips provider/consumer
 * semantics: the buyer/consumer is the one signing and the one proposing
 * a (typically lower) price.
 *
 * `quotedAmount` from the original provider quote is preserved as
 * `quoteAmount` for unambiguous binding — the verifier can confirm this
 * counter is in response to the exact quote it claims to be.
 */
export interface CounterOfferMessage {
  type: 'agirails.counteroffer.v1';
  version: '1.0.0';
  /** Transaction ID this counter belongs to (binds counter to txn). */
  txId: string;
  /** Buyer/consumer DID (signer). */
  consumer: string;
  /** Provider DID (recipient). */
  provider: string;
  /** Provider's most recent quoted amount this counter is replying to. */
  quoteAmount: string;
  /** Buyer's proposed counter amount in USDC base units. */
  counterAmount: string;
  /** Original maxPrice from the buyer's policy (anchors the negotiation band). */
  maxPrice: string;
  currency: 'USDC';
  decimals: 6;
  /** Quote hash this counter is replying to — links counter to a specific quote. */
  inReplyTo: string;
  /** Unix seconds, when this counter was constructed. */
  counteredAt: number;
  /** Unix seconds, when this counter expires. Provider must accept/reject by then. */
  expiresAt: number;
  /** Optional human-readable reasoning + market data. */
  justification?: {
    reason?: string;
    /** Average market price observed for the same service (USD). */
    marketRate?: number;
    /** Free-form key/value breakdown the buyer wants to share. */
    breakdown?: Record<string, unknown>;
  };
  chainId: number;
  /** Monotonic per-consumer per-message-type. */
  nonce: number;
  /** EIP-712 signature by consumer over the canonical message. */
  signature: string;
}

/**
 * Parameters to build a counter-offer. `counteredAt`, `nonce`, and
 * `signature` are filled by the builder.
 */
export interface CounterOfferParams {
  txId: string;
  consumer: string;
  provider: string;
  quoteAmount: string;
  counterAmount: string;
  maxPrice: string;
  inReplyTo: string;
  expiresAt?: number;
  justification?: CounterOfferMessage['justification'];
  chainId: number;
  /** ACTPKernel address — used in EIP-712 domain. */
  kernelAddress: string;
}

/**
 * EIP-712 type definitions for `agirails.counteroffer.v1`.
 *
 * The justification object is hashed (single bytes32 field) instead of
 * inlined — same pattern as AIP-2 quotes — so callers can omit large
 * justification blobs without changing the signed payload structure.
 */
export const AIP21CounterOfferTypes = {
  CounterOffer: [
    { name: 'txId', type: 'bytes32' },
    { name: 'consumer', type: 'string' },
    { name: 'provider', type: 'string' },
    { name: 'quoteAmount', type: 'string' },
    { name: 'counterAmount', type: 'string' },
    { name: 'maxPrice', type: 'string' },
    { name: 'currency', type: 'string' },
    { name: 'decimals', type: 'uint8' },
    { name: 'inReplyTo', type: 'bytes32' },
    { name: 'counteredAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'justificationHash', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const MESSAGE_TYPE = 'agirails.counteroffer.v1';
const DEFAULT_TTL_SECONDS = 3600; // 1 hour
const MAX_TTL_SECONDS = 86_400; // 24 hours
const TIMESTAMP_GRACE_SECONDS = 300; // 5 minutes (matches QuoteBuilder)
const PLATFORM_MIN_BASE_UNITS = 50_000n; // $0.05 USDC
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';
const VALID_CHAIN_IDS = new Set([84_532, 8_453]);

// ============================================================================
// Builder
// ============================================================================

export class CounterOfferBuilder {
  constructor(
    private readonly signer: Signer,
    private readonly nonceManager: NonceManager,
  ) {}

  /**
   * Build and sign a counter-offer message.
   * @throws Error on validation failure (amount bands, formats, expiry).
   */
  async build(params: CounterOfferParams): Promise<CounterOfferMessage> {
    this.validateParams(params);

    const counteredAt = Math.floor(Date.now() / 1000);
    const expiresAt = params.expiresAt ?? counteredAt + DEFAULT_TTL_SECONDS;

    if (expiresAt <= counteredAt) {
      throw new Error('expiresAt must be after counteredAt');
    }
    if (expiresAt > counteredAt + MAX_TTL_SECONDS) {
      throw new Error(`expiresAt cannot exceed ${MAX_TTL_SECONDS}s from counteredAt`);
    }

    const message: CounterOfferMessage = {
      type: MESSAGE_TYPE,
      version: '1.0.0',
      txId: params.txId,
      consumer: params.consumer,
      provider: params.provider,
      quoteAmount: params.quoteAmount,
      counterAmount: params.counterAmount,
      maxPrice: params.maxPrice,
      currency: 'USDC',
      decimals: 6,
      inReplyTo: params.inReplyTo,
      counteredAt,
      expiresAt,
      justification: params.justification,
      chainId: params.chainId,
      nonce: this.nonceManager.getNextNonce(MESSAGE_TYPE),
      signature: '',
    };

    message.signature = await this.signMessage(message, params.kernelAddress);
    this.nonceManager.recordNonce(MESSAGE_TYPE, message.nonce);

    return message;
  }

  /**
   * Verify a counter-offer:
   *  1. Schema is well-formed
   *  2. EIP-712 signature recovers to the consumer DID's address
   *  3. Amount band: counterAmount within [platformMin, maxPrice], not above quoteAmount
   *  4. Not expired (with TIMESTAMP_GRACE_SECONDS slack on counteredAt)
   *
   * @returns true on success; throws otherwise.
   */
  async verify(message: CounterOfferMessage, kernelAddress: string): Promise<boolean> {
    this.validateMessageSchema(message);

    const recovered = this.recoverSigner(message, kernelAddress);
    const expected = this.extractAddressFromDID(message.consumer);
    if (recovered.toLowerCase() !== expected.toLowerCase()) {
      throw new SignatureVerificationError(message.consumer, 'unknown');
    }

    const counterAmount = BigInt(message.counterAmount);
    const quoteAmount = BigInt(message.quoteAmount);
    const maxPrice = BigInt(message.maxPrice);

    if (counterAmount < PLATFORM_MIN_BASE_UNITS) {
      throw new Error('counterAmount below platform minimum ($0.05)');
    }
    // A counter that meets or exceeds the existing quote is not a counter —
    // accept the quote instead.
    if (counterAmount >= quoteAmount) {
      throw new Error('counterAmount must be less than quoteAmount (otherwise just accept the quote)');
    }
    if (counterAmount > maxPrice) {
      // Defensive — should never happen if buyer policy is consistent.
      throw new Error('counterAmount exceeds maxPrice');
    }

    const now = Math.floor(Date.now() / 1000);
    if (message.expiresAt < now) {
      throw new Error('Counter-offer expired');
    }
    if (Math.abs(now - message.counteredAt) > TIMESTAMP_GRACE_SECONDS) {
      throw new Error('counteredAt outside 5-minute tolerance');
    }

    return true;
  }

  /**
   * Compute the canonical hash of a counter-offer (signature stripped).
   *
   * This is the value that should be used for any on-chain anchoring or
   * off-chain dedup keys. Identical counter content → identical hash on
   * any implementation that uses fast-json-stable-stringify.
   */
  computeHash(message: CounterOfferMessage): string {
    const { signature: _sig, ...withoutSig } = message;
    void _sig;
    return keccak256(toUtf8Bytes(canonicalJsonStringify(withoutSig)));
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async signMessage(message: CounterOfferMessage, kernelAddress: string): Promise<string> {
    const domain: EIP712Domain = {
      name: 'AGIRAILS',
      version: '1',
      chainId: message.chainId,
      verifyingContract: kernelAddress,
    };

    const justificationHash = this.computeJustificationHash(message.justification);
    const signed = this.toSignedShape(message, justificationHash);

    // Call as method (preserve `this` binding) — detaching the function ref
    // breaks ethers' Wallet which reaches for `this.signingKey`.
    const signerWithTypedData = this.signer as Signer & {
      signTypedData?: (d: EIP712Domain, t: typeof AIP21CounterOfferTypes, m: Record<string, unknown>) => Promise<string>;
    };
    if (typeof signerWithTypedData.signTypedData === 'function') {
      return signerWithTypedData.signTypedData(domain, AIP21CounterOfferTypes, signed);
    }
    throw new Error('Signer does not support EIP-712 typed data signing');
  }

  private recoverSigner(message: CounterOfferMessage, kernelAddress: string): string {
    const domain: EIP712Domain = {
      name: 'AGIRAILS',
      version: '1',
      chainId: message.chainId,
      verifyingContract: kernelAddress,
    };
    const justificationHash = this.computeJustificationHash(message.justification);
    const signed = this.toSignedShape(message, justificationHash);
    try {
      return verifyTypedData(domain, AIP21CounterOfferTypes, signed, message.signature);
    } catch {
      throw new SignatureVerificationError(message.consumer, 'unknown');
    }
  }

  /** Build the exact object EIP-712 sees (justificationHash field, no inline justification). */
  private toSignedShape(message: CounterOfferMessage, justificationHash: string): Record<string, unknown> {
    return {
      txId: message.txId,
      consumer: message.consumer,
      provider: message.provider,
      quoteAmount: message.quoteAmount,
      counterAmount: message.counterAmount,
      maxPrice: message.maxPrice,
      currency: message.currency,
      decimals: message.decimals,
      inReplyTo: message.inReplyTo,
      counteredAt: message.counteredAt,
      expiresAt: message.expiresAt,
      justificationHash,
      chainId: message.chainId,
      nonce: message.nonce,
    };
  }

  private computeJustificationHash(justification: CounterOfferMessage['justification']): string {
    if (!justification || Object.keys(justification).length === 0) {
      return ZERO_HASH;
    }
    return keccak256(toUtf8Bytes(canonicalJsonStringify(justification)));
  }

  private extractAddressFromDID(did: string): string {
    const parts = did.replace('did:ethr:', '').split(':');
    const address = parts.length === 2 ? parts[1] : parts[0];
    if (!address.startsWith('0x') || address.length !== 42) {
      throw new Error(`Invalid DID format: ${did}`);
    }
    return address;
  }

  private validateParams(params: CounterOfferParams): void {
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.txId)) {
      throw new Error('txId must be valid bytes32 hex string');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.inReplyTo)) {
      throw new Error('inReplyTo must be valid bytes32 hex string (the quote hash)');
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(params.kernelAddress)) {
      throw new Error('kernelAddress must be valid Ethereum address');
    }
    if (!params.consumer.startsWith('did:ethr:')) {
      throw new Error('consumer must be valid did:ethr format');
    }
    if (!params.provider.startsWith('did:ethr:')) {
      throw new Error('provider must be valid did:ethr format');
    }
    if (!VALID_CHAIN_IDS.has(params.chainId)) {
      throw new Error('chainId must be 84532 (Base Sepolia) or 8453 (Base Mainnet)');
    }

    let counter: bigint;
    let quote: bigint;
    let max: bigint;
    try {
      counter = BigInt(params.counterAmount);
      quote = BigInt(params.quoteAmount);
      max = BigInt(params.maxPrice);
    } catch {
      throw new Error('counterAmount, quoteAmount, maxPrice must be numeric strings');
    }

    if (counter < PLATFORM_MIN_BASE_UNITS) {
      throw new Error('counterAmount below platform minimum ($0.05)');
    }
    if (counter >= quote) {
      throw new Error('counterAmount must be strictly less than quoteAmount');
    }
    if (counter > max) {
      throw new Error('counterAmount exceeds maxPrice');
    }

    if (params.expiresAt !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      if (params.expiresAt <= now) {
        throw new Error('expiresAt must be in the future');
      }
      if (params.expiresAt > now + MAX_TTL_SECONDS) {
        throw new Error(`expiresAt cannot be more than ${MAX_TTL_SECONDS}s in the future`);
      }
    }
  }

  private validateMessageSchema(message: CounterOfferMessage): void {
    if (message.type !== MESSAGE_TYPE) {
      throw new Error(`Invalid message type (expected ${MESSAGE_TYPE}, got ${message.type})`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(message.version)) {
      throw new Error('Invalid version format');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(message.txId)) {
      throw new Error('Invalid txId format');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(message.inReplyTo)) {
      throw new Error('Invalid inReplyTo format');
    }
    if (!message.consumer.startsWith('did:ethr:')) {
      throw new Error('Invalid consumer DID format');
    }
    if (!message.provider.startsWith('did:ethr:')) {
      throw new Error('Invalid provider DID format');
    }
    if (!/^\d+$/.test(message.counterAmount)) {
      throw new Error('Invalid counterAmount format');
    }
    if (!/^\d+$/.test(message.quoteAmount)) {
      throw new Error('Invalid quoteAmount format');
    }
    if (!/^\d+$/.test(message.maxPrice)) {
      throw new Error('Invalid maxPrice format');
    }
    if (message.currency !== 'USDC') {
      throw new Error('Only USDC currency is supported');
    }
    if (message.decimals !== 6) {
      throw new Error('USDC must use 6 decimals');
    }
    if (!VALID_CHAIN_IDS.has(message.chainId)) {
      throw new Error('Invalid chainId');
    }
    if (!/^0x[a-fA-F0-9]{130}$/.test(message.signature)) {
      throw new Error('Invalid signature format');
    }
  }
}
