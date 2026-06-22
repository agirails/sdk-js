/**
 * Evidence Bundle canonical serializer — TS golden + cross-SDK suite (PRD P2-3).
 *
 * Loads the SHARED cross-SDK fixture `DISPUTE SYSTEM/test-vectors/bundle-vectors.json`
 * (the SAME file the Python pytest suite loads) and asserts, for every vector:
 *   - serializeBundle → EXACT canonical bytes == fixture.canonicalBytesHex
 *   - bundleHash      == fixture.bundleHash
 *   - cl100k_base tokenCount == fixture.tokenCount
 * Plus a CROSS-LANG assertion: the Py-produced hashes (written by the pytest
 * suite to `bundle-hashes.py.json`) equal the TS-produced hashes == the fixture.
 * And malformed-bundle rejection parity.
 *
 * Anchor: Example A bundleHash
 *   0x379fb8140138f7d90cfbcb481898b6ec646e2c0378ff0d3a4a4572a6570ca257.
 */

import fs from 'fs';
import path from 'path';
import { getEncoding } from 'js-tiktoken';

import {
  serializeBundle,
  serializeBundleToString,
  bundleHash,
  computeBundleHash,
  validateBundle,
  countBundleTokens,
  enforceTokenCap,
  setBundleTokenizer,
  pinEvidenceBundle,
  BundleTooLargeError,
  UnsupportedBundleVersionError,
  InvalidBundleError,
  MAX_BUNDLE_TOKENS,
  EvidenceBundle,
  EvidenceBundlePinner
} from '../src/dispute/EvidenceBundle';

// Inject the frozen cl100k_base tokenizer (OQ-9) once for the suite.
beforeAll(() => {
  setBundleTokenizer(getEncoding('cl100k_base'));
});

// ---------------------------------------------------------------------------
// Shared cross-SDK fixture (byte-identical to the copy the pytest suite loads)
// ---------------------------------------------------------------------------

const VECTORS_DIR = path.resolve(__dirname, '../../../DISPUTE SYSTEM/test-vectors');
const FIXTURE_PATH = path.join(VECTORS_DIR, 'bundle-vectors.json');
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

const TS_HASHES_PATH = path.join(VECTORS_DIR, 'bundle-hashes.ts.json');
const PY_HASHES_PATH = path.join(VECTORS_DIR, 'bundle-hashes.py.json');

interface Vector {
  name: string;
  description: string;
  bundle: EvidenceBundle;
  canonicalBytesUtf8Len: number;
  canonicalBytesHex: string;
  bundleHash: string;
  tokenCount: number;
  tokenizer: string;
}
const VECTORS: Vector[] = FIXTURE.vectors;

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// 1. Per-vector canonical bytes + bundleHash + tokenCount
// ---------------------------------------------------------------------------

describe('EvidenceBundle — golden vectors (shared cross-SDK fixture)', () => {
  it('fixture has the 4 seed vectors A/B/C/D', () => {
    expect(VECTORS.map((v) => v.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it.each(VECTORS.map((v) => [v.name, v] as [string, Vector]))(
    'vector %s → exact canonical bytes',
    (_name, v) => {
      const bytes = serializeBundle(v.bundle);
      expect(hexOf(bytes)).toBe(v.canonicalBytesHex);
      expect(bytes.length).toBe(v.canonicalBytesUtf8Len);
    }
  );

  it.each(VECTORS.map((v) => [v.name, v] as [string, Vector]))(
    'vector %s → bundleHash matches fixture',
    (_name, v) => {
      expect(bundleHash(v.bundle)).toBe(v.bundleHash);
      // alias parity
      expect(computeBundleHash(v.bundle, { skipTokenCheck: true })).toBe(v.bundleHash);
    }
  );

  it.each(VECTORS.map((v) => [v.name, v] as [string, Vector]))(
    'vector %s → cl100k_base tokenCount matches fixture',
    (_name, v) => {
      expect(v.tokenizer).toBe('cl100k_base');
      expect(countBundleTokens(serializeBundleToString(v.bundle))).toBe(v.tokenCount);
    }
  );

  it('Example A is the frozen schema anchor', () => {
    const a = VECTORS.find((v) => v.name === 'A')!;
    expect(a.bundleHash).toBe(
      '0x379fb8140138f7d90cfbcb481898b6ec646e2c0378ff0d3a4a4572a6570ca257'
    );
    expect(a.canonicalBytesUtf8Len).toBe(719);
  });

  it('vector C emits non-ASCII reason as RAW UTF-8 (ensure_ascii=false), not \\uXXXX', () => {
    const c = VECTORS.find((v) => v.name === 'C')!;
    const text = serializeBundleToString(c.bundle);
    expect(text).toContain('résultat incorrect — 図 missing 🎉');
    expect(text).not.toContain('\\u');
  });

  it('vector D pins JSON escape parity (control chars, quote, backslash, slash, surrogate emoji)', () => {
    // This vector exists so the cross-SDK byte-identity assertion (TS == Py)
    // permanently LOCKS the escape + sort rules for arbitrary free-text fields.
    const d = VECTORS.find((v) => v.name === 'D')!;
    const text = serializeBundleToString(d.bundle);
    // Two-char escapes for \b \f \n \r \t and quote/backslash.
    expect(text).toContain('\\b');
    expect(text).toContain('\\f');
    expect(text).toContain('\\n');
    expect(text).toContain('\\r');
    expect(text).toContain('\\t');
    expect(text).toContain('\\"');
    expect(text).toContain('\\\\');
    // Other C0 control chars escape as \u00XX (lowercase hex).
    expect(text).toContain('\\u0007'); // BEL
    expect(text).toContain('\\u001f'); // unit separator
    // Forward slash is NOT escaped; surrogate-pair emoji stays raw UTF-8.
    expect(text).toContain('slash=/');
    expect(text).toContain('🚀');
    expect(text).not.toContain('\\/');
    expect(text).not.toContain('\\ud83d'); // emoji not escaped to surrogate \u
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-language assertion (TS == Py == fixture)
// ---------------------------------------------------------------------------

describe('EvidenceBundle — cross-language byte/hash identity', () => {
  it('writes TS-produced hashes for the Py suite to cross-check', () => {
    const produced = VECTORS.map((v) => ({
      name: v.name,
      canonicalBytesHex: hexOf(serializeBundle(v.bundle)),
      bundleHash: bundleHash(v.bundle)
    }));
    fs.writeFileSync(TS_HASHES_PATH, JSON.stringify(produced, null, 2));
    // Self-consistency: TS production equals the fixture.
    produced.forEach((p, i) => {
      expect(p.bundleHash).toBe(VECTORS[i].bundleHash);
      expect(p.canonicalBytesHex).toBe(VECTORS[i].canonicalBytesHex);
    });
  });

  it('Py-produced hashes (if present) equal the TS-produced hashes == fixture', () => {
    if (!fs.existsSync(PY_HASHES_PATH)) {
      // Run the Python suite first to materialize this; skip cleanly otherwise.
      console.warn(`[cross-lang] ${PY_HASHES_PATH} not present — run the pytest suite to cross-check.`);
      return;
    }
    const py = JSON.parse(fs.readFileSync(PY_HASHES_PATH, 'utf-8')) as Array<{
      name: string;
      canonicalBytesHex: string;
      bundleHash: string;
    }>;
    for (const v of VECTORS) {
      const pyEntry = py.find((p) => p.name === v.name);
      expect(pyEntry).toBeDefined();
      // Py bytes == TS bytes == fixture bytes.
      expect(pyEntry!.canonicalBytesHex).toBe(hexOf(serializeBundle(v.bundle)));
      expect(pyEntry!.canonicalBytesHex).toBe(v.canonicalBytesHex);
      // Py hash == TS hash == fixture hash.
      expect(pyEntry!.bundleHash).toBe(bundleHash(v.bundle));
      expect(pyEntry!.bundleHash).toBe(v.bundleHash);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Token cap (schema §4 / OQ-9)
// ---------------------------------------------------------------------------

describe('EvidenceBundle — token cap (BundleTooLargeError)', () => {
  const a = () => JSON.parse(JSON.stringify(VECTORS[0].bundle)) as EvidenceBundle;

  it('within-cap bundle returns its token count', () => {
    const count = enforceTokenCap(serializeBundleToString(a()));
    expect(count).toBeLessThanOrEqual(MAX_BUNDLE_TOKENS);
    expect(count).toBe(VECTORS[0].tokenCount);
  });

  it('over-cap bundle raises BundleTooLargeError BEFORE hashing', () => {
    const big = a();
    // ~100k tokens of inline content (well over the 100k cap).
    big.delivery.deliverableInline = 'lorem ipsum dolor sit amet '.repeat(20000);
    expect(() => bundleHash(big)).toThrow(BundleTooLargeError);
    try {
      bundleHash(big);
    } catch (e) {
      expect(e).toBeInstanceOf(BundleTooLargeError);
      expect((e as BundleTooLargeError).tokenCount).toBeGreaterThan(MAX_BUNDLE_TOKENS);
    }
  });

  it('skipTokenCheck bypasses the cap (hash still correct)', () => {
    expect(bundleHash(VECTORS[0].bundle, { skipTokenCheck: true })).toBe(VECTORS[0].bundleHash);
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed-bundle rejection (schema §6)
// ---------------------------------------------------------------------------

describe('EvidenceBundle — malformed rejection (InvalidBundleError / version)', () => {
  const a = () => JSON.parse(JSON.stringify(VECTORS[0].bundle)) as any;

  it('missing required key → InvalidBundleError', () => {
    const bad = a();
    delete bad.spec;
    expect(() => validateBundle(bad)).toThrow(InvalidBundleError);
  });

  it('extra top-level key → InvalidBundleError (additionalProperties:false)', () => {
    const bad = a();
    bad.extra = 'nope';
    expect(() => validateBundle(bad)).toThrow(InvalidBundleError);
  });

  it('non-integer uint (float) → InvalidBundleError', () => {
    const bad = a();
    bad.delivery.deliveredAt = 1700000000.5;
    expect(() => validateBundle(bad)).toThrow(InvalidBundleError);
  });

  it('malformed bytes32hex → InvalidBundleError', () => {
    const bad = a();
    bad.disputeId = '0xnothex';
    expect(() => validateBundle(bad)).toThrow(InvalidBundleError);
  });

  it('optional key present as null → InvalidBundleError (absent ≠ null)', () => {
    const bad = a();
    bad.delivery.deliverableInline = null;
    expect(() => validateBundle(bad)).toThrow(InvalidBundleError);
  });

  it('timeline with < 2 events → InvalidBundleError', () => {
    const bad = a();
    bad.timeline = [bad.timeline[0]];
    expect(() => validateBundle(bad)).toThrow(InvalidBundleError);
  });

  it('unknown major schemaVersion → UnsupportedBundleVersionError', () => {
    const bad = a();
    bad.schemaVersion = '2.0.0';
    expect(() => validateBundle(bad)).toThrow(UnsupportedBundleVersionError);
  });
});

// ---------------------------------------------------------------------------
// 5. pinEvidenceBundle round-trip (schema §5 — OQ-10)
// ---------------------------------------------------------------------------

describe('EvidenceBundle — pinEvidenceBundle (OQ-10 binding)', () => {
  it('pins the EXACT canonical bytes and round-trips keccak256(fetched) == bundleHash', async () => {
    let pinned: Uint8Array | null = null;
    const fakePinner: EvidenceBundlePinner = {
      async uploadBinary(data, _contentType) {
        pinned = Buffer.from(data);
        return { cid: 'bafyfakecid', size: data.length };
      }
    };
    const v = VECTORS[0];
    const res = await pinEvidenceBundle(v.bundle, fakePinner);
    expect(res.cid).toBe('bafyfakecid');
    expect(res.bundleHash).toBe(v.bundleHash);
    // The pinned bytes ARE the canonical bytes (no re-encoding).
    expect(hexOf(pinned!)).toBe(v.canonicalBytesHex);
  });
});
