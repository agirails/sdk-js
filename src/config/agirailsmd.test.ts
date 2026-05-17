/**
 * AGIRAILS.md Parser + Canonical Hash Tests
 *
 * Tests: parsing, canonicalization, hashing determinism,
 * publish metadata stripping, Date handling, serialization round-trips.
 *
 * @module config/agirailsmd.test
 */

import {
  parseAgirailsMd,
  computeConfigHash,
  computeConfigHashFromParts,
  serializeAgirailsMd,
  canonicalize,
  stripPublishMetadata,
  PUBLISH_METADATA_KEYS,
} from './agirailsmd';

// ============================================================================
// Test fixtures
// ============================================================================

const MINIMAL_MD = `---
name: test-agent
version: "1.0.0"
---
# Hello
`;

const FULL_MD = `---
name: test-agent
version: "1.0.0"
network: base-sepolia
capabilities:
  - text-generation
  - code-review
pricing:
  min: 1.0
  max: 100.0
sla:
  uptime: 99.9
  response_time: 5000
---
# Test Agent

This agent does cool things.

## Features

- Feature A
- Feature B
`;

const WITH_PUBLISH_METADATA = `---
name: test-agent
version: "1.0.0"
config_hash: "0xabc123"
published_at: "2026-02-08T00:00:00.000Z"
config_cid: "bafybeig"
arweave_tx: "abc123def456"
template_source: "openclaw/skill-template"
---
# Hello
`;

// ============================================================================
// parseAgirailsMd
// ============================================================================

describe('parseAgirailsMd', () => {
  test('parses minimal AGIRAILS.md', () => {
    const result = parseAgirailsMd(MINIMAL_MD);
    expect(result.frontmatter).toEqual({
      name: 'test-agent',
      version: '1.0.0',
    });
    expect(result.body).toContain('# Hello');
  });

  test('parses full AGIRAILS.md with nested frontmatter', () => {
    const result = parseAgirailsMd(FULL_MD);
    expect(result.frontmatter.name).toBe('test-agent');
    expect(result.frontmatter.capabilities).toEqual(['text-generation', 'code-review']);
    expect((result.frontmatter.pricing as any).min).toBe(1.0);
    expect((result.frontmatter.sla as any).uptime).toBe(99.9);
    expect(result.body).toContain('# Test Agent');
    expect(result.body).toContain('- Feature A');
  });

  test('strips leading whitespace before frontmatter', () => {
    const content = `  \n\n---\nname: test\n---\n# Body`;
    const result = parseAgirailsMd(content);
    expect(result.frontmatter.name).toBe('test');
  });

  test('throws on missing frontmatter', () => {
    expect(() => parseAgirailsMd('# Just markdown')).toThrow('must start with YAML frontmatter');
  });

  test('throws on unclosed frontmatter', () => {
    expect(() => parseAgirailsMd('---\nname: test\n# No closing')).toThrow('not closed');
  });

  test('throws on invalid YAML', () => {
    expect(() => parseAgirailsMd('---\n: invalid: yaml: [unclosed\n---\n')).toThrow('Failed to parse YAML');
  });

  test('throws on non-object frontmatter', () => {
    expect(() => parseAgirailsMd('---\njust a string\n---\n')).toThrow('must be an object');
  });

  test('handles empty body', () => {
    const result = parseAgirailsMd('---\nname: test\n---\n');
    expect(result.frontmatter.name).toBe('test');
    expect(result.body).toBe('');
  });

  test('preserves publish metadata in parsed output', () => {
    const result = parseAgirailsMd(WITH_PUBLISH_METADATA);
    expect(result.frontmatter.config_hash).toBe('0xabc123');
    expect(result.frontmatter.published_at).toBe('2026-02-08T00:00:00.000Z');
    expect(result.frontmatter.config_cid).toBe('bafybeig');
    expect(result.frontmatter.arweave_tx).toBe('abc123def456');
    expect(result.frontmatter.template_source).toBe('openclaw/skill-template');
  });
});

// ============================================================================
// stripPublishMetadata
// ============================================================================

describe('stripPublishMetadata', () => {
  test('strips all publish metadata keys', () => {
    const fm: Record<string, unknown> = {
      name: 'test-agent',
      version: '1.0.0',
      config_hash: '0xabc',
      published_at: '2026-01-01',
      config_cid: 'bafytest',
      arweave_tx: 'artx123',
      template_source: 'openclaw/test',
    };

    const stripped = stripPublishMetadata(fm);
    expect(stripped).toEqual({ name: 'test-agent', version: '1.0.0' });
  });

  test('does not mutate original object', () => {
    const fm: Record<string, unknown> = {
      name: 'test',
      config_hash: '0xabc',
    };

    stripPublishMetadata(fm);
    expect(fm.config_hash).toBe('0xabc');
  });

  test('handles object with no publish metadata', () => {
    const fm = { name: 'test', version: '1.0.0' };
    const stripped = stripPublishMetadata(fm);
    expect(stripped).toEqual(fm);
  });

  test('PUBLISH_METADATA_KEYS contains all expected keys', () => {
    expect(PUBLISH_METADATA_KEYS).toContain('config_hash');
    expect(PUBLISH_METADATA_KEYS).toContain('published_at');
    expect(PUBLISH_METADATA_KEYS).toContain('config_cid');
    expect(PUBLISH_METADATA_KEYS).toContain('arweave_tx');
    expect(PUBLISH_METADATA_KEYS).toContain('template_source');
    expect(PUBLISH_METADATA_KEYS).toContain('wallet');
    expect(PUBLISH_METADATA_KEYS).toContain('agent_id');
    expect(PUBLISH_METADATA_KEYS).toContain('did');
    expect(PUBLISH_METADATA_KEYS).toHaveLength(8);
  });
});

// ============================================================================
// canonicalize
// ============================================================================

describe('canonicalize', () => {
  test('sorts object keys lexicographically', () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    const keys = Object.keys(result as Record<string, unknown>);
    expect(keys).toEqual(['a', 'm', 'z']);
  });

  test('sorts nested object keys recursively', () => {
    const result = canonicalize({
      outer: { z: 1, a: 2 },
      inner: { b: 3, a: 4 },
    }) as Record<string, Record<string, number>>;

    expect(Object.keys(result)).toEqual(['inner', 'outer']);
    expect(Object.keys(result.outer)).toEqual(['a', 'z']);
    expect(Object.keys(result.inner)).toEqual(['a', 'b']);
  });

  test('sorts arrays of primitives lexicographically', () => {
    expect(canonicalize(['code-review', 'text-generation', 'analysis'])).toEqual([
      'analysis',
      'code-review',
      'text-generation',
    ]);
  });

  test('sorts numeric arrays as strings', () => {
    expect(canonicalize([3, 1, 2])).toEqual([1, 2, 3]);
  });

  test('preserves order of object arrays', () => {
    const input = [
      { name: 'second', order: 2 },
      { name: 'first', order: 1 },
    ];
    const result = canonicalize(input) as any[];
    expect(result[0].name).toBe('second');
    expect(result[1].name).toBe('first');
  });

  test('converts Date to ISO string', () => {
    const date = new Date('2026-02-08T12:00:00Z');
    expect(canonicalize(date)).toBe('2026-02-08T12:00:00.000Z');
  });

  test('handles nested Dates in objects', () => {
    const result = canonicalize({
      created: new Date('2026-01-01T00:00:00Z'),
      name: 'test',
    }) as Record<string, unknown>;

    expect(result.created).toBe('2026-01-01T00:00:00.000Z');
  });

  test('preserves null and undefined', () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(undefined)).toBeUndefined();
  });

  test('preserves primitive values', () => {
    expect(canonicalize('hello')).toBe('hello');
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize(true)).toBe(true);
  });

  test('handles mixed primitive/object arrays', () => {
    // Array with objects — should preserve order (not all primitives)
    const input = [{ a: 1 }, 'string'];
    const result = canonicalize(input) as any[];
    expect(result[0]).toEqual({ a: 1 });
    expect(result[1]).toBe('string');
  });

  test('handles empty objects and arrays', () => {
    expect(canonicalize({})).toEqual({});
    expect(canonicalize([])).toEqual([]);
  });
});

// ============================================================================
// computeConfigHash — determinism
// ============================================================================

describe('computeConfigHash', () => {
  test('returns consistent hash for same content', () => {
    const hash1 = computeConfigHash(MINIMAL_MD);
    const hash2 = computeConfigHash(MINIMAL_MD);
    expect(hash1).toEqual(hash2);
  });

  test('returns different hashes for different frontmatter', () => {
    const md1 = '---\nname: agent-a\n---\n# Body';
    const md2 = '---\nname: agent-b\n---\n# Body';
    expect(computeConfigHash(md1).configHash).not.toBe(computeConfigHash(md2).configHash);
  });

  test('returns different hashes for different body', () => {
    const md1 = '---\nname: test\n---\n# Body A';
    const md2 = '---\nname: test\n---\n# Body B';
    expect(computeConfigHash(md1).configHash).not.toBe(computeConfigHash(md2).configHash);
  });

  test('hash is bytes32 format', () => {
    const { configHash, structuredHash, bodyHash } = computeConfigHash(MINIMAL_MD);
    expect(configHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(structuredHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(bodyHash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  test('key order does not affect hash', () => {
    const md1 = '---\nname: test\nversion: "1.0.0"\n---\n# Body';
    const md2 = '---\nversion: "1.0.0"\nname: test\n---\n# Body';
    expect(computeConfigHash(md1).configHash).toBe(computeConfigHash(md2).configHash);
  });

  test('publish metadata does not affect hash', () => {
    const withoutMeta = '---\nname: test\nversion: "1.0.0"\n---\n# Body';
    const withMeta = `---\nname: test\nversion: "1.0.0"\nconfig_hash: "0xold"\npublished_at: "2026-01-01"\nconfig_cid: "bafyold"\narweave_tx: "artxold"\ntemplate_source: "github"\n---\n# Body`;

    expect(computeConfigHash(withoutMeta).configHash).toBe(
      computeConfigHash(withMeta).configHash
    );
  });

  test('CRLF vs LF in body does not affect hash', () => {
    const lf = '---\nname: test\n---\n# Line1\n# Line2';
    const crlf = '---\nname: test\n---\n# Line1\r\n# Line2';
    expect(computeConfigHash(lf).configHash).toBe(computeConfigHash(crlf).configHash);
  });

  test('trailing whitespace in body does not affect hash', () => {
    const clean = '---\nname: test\n---\n# Line1\n# Line2';
    const trailing = '---\nname: test\n---\n# Line1   \n# Line2  ';
    expect(computeConfigHash(clean).configHash).toBe(computeConfigHash(trailing).configHash);
  });

  test('primitive array order does not affect hash (sorted)', () => {
    const md1 = '---\ncapabilities:\n  - b\n  - a\n---\n# Body';
    const md2 = '---\ncapabilities:\n  - a\n  - b\n---\n# Body';
    expect(computeConfigHash(md1).configHash).toBe(computeConfigHash(md2).configHash);
  });

  test('YAML Date auto-parsing does not break determinism', () => {
    // YAML parsers may auto-convert "2026-02-08" to a Date object
    const md = '---\nname: test\ncreated: 2026-02-08\n---\n# Body';
    const hash1 = computeConfigHash(md);
    const hash2 = computeConfigHash(md);
    expect(hash1.configHash).toBe(hash2.configHash);
  });
});

// ============================================================================
// computeConfigHashFromParts
// ============================================================================

describe('computeConfigHashFromParts', () => {
  test('matches computeConfigHash for same content', () => {
    const { frontmatter, body } = parseAgirailsMd(FULL_MD);
    const fromContent = computeConfigHash(FULL_MD);
    const fromParts = computeConfigHashFromParts(frontmatter, body);
    expect(fromParts).toEqual(fromContent);
  });

  test('strips publish metadata before hashing', () => {
    const fm = { name: 'test', config_hash: '0xold', published_at: '2026-01-01' };
    const fmClean = { name: 'test' };
    const body = '# Body';

    expect(computeConfigHashFromParts(fm, body).configHash).toBe(
      computeConfigHashFromParts(fmClean, body).configHash
    );
  });
});

// ============================================================================
// serializeAgirailsMd
// ============================================================================

describe('serializeAgirailsMd', () => {
  test('produces valid AGIRAILS.md format', () => {
    const result = serializeAgirailsMd({ name: 'test', version: '1.0.0' }, '# Hello\n');
    expect(result).toMatch(/^---\n/);
    expect(result).toContain('name: test');
    expect(result).toContain('version: 1.0.0');
    expect(result).toContain('\n---\n');
    expect(result).toContain('# Hello');
  });

  test('round-trip: parse → serialize → parse produces same data', () => {
    const original = parseAgirailsMd(FULL_MD);
    const serialized = serializeAgirailsMd(original.frontmatter, original.body);
    const reparsed = parseAgirailsMd(serialized);

    expect(reparsed.frontmatter.name).toBe(original.frontmatter.name);
    expect(reparsed.frontmatter.capabilities).toEqual(original.frontmatter.capabilities);
    expect(reparsed.body).toContain('# Test Agent');
  });

  test('round-trip preserves hash', () => {
    const original = parseAgirailsMd(FULL_MD);
    const serialized = serializeAgirailsMd(original.frontmatter, original.body);

    const hashOriginal = computeConfigHash(FULL_MD);
    const hashSerialized = computeConfigHash(serialized);

    expect(hashSerialized.configHash).toBe(hashOriginal.configHash);
  });

  test('handles body without leading newline', () => {
    const result = serializeAgirailsMd({ name: 'test' }, '# No leading newline');
    expect(result).toContain('\n---\n\n# No leading newline');
  });

  test('handles body with leading newline', () => {
    const result = serializeAgirailsMd({ name: 'test' }, '\n# Leading newline');
    expect(result).toContain('\n---\n\n# Leading newline');
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('edge cases', () => {
  test('frontmatter with special characters', () => {
    const md = `---\nname: "test: agent"\ndescription: "line1\\nline2"\n---\n# Body`;
    const result = parseAgirailsMd(md);
    expect(result.frontmatter.name).toBe('test: agent');
  });

  test('frontmatter with unicode', () => {
    const md = `---\nname: "Agent 🤖"\nlang: "日本語"\n---\n# Body`;
    const result = parseAgirailsMd(md);
    expect(result.frontmatter.name).toBe('Agent 🤖');
    expect(result.frontmatter.lang).toBe('日本語');

    // Hash is deterministic
    const h1 = computeConfigHash(md);
    const h2 = computeConfigHash(md);
    expect(h1.configHash).toBe(h2.configHash);
  });

  test('frontmatter with deeply nested objects', () => {
    const md = `---\na:\n  b:\n    c:\n      d: deep\n---\n# Body`;
    const result = parseAgirailsMd(md);
    expect((result.frontmatter.a as any).b.c.d).toBe('deep');
  });

  test('very large body content hashes correctly', () => {
    const largeBody = '# Title\n' + 'Lorem ipsum dolor sit amet.\n'.repeat(1000);
    const md = `---\nname: test\n---\n${largeBody}`;
    const { configHash } = computeConfigHash(md);
    expect(configHash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  test('empty frontmatter (only required ---)', () => {
    // YAML parses empty content as null, which should throw
    expect(() => parseAgirailsMd('---\n\n---\n# Body')).toThrow();
  });

  test('boolean arrays are sorted', () => {
    const result = canonicalize([true, false, true]);
    expect(result).toEqual([false, true, true]);
  });

  // ============================================================================
  // Apex audit FIND-016 — defence-in-depth bounds on parser inputs
  // ============================================================================

  describe('input-size and alias-count guards (FIND-016)', () => {
    test('rejects content larger than the 256 KB cap', () => {
      // The bound applies before YAML / regex work so an attacker can't
      // burn CPU on string normalisation either. Payload is one byte
      // over the cap.
      const overSize = '---\nname: test\n---\n' + 'x'.repeat(256_001);
      expect(() => parseAgirailsMd(overSize)).toThrow(/exceeds 256000 bytes/);
    });

    test('accepts content right under the cap (boundary)', () => {
      const padding = '\n'.repeat(255_000);
      const md = `---\nname: t\n---\n${padding}`;
      expect(md.length).toBeLessThanOrEqual(256_000);
      expect(() => parseAgirailsMd(md)).not.toThrow();
    });

    test('rejects YAML that uses more aliases than the tight cap', () => {
      // 12 references to one anchor; cap is 10. Canonical AGIRAILS.md
      // files never use anchors, so the cap is conservative on purpose.
      const md = [
        '---',
        'anchor: &a [1, 2, 3]',
        'a1: *a',
        'a2: *a',
        'a3: *a',
        'a4: *a',
        'a5: *a',
        'a6: *a',
        'a7: *a',
        'a8: *a',
        'a9: *a',
        'a10: *a',
        'a11: *a',
        'a12: *a',
        '---',
        '# Body',
      ].join('\n');
      expect(() => parseAgirailsMd(md)).toThrow(/alias|Failed to parse YAML/i);
    });

    test('accepts canonical AGIRAILS.md (no anchors, well under the cap)', () => {
      const md = `---\nname: Test Agent\nslug: test-agent\nservices:\n  - foo\n---\n# Body`;
      const result = parseAgirailsMd(md);
      expect(result.frontmatter.name).toBe('Test Agent');
    });
  });
});
