/**
 * V4 Typed Parser Tests
 *
 * Tests: parsing, defaults, validation, body splitting, required fields.
 *
 * @module config/agirailsmdV4.test
 */

import { parseAgirailsMdV4, validateAgirailsMdV4, AgirailsMdV4Config } from './agirailsmdV4';

// ============================================================================
// Test fixtures
// ============================================================================

const MINIMAL_V4 = `---
name: Code Reviewer
services:
  - code-review
pricing:
  base: 5.00
---
A code review agent.
`;

const FULL_V4 = `---
name: Code Reviewer Pro
slug: code-reviewer-pro
services:
  - code-review
  - security-audit
pricing:
  base: 10.00
  unit: review
  negotiable: true
  min_price: 5.00
  max_price: 50.00
network: testnet
sla:
  response: 1h
  delivery: 12h
  concurrency: 5
  dispute_window: 24h
covenant:
  accepts:
    code: typescript
    format: git-diff
  returns:
    review: markdown
    severity: enum
payment:
  modes:
    - actp
    - x402
endpoint: https://api.example.com/review
wallet: "0x1234567890abcdef"
agent_id: "42"
did: "did:agirails:42"
---
# Code Reviewer Pro

Expert code review agent.

## How to Request This Service

Send a git diff or PR link.

## FAQ

Common questions.
`;

const NO_NAME = `---
services:
  - code-review
pricing:
  base: 5.00
---
body
`;

const NO_SERVICES = `---
name: Test
pricing:
  base: 5.00
---
body
`;

const NO_PRICE = `---
name: Test
services:
  - testing
---
body
`;

// ============================================================================
// parseAgirailsMdV4 — required fields
// ============================================================================

describe('parseAgirailsMdV4 — required fields', () => {
  test('throws on missing name', () => {
    expect(() => parseAgirailsMdV4(NO_NAME)).toThrow('Missing required field: name');
  });

  test('throws on missing services', () => {
    expect(() => parseAgirailsMdV4(NO_SERVICES)).toThrow('services');
  });

  test('throws on missing pricing.base', () => {
    expect(() => parseAgirailsMdV4(NO_PRICE)).toThrow('pricing.base');
  });
});

// ============================================================================
// parseAgirailsMdV4 — services in canonical object form
// ============================================================================

describe('parseAgirailsMdV4 — services as objects', () => {
  test('parses services as {type, price, min_price, max_price} entries', () => {
    const md = `---
name: Pro Reviewer
services:
  - type: code-review
    price: "5"
    min_price: 4.95
    max_price: 5.05
  - type: security-audit
    price: "10"
pricing:
  base: 5
---
body`;
    const config = parseAgirailsMdV4(md);
    expect(config.services).toEqual([
      { type: 'code-review', price: '5', min_price: 4.95, max_price: 5.05 },
      { type: 'security-audit', price: '10' },
    ]);
  });

  test('mixed string + object entries are normalized to entries', () => {
    const md = `---
name: Mixed
services:
  - code-review
  - { type: security-audit, min_price: 1, max_price: 2 }
pricing:
  base: 5
---
body`;
    const config = parseAgirailsMdV4(md);
    expect(config.services).toEqual([
      { type: 'code-review' },
      { type: 'security-audit', min_price: 1, max_price: 2 },
    ]);
  });

  test('skips invalid entries (no type) but keeps valid ones', () => {
    const md = `---
name: PartialJunk
services:
  - { price: "5" }
  - code-review
pricing:
  base: 5
---
body`;
    const config = parseAgirailsMdV4(md);
    expect(config.services).toEqual([{ type: 'code-review' }]);
  });
});

// ============================================================================
// parseAgirailsMdV4 — intent semantics
// ============================================================================

describe('parseAgirailsMdV4 — intent', () => {
  test('defaults intent to "earn" when not present', () => {
    const md = `---
name: Default Intent
services: [code-review]
pricing:
  base: 5
---
body`;
    expect(parseAgirailsMdV4(md).intent).toBe('earn');
  });

  test('parses intent: pay with servicesNeeded and no services', () => {
    const md = `---
name: Pay Only
intent: pay
servicesNeeded: [code-review, translation]
budget: 20
---
body`;
    const config = parseAgirailsMdV4(md);
    expect(config.intent).toBe('pay');
    expect(config.services).toEqual([]);
    expect(config.servicesNeeded).toEqual(['code-review', 'translation']);
    expect(config.budget).toBe(20);
    // base falls back to budget when pricing is omitted entirely
    expect(config.pricing.base).toBe(20);
  });

  test('accepts snake_case `services_needed` as alias', () => {
    const md = `---
name: SnakeCase
intent: pay
services_needed: [code-review]
---
body`;
    expect(parseAgirailsMdV4(md).servicesNeeded).toEqual(['code-review']);
  });

  test('intent: pay throws when servicesNeeded is empty', () => {
    const md = `---
name: PayNoNeeds
intent: pay
---
body`;
    expect(() => parseAgirailsMdV4(md)).toThrow(/servicesNeeded/);
  });

  test('intent: pay no longer throws on missing services', () => {
    const md = `---
name: PayNoServices
intent: pay
servicesNeeded: [code-review]
---
body`;
    expect(() => parseAgirailsMdV4(md)).not.toThrow();
  });

  test('intent: pay no longer throws on missing pricing.base', () => {
    const md = `---
name: PayNoPrice
intent: pay
servicesNeeded: [code-review]
budget: 15
---
body`;
    expect(() => parseAgirailsMdV4(md)).not.toThrow();
    expect(parseAgirailsMdV4(md).pricing.base).toBe(15);
  });

  test('intent: both parses both blocks', () => {
    const md = `---
name: Both
intent: both
services: [code-review]
servicesNeeded: [translation]
pricing:
  base: 5
budget: 10
---
body`;
    const config = parseAgirailsMdV4(md);
    expect(config.intent).toBe('both');
    expect(config.services).toEqual([{ type: 'code-review' }]);
    expect(config.servicesNeeded).toEqual(['translation']);
    expect(config.budget).toBe(10);
  });

  test('unknown intent value falls back to default', () => {
    const md = `---
name: Garbage
intent: chaos
services: [code-review]
pricing:
  base: 5
---
body`;
    expect(parseAgirailsMdV4(md).intent).toBe('earn');
  });
});

// ============================================================================
// parseAgirailsMdV4 — minimal config with defaults
// ============================================================================

describe('parseAgirailsMdV4 — defaults', () => {
  let config: AgirailsMdV4Config;

  beforeAll(() => {
    config = parseAgirailsMdV4(MINIMAL_V4);
  });

  test('parses name', () => {
    expect(config.name).toBe('Code Reviewer');
  });

  test('generates slug from name when not specified', () => {
    expect(config.slug).toBe('code-reviewer');
  });

  test('parses services (legacy strings lifted to entries)', () => {
    expect(config.services).toEqual([{ type: 'code-review' }]);
  });

  test('parses pricing.base', () => {
    expect(config.pricing.base).toBe(5.0);
  });

  test('applies pricing defaults', () => {
    expect(config.pricing.currency).toBe('USDC');
    expect(config.pricing.unit).toBe('job');
    expect(config.pricing.negotiable).toBe(false);
  });

  test('min_price/max_price default to base when not specified', () => {
    expect(config.pricing.min_price).toBe(5.0);
    expect(config.pricing.max_price).toBe(5.0);
  });

  test('network defaults to mock', () => {
    expect(config.network).toBe('mock');
  });

  test('SLA uses defaults', () => {
    expect(config.sla.response).toBe('2h');
    expect(config.sla.delivery).toBe('24h');
    expect(config.sla.concurrency).toBe(10);
    expect(config.sla.dispute_window).toBe('48h');
  });

  test('covenant defaults to empty', () => {
    expect(config.covenant.accepts).toEqual({});
    expect(config.covenant.returns).toEqual({});
  });

  test('payment defaults to actp', () => {
    expect(config.payment.modes).toEqual(['actp']);
  });

  test('endpoint is undefined when not specified', () => {
    expect(config.endpoint).toBeUndefined();
  });

  test('publish metadata is undefined when not present', () => {
    expect(config.wallet).toBeUndefined();
    expect(config.agent_id).toBeUndefined();
    expect(config.did).toBeUndefined();
  });

  test('description is body content', () => {
    expect(config.description).toBe('A code review agent.');
  });

  test('howToRequest is empty when heading missing', () => {
    expect(config.howToRequest).toBe('');
  });
});

// ============================================================================
// parseAgirailsMdV4 — full config
// ============================================================================

describe('parseAgirailsMdV4 — full config', () => {
  let config: AgirailsMdV4Config;

  beforeAll(() => {
    config = parseAgirailsMdV4(FULL_V4);
  });

  test('uses explicit slug over generated', () => {
    expect(config.slug).toBe('code-reviewer-pro');
  });

  test('parses multiple services (legacy strings lifted to entries)', () => {
    expect(config.services).toEqual([
      { type: 'code-review' },
      { type: 'security-audit' },
    ]);
  });

  test('parses full pricing', () => {
    expect(config.pricing.base).toBe(10.0);
    expect(config.pricing.unit).toBe('review');
    expect(config.pricing.negotiable).toBe(true);
    expect(config.pricing.min_price).toBe(5.0);
    expect(config.pricing.max_price).toBe(50.0);
  });

  test('parses explicit network', () => {
    expect(config.network).toBe('testnet');
  });

  test('parses explicit SLA', () => {
    expect(config.sla.response).toBe('1h');
    expect(config.sla.delivery).toBe('12h');
    expect(config.sla.concurrency).toBe(5);
    expect(config.sla.dispute_window).toBe('24h');
  });

  test('parses covenant', () => {
    expect(config.covenant.accepts).toEqual({ code: 'typescript', format: 'git-diff' });
    expect(config.covenant.returns).toEqual({ review: 'markdown', severity: 'enum' });
  });

  test('parses payment modes', () => {
    expect(config.payment.modes).toEqual(['actp', 'x402']);
  });

  test('parses endpoint', () => {
    expect(config.endpoint).toBe('https://api.example.com/review');
  });

  test('parses publish metadata', () => {
    expect(config.wallet).toBe('0x1234567890abcdef');
    expect(config.agent_id).toBe('42');
    expect(config.did).toBe('did:agirails:42');
  });

  test('splits description from howToRequest', () => {
    expect(config.description).toContain('Code Reviewer Pro');
    expect(config.description).toContain('Expert code review agent');
    expect(config.description).not.toContain('Send a git diff');
  });

  test('howToRequest captures section content', () => {
    expect(config.howToRequest).toContain('Send a git diff');
    expect(config.howToRequest).not.toContain('FAQ');
  });
});

// ============================================================================
// parseAgirailsMdV4 — network fallback
// ============================================================================

describe('parseAgirailsMdV4 — network', () => {
  test('invalid network falls back to mock', () => {
    const md = `---\nname: Test\nservices:\n  - testing\npricing:\n  base: 1.00\nnetwork: invalid\n---\nbody`;
    const config = parseAgirailsMdV4(md);
    expect(config.network).toBe('mock');
  });

  test('accepts mainnet', () => {
    const md = `---\nname: Test\nservices:\n  - testing\npricing:\n  base: 1.00\nnetwork: mainnet\n---\nbody`;
    const config = parseAgirailsMdV4(md);
    expect(config.network).toBe('mainnet');
  });
});

// ============================================================================
// parseAgirailsMdV4 — body parsing
// ============================================================================

describe('parseAgirailsMdV4 — body parsing', () => {
  test('empty body → empty description and howToRequest', () => {
    const md = `---\nname: Test\nservices:\n  - testing\npricing:\n  base: 1.00\n---\n`;
    const config = parseAgirailsMdV4(md);
    expect(config.description).toBe('');
    expect(config.howToRequest).toBe('');
  });

  test('body with only howToRequest heading', () => {
    const md = `---\nname: Test\nservices:\n  - testing\npricing:\n  base: 1.00\n---\n## How to Request This Service\n\nSend a message.\n`;
    const config = parseAgirailsMdV4(md);
    expect(config.description).toBe('');
    expect(config.howToRequest).toBe('Send a message.');
  });

  test('body with description only (no howToRequest heading)', () => {
    const md = `---\nname: Test\nservices:\n  - testing\npricing:\n  base: 1.00\n---\n# Agent\n\nDoes things.\n`;
    const config = parseAgirailsMdV4(md);
    expect(config.description).toContain('Does things.');
    expect(config.howToRequest).toBe('');
  });
});

// ============================================================================
// validateAgirailsMdV4
// ============================================================================

describe('validateAgirailsMdV4', () => {
  function makeConfig(overrides: Partial<AgirailsMdV4Config> = {}): AgirailsMdV4Config {
    return {
      name: 'Test',
      slug: 'test',
      intent: 'earn',
      services: [{ type: 'testing' }],
      servicesNeeded: [],
      pricing: {
        base: 5.0,
        currency: 'USDC',
        unit: 'job',
        negotiable: false,
        min_price: 5.0,
        max_price: 5.0,
      },
      network: 'mock',
      sla: { response: '2h', delivery: '24h', concurrency: 10, dispute_window: '48h' },
      covenant: { accepts: {}, returns: {} },
      payment: { modes: ['actp'] },
      description: 'A test agent.',
      howToRequest: '',
      ...overrides,
    };
  }

  test('valid config returns no errors', () => {
    const result = validateAgirailsMdV4(makeConfig());
    expect(result.valid).toBe(true);
    expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  test('negative price is error', () => {
    const result = validateAgirailsMdV4(makeConfig({
      pricing: { ...makeConfig().pricing, base: -1 },
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: 'pricing.base', severity: 'error' })
    );
  });

  test('price below minimum is error', () => {
    const result = validateAgirailsMdV4(makeConfig({
      pricing: { ...makeConfig().pricing, base: 0.01 },
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: 'pricing.base', severity: 'error' })
    );
  });

  test('price at minimum is valid', () => {
    const result = validateAgirailsMdV4(makeConfig({
      pricing: { ...makeConfig().pricing, base: 0.05 },
    }));
    expect(result.valid).toBe(true);
  });

  test('negotiable with min > max is error', () => {
    const result = validateAgirailsMdV4(makeConfig({
      pricing: { ...makeConfig().pricing, negotiable: true, min_price: 10, max_price: 5 },
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: 'pricing.min_price', severity: 'error' })
    );
  });

  test('negotiable with min <= max is valid', () => {
    const result = validateAgirailsMdV4(makeConfig({
      pricing: { ...makeConfig().pricing, negotiable: true, min_price: 5, max_price: 10 },
    }));
    const minPriceErrors = result.issues.filter(i => i.field === 'pricing.min_price');
    expect(minPriceErrors).toHaveLength(0);
  });

  test('concurrency < 1 is error', () => {
    const result = validateAgirailsMdV4(makeConfig({
      sla: { ...makeConfig().sla, concurrency: 0 },
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: 'sla.concurrency', severity: 'error' })
    );
  });

  test('empty description is warning (not error)', () => {
    const result = validateAgirailsMdV4(makeConfig({ description: '' }));
    expect(result.valid).toBe(true); // warnings don't invalidate
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: 'description', severity: 'warning' })
    );
  });

  test('x402 without endpoint is error', () => {
    const result = validateAgirailsMdV4(makeConfig({
      payment: { modes: ['x402'] },
      endpoint: undefined,
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: 'endpoint', severity: 'error' })
    );
  });

  test('x402 with endpoint is valid', () => {
    const result = validateAgirailsMdV4(makeConfig({
      payment: { modes: ['x402'] },
      endpoint: 'https://api.example.com',
    }));
    const endpointErrors = result.issues.filter(i => i.field === 'endpoint');
    expect(endpointErrors).toHaveLength(0);
  });

  test('invalid slug is error', () => {
    const result = validateAgirailsMdV4(makeConfig({ slug: 'INVALID-SLUG' }));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ field: 'slug', severity: 'error' })
    );
  });
});

// ============================================================================
// parseAgirailsMdV4 — edge cases (branch coverage)
// ============================================================================

describe('parseAgirailsMdV4 — edge cases', () => {
  test('non-numeric pricing field returns undefined (NaN branch)', () => {
    const md = `---\nname: Test\nservices:\n  - testing\npricing:\n  base: 5.00\n  min_price: not-a-number\n---\nbody`;
    const config = parseAgirailsMdV4(md);
    // min_price falls back to base when NaN
    expect(config.pricing.min_price).toBe(5.0);
  });
});
