/**
 * verifyQuoteOnChain — tests both matchers (canonical AIP-2 + legacy
 * Agent.ts:1035 ad-hoc shape) and the source tagging.
 */

import { Wallet, HDNodeWallet, keccak256, toUtf8Bytes } from 'ethers';
import { QuoteBuilder } from '../builders/QuoteBuilder';
import { InMemoryNonceManager } from '../utils/NonceManager';
import { verifyQuoteHashOnChain } from './verifyQuoteOnChain';

const KERNEL = '0x1234567890123456789012345678901234567890';
const TX_ID = '0x' + 'a'.repeat(64);

async function buildCanonicalQuote(signer: HDNodeWallet) {
  const b = new QuoteBuilder(signer, new InMemoryNonceManager());
  return b.build({
    txId: TX_ID,
    provider: `did:ethr:84532:${signer.address}`,
    consumer: 'did:ethr:84532:0x2222222222222222222222222222222222222222',
    quotedAmount: '7000000',
    originalAmount: '5000000',
    maxPrice: '10000000',
    chainId: 84532,
    kernelAddress: KERNEL,
  });
}

describe('verifyQuoteHashOnChain', () => {
  it('matches the canonical AIP-2 hash with source=aip2', async () => {
    const signer = Wallet.createRandom();
    const quote = await buildCanonicalQuote(signer);
    const builder = new QuoteBuilder(Wallet.createRandom(), new InMemoryNonceManager());
    const expected = builder.computeHash(quote);

    const result = verifyQuoteHashOnChain(quote, expected);
    expect(result.match).toBe(true);
    expect(result.source).toBe('aip2');
    expect(result.canonicalHash).toBe(expected);
  });

  it('matches the legacy ad-hoc hash with source=legacy', async () => {
    // Replicate Agent.ts:1035-1038 hash: keccak256(JSON.stringify({
    //   txId, providerIdealPrice, actualEscrow, provider
    // }))
    const signer = Wallet.createRandom();
    const quote = await buildCanonicalQuote(signer);
    const providerAddress = signer.address;
    const actualEscrow = '5000000'; // tx.amount at QUOTED time

    const legacyShape = {
      txId: quote.txId,
      providerIdealPrice: quote.quotedAmount,
      actualEscrow,
      provider: providerAddress,
    };
    const legacyHash = keccak256(toUtf8Bytes(JSON.stringify(legacyShape)));

    const result = verifyQuoteHashOnChain(quote, legacyHash, {
      providerAddress,
      actualEscrow,
    });
    expect(result.match).toBe(true);
    expect(result.source).toBe('legacy');
    expect(result.legacyHash).toBe(legacyHash);
  });

  it('returns no match when hash does not correspond to either format', async () => {
    const signer = Wallet.createRandom();
    const quote = await buildCanonicalQuote(signer);
    const garbage = '0x' + 'f'.repeat(64);
    const result = verifyQuoteHashOnChain(quote, garbage, {
      providerAddress: signer.address,
      actualEscrow: '5000000',
    });
    expect(result.match).toBe(false);
    expect(result.source).toBeUndefined();
  });

  it('skips legacy attempt when providerAddress/actualEscrow not provided', async () => {
    // Without legacy inputs, only canonical is tried. A hash that would
    // legacy-match but not canonical-match → no match.
    const signer = Wallet.createRandom();
    const quote = await buildCanonicalQuote(signer);
    const legacyShape = {
      txId: quote.txId,
      providerIdealPrice: quote.quotedAmount,
      actualEscrow: '5000000',
      provider: signer.address,
    };
    const legacyHash = keccak256(toUtf8Bytes(JSON.stringify(legacyShape)));

    const result = verifyQuoteHashOnChain(quote, legacyHash);
    expect(result.match).toBe(false);
    expect(result.canonicalHash).toBeDefined();
    expect(result.legacyHash).toBeUndefined();
  });

  it('canonical hash is signer-independent (any QuoteBuilder yields same hash)', async () => {
    const signer = Wallet.createRandom();
    const quote = await buildCanonicalQuote(signer);

    const hasher1 = new QuoteBuilder(Wallet.createRandom(), new InMemoryNonceManager());
    const hasher2 = new QuoteBuilder(Wallet.createRandom(), new InMemoryNonceManager());
    expect(hasher1.computeHash(quote)).toBe(hasher2.computeHash(quote));
  });
});
