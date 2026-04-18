/**
 * CounterAcceptBuilder — AIP-2.1 provider's signed acceptance of a
 * buyer's counter-offer.
 *
 * Closes the non-repudiation gap noted in AIP-2.1-DRAFT §8: the
 * counter itself is signed by the buyer; the on-chain `acceptQuote`
 * call by the buyer pins the price; but until now there was no
 * signed surface for the provider to *commit* to the counter
 * off-chain. Without this, a buyer who calls acceptQuote(counter)
 * has no cryptographic record of provider agreement, only "they
 * didn't reject within TTL".
 *
 * Mirrors CounterOfferBuilder shape — same EIP-712 domain, same
 * canonical JSON hashing, signer-independent verification.
 *
 * @module builders/CounterAcceptBuilder
 * @see Protocol/aips/AIP-2.1-DRAFT.md §8 (acceptance signal)
 * @see src/builders/CounterOfferBuilder.ts (sibling, buyer side)
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
 * Provider-signed acceptance of a buyer's counter-offer.
 *
 * Carries the counter hash this is responding to (`inReplyTo`) so the
 * buyer's verifier can cryptographically link the acceptance to the
 * exact counter it sent. `acceptedAmount` MUST equal the counter's
 * `counterAmount` — verifier rejects mismatches.
 */
export interface CounterAcceptMessage {
  type: 'agirails.counteraccept.v1';
  version: '1.0.0';
  /** Transaction this acceptance belongs to. */
  txId: string;
  /** Provider DID (signer). */
  provider: string;
  /** Buyer DID (recipient). */
  consumer: string;
  /** Final agreed amount in USDC base units — equals counter.counterAmount. */
  acceptedAmount: string;
  /** Hash of the counter-offer this is replying to (CounterOfferBuilder.computeHash). */
  inReplyTo: string;
  /** Unix seconds when accepted. */
  acceptedAt: number;
  chainId: number;
  nonce: number;
  signature: string;
}

export interface CounterAcceptParams {
  txId: string;
  provider: string;
  consumer: string;
  acceptedAmount: string;
  inReplyTo: string;
  chainId: number;
  kernelAddress: string;
}

export const AIP21CounterAcceptTypes = {
  CounterAccept: [
    { name: 'txId', type: 'bytes32' },
    { name: 'provider', type: 'string' },
    { name: 'consumer', type: 'string' },
    { name: 'acceptedAmount', type: 'string' },
    { name: 'inReplyTo', type: 'bytes32' },
    { name: 'acceptedAt', type: 'uint256' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const MESSAGE_TYPE = 'agirails.counteraccept.v1';
const TIMESTAMP_GRACE_SECONDS = 300;
const VALID_CHAIN_IDS = new Set([84_532, 8_453]);
const PLATFORM_MIN_BASE_UNITS = 50_000n;

// ============================================================================
// Builder
// ============================================================================

export class CounterAcceptBuilder {
  /**
   * `signer` and `nonceManager` are only required for `build()`.
   * `verify()` and `computeHash()` work signer-independent — pass
   * `undefined` to construct a verify-only instance (used by buyer
   * orchestrator when validating a provider's acceptance message).
   */
  constructor(
    private readonly signer?: Signer,
    private readonly nonceManager?: NonceManager,
  ) {}

  async build(params: CounterAcceptParams): Promise<CounterAcceptMessage> {
    if (!this.signer || !this.nonceManager) {
      throw new Error('CounterAcceptBuilder.build requires signer + nonceManager');
    }
    this.validateParams(params);

    const acceptedAt = Math.floor(Date.now() / 1000);

    const message: CounterAcceptMessage = {
      type: MESSAGE_TYPE,
      version: '1.0.0',
      txId: params.txId,
      provider: params.provider,
      consumer: params.consumer,
      acceptedAmount: params.acceptedAmount,
      inReplyTo: params.inReplyTo,
      acceptedAt,
      chainId: params.chainId,
      nonce: this.nonceManager!.getNextNonce(MESSAGE_TYPE),
      signature: '',
    };

    message.signature = await this.signMessage(message, params.kernelAddress);
    this.nonceManager!.recordNonce(MESSAGE_TYPE, message.nonce);

    return message;
  }

  /**
   * Verify provider acceptance:
   *  1. Schema well-formed
   *  2. EIP-712 signature recovers to provider DID's address
   *  3. acceptedAmount ≥ platform minimum (defense)
   *  4. acceptedAt within skew tolerance (one-sided future check)
   *
   * Caller is responsible for additionally checking
   * `acceptedAmount === counter.counterAmount` and
   * `inReplyTo === CounterOfferBuilder.computeHash(counter)` —
   * those bind the acceptance to the buyer's specific counter.
   */
  async verify(message: CounterAcceptMessage, kernelAddress: string): Promise<boolean> {
    this.validateMessageSchema(message);

    const recovered = this.recoverSigner(message, kernelAddress);
    const expected = this.extractAddressFromDID(message.provider);
    if (recovered.toLowerCase() !== expected.toLowerCase()) {
      throw new SignatureVerificationError(message.provider, 'unknown');
    }

    const accepted = BigInt(message.acceptedAmount);
    if (accepted < PLATFORM_MIN_BASE_UNITS) {
      throw new Error('acceptedAmount below platform minimum ($0.05)');
    }

    const now = Math.floor(Date.now() / 1000);
    if (message.acceptedAt > now + TIMESTAMP_GRACE_SECONDS) {
      throw new Error('acceptedAt is in the future beyond skew tolerance');
    }

    return true;
  }

  computeHash(message: CounterAcceptMessage): string {
    const { signature: _sig, ...withoutSig } = message;
    void _sig;
    return keccak256(toUtf8Bytes(canonicalJsonStringify(withoutSig)));
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async signMessage(message: CounterAcceptMessage, kernelAddress: string): Promise<string> {
    const domain: EIP712Domain = {
      name: 'AGIRAILS',
      version: '1',
      chainId: message.chainId,
      verifyingContract: kernelAddress,
    };
    const signed = this.toSignedShape(message);
    const signerWithTypedData = this.signer as Signer & {
      signTypedData?: (d: EIP712Domain, t: typeof AIP21CounterAcceptTypes, m: Record<string, unknown>) => Promise<string>;
    };
    if (typeof signerWithTypedData.signTypedData === 'function') {
      return signerWithTypedData.signTypedData(domain, AIP21CounterAcceptTypes, signed);
    }
    throw new Error('Signer does not support EIP-712 typed data signing');
  }

  private recoverSigner(message: CounterAcceptMessage, kernelAddress: string): string {
    const domain: EIP712Domain = {
      name: 'AGIRAILS',
      version: '1',
      chainId: message.chainId,
      verifyingContract: kernelAddress,
    };
    const signed = this.toSignedShape(message);
    try {
      return verifyTypedData(domain, AIP21CounterAcceptTypes, signed, message.signature);
    } catch {
      throw new SignatureVerificationError(message.provider, 'unknown');
    }
  }

  private toSignedShape(message: CounterAcceptMessage): Record<string, unknown> {
    return {
      txId: message.txId,
      provider: message.provider,
      consumer: message.consumer,
      acceptedAmount: message.acceptedAmount,
      inReplyTo: message.inReplyTo,
      acceptedAt: message.acceptedAt,
      chainId: message.chainId,
      nonce: message.nonce,
    };
  }

  private extractAddressFromDID(did: string): string {
    const parts = did.replace('did:ethr:', '').split(':');
    const address = parts.length === 2 ? parts[1] : parts[0];
    if (!address.startsWith('0x') || address.length !== 42) {
      throw new Error(`Invalid DID format: ${did}`);
    }
    return address;
  }

  private validateParams(params: CounterAcceptParams): void {
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.txId)) {
      throw new Error('txId must be valid bytes32 hex string');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(params.inReplyTo)) {
      throw new Error('inReplyTo must be valid bytes32 hex string (the counter hash)');
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(params.kernelAddress)) {
      throw new Error('kernelAddress must be valid Ethereum address');
    }
    if (!params.provider.startsWith('did:ethr:')) {
      throw new Error('provider must be valid did:ethr format');
    }
    if (!params.consumer.startsWith('did:ethr:')) {
      throw new Error('consumer must be valid did:ethr format');
    }
    if (!VALID_CHAIN_IDS.has(params.chainId)) {
      throw new Error('chainId must be 84532 (Base Sepolia) or 8453 (Base Mainnet)');
    }
    let accepted: bigint;
    try {
      accepted = BigInt(params.acceptedAmount);
    } catch {
      throw new Error('acceptedAmount must be a numeric string');
    }
    if (accepted < PLATFORM_MIN_BASE_UNITS) {
      throw new Error('acceptedAmount below platform minimum ($0.05)');
    }
  }

  private validateMessageSchema(message: CounterAcceptMessage): void {
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
    if (!message.provider.startsWith('did:ethr:')) {
      throw new Error('Invalid provider DID format');
    }
    if (!message.consumer.startsWith('did:ethr:')) {
      throw new Error('Invalid consumer DID format');
    }
    if (!/^\d+$/.test(message.acceptedAmount)) {
      throw new Error('Invalid acceptedAmount format');
    }
    if (!VALID_CHAIN_IDS.has(message.chainId)) {
      throw new Error('Invalid chainId');
    }
    if (!/^0x[a-fA-F0-9]{130}$/.test(message.signature)) {
      throw new Error('Invalid signature format');
    }
  }
}
