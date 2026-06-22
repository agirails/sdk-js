/**
 * P2-6 — EvaluatorClient unit tests (TS side).
 *
 * Mirrors python-sdk-v2/tests/test_dispute/test_evaluator_client.py 1:1 and
 * consumes the SAME shared cross-SDK fixture
 * `DISPUTE SYSTEM/test-vectors/evaluator-client-vectors.json`.
 *
 * Proves, with mocked HTTP (no live evaluator, no live chain):
 *   1. §4.7 signature verification replicated client-side — 2-valid+1-unknown
 *      passes, two fixed pass, duplicate counted once, duplicate-under-threshold
 *      fails, stale fails, one-valid+unknown fails. (PARITY: the Py twin asserts
 *      the IDENTICAL fixture rows and recovers the SAME signers.)
 *   2. selectThirdEvaluator matches §4.7 step 4 (keccak(abi.encode(disputeId)) % len).
 *   3. requestEvaluation runs the full STEP 0→5 handshake: POST /quote (declare,
 *      no money) → 402 → pay via the injected x402 buyer stub → POST /evaluate →
 *      parse signed response → §4.7 verify → return signed result.
 *   4. A proposeDirectly evaluate response surfaces a no-sig recommendation.
 *   5. A signed response that FAILS §4.7 downgrades to a proposeDirectly
 *      recommendation with NO signatures (never fabricates a signature).
 *   6. The client NEVER submits on-chain (no contract is constructed).
 */

import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { getEncoding } from 'js-tiktoken';

import {
  EvaluatorClient,
  EvaluatorPaymentClient,
  verifyRulingSignatures,
  selectThirdEvaluator,
  QuoteRejectedError,
} from '../src/dispute/EvaluatorClient';
import {
  bundleHash as computeBundleHash,
  setBundleTokenizer,
  EvidenceBundle,
} from '../src/dispute/EvidenceBundle';
import { recoverRulingSigner, AIRuling } from '../src/types/dispute';

// Inject the frozen cl100k_base tokenizer (OQ-9) once for the suite.
beforeAll(() => {
  setBundleTokenizer(getEncoding('cl100k_base'));
});

// PARITY: test_evaluator_client.py — same fixtures, same assertions, same signers.
const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors');
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(VECTORS_DIR, 'evaluator-client-vectors.json'), 'utf-8')
);
const BUNDLE_VECTORS = JSON.parse(
  fs.readFileSync(path.join(VECTORS_DIR, 'bundle-vectors.json'), 'utf-8')
);

const DOMAIN = FIXTURE.domain as {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
};
const RULING = FIXTURE.ruling as AIRuling;
const REGISTRY = FIXTURE.registry as {
  fixedEvaluators: string[];
  rotatingPool: string[];
  selectedRotatingEvaluator: string;
  unknownSigner: string;
  freshnessSeconds: number;
};
const SIGS = FIXTURE.signatures as Record<string, string>;

// =====================================================================
// 1. §4.7 signature verification (pure — consumes the static golden fixture)
// =====================================================================

describe('EvaluatorClient — §4.7 signature verification (cross-SDK fixture)', () => {
  it('digest of the golden ruling matches the GOLDEN_DIGEST anchor', () => {
    const types = {
      AIRuling: [
        { name: 'disputeId', type: 'bytes32' },
        { name: 'ruling', type: 'uint8' },
        { name: 'confidence', type: 'uint16' },
        { name: 'splitBps', type: 'uint16' },
        { name: 'timestamp', type: 'uint64' },
        { name: 'reasoningHash', type: 'bytes32' },
        { name: 'bundleHash', type: 'bytes32' },
      ],
    };
    expect(ethers.TypedDataEncoder.hash(DOMAIN, types, RULING as any)).toBe(
      FIXTURE.expectedDigest
    );
  });

  it('recovers the EXACT fixture signers for each signature (PARITY anchor)', () => {
    const rec = (key: string) =>
      recoverRulingSigner(RULING, SIGS[key], DOMAIN.chainId, DOMAIN.verifyingContract);
    expect(rec('fixedA').toLowerCase()).toBe(REGISTRY.fixedEvaluators[0].toLowerCase());
    expect(rec('fixedB').toLowerCase()).toBe(REGISTRY.fixedEvaluators[1].toLowerCase());
    expect(rec('rotating').toLowerCase()).toBe(
      REGISTRY.selectedRotatingEvaluator.toLowerCase()
    );
    expect(rec('unknown').toLowerCase()).toBe(REGISTRY.unknownSigner.toLowerCase());
  });

  it('selectThirdEvaluator matches §4.7 step 4 (keccak(abi.encode(disputeId)) % len)', () => {
    expect(selectThirdEvaluator(RULING.disputeId, REGISTRY.rotatingPool)?.toLowerCase()).toBe(
      REGISTRY.selectedRotatingEvaluator.toLowerCase()
    );
    expect(selectThirdEvaluator(RULING.disputeId, [])).toBeUndefined();
  });

  const cases = FIXTURE.verificationCases as Record<
    string,
    { sigKeys: string[]; now: number; expectValid: boolean; expectValidCount: number; expectStale?: boolean }
  >;

  for (const [name, c] of Object.entries(cases)) {
    if (name.startsWith('_')) continue; // skip the fixture _comment key
    it(`§4.7 case "${name}" → valid=${c.expectValid}, count=${c.expectValidCount}`, () => {
      const signatures = c.sigKeys.map((k) => SIGS[k]);
      const v = verifyRulingSignatures(RULING, signatures, {
        chainId: DOMAIN.chainId,
        verifyingContract: DOMAIN.verifyingContract,
        fixedEvaluators: REGISTRY.fixedEvaluators,
        rotatingPool: REGISTRY.rotatingPool,
        now: c.now,
        freshnessSeconds: REGISTRY.freshnessSeconds,
      });
      expect(v.valid).toBe(c.expectValid);
      expect(v.validCount).toBe(c.expectValidCount);
      if (c.expectStale !== undefined) expect(v.stale).toBe(c.expectStale);
      expect(v.thirdEvaluator.toLowerCase()).toBe(
        REGISTRY.selectedRotatingEvaluator.toLowerCase()
      );
    });
  }
});

// =====================================================================
// 2. Full handshake (mocked /quote + injected x402 buyer stub)
// =====================================================================

/** Example A bundle from the shared bundle-vectors fixture (valid, hashes deterministically). */
const EXAMPLE_A_BUNDLE: EvidenceBundle = BUNDLE_VECTORS.vectors[0].bundle;
const EXAMPLE_A_HASH = computeBundleHash(EXAMPLE_A_BUNDLE, { skipTokenCheck: true });

const TEST_KEYS = {
  fixedA: '0x' + '11'.repeat(32),
  fixedB: '0x' + '22'.repeat(32),
  rotating: '0x' + '33'.repeat(32),
};
const RULING_TYPES = {
  AIRuling: [
    { name: 'disputeId', type: 'bytes32' },
    { name: 'ruling', type: 'uint8' },
    { name: 'confidence', type: 'uint16' },
    { name: 'splitBps', type: 'uint16' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'reasoningHash', type: 'bytes32' },
    { name: 'bundleHash', type: 'bytes32' },
  ],
};

/** Build a signed ruling for Example A's bundle at a chosen timestamp, signed by chosen keys. */
async function buildSignedRulingForExampleA(
  timestamp: number,
  signerKeys: string[]
): Promise<{ ruling: AIRuling; signatures: string[] }> {
  const ruling: AIRuling = {
    disputeId: RULING.disputeId, // same disputeId so the rotating selection holds
    ruling: 1,
    confidence: 9500,
    splitBps: 0,
    timestamp,
    reasoningHash: RULING.reasoningHash,
    bundleHash: EXAMPLE_A_HASH, // OQ-10: ruling commits the bundle we send
  };
  const signatures: string[] = [];
  for (const pk of signerKeys) {
    const w = new ethers.Wallet(pk);
    signatures.push(await w.signTypedData(DOMAIN, RULING_TYPES, ruling as any));
  }
  return { ruling, signatures };
}

/** A stub x402 buyer that records the /evaluate POST and returns a canned 200 response. */
function makePaymentStub(evaluateBody: unknown): {
  client: EvaluatorPaymentClient;
  calls: Array<{ to: string; httpMethod?: string; httpBody?: string; metadata?: any }>;
} {
  const calls: Array<{ to: string; httpMethod?: string; httpBody?: string; metadata?: any }> = [];
  const client: EvaluatorPaymentClient = {
    async pay(params) {
      calls.push({
        to: params.to,
        httpMethod: params.httpMethod,
        httpBody: typeof params.httpBody === 'string' ? params.httpBody : undefined,
        metadata: params.metadata,
      });
      const response = new Response(JSON.stringify(evaluateBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      return { response };
    },
  };
  return { client, calls };
}

/** A mock /quote fetch that returns the fixture 402 quote body. */
function makeQuoteFetch(quoteBody: unknown, status = 402): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: any }>;
} {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(quoteBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE_PARAMS = {
  bundle: EXAMPLE_A_BUNDLE,
  disputeId: RULING.disputeId,
  payer: '0x1DC48019D708f3d7f1adCAAfA2Ffa198A6897E8d',
  escrowAmount: '5000000',
  tier: 0,
  bundleSource: { cid: 'bafyExampleACid' },
  chainId: DOMAIN.chainId,
  verifyingContract: DOMAIN.verifyingContract,
  fixedEvaluators: REGISTRY.fixedEvaluators as [string, string],
  rotatingPool: REGISTRY.rotatingPool,
  freshnessSeconds: REGISTRY.freshnessSeconds,
};

describe('EvaluatorClient — full STEP 0→5 handshake (mocked HTTP)', () => {
  it('signed path: declares, pays via x402 stub, verifies §4.7, returns signed ruling', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { ruling, signatures } = await buildSignedRulingForExampleA(now, [
      TEST_KEYS.fixedA,
      TEST_KEYS.rotating,
    ]);
    const evaluateBody = {
      apiVersion: '1.0.0',
      outcome: 'signed',
      bundleHash: EXAMPLE_A_HASH,
      tokenCount: 419,
      ruling: { ...ruling, disputeId: ruling.disputeId },
      signatures,
      evaluators: ['0xLyingEvaluator', '0xAlsoLying'], // advisory; MUST be ignored
      reasoning: 'requester wins',
    };

    const quote = makeQuoteFetch(FIXTURE.quoteResponse);
    const pay = makePaymentStub(evaluateBody);
    const client = new EvaluatorClient({
      baseUrl: 'https://evaluator.test',
      paymentClient: pay.client,
      fetchImpl: quote.fetchImpl,
    });

    const result = await client.requestEvaluation(BASE_PARAMS);

    // STEP 0: declared to /quote with the SDK-derived bundleHash (no money).
    expect(quote.calls).toHaveLength(1);
    expect(quote.calls[0].url).toBe('https://evaluator.test/quote');
    expect(quote.calls[0].body.bundleHash).toBe(EXAMPLE_A_HASH);
    expect(quote.calls[0].body.payer).toBe(BASE_PARAMS.payer);

    // STEP 2: paid via the x402 buyer stub against /evaluate, echoing the nonce.
    expect(pay.calls).toHaveLength(1);
    expect(pay.calls[0].to).toBe('https://evaluator.test/evaluate');
    expect(pay.calls[0].httpMethod).toBe('POST');
    expect(pay.calls[0].metadata?.paymentMethod).toBe('x402');
    expect(JSON.parse(pay.calls[0].httpBody!).disputeNonce).toBe(
      FIXTURE.quoteResponse.disputeNonce
    );

    // STEP 5: signed result, §4.7 PASSED, signers re-recovered (evaluators[] ignored).
    expect(result.outcome).toBe('signed');
    if (result.outcome !== 'signed') throw new Error('unreachable');
    expect(result.verification.valid).toBe(true);
    expect(result.verification.validCount).toBe(2);
    expect(result.signatures).toEqual(signatures);
    expect(Number(result.ruling.ruling)).toBe(1);
    expect(result.ruling.bundleHash.toLowerCase()).toBe(EXAMPLE_A_HASH.toLowerCase());
  });

  it('proposeDirectly path: surfaces a no-sig recommendation', async () => {
    const evaluateBody = {
      ...FIXTURE.evaluateProposeDirectlyResponse,
      bundleHash: EXAMPLE_A_HASH, // echo the bundle we send (OQ-10)
    };
    const quote = makeQuoteFetch(FIXTURE.quoteResponse);
    const pay = makePaymentStub(evaluateBody);
    const client = new EvaluatorClient({
      baseUrl: 'https://evaluator.test',
      paymentClient: pay.client,
      fetchImpl: quote.fetchImpl,
    });

    const result = await client.requestEvaluation(BASE_PARAMS);
    expect(result.outcome).toBe('proposeDirectly');
    if (result.outcome !== 'proposeDirectly') throw new Error('unreachable');
    expect(result.reason).toBe('server-recommended');
    expect(result.recommendation.ruling).toBe(2);
    expect(result.recommendation.splitBps).toBe(5000);
    // No `signatures` field is exposed on the proposeDirectly result at all.
    expect((result as any).signatures).toBeUndefined();
  });

  it('signed-but-stale: downgrades to proposeDirectly with NO signatures', async () => {
    // Sign with valid evaluators but a timestamp older than the freshness window.
    const staleTs = Math.floor(Date.now() / 1000) - (REGISTRY.freshnessSeconds + 10);
    const { ruling, signatures } = await buildSignedRulingForExampleA(staleTs, [
      TEST_KEYS.fixedA,
      TEST_KEYS.fixedB,
    ]);
    const evaluateBody = {
      apiVersion: '1.0.0',
      outcome: 'signed',
      bundleHash: EXAMPLE_A_HASH,
      tokenCount: 419,
      ruling,
      signatures,
    };
    const quote = makeQuoteFetch(FIXTURE.quoteResponse);
    const pay = makePaymentStub(evaluateBody);
    const client = new EvaluatorClient({
      baseUrl: 'https://evaluator.test',
      paymentClient: pay.client,
      fetchImpl: quote.fetchImpl,
    });

    const result = await client.requestEvaluation(BASE_PARAMS);
    expect(result.outcome).toBe('proposeDirectly');
    if (result.outcome !== 'proposeDirectly') throw new Error('unreachable');
    expect(result.reason).toBe('verification-failed');
    expect(result.verification?.stale).toBe(true);
    expect((result as any).signatures).toBeUndefined(); // never fabricated/surfaced
  });

  it('signed-but-insufficient: one valid + one unknown → proposeDirectly (no sigs)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { ruling, signatures } = await buildSignedRulingForExampleA(now, [
      TEST_KEYS.fixedA,
      '0x' + '44'.repeat(32), // unknown signer
    ]);
    const evaluateBody = {
      apiVersion: '1.0.0',
      outcome: 'signed',
      bundleHash: EXAMPLE_A_HASH,
      tokenCount: 419,
      ruling,
      signatures,
    };
    const quote = makeQuoteFetch(FIXTURE.quoteResponse);
    const pay = makePaymentStub(evaluateBody);
    const client = new EvaluatorClient({
      baseUrl: 'https://evaluator.test',
      paymentClient: pay.client,
      fetchImpl: quote.fetchImpl,
    });

    const result = await client.requestEvaluation(BASE_PARAMS);
    expect(result.outcome).toBe('proposeDirectly');
    if (result.outcome !== 'proposeDirectly') throw new Error('unreachable');
    expect(result.reason).toBe('verification-failed');
    expect(result.verification?.validCount).toBe(1);
  });

  it('quote rejected (413 BundleTooLargeError envelope) → QuoteRejectedError', async () => {
    const errorEnvelope = {
      apiVersion: '1.0.0',
      error: { code: 'BundleTooLargeError', message: 'Pinned bundle is 142113 tokens; cap 100000.' },
    };
    const quote = makeQuoteFetch(errorEnvelope, 413);
    const pay = makePaymentStub({});
    const client = new EvaluatorClient({
      baseUrl: 'https://evaluator.test',
      paymentClient: pay.client,
      fetchImpl: quote.fetchImpl,
    });

    await expect(client.requestEvaluation(BASE_PARAMS)).rejects.toMatchObject({
      name: 'QuoteRejectedError',
      status: 413,
      code: 'BundleTooLargeError',
    });
    // Never paid — the x402 stub was not invoked.
    expect(pay.calls).toHaveLength(0);
  });

  it('throws QuoteRejectedError when /quote returns a non-402 status', async () => {
    const quote = makeQuoteFetch({ error: { code: 'PricingUnavailableError' } }, 503);
    const pay = makePaymentStub({});
    const client = new EvaluatorClient({
      baseUrl: 'https://evaluator.test',
      paymentClient: pay.client,
      fetchImpl: quote.fetchImpl,
    });
    await expect(client.requestEvaluation(BASE_PARAMS)).rejects.toBeInstanceOf(
      QuoteRejectedError
    );
  });
});
