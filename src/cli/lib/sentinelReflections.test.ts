/**
 * Tests for the vendored Sentinel reflection table.
 *
 * Locks down:
 *   - shape contract (76 entries, well-formed)
 *   - determinism contract (same UTC day → same entry; UTC, not local tz)
 *   - hash function contract (djb2-style; matches Sentinel exactly)
 *
 * Anything here breaking means the local-fallback render will diverge
 * from what Sentinel would have streamed on the same day, which silently
 * breaks the "Reflection: ..." line in `actp test`.
 *
 * @module cli/lib/sentinelReflections.test
 */

import {
  REFLECTIONS,
  Reflection,
  djb2hash,
  utcDateKey,
  todaysReflection,
} from './sentinelReflections';

describe('sentinelReflections — shape contract', () => {
  it('contains exactly 76 reflections (matches upstream Sentinel table)', () => {
    expect(REFLECTIONS.length).toBe(76);
  });

  it('has no undefined or null entries', () => {
    for (let i = 0; i < REFLECTIONS.length; i++) {
      const entry = REFLECTIONS[i];
      // Tightly assert non-nullish to surface a bad copy-paste during a
      // future port from Sentinel. `expect(entry).toBeDefined()` would
      // also pass for `null`, so be explicit.
      expect(entry).not.toBeNull();
      expect(entry).not.toBeUndefined();
    }
  });

  it('every entry has a numeric `id` and a non-empty string `text`', () => {
    for (const entry of REFLECTIONS) {
      expect(typeof entry.id).toBe('number');
      expect(Number.isFinite(entry.id)).toBe(true);
      expect(entry.id).toBeGreaterThan(0);
      expect(typeof entry.text).toBe('string');
      expect(entry.text.length).toBeGreaterThan(0);
      // ACIM Workbook lessons are 1–365.
      expect(entry.id).toBeLessThanOrEqual(365);
    }
  });

  it('all ids are unique (no duplicate lesson numbers)', () => {
    const ids = REFLECTIONS.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all texts are unique (no accidental duplicates introduced during port)', () => {
    const texts = REFLECTIONS.map((r) => r.text);
    const unique = new Set(texts);
    expect(unique.size).toBe(texts.length);
  });

  it('preserves byte-equivalent canonical entries (id=1 and id=345 anchors)', () => {
    // Anchor first and last entry against Sentinel to catch a silent
    // reorder during a future port.
    const first = REFLECTIONS[0];
    const last = REFLECTIONS[REFLECTIONS.length - 1];
    expect(first).toEqual<Reflection>({ id: 1, text: 'Nothing I see means anything.' });
    expect(last).toEqual<Reflection>({ id: 345, text: 'I offer only miracles today.' });
  });
});

describe('sentinelReflections — djb2hash', () => {
  it('returns the same hash for the same input', () => {
    expect(djb2hash('2026-06-09')).toBe(djb2hash('2026-06-09'));
  });

  it('returns different hashes for different inputs (typical case)', () => {
    // Not a strict contract (collisions are possible in principle), but
    // for two adjacent dates we expect a different output.
    expect(djb2hash('2026-06-09')).not.toBe(djb2hash('2026-06-10'));
  });

  it('returns 0 for the empty string', () => {
    // Sentinel's loop never runs for an empty key, so h stays 0.
    expect(djb2hash('')).toBe(0);
  });

  it('returns a non-negative integer (Math.abs applied)', () => {
    // Pick a few representative keys.
    for (const key of ['2026-01-01', '2026-12-31', '2030-06-15', 'arbitrary']) {
      const h = djb2hash(key);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
});

describe('sentinelReflections — utcDateKey', () => {
  it('formats a UTC midnight as YYYY-MM-DD', () => {
    expect(utcDateKey(new Date('2026-06-09T00:00:00.000Z'))).toBe('2026-06-09');
  });

  it('uses UTC, not local time (a UTC noon is still that UTC day)', () => {
    expect(utcDateKey(new Date('2026-06-09T12:34:56.000Z'))).toBe('2026-06-09');
  });

  it('rolls to the next UTC day exactly at 00:00:00 UTC', () => {
    expect(utcDateKey(new Date('2026-06-09T23:59:59.999Z'))).toBe('2026-06-09');
    expect(utcDateKey(new Date('2026-06-10T00:00:00.000Z'))).toBe('2026-06-10');
  });
});

describe('sentinelReflections — todaysReflection', () => {
  it('returns the same entry for two Dates inside the same UTC day', () => {
    const morning = new Date('2026-06-09T01:23:45.000Z');
    const evening = new Date('2026-06-09T22:11:00.000Z');
    expect(todaysReflection(morning)).toEqual(todaysReflection(evening));
  });

  it('returns the same entry across repeated calls with the same instant', () => {
    const at = new Date('2026-06-09T12:00:00.000Z');
    const a = todaysReflection(at);
    const b = todaysReflection(at);
    const c = todaysReflection(at);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('returns a different entry on at least 8 of 10 sampled adjacent days', () => {
    // Strict "always different" would be wrong: djb2 % 76 can collide
    // across adjacent days in principle. The contract we care about is
    // "the pool actually varies", so we sample 10 sequential days and
    // require ≥8 distinct entries.
    const days = [
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
      '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10',
    ];
    const ids = days.map((d) => todaysReflection(new Date(`${d}T00:00:00.000Z`)).id);
    const unique = new Set(ids);
    expect(unique.size).toBeGreaterThanOrEqual(8);
  });

  it('only ever returns entries from the canonical REFLECTIONS table', () => {
    const tableIds = new Set(REFLECTIONS.map((r) => r.id));
    for (let i = 0; i < 30; i++) {
      // Walk forward one day at a time from a fixed epoch.
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      const r = todaysReflection(d);
      expect(tableIds.has(r.id)).toBe(true);
    }
  });

  it('returns an entry with a non-empty text (defensive — no malformed slot)', () => {
    const r = todaysReflection(new Date('2026-06-09T00:00:00.000Z'));
    expect(typeof r.text).toBe('string');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('uses the documented (hash mod table-length) selection rule', () => {
    // Independent recomputation: hash the same key, mod 76, compare.
    const d = new Date('2026-06-09T15:30:00.000Z');
    const expectedIdx = djb2hash('2026-06-09') % REFLECTIONS.length;
    const expected = REFLECTIONS[expectedIdx];
    expect(todaysReflection(d)).toEqual(expected);
  });
});
