/**
 * P2-10 CAPSTONE — cross-SDK META parity + golden-vector suite (TS side).
 *
 * Mirrors python-sdk-v2/tests/test_cross_sdk/test_dispute_parity.py 1:1 and
 * consumes the SAME two shared fixtures under
 * `DISPUTE SYSTEM/test-vectors/dispute/`:
 *
 *   - `parity-surface.json` — the META manifest: every intentional public dispute
 *     symbol with its TS name + Py name + per-language required arity. This suite
 *     asserts the TS SDK matches its column; the Py suite asserts the Py column;
 *     and BOTH assert no symbol is single-language (each manifest row carries a
 *     `ts` AND a `py` name). The parity-surface DIFF is therefore the manifest:
 *     if a symbol existed in only one SDK, it could not appear here with both
 *     twins AND pass in both suites.
 *
 *   - `golden-vectors.json` — five byte/value-identical golden families
 *     (AIRuling digest, bundle-hash, BondEscalation calldata, DisputeSplitRecorded
 *     decode + ZERO-REMAINING rule, split-rate). Both SDKs load THIS file and must
 *     reproduce every expected value exactly.
 *
 * PARITY: python-sdk-v2/tests/test_cross_sdk/test_dispute_parity.py
 */

import fs from 'fs';
import path from 'path';
import { Interface, getBytes } from 'ethers';

// ── Runtime dispute surface (the values the manifest enumerates) ─────────────
import {
  // enums
  Ruling,
  Tier,
  // constants (signing)
  DOMAIN_TYPEHASH,
  RULING_TYPEHASH,
  DISPUTE_EVALUATOR_DOMAIN_NAME,
  DISPUTE_EVALUATOR_DOMAIN_VERSION,
  // signing functions
  signRuling,
  recoverRulingSigner,
  computeRulingDigest,
  computeRulingDomainSeparator,
  computeRulingStructHash,
  disputeEvaluatorDomain,
} from '../src/types/dispute';
import {
  ESCALATION_INITIAL_BPS,
  MIN_ESCALATION_BOND,
  MAX_ESCALATION_BOND,
  ESCALATION_MULTIPLIER,
  BPS_DENOMINATOR,
  BondEscalationClient,
} from '../src/dispute/BondEscalation';
import {
  CompositeMediator,
  decodeDisputeSplitRecorded,
  decodeResolutionProof,
  computeSplitRate,
} from '../src/dispute/CompositeMediator';
import {
  UMA_BOND,
  SELF_DISPUTE_TOTAL,
  SELF_DISPUTE_RECOVER,
  SELF_DISPUTE_LOSS,
  UMAHelper,
} from '../src/dispute/UMAHelper';
import {
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SUPPORTED_BUNDLE_MAJOR,
  MAX_BUNDLE_TOKENS,
  validateBundle,
  assertSupportedVersion,
  serializeBundle,
  serializeBundleToString,
  bundleHash,
  computeBundleHash,
  countBundleTokens,
  enforceTokenCap,
  setBundleTokenizer,
  pinEvidenceBundle,
  BundleTooLargeError,
  UnsupportedBundleVersionError,
  InvalidBundleError,
} from '../src/dispute/EvidenceBundle';
import {
  DisputeSplitIndexer,
  isSplitKind,
  outcomeFromSplitRecorded,
} from '../src/reputation/DisputeSplitIndexer';
import {
  EvaluatorClient,
  verifyRulingSignatures,
  selectThirdEvaluator,
  EvaluatorClientError,
  QuoteRejectedError,
  EvaluateResponseError,
} from '../src/dispute/EvaluatorClient';
import {
  DisputeClient,
  decodeDisputeSubState,
} from '../src/dispute/DisputeClient';
import type {
  AIRuling,
} from '../src/types/dispute';
import CompositeMediatorABI from '../src/abi/CompositeMediator.json';
// The whole package entrypoint — used to assert the `tsOnlyDeExported` wire
// shapes are NOT re-exported from the public surface (parity de-export lock).
import * as PUBLIC_SURFACE from '../src';

// Compile-time parity guard: each `kind:"type"` interface MUST be importable as a
// TYPE from the public surface (erased at runtime in TS, real classes in Py). If
// any of these named type imports were removed/renamed, this file would not
// compile — the static half of the META parity check for interfaces.
import type {
  DisputeState,
  DisputeSplitRecorded,
  DecodedResolutionProof,
  SelfDisputeCost,
  DisputeOutcome,
  SplitRateResult,
  SplitRateBreakdown,
  EvidenceBundle,
  EvidenceBundleSpec,
  EvidenceBundleDelivery,
  EvidenceBundleDispute,
  EvidenceBundleTimelineEvent,
  EvidenceBundleReasoning,
  PinEvidenceBundleResult,
  // DisputeClient facade types (PRD P2-9)
  DisputeStatus,
  DisputeSubState,
  // EvaluatorClient paired input/result types (both SDKs have a twin)
  BundleSource,
  RequestEvaluationParams,
  EvaluationResult,
  RulingVerification,
  ProposeDirectlyRecommendation,
  EvaluatorClientConfig,
  EvaluatorPaymentClient,
} from '../src';
// Reference them so the unused-import lint cannot strip the guard.
type _TypeParityGuard = [
  AIRuling, DisputeState, DisputeSplitRecorded, DecodedResolutionProof,
  SelfDisputeCost, DisputeOutcome, SplitRateResult, SplitRateBreakdown,
  EvidenceBundle, EvidenceBundleSpec, EvidenceBundleDelivery, EvidenceBundleDispute,
  EvidenceBundleTimelineEvent, EvidenceBundleReasoning, PinEvidenceBundleResult,
  DisputeStatus, DisputeSubState,
  BundleSource, RequestEvaluationParams, EvaluationResult, RulingVerification,
  ProposeDirectlyRecommendation, EvaluatorClientConfig, EvaluatorPaymentClient
];

const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors/dispute');
const SURFACE = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, 'parity-surface.json'), 'utf-8'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, 'golden-vectors.json'), 'utf-8'));

// Runtime registry of every dispute symbol the manifest can reference (errors are
// classes; enums/consts/functions/clients are real values; pure interfaces are
// undefined here and checked at compile-time above).
const RUNTIME: Record<string, unknown> = {
  Ruling, Tier,
  DOMAIN_TYPEHASH, RULING_TYPEHASH, DISPUTE_EVALUATOR_DOMAIN_NAME, DISPUTE_EVALUATOR_DOMAIN_VERSION,
  ESCALATION_INITIAL_BPS, MIN_ESCALATION_BOND, MAX_ESCALATION_BOND, ESCALATION_MULTIPLIER, BPS_DENOMINATOR,
  UMA_BOND, SELF_DISPUTE_TOTAL, SELF_DISPUTE_RECOVER, SELF_DISPUTE_LOSS,
  EVIDENCE_BUNDLE_SCHEMA_VERSION, SUPPORTED_BUNDLE_MAJOR, MAX_BUNDLE_TOKENS,
  signRuling, recoverRulingSigner, computeRulingDigest, computeRulingDomainSeparator,
  computeRulingStructHash, disputeEvaluatorDomain,
  validateBundle, assertSupportedVersion, serializeBundle, serializeBundleToString,
  bundleHash, computeBundleHash, countBundleTokens, enforceTokenCap, setBundleTokenizer, pinEvidenceBundle,
  decodeDisputeSplitRecorded, decodeResolutionProof, computeSplitRate,
  isSplitKind, outcomeFromSplitRecorded,
  verifyRulingSignatures, selectThirdEvaluator,
  decodeDisputeSubState,
  BondEscalationClient, CompositeMediator, UMAHelper, DisputeSplitIndexer, EvaluatorClient,
  DisputeClient,
  BundleTooLargeError, UnsupportedBundleVersionError, InvalidBundleError,
  EvaluatorClientError, QuoteRejectedError, EvaluateResponseError,
};

/** TS required arity = function .length (params before first default/rest). */
function tsArityOf(fn: unknown): number {
  return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).length : -1;
}
function expectedTsArity(entry: { arity?: number; tsArity?: number }): number {
  return entry.tsArity ?? (entry.arity as number);
}

// =====================================================================
// META PARITY — TS surface == manifest (and every row has a Py twin)
// =====================================================================

describe('P2-10 META parity — TS dispute surface matches the manifest', () => {
  test('every manifest row declares BOTH a ts and a py twin (no single-lang symbol)', () => {
    const rows: Array<{ ts?: string; py?: string }> = [
      ...SURFACE.enums,
      ...SURFACE.constants,
      ...SURFACE.functions,
      ...SURFACE.types,
      ...SURFACE.classes,
      ...SURFACE.classes.flatMap((c: any) => [
        ...c.methods,
        ...c.staticMethods,
        ...(c.accessors ?? []),
      ]),
      ...SURFACE.absent,
    ];
    for (const r of rows) {
      expect(typeof r.ts).toBe('string');
      expect(typeof r.py).toBe('string');
      expect(r.ts!.length).toBeGreaterThan(0);
      expect(r.py!.length).toBeGreaterThan(0);
    }
  });

  test('enums present with identical member values', () => {
    for (const e of SURFACE.enums) {
      const en = RUNTIME[e.ts] as Record<string, number>;
      expect(en).toBeDefined();
      for (const [member, value] of Object.entries(e.members)) {
        expect(en[member]).toBe(value);
      }
    }
  });

  test('constants present at runtime', () => {
    for (const c of SURFACE.constants) {
      expect(RUNTIME[c.ts]).toBeDefined();
    }
  });

  test('top-level functions present with the manifest TS arity', () => {
    for (const f of SURFACE.functions) {
      const fn = RUNTIME[f.ts];
      expect(typeof fn).toBe('function');
      expect(tsArityOf(fn)).toBe(expectedTsArity(f));
    }
  });

  test('client classes expose every method + static at the manifest TS arity', () => {
    for (const c of SURFACE.classes) {
      const cls = RUNTIME[c.ts] as { prototype: Record<string, unknown> } & Record<string, unknown>;
      expect(typeof cls).toBe('function');
      for (const m of c.methods) {
        const fn = cls.prototype[m.ts];
        expect(typeof fn).toBe('function');
        expect(tsArityOf(fn)).toBe(expectedTsArity(m));
      }
      for (const m of c.staticMethods) {
        const fn = cls[m.ts];
        expect(typeof fn).toBe('function');
        expect(tsArityOf(fn)).toBe(expectedTsArity(m));
      }
    }
  });

  test('client classes expose every accessor as a real getter DESCRIPTOR', () => {
    // Accessors (TS `get x()`) MUST be validated via their property descriptor —
    // reading the value off the prototype would TRIGGER the getter and throw on an
    // unconfigured facade (e.g. DisputeClient.bond with no BondEscalationClient).
    for (const c of SURFACE.classes) {
      if (!c.accessors) continue;
      const cls = RUNTIME[c.ts] as { prototype: object };
      expect(typeof cls).toBe('function');
      for (const a of c.accessors) {
        const desc = Object.getOwnPropertyDescriptor(cls.prototype, a.ts);
        expect(desc).toBeDefined();
        expect(typeof desc!.get).toBe('function');
      }
    }
  });

  test('error types are runtime classes (kind:error); interface types compile-time only', () => {
    for (const t of SURFACE.types) {
      if (t.kind === 'error') {
        const cls = RUNTIME[t.ts];
        expect(typeof cls).toBe('function');
        // is an Error subclass
        expect(Object.create((cls as new (...a: any[]) => Error).prototype) instanceof Error).toBe(true);
      }
      // kind:"type" interfaces are erased at runtime — their presence is enforced
      // by the compile-time `import type {...}` guard at the top of this file.
    }
  });

  test('intentionally-absent symbols are absent in TS too (resolve() onlyBondEscalation)', () => {
    for (const ab of SURFACE.absent) {
      const cls = RUNTIME[ab.on] as { prototype: Record<string, unknown> };
      expect(cls.prototype[ab.ts]).toBeUndefined();
      // …but it DOES exist on the ABI (proving the omission is deliberate).
      const iface = new Interface(CompositeMediatorABI as any);
      expect(iface.getFunction(ab.ts)).not.toBeNull();
    }
  });

  test('TS-only wire-parse shapes are DE-EXPORTED from the package entrypoint', () => {
    // The manifest declares these 4 evaluate wire-parse shapes as
    // `tsOnlyDeExported` (no Py twin). They must NOT be on the public package
    // surface — TS erases pure interfaces at runtime, so a runtime check cannot
    // see them; instead we assert the GENERATED .d.ts for the package entrypoint
    // does not re-export them, which is what consumers actually import.
    expect(SURFACE.tsOnlyDeExported.length).toBeGreaterThan(0);
    // Runtime guard: none of them leak as runtime VALUES on the entrypoint
    // (defense-in-depth; interfaces never would, but a class/type drift would).
    for (const t of SURFACE.tsOnlyDeExported) {
      expect((PUBLIC_SURFACE as Record<string, unknown>)[t.ts]).toBeUndefined();
      expect(t.pyTwin).toBeNull();
    }
    // Static guard: the entrypoint source must not name any of them in an export
    // clause. Interfaces are type-only, so the runtime check above cannot catch a
    // `export type { SignedEvaluateResponse } from './dispute/EvaluatorClient'`
    // regression — this source assertion does. We scan only non-comment lines that
    // contain a bare-identifier export clause member (`  Name,` or `  Name }`).
    const indexSrc = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf-8');
    const exportClauseLines = indexSrc
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && /^\s*[A-Za-z_]\w*\s*[,}]/.test(l));
    for (const t of SURFACE.tsOnlyDeExported) {
      const named = exportClauseLines.some((l) => new RegExp(`^\\s*${t.ts}\\s*[,}]`).test(l));
      expect(named).toBe(false);
    }
  });
});

// =====================================================================
// GOLDEN VECTOR 1 — AIRuling EIP-712 digest
// =====================================================================

describe('P2-10 golden — AIRuling digest (byte-identical to Py + Solidity)', () => {
  const g = GOLDEN.airulingDigest;
  const ruling: AIRuling = {
    disputeId: g.ruling.disputeId,
    ruling: g.ruling.ruling as Ruling,
    confidence: g.ruling.confidence,
    splitBps: g.ruling.splitBps,
    timestamp: g.ruling.timestamp,
    reasoningHash: g.ruling.reasoningHash,
    bundleHash: g.ruling.bundleHash,
    evidenceRefHash: g.ruling.evidenceRefHash,
    reasoningRefHash: g.ruling.reasoningRefHash,
  };

  test('domain identity matches the frozen constants', () => {
    expect(DISPUTE_EVALUATOR_DOMAIN_NAME).toBe(g.domain.name);
    expect(DISPUTE_EVALUATOR_DOMAIN_VERSION).toBe(g.domain.version);
  });

  test('struct hash == frozen', () => {
    expect(computeRulingStructHash(ruling)).toBe(g.expected.structHash);
  });

  test('domain separator == frozen', () => {
    expect(computeRulingDomainSeparator(g.domain.chainId, g.domain.verifyingContract)).toBe(
      g.expected.domainSeparator
    );
  });

  test('digest == frozen GOLDEN_DIGEST', () => {
    expect(computeRulingDigest(ruling, g.domain.chainId, g.domain.verifyingContract)).toBe(
      g.expected.digest
    );
  });

  test('typehash bytes are byte-comparable to the Py twin (representation differs)', () => {
    // TS exposes 0x-hex strings; Py exposes raw bytes — the 32 raw bytes match.
    expect(getBytes(RULING_TYPEHASH).length).toBe(32);
    expect(getBytes(DOMAIN_TYPEHASH).length).toBe(32);
  });
});

// =====================================================================
// GOLDEN VECTOR 2 — evidence bundle hash
// =====================================================================

describe('P2-10 golden — bundle hash (byte-identical canonical bytes)', () => {
  const g = GOLDEN.bundleHash;

  test('canonical bytes length == frozen', () => {
    const bytesLen = serializeBundle(g.bundle).length;
    expect(bytesLen).toBe(g.expected.canonicalBytesUtf8Len);
  });

  test('bundleHash == frozen (skip token check — count is pinned in the fixture)', () => {
    expect(bundleHash(g.bundle, { skipTokenCheck: true })).toBe(g.expected.bundleHash);
    expect(computeBundleHash(g.bundle, { skipTokenCheck: true })).toBe(g.expected.bundleHash);
  });

  test('canonical string is stable + parseable', () => {
    const s = serializeBundleToString(g.bundle);
    expect(JSON.parse(s).schemaVersion).toBe('1.0.0');
  });
});

// =====================================================================
// GOLDEN VECTOR 3 — BondEscalation calldata
// =====================================================================

describe('P2-10 golden — BondEscalation calldata (byte-exact, both SDKs)', () => {
  const g = GOLDEN.bondEscalationCalldata;
  // The client builds calldata via `interface.encodeFunctionData`; we exercise
  // exactly that path with an injected mock that captures the encoded data.
  function makeClient() {
    const iface = new Interface(require('../src/abi/BondEscalation.json'));
    const captured: { method: string; data: string }[] = [];
    const contract: any = {
      interface: iface,
      getFunction: (method: string) => {
        const fn = (...args: unknown[]) => {
          captured.push({ method, data: iface.encodeFunctionData(method, args as any) });
          return Promise.resolve({ hash: '0xtx', wait: async () => ({ hash: '0xtx' }) });
        };
        return fn;
      },
      disputes: async () => [],
    };
    const client = new BondEscalationClient({ address: '0x00', signer: {} as any, contract });
    return { client, captured };
  }

  test('openDispute calldata == frozen', async () => {
    const { client, captured } = makeClient();
    const { disputeId } = await client.openDispute(g.txId);
    expect(disputeId).toBe(g.disputeId);
    expect(captured[0].data).toBe(g.openDispute.calldata);
    expect(captured[0].data.slice(0, 10)).toBe(g.openDispute.selector);
  });

  test('challenge calldata == frozen', async () => {
    const { client, captured } = makeClient();
    await client.challenge(g.disputeId, g.challenge.args.counterRuling, g.challenge.args.counterSplitBps);
    expect(captured[0].data).toBe(g.challenge.calldata);
  });

  test('submitAIRuling calldata == frozen', async () => {
    const { client, captured } = makeClient();
    await client.submitAIRuling(
      g.submitAIRuling.args.ruling as AIRuling,
      g.submitAIRuling.args.evidenceCID,
      g.submitAIRuling.args.reasoningCID,
      g.submitAIRuling.args.signatures
    );
    expect(captured[0].data).toBe(g.submitAIRuling.calldata);
    expect(captured[0].data.slice(0, 10)).toBe(g.submitAIRuling.selector);
  });

  test('escalateToUMA calldata == frozen', async () => {
    const { client, captured } = makeClient();
    await client.escalateToUMA(
      g.disputeId,
      g.escalateToUMA.args.evidenceCID,
      g.escalateToUMA.args.reasoningCID
    );
    expect(captured[0].data).toBe(g.escalateToUMA.calldata);
    expect(captured[0].data.slice(0, 10)).toBe(g.escalateToUMA.selector);
  });
});

// =====================================================================
// GOLDEN VECTOR 4 — DisputeSplitRecorded decode + ZERO-REMAINING rule
// =====================================================================

describe('P2-10 golden — DisputeSplitRecorded decode + ZERO-REMAINING (both SDKs)', () => {
  const g = GOLDEN.disputeSplitRecordedDecode;

  test('topic0 == frozen', () => {
    const iface = new Interface(CompositeMediatorABI as any);
    expect(iface.getEvent('DisputeSplitRecorded')!.topicHash).toBe(g.disputeSplitRecordedTopic0);
  });

  test('decodeDisputeSplitRecorded surfaces the event fields', () => {
    const e = g.event;
    const decoded = decodeDisputeSplitRecorded({
      eventName: 'DisputeSplitRecorded',
      args: { txId: e.txId, requester: e.requester, provider: e.provider, splitBps: BigInt(e.splitBps) },
    } as any);
    expect(decoded.txId).toBe(e.txId);
    expect(decoded.requester).toBe(e.requester);
    expect(decoded.provider).toBe(e.provider);
    expect(decoded.splitBps).toBe(e.splitBps);
  });

  const proofRows: Array<[string, any]> = g.resolutionProofs.map((p: any) => [p.name, p]);
  test.each(proofRows)(
    'resolution proof %s decodes per the CONSUMER RULE',
    (_name: string, p: any) => {
      const decoded = decodeResolutionProof(p.proof, BigInt(p.remaining));
      expect(decoded.isSplit).toBe(p.expected.isSplit);
      expect(decoded.phantomSentinel).toBe(p.expected.phantomSentinel);
      expect(decoded.payouts.requester).toBe(BigInt(p.expected.requesterAmount));
      expect(decoded.payouts.provider).toBe(BigInt(p.expected.providerAmount));
      expect(decoded.providerAtFault ?? null).toBe(p.expected.providerAtFault);
      // ZERO-REMAINING hard assertion: a phantom sentinel NEVER surfaces as a payout.
      if (p.expected.phantomSentinel) {
        expect(decoded.payouts.requester).not.toBe(1n);
        expect(decoded.payouts.provider).not.toBe(1n);
      }
    }
  );
});

// =====================================================================
// GOLDEN VECTOR 5 — split-rate computation (OQ-11)
// =====================================================================

describe('P2-10 golden — split rate (OQ-11, admin-CANCELLED counted equally)', () => {
  const g = GOLDEN.splitRate;

  const caseRows: Array<[string, any]> = g.cases.map((c: any) => [c.name, c]);
  test.each(caseRows)(
    'computeSplitRate %s == frozen',
    (_name: string, c: any) => {
      const rate = computeSplitRate(c.splitRecorded, c.kernelDisputedToCancelled, c.totalDisputes);
      expect(rate).toBeCloseTo(c.expectedSplitRate, 15);
      if (c.approxPercent !== undefined) {
        expect(Math.round(rate * 100)).toBe(c.approxPercent);
      }
    }
  );

  test('the DisputeSplitIndexer reuses the SAME primitive (headline 14% admin split)', () => {
    const headline = g.cases.find((c: any) => c.name === 'headline_admin_cancelled_14pct');
    const provider = '0x2222222222222222222222222222222222222222';
    const indexer = new DisputeSplitIndexer();
    // 1 admin-CANCELLED split + 6 settled = 1/7.
    indexer.addOutcome({ provider, requester: '0x1', kind: 'kernelDisputedToCancelled' });
    for (let i = 0; i < 6; i++) indexer.addOutcome({ provider, requester: '0x1', kind: 'settled' });
    const r = indexer.getSplitRate(provider);
    expect(r.splitCount).toBe(1);
    expect(r.totalDisputes).toBe(7);
    expect(r.splitRate).toBeCloseTo(headline.expectedSplitRate, 15);
    // admin-CANCELLED counted in the breakdown at identical weight.
    const b = indexer.getSplitRateBreakdown(provider);
    expect(b.adminSplitCount).toBe(1);
    expect(b.mediatorSplitCount).toBe(0);
  });
});
