import {
  AIRuling,
  Ruling,
  Tier,
  recoverRulingSigner,
} from '../types/dispute';
import { bundleHash as computeBundleHash, EvidenceBundle } from './EvidenceBundle';

// PARITY: python-sdk-v2/src/agirails/dispute/evaluator_client.py
// This file and its Python twin MUST stay 1:1 — every public symbol here
// (EvaluatorClient + its methods, the request/result types, verifyRulingSignatures,
// selectThirdEvaluator, the error classes) has a Py twin with the SAME name
// (snake_case for methods/functions) and arity, and vice-versa. The §4.7
// signature-verification math and the two-phase handshake step order are anchored
// to the shared cross-SDK fixture
// `DISPUTE SYSTEM/test-vectors/evaluator-client-vectors.json`, which both the jest
// and pytest suites consume byte-identically and from which both recover the SAME
// signer addresses. Any change here (rename, new method, verification tweak) must
// be mirrored in the twin.

/**
 * EvaluatorClient — the SDK half of the off-chain dispute-evaluator handshake
 * (PRD P2-6). Targets the FROZEN wire contract
 * `services/dispute-evaluator/API-CONTRACT.md` and the AIP-14 FINAL §4.7
 * 2/3-signature verification spec.
 *
 * It performs the two-phase x402 quote handshake against the evaluator service:
 *
 * ```
 *  STEP 0 DECLARE   client → POST /quote     {bundleHash, declaredTokenCount, ...}   (no money, no LLM)
 *  STEP 1 QUOTE     server → 402             {quote, x402 commit (bundleHash,payer,disputeNonce)}
 *  STEP 2 PAY       client → x402 facilitator (USDC on Base, via the existing X402Adapter buyer stack)
 *  STEP 3 VERIFY    server: receipt valid + settled + SINGLE-USE + identity-bound → CONSUME atomically
 *  STEP 4 RUN       server: 3-eval + 3-screen ensemble (service-internal)
 *  STEP 5 RETURN    server → 200             signed AIRuling(s)  OR  proposeDirectly recommendation
 * ```
 *
 * The payment leg (STEP 2) is delegated to the EXISTING x402 buyer stack
 * ({@link X402Adapter}, see `src/adapters/X402Adapter.ts`): the adapter's `pay()`
 * POSTs to `/evaluate`, transparently consumes the server's own 402, signs the
 * EIP-3009/Permit2 authorization, retries, and returns the settled 200 response.
 * This client never re-implements x402 — it passes the `/evaluate` body through
 * the adapter and parses the returned response body.
 *
 * After receiving an `outcome: "signed"` response, the client REPLICATES the
 * on-chain `_verifyEvaluatorSignatures` logic (§4.7) client-side using the FROZEN
 * {@link recoverRulingSigner}: it independently recovers each signer, matches it
 * against `[fixedEvaluators[0], fixedEvaluators[1], thirdEvaluator]`, counts each
 * once (duplicates ignored, unknown signers ignored), enforces freshness, and
 * requires `validCount >= 2`. It does **NOT** trust the server's advisory
 * `evaluators[]`. If the response is `outcome: "proposeDirectly"` OR the signed
 * response fails §4.7, the client returns a `proposeDirectly` recommendation with
 * NO signatures — it NEVER fabricates a signature and NEVER submits on-chain
 * (the caller does that via {@link BondEscalationClient}).
 *
 * Reference: API-CONTRACT.md §3–§4; AIP-14 FINAL §4.7 (verification), §4.5 (domain),
 * §7.6 (proposeDirectly); INV-16 (2/3 valid sigs), INV-21 (AI never final).
 *
 * @module dispute/EvaluatorClient
 */

// =====================================================================
// Wire / config types (API-CONTRACT.md §2, §3, §4)
// =====================================================================

/** How the server obtains the evidence bundle (API-CONTRACT.md §3.1 `bundleSource`). */
export interface BundleSource {
  /** IPFS CIDv1 the client already pinned (preferred). */
  cid?: string;
  /** base64 of the exact `canonical_bytes` (small bundles). */
  inlineBytesB64?: string;
}

/**
 * Inputs to {@link EvaluatorClient.requestEvaluation}. `bundle` is the logical
 * {@link EvidenceBundle}; the client derives `bundleHash` and `tokenCount` from
 * the FROZEN serializer (it never trusts a caller-supplied hash).
 */
export interface RequestEvaluationParams {
  /** The logical evidence bundle (hashed + token-counted via the frozen serializer). */
  bundle: EvidenceBundle;
  /** On-chain dispute id (bytes32hex) — bound into the quote + ruling. */
  disputeId: string;
  /** The address paying the x402 quote (MUST equal the on-chain dispute submitter). */
  payer: string;
  /** Remaining escrow at dispute time (USDC base units, decimal string). */
  escrowAmount: string;
  /** Dispute tier ({@link Tier}). At Tier-0 evaluation this is `0`. */
  tier: Tier | number;
  /** How the server fetches the bundle (`cid` preferred, or `inlineBytesB64`). */
  bundleSource: BundleSource;
  /** Chain of the verifying BondEscalation contract (EIP-712 `chainId`). */
  chainId: number;
  /** BondEscalation address — the EIP-712 `verifyingContract` the sigs verify against. */
  verifyingContract: string;
  /** Fixed evaluator slots `[0,1]` (from `/v1/meta` or on-chain). Used for §4.7 verification. */
  fixedEvaluators: [string, string] | string[];
  /** The rotating evaluator pool (from `/v1/meta` or on-chain). Used for §4.7 verification. */
  rotatingPool: string[];
  /**
   * On-chain ruling-freshness window in seconds (RULING_FRESHNESS, default 3600).
   * `now > ruling.timestamp + freshnessSeconds` fails §4.7 freshness.
   */
  freshnessSeconds?: number;
}

/** The exact `AIRuling` struct echoed in a signed evaluate response. */
export type EvaluatorRuling = AIRuling;

/**
 * `outcome: "signed"` evaluate response (API-CONTRACT.md §4.3a). The SDK
 * re-recovers signers from `signatures` and does NOT trust `evaluators[]`.
 */
export interface SignedEvaluateResponse {
  apiVersion: string;
  outcome: 'signed';
  bundleHash: string;
  tokenCount: number;
  ruling: EvaluatorRuling;
  signatures: string[];
  evaluators?: string[];
  domain?: { name: string; version: string; chainId: number; verifyingContract: string };
  reasoning?: string;
}

/** A non-binding `proposeDirectly` recommendation (API-CONTRACT.md §4.3b). */
export interface ProposeDirectlyRecommendation {
  /** Suggested ruling (advisory only). */
  ruling: Ruling | number;
  /** Suggested provider share (bps) if `ruling == 2`. */
  splitBps: number;
  /** Confidence in basis points (below the signed threshold). */
  confidence: number;
  /** Human-readable rationale. */
  rationale: string;
}

/**
 * `outcome: "proposeDirectly"` evaluate response (API-CONTRACT.md §4.3b).
 * `signatures` is ALWAYS empty on this path.
 */
export interface ProposeDirectlyEvaluateResponse {
  apiVersion: string;
  outcome: 'proposeDirectly';
  bundleHash: string;
  tokenCount: number;
  recommendation: ProposeDirectlyRecommendation;
  signatures: [];
  reasoning?: string;
}

/** Raw evaluate response (the two mutually-exclusive shapes). */
export type EvaluateResponse = SignedEvaluateResponse | ProposeDirectlyEvaluateResponse;

/**
 * Discriminated result of {@link EvaluatorClient.requestEvaluation}.
 *
 * - `outcome: "signed"` — 2/3 §4.7 verification PASSED. Carries the FROZEN
 *   {@link AIRuling} + the 2–3 verified signatures the caller submits via
 *   `BondEscalationClient.submitAIRuling`. The SDK has already re-recovered the
 *   signers; `verification` records the §4.7 result.
 * - `outcome: "proposeDirectly"` — either the server returned a recommendation,
 *   OR a signed response FAILED §4.7 (insufficient valid sigs / stale). NO
 *   signatures are surfaced; the caller may call `BondEscalationClient.proposeDirectly`
 *   themselves. The SDK NEVER fabricates a signature here.
 */
export type EvaluationResult =
  | {
      outcome: 'signed';
      ruling: AIRuling;
      signatures: string[];
      verification: RulingVerification;
      tokenCount: number;
      reasoning?: string;
    }
  | {
      outcome: 'proposeDirectly';
      recommendation: ProposeDirectlyRecommendation;
      /** Why the SDK fell back here: server recommended it, or signed verification failed. */
      reason: 'server-recommended' | 'verification-failed';
      verification?: RulingVerification;
      tokenCount?: number;
      reasoning?: string;
    };

/** Result of replicating the §4.7 `_verifyEvaluatorSignatures` logic client-side. */
export interface RulingVerification {
  /** Whether the §4.7 threshold (`validCount >= 2`) AND freshness both hold. */
  valid: boolean;
  /** How many DISTINCT registered evaluators signed (duplicates counted once). */
  validCount: number;
  /** The signer addresses that matched a registered evaluator (deduped, in seen order). */
  recoveredSigners: string[];
  /** The rotating evaluator selected for this disputeId (§4.7 step 4). */
  thirdEvaluator: string;
  /** True when `now > ruling.timestamp + freshnessSeconds` (freshness gate failed). */
  stale: boolean;
}

/**
 * Minimal x402 buyer surface this client REUSES for STEP 2. The existing
 * {@link X402Adapter} satisfies this structurally — its `pay(params)` POSTs to
 * the URL, transparently handles the server 402 (sign + retry), and returns a
 * `UnifiedPayResult` whose `.response` is the settled HTTP response. Tests inject
 * a stub exposing the same shape.
 */
export interface EvaluatorPaymentClient {
  pay(params: {
    to: string;
    httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    httpBody?: string;
    httpHeaders?: Record<string, string>;
    metadata?: { paymentMethod?: string };
  }): Promise<{ response?: Response }>;
}

/** Configuration for {@link EvaluatorClient}. */
export interface EvaluatorClientConfig {
  /**
   * Base URL of the evaluator service (e.g. `https://evaluator.agirails.io`).
   * `POST {baseUrl}/quote` and `POST {baseUrl}/evaluate` are the two endpoints
   * (the `/v1/...` aliases are also accepted by the service, see §1).
   */
  baseUrl: string;
  /**
   * The x402 buyer used for STEP 2 — typically the SDK's {@link X402Adapter}.
   * Its `pay()` performs the 402→sign→pay→retry against `/evaluate`.
   */
  paymentClient: EvaluatorPaymentClient;
  /**
   * `fetch` implementation for the no-money STEP-0 `/quote` declare. Defaults to
   * the global `fetch`. Injected in tests to mock the HTTP endpoint.
   */
  fetchImpl?: typeof fetch;
  /** Body-level contract version (API-CONTRACT.md §1). Default `"1.0.0"`. */
  apiVersion?: string;
}

// =====================================================================
// Errors (frozen names — 1:1 with the Py twin)
// =====================================================================

/** Base class for evaluator-client errors. */
export class EvaluatorClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluatorClientError';
    Object.setPrototypeOf(this, EvaluatorClientError.prototype);
  }
}

/** The `/quote` declare did not return the expected 402 quote (e.g. 4xx/5xx error envelope). */
export class QuoteRejectedError extends EvaluatorClientError {
  public readonly status: number;
  public readonly code?: string;
  constructor(status: number, code?: string, message?: string) {
    super(
      `Evaluator /quote rejected (HTTP ${status}${code ? `, code=${code}` : ''})` +
        (message ? `: ${message}` : '')
    );
    this.name = 'QuoteRejectedError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, QuoteRejectedError.prototype);
  }
}

/** The `/evaluate` response was malformed or absent (no body, bad outcome, hash mismatch). */
export class EvaluateResponseError extends EvaluatorClientError {
  constructor(message: string) {
    super(`Evaluator /evaluate response invalid: ${message}`);
    this.name = 'EvaluateResponseError';
    Object.setPrototypeOf(this, EvaluateResponseError.prototype);
  }
}

// =====================================================================
// §4.7 third-evaluator selection (mirrors BondEscalation.sol)
// =====================================================================

/**
 * Select the rotating third evaluator for a dispute, mirroring §4.7 step 4:
 * `rotatingPool[uint256(keccak256(abi.encode(disputeId))) % rotatingPool.length]`.
 *
 * `abi.encode(bytes32 disputeId)` is the 32-byte disputeId itself, so we keccak
 * the raw 32 bytes. Returns `undefined` when the pool is empty (no third
 * evaluator can be selected — §4.7 then relies solely on the two fixed slots).
 *
 * @param disputeId - bytes32hex dispute id.
 * @param rotatingPool - the rotating evaluator addresses.
 */
export function selectThirdEvaluator(
  disputeId: string,
  rotatingPool: string[]
): string | undefined {
  if (!rotatingPool || rotatingPool.length === 0) return undefined;
  // abi.encode(bytes32) == the 32-byte value; keccak256 over those 32 bytes.
  const hashHex = keccak256AbiEncodeBytes32(disputeId);
  const idx = BigInt(hashHex) % BigInt(rotatingPool.length);
  return rotatingPool[Number(idx)];
}

/**
 * Replicate the on-chain `_verifyEvaluatorSignatures` logic (AIP-14 FINAL §4.7),
 * client-side, over a recovered AIRuling.
 *
 * Steps (§4.7):
 *  1. require `2 <= signatures.length <= 3`
 *  2. freshness: require `now <= ruling.timestamp + freshnessSeconds`
 *  3. require `rotatingPool.length >= 1` (else only the two fixed slots count)
 *  4. `thirdEvaluator = rotatingPool[keccak(abi.encode(disputeId)) % len]`
 *  5–6. for each signature, recover signer via {@link recoverRulingSigner};
 *       count it against `[fixed0, fixed1, third]` with a `seen[3]` dedupe map —
 *       unknown signers silently ignored, duplicates counted once.
 *  7. threshold: `validCount >= 2`.
 *
 * Returns the structured result; `valid` is `true` iff the threshold holds AND
 * freshness holds AND the count gate (2–3) holds. NEVER throws — the caller maps
 * a `false` result to a `proposeDirectly` recommendation.
 */
export function verifyRulingSignatures(
  ruling: AIRuling,
  signatures: string[],
  opts: {
    chainId: number;
    verifyingContract: string;
    fixedEvaluators: string[];
    rotatingPool: string[];
    now?: number;
    freshnessSeconds?: number;
  }
): RulingVerification {
  const { chainId, verifyingContract, fixedEvaluators, rotatingPool } = opts;
  const freshnessSeconds = opts.freshnessSeconds ?? 3600;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const thirdEvaluator = selectThirdEvaluator(ruling.disputeId, rotatingPool);

  // §4.7 step 4 — the ordered slot list the seen[] map tracks (fixed0, fixed1, third).
  const slots: Array<string | undefined> = [
    fixedEvaluators[0],
    fixedEvaluators[1],
    thirdEvaluator,
  ];
  const slotsLc = slots.map((s) => (s ? s.toLowerCase() : undefined));
  const seen = [false, false, false];

  const stale = now > Number(ruling.timestamp) + freshnessSeconds;

  const recoveredSigners: string[] = [];
  let validCount = 0;

  // §4.7 step 1 gate — count must be 2..3. A count outside this range can never
  // be `valid`, but we still recover signers (advisory) for diagnostics.
  const countInRange = signatures.length >= 2 && signatures.length <= 3;

  for (const sig of signatures) {
    let signer: string;
    try {
      signer = recoverRulingSigner(ruling, sig, chainId, verifyingContract);
    } catch {
      // A malformed signature recovers nothing — silently ignored (unknown).
      continue;
    }
    const signerLc = signer.toLowerCase();
    const slotIdx = slotsLc.findIndex((s) => s !== undefined && s === signerLc);
    if (slotIdx === -1) continue; // unknown signer — silently ignored (§4.7)
    if (seen[slotIdx]) continue; // duplicate — counted once (§4.7)
    seen[slotIdx] = true;
    validCount += 1;
    recoveredSigners.push(slots[slotIdx] as string);
  }

  const valid = countInRange && !stale && validCount >= 2;
  return { valid, validCount, recoveredSigners, thirdEvaluator: thirdEvaluator ?? '', stale };
}

// =====================================================================
// Client
// =====================================================================

/**
 * Typed client for the off-chain dispute evaluator (PRD P2-6).
 */
export class EvaluatorClient {
  private readonly baseUrl: string;
  private readonly paymentClient: EvaluatorPaymentClient;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;

  constructor(config: EvaluatorClientConfig) {
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      throw new EvaluatorClientError('EvaluatorClient requires a baseUrl string.');
    }
    if (!config.paymentClient || typeof config.paymentClient.pay !== 'function') {
      throw new EvaluatorClientError(
        'EvaluatorClient requires a paymentClient with a pay() method (e.g. X402Adapter).'
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.paymentClient = config.paymentClient;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.apiVersion = config.apiVersion ?? '1.0.0';
  }

  /**
   * Run the full STEP 0→5 evaluator handshake for an evidence bundle and return
   * either signed-and-§4.7-verified ruling(s) or a `proposeDirectly` recommendation.
   *
   * NEVER submits on-chain — the caller decides whether to call
   * `BondEscalationClient.submitAIRuling` (on `outcome: "signed"`) or
   * `BondEscalationClient.proposeDirectly` (on `outcome: "proposeDirectly"`).
   *
   * @throws {QuoteRejectedError} if `/quote` returns an error envelope instead of a 402 quote.
   * @throws {EvaluateResponseError} if `/evaluate` returns no/invalid body or a bundleHash mismatch.
   */
  async requestEvaluation(params: RequestEvaluationParams): Promise<EvaluationResult> {
    // Derive bundleHash + tokenCount from the FROZEN serializer — never trust a
    // caller-supplied hash. (The token cap is enforced here too: an over-cap
    // bundle throws BundleTooLargeError before any quote/spend.)
    const bundleHashHex = computeBundleHash(params.bundle);
    const declaredTokenCount = this.countTokens(params.bundle);

    // ---- STEP 0 DECLARE → STEP 1 QUOTE (no money, no LLM) -----------------
    const quote = await this.declare(params, bundleHashHex, declaredTokenCount);

    // ---- STEP 2 PAY (delegated to the existing x402 buyer stack) ----------
    // ---- STEP 3 VERIFY + STEP 4 RUN + STEP 5 RETURN (server-side) ---------
    const evaluateBody = {
      apiVersion: this.apiVersion,
      bundleHash: bundleHashHex,
      disputeId: params.disputeId,
      disputeNonce: quote.disputeNonce,
      payer: params.payer,
      chainId: params.chainId,
      verifyingContract: params.verifyingContract,
    };
    const response = await this.payAndEvaluate(evaluateBody);

    // ---- Parse the §4.3 200 body ------------------------------------------
    const body = await this.parseEvaluateResponse(response, bundleHashHex);

    if (body.outcome === 'proposeDirectly') {
      // §4.3b — recommendation, ALWAYS no signatures. Surface as-is.
      return {
        outcome: 'proposeDirectly',
        recommendation: body.recommendation,
        reason: 'server-recommended',
        tokenCount: body.tokenCount,
        reasoning: body.reasoning,
      };
    }

    // §4.3a — signed. REPLICATE §4.7 client-side; never trust evaluators[].
    const ruling = this.normalizeRuling(body.ruling);
    const verification = verifyRulingSignatures(ruling, body.signatures, {
      chainId: params.chainId,
      verifyingContract: params.verifyingContract,
      fixedEvaluators: params.fixedEvaluators,
      rotatingPool: params.rotatingPool,
      freshnessSeconds: params.freshnessSeconds,
    });

    if (!verification.valid) {
      // < 2/3 (or stale): DOWNGRADE to a proposeDirectly recommendation with NO
      // signatures (INV-21: AI never gains finality on a failed quorum). We do
      // NOT pass the unverified signatures through.
      return {
        outcome: 'proposeDirectly',
        recommendation: {
          ruling: ruling.ruling,
          splitBps: ruling.splitBps,
          confidence: ruling.confidence,
          rationale:
            `Signed response failed §4.7 verification ` +
            `(validCount=${verification.validCount}${verification.stale ? ', stale' : ''}); ` +
            `recommend calling proposeDirectly() instead of submitting the AI ruling.`,
        },
        reason: 'verification-failed',
        verification,
        tokenCount: body.tokenCount,
        reasoning: body.reasoning,
      };
    }

    return {
      outcome: 'signed',
      ruling,
      signatures: body.signatures,
      verification,
      tokenCount: body.tokenCount,
      reasoning: body.reasoning,
    };
  }

  // ===================================================================
  // Internals
  // ===================================================================

  /**
   * STEP 0→1: POST `/quote` with the declaration (no money). A 402 carries the
   * quote body (the normal success path); any other status is an error envelope.
   */
  private async declare(
    params: RequestEvaluationParams,
    bundleHashHex: string,
    declaredTokenCount: number
  ): Promise<QuoteBody> {
    const declareBody = {
      apiVersion: this.apiVersion,
      bundleHash: bundleHashHex,
      disputeId: params.disputeId,
      declaredTokenCount,
      escrowAmount: params.escrowAmount,
      tier: Number(params.tier),
      payer: params.payer,
      bundleSource: params.bundleSource,
    };

    const res = await this.fetchImpl(`${this.baseUrl}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(declareBody),
    });

    // §3.2 — a 402 IS the quote success. Anything else is a §3.3 error envelope.
    if (res.status !== 402) {
      let code: string | undefined;
      let message: string | undefined;
      try {
        const errBody = (await res.json()) as { error?: { code?: string; message?: string } };
        code = errBody?.error?.code;
        message = errBody?.error?.message;
      } catch {
        /* non-JSON body — leave code/message undefined */
      }
      throw new QuoteRejectedError(res.status, code, message);
    }

    const quote = (await res.json()) as QuoteBody;
    if (!quote || typeof quote.disputeNonce !== 'string') {
      throw new QuoteRejectedError(402, undefined, 'quote body missing disputeNonce');
    }
    return quote;
  }

  /**
   * STEP 2: pay the quote and POST `/evaluate` in one shot via the existing
   * x402 buyer stack. The {@link EvaluatorPaymentClient} `pay()` posts the body,
   * transparently consumes the server 402, signs, retries, and returns the
   * settled 200 `response`.
   */
  private async payAndEvaluate(evaluateBody: Record<string, unknown>): Promise<Response> {
    const result = await this.paymentClient.pay({
      to: `${this.baseUrl}/evaluate`,
      httpMethod: 'POST',
      httpBody: JSON.stringify(evaluateBody),
      httpHeaders: { 'content-type': 'application/json', accept: 'application/json' },
      metadata: { paymentMethod: 'x402' }, // explicit opt-in (X402Adapter §P1-3 gate)
    });
    if (!result || !result.response) {
      throw new EvaluateResponseError('payment client returned no HTTP response');
    }
    return result.response;
  }

  /** Parse + validate the §4.3 evaluate response body. */
  private async parseEvaluateResponse(
    response: Response,
    expectedBundleHash: string
  ): Promise<EvaluateResponse> {
    let body: EvaluateResponse;
    try {
      body = (await response.json()) as EvaluateResponse;
    } catch (e) {
      throw new EvaluateResponseError(
        `body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (!body || (body.outcome !== 'signed' && body.outcome !== 'proposeDirectly')) {
      throw new EvaluateResponseError(
        `missing/unknown outcome (got ${JSON.stringify((body as { outcome?: unknown })?.outcome)})`
      );
    }
    // OQ-10: the returned bundleHash MUST equal the one we declared.
    if (
      typeof body.bundleHash !== 'string' ||
      body.bundleHash.toLowerCase() !== expectedBundleHash.toLowerCase()
    ) {
      throw new EvaluateResponseError(
        `bundleHash mismatch: response ${body.bundleHash} != declared ${expectedBundleHash}`
      );
    }
    if (body.outcome === 'signed') {
      // §4.3a — ruling.bundleHash MUST also equal the declared hash (OQ-10).
      if (
        !body.ruling ||
        String(body.ruling.bundleHash).toLowerCase() !== expectedBundleHash.toLowerCase()
      ) {
        throw new EvaluateResponseError('signed ruling.bundleHash != declared bundleHash');
      }
      if (!Array.isArray(body.signatures)) {
        throw new EvaluateResponseError('signed response missing signatures[]');
      }
    } else {
      if (!body.recommendation) {
        throw new EvaluateResponseError('proposeDirectly response missing recommendation');
      }
    }
    return body;
  }

  /** Normalize a wire ruling object into the FROZEN {@link AIRuling} (numeric coercion). */
  private normalizeRuling(r: EvaluatorRuling): AIRuling {
    return {
      disputeId: r.disputeId,
      ruling: Number(r.ruling),
      confidence: Number(r.confidence),
      splitBps: Number(r.splitBps),
      timestamp: Number(r.timestamp),
      reasoningHash: r.reasoningHash,
      bundleHash: r.bundleHash,
      // AIP-14c D7: carry the CID-commitment ref-hashes through verbatim when the
      // evaluator provides them; a missing value is normalized to bytes32(0) by
      // the signer helpers (withRefDefaults).
      evidenceRefHash: r.evidenceRefHash,
      reasoningRefHash: r.reasoningRefHash,
    };
  }

  /**
   * Count cl100k_base tokens over the bundle's canonical bytes (advisory STEP-0
   * `declaredTokenCount`; the server re-counts authoritatively, §3.1/R3). Falls
   * back to `0` if no tokenizer is installed — the field is advisory, so a
   * missing tokenizer must not block the declare. `computeBundleHash` already
   * enforced the hard 100k cap when a tokenizer IS present.
   */
  private countTokens(bundle: EvidenceBundle): number {
    try {
      // Lazy import avoids a hard dependency cycle; reuses the frozen counter.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./EvidenceBundle') as typeof import('./EvidenceBundle');
      const text = mod.serializeBundleToString(bundle);
      return mod.countBundleTokens(text);
    } catch {
      return 0;
    }
  }
}

// =====================================================================
// Local helpers
// =====================================================================

/** Internal shape of the §3.2 402 quote body the SDK consumes. */
interface QuoteBody {
  apiVersion?: string;
  status?: string;
  bundleHash?: string;
  tokenCount?: number;
  quote?: {
    amount?: string;
    currency?: string;
    asset?: string;
    chainId?: number;
    expiresAt?: number;
  };
  disputeNonce: string;
  x402?: Record<string, unknown>;
}

/**
 * `keccak256(abi.encode(bytes32 disputeId))` as a 0x-hex string. `abi.encode` of
 * a single bytes32 is the 32-byte value verbatim, so we keccak the raw bytes
 * (mirrors §4.7 step 4 in BondEscalation.sol). Uses ethers under the hood.
 */
function keccak256AbiEncodeBytes32(disputeId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ethers } = require('ethers') as typeof import('ethers');
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [disputeId]);
  return ethers.keccak256(encoded);
}
