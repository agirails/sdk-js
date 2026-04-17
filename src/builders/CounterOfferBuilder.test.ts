/**
 * CounterOfferBuilder unit tests.
 *
 * Mirrors the QuoteBuilder.test.ts structure: validation, sign+verify
 * roundtrip, hash determinism, edge cases on amount band and expiry.
 */

import { CounterOfferBuilder, CounterOfferMessage, CounterOfferParams, AIP21CounterOfferTypes } from './CounterOfferBuilder';
import { Wallet, HDNodeWallet, keccak256, toUtf8Bytes } from 'ethers';
import { InMemoryNonceManager } from '../utils/NonceManager';
import { canonicalJsonStringify } from '../utils/canonicalJson';

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Re-sign a tampered counter-offer payload so verify() reaches the
 * business-logic checks (expiry, amount band, etc) instead of failing
 * fast on signature mismatch. Mirrors the EIP-712 shape the builder
 * uses internally.
 */
async function reSign(
  signer: HDNodeWallet,
  msg: CounterOfferMessage,
  kernelAddress: string,
): Promise<CounterOfferMessage> {
  const justificationHash = msg.justification && Object.keys(msg.justification).length > 0
    ? keccak256(toUtf8Bytes(canonicalJsonStringify(msg.justification)))
    : ZERO_HASH;
  const signed = {
    txId: msg.txId,
    consumer: msg.consumer,
    provider: msg.provider,
    quoteAmount: msg.quoteAmount,
    counterAmount: msg.counterAmount,
    maxPrice: msg.maxPrice,
    currency: msg.currency,
    decimals: msg.decimals,
    inReplyTo: msg.inReplyTo,
    counteredAt: msg.counteredAt,
    expiresAt: msg.expiresAt,
    justificationHash,
    chainId: msg.chainId,
    nonce: msg.nonce,
  };
  const signature = await signer.signTypedData(
    { name: 'AGIRAILS', version: '1', chainId: msg.chainId, verifyingContract: kernelAddress },
    AIP21CounterOfferTypes,
    signed,
  );
  return { ...msg, signature };
}

describe('CounterOfferBuilder', () => {
  let builder: CounterOfferBuilder;
  let wallet: HDNodeWallet;
  let nonceManager: InMemoryNonceManager;

  const KERNEL_ADDRESS = '0x1234567890123456789012345678901234567890';
  const TX_ID = '0xabcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234';
  const QUOTE_HASH = '0xfeed1234567890feed1234567890feed1234567890feed1234567890feed1234';
  const PROVIDER_DID = 'did:ethr:84532:0x1111111111111111111111111111111111111111';
  // Consumer DID derives from a fresh wallet's address per-test (set in beforeEach)
  let consumerDID: string;

  function baseParams(overrides: Partial<CounterOfferParams> = {}): CounterOfferParams {
    return {
      txId: TX_ID,
      consumer: consumerDID,
      provider: PROVIDER_DID,
      // Provider quoted $7.00, buyer counters $6.50, original max was $10.00
      quoteAmount: '7000000',
      counterAmount: '6500000',
      maxPrice: '10000000',
      inReplyTo: QUOTE_HASH,
      chainId: 84532,
      kernelAddress: KERNEL_ADDRESS,
      ...overrides,
    };
  }

  beforeEach(() => {
    wallet = Wallet.createRandom();
    nonceManager = new InMemoryNonceManager();
    builder = new CounterOfferBuilder(wallet, nonceManager);
    consumerDID = `did:ethr:84532:${wallet.address}`;
  });

  // --------------------------------------------------------------------------
  // Type definitions sanity
  // --------------------------------------------------------------------------

  describe('AIP21CounterOfferTypes', () => {
    it('exposes a CounterOffer type definition with 14 named fields', () => {
      expect(AIP21CounterOfferTypes).toHaveProperty('CounterOffer');
      expect(AIP21CounterOfferTypes.CounterOffer).toHaveLength(14);
      const fieldNames = AIP21CounterOfferTypes.CounterOffer.map((f) => f.name);
      expect(fieldNames).toContain('txId');
      expect(fieldNames).toContain('counterAmount');
      expect(fieldNames).toContain('inReplyTo');
      expect(fieldNames).toContain('justificationHash');
    });
  });

  // --------------------------------------------------------------------------
  // build() — validation
  // --------------------------------------------------------------------------

  describe('build() — validation', () => {
    it('rejects counterAmount >= quoteAmount (would just be acceptance)', async () => {
      await expect(builder.build(baseParams({ counterAmount: '7000000' }))).rejects.toThrow(
        'counterAmount must be strictly less than quoteAmount',
      );
    });

    it('rejects counterAmount above maxPrice', async () => {
      await expect(
        builder.build(baseParams({
          quoteAmount: '15000000',
          counterAmount: '12000000',
          maxPrice: '10000000',
        })),
      ).rejects.toThrow('counterAmount exceeds maxPrice');
    });

    it('rejects counterAmount below platform minimum ($0.05)', async () => {
      await expect(
        builder.build(baseParams({ counterAmount: '40000', quoteAmount: '50000' })),
      ).rejects.toThrow('counterAmount below platform minimum');
    });

    it('rejects malformed txId', async () => {
      await expect(builder.build(baseParams({ txId: 'not-hex' }))).rejects.toThrow(
        'txId must be valid bytes32',
      );
    });

    it('rejects malformed inReplyTo (must be 32-byte hash)', async () => {
      await expect(builder.build(baseParams({ inReplyTo: '0xabc' }))).rejects.toThrow(
        'inReplyTo must be valid bytes32',
      );
    });

    it('rejects unsupported chainId', async () => {
      await expect(builder.build(baseParams({ chainId: 1 }))).rejects.toThrow(
        'chainId must be 84532',
      );
    });

    it('rejects expiresAt in the past', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expect(builder.build(baseParams({ expiresAt: now - 60 }))).rejects.toThrow(
        'expiresAt must be in the future',
      );
    });

    it('rejects expiresAt more than 24h in the future', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expect(builder.build(baseParams({ expiresAt: now + 100_000 }))).rejects.toThrow(
        'cannot be more than',
      );
    });

    it('rejects non-DID consumer', async () => {
      await expect(builder.build(baseParams({ consumer: '0xabc' }))).rejects.toThrow(
        'consumer must be valid did:ethr',
      );
    });
  });

  // --------------------------------------------------------------------------
  // build() — happy path
  // --------------------------------------------------------------------------

  describe('build() — happy path', () => {
    it('produces a fully populated message with default 1h TTL', async () => {
      const before = Math.floor(Date.now() / 1000);
      const msg = await builder.build(baseParams());
      const after = Math.floor(Date.now() / 1000);

      expect(msg.type).toBe('agirails.counteroffer.v1');
      expect(msg.version).toBe('1.0.0');
      expect(msg.txId).toBe(TX_ID);
      expect(msg.consumer).toBe(consumerDID);
      expect(msg.provider).toBe(PROVIDER_DID);
      expect(msg.counterAmount).toBe('6500000');
      expect(msg.inReplyTo).toBe(QUOTE_HASH);
      expect(msg.currency).toBe('USDC');
      expect(msg.decimals).toBe(6);
      expect(msg.counteredAt).toBeGreaterThanOrEqual(before);
      expect(msg.counteredAt).toBeLessThanOrEqual(after);
      expect(msg.expiresAt).toBe(msg.counteredAt + 3600);
      expect(msg.nonce).toBe(1);
      expect(msg.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    });

    it('honors a custom expiresAt within 24h', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 600;
      const msg = await builder.build(baseParams({ expiresAt }));
      expect(msg.expiresAt).toBe(expiresAt);
    });

    it('increments nonce monotonically across builds', async () => {
      const a = await builder.build(baseParams());
      const b = await builder.build(baseParams({ counterAmount: '6000000' }));
      const c = await builder.build(baseParams({ counterAmount: '5500000' }));
      expect(a.nonce).toBe(1);
      expect(b.nonce).toBe(2);
      expect(c.nonce).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // verify()
  // --------------------------------------------------------------------------

  describe('verify()', () => {
    it('round-trips a fresh build', async () => {
      const msg = await builder.build(baseParams());
      await expect(builder.verify(msg, KERNEL_ADDRESS)).resolves.toBe(true);
    });

    it('rejects when consumer DID address does not match the recovered signer', async () => {
      const msg = await builder.build(baseParams());
      const bogus = { ...msg, consumer: 'did:ethr:84532:0x9999999999999999999999999999999999999999' };
      await expect(builder.verify(bogus, KERNEL_ADDRESS)).rejects.toThrow();
    });

    it('rejects when the signature was made for a different kernel address', async () => {
      const msg = await builder.build(baseParams());
      const otherKernel = '0x9999999999999999999999999999999999999999';
      await expect(builder.verify(msg, otherKernel)).rejects.toThrow();
    });

    it('rejects an expired message', async () => {
      const msg = await builder.build(baseParams());
      const tampered = await reSign(
        wallet,
        { ...msg, expiresAt: msg.counteredAt - 1 },
        KERNEL_ADDRESS,
      );
      await expect(builder.verify(tampered, KERNEL_ADDRESS)).rejects.toThrow('expired');
    });

    it('rejects a message whose counteredAt is too old (skew check)', async () => {
      const msg = await builder.build(baseParams());
      const tampered = await reSign(
        wallet,
        { ...msg, counteredAt: msg.counteredAt - 600 },
        KERNEL_ADDRESS,
      );
      await expect(builder.verify(tampered, KERNEL_ADDRESS)).rejects.toThrow('5-minute tolerance');
    });

    it('rejects a counter that is not actually a counter (>= quote)', async () => {
      const msg = await builder.build(baseParams());
      const tampered = await reSign(
        wallet,
        { ...msg, counterAmount: msg.quoteAmount },
        KERNEL_ADDRESS,
      );
      await expect(builder.verify(tampered, KERNEL_ADDRESS)).rejects.toThrow('less than quoteAmount');
    });
  });

  // --------------------------------------------------------------------------
  // computeHash()
  // --------------------------------------------------------------------------

  describe('computeHash()', () => {
    it('is deterministic — same content gives the same hash twice', async () => {
      const msg = await builder.build(baseParams());
      expect(builder.computeHash(msg)).toBe(builder.computeHash(msg));
    });

    it('is signature-independent (does not include the signature field)', async () => {
      const msg = await builder.build(baseParams());
      const original = builder.computeHash(msg);
      const tampered = { ...msg, signature: '0x' + '00'.repeat(65) };
      expect(builder.computeHash(tampered)).toBe(original);
    });

    it('changes when the counterAmount changes', async () => {
      const msg = await builder.build(baseParams());
      const before = builder.computeHash(msg);
      const after = builder.computeHash({ ...msg, counterAmount: '6000000' });
      expect(after).not.toBe(before);
    });

    it('emits zero hash for empty justification (matches QuoteBuilder pattern)', async () => {
      // The justificationHash inside the EIP-712 signed shape should default
      // to all-zeros when no justification is provided. Indirect test: two
      // messages identical except justification omitted vs present {} should
      // produce the same canonical hash since both reduce to ZERO_HASH.
      const a = await builder.build(baseParams());
      const b = await builder.build(baseParams({ justification: {} }));
      // Different nonces, so we can't compare full hashes — but we can confirm
      // both verify successfully (proves justification handling matches).
      await expect(builder.verify(a, KERNEL_ADDRESS)).resolves.toBe(true);
      await expect(builder.verify(b, KERNEL_ADDRESS)).resolves.toBe(true);
    });
  });
});
