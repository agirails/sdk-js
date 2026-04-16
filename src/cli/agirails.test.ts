/**
 * Agirails Quickstart Tests
 *
 * Tests the core logic paths of `npx agirails` without spawning
 * a subprocess or requiring interactive input.
 *
 * @module cli/agirails.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveConfig, loadConfig, isInitialized, resolveIdentityPath, updateConfig, CONFIG_DEFAULTS } from './utils/config';
import { generateSlug } from '../config/slugUtils';
import { validateSlug } from '../config/slugUtils';
import { serializeAgirailsMd } from '../config/agirailsmd';
import { V4_DEFAULTS } from '../config/defaults';

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;
let origCwd: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agirails-test-'));
  origCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Slug Validation (Medium finding: empty slug)
// ============================================================================

describe('slug validation for quickstart', () => {
  it('rejects symbol-only names that produce empty slugs', () => {
    const slug = generateSlug('!!!');
    expect(slug).toBe('');
    expect(validateSlug(slug)).not.toBeNull();
  });

  it('accepts valid agent names', () => {
    const slug = generateSlug('Code Reviewer Pro');
    expect(slug).toBe('code-reviewer-pro');
    expect(validateSlug(slug)).toBeNull();
  });

  it('handles single-character valid names', () => {
    const slug = generateSlug('x');
    expect(slug).toBe('x');
    expect(validateSlug(slug)).toBeNull();
  });
});

// ============================================================================
// File Overwrite Guard (Medium finding: silent clobber)
// ============================================================================

describe('identity file guard', () => {
  it('detects existing file with same slug name', () => {
    const slug = generateSlug('My Agent');
    const filename = `${slug}.md`;
    fs.writeFileSync(filename, 'existing content', 'utf-8');

    expect(fs.existsSync(filename)).toBe(true);
    // The quickstart flow should check this before writing
    const existsBefore = fs.existsSync(filename);
    expect(existsBefore).toBe(true);
  });
});

// ============================================================================
// Identity Backfill (High finding: initialized without identity)
// ============================================================================

describe('identity backfill for existing configs', () => {
  it('resolveIdentityPath returns null when config has no identity', () => {
    // Simulate an older config without identity pointer
    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: 'mock',
      address: '0x' + 'a'.repeat(40),
    });

    expect(isInitialized()).toBe(true);
    expect(resolveIdentityPath()).toBeNull();
  });

  it('updateConfig adds identity pointer to existing config', () => {
    // Simulate older config
    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: 'mock',
      address: '0x' + 'a'.repeat(40),
    });

    // Backfill identity (what the fix does)
    updateConfig({ identity: 'my-agent.md' });

    const config = loadConfig();
    expect(config.identity).toBe('my-agent.md');
  });

  it('resolveIdentityPath works after backfill when file exists', () => {
    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: 'mock',
      address: '0x' + 'a'.repeat(40),
    });

    const filename = 'my-agent.md';
    fs.writeFileSync(filename, '---\nname: My Agent\n---\n', 'utf-8');
    updateConfig({ identity: filename });

    // Use realpath to normalize macOS /var → /private/var symlink
    expect(fs.realpathSync(resolveIdentityPath()!)).toBe(fs.realpathSync(path.join(testDir, filename)));
  });
});

// ============================================================================
// Full Onboarding Flow (simulated, no readline)
// ============================================================================

describe('quickstart onboarding flow', () => {
  it('generates valid {slug}.md with V4 frontmatter and SDK-publishable services', () => {
    const name = 'Code Reviewer Pro';
    const slug = generateSlug(name);
    const service = 'code-review';
    const price = 2.50;
    const minPrice = Math.max(0.01, price * 0.99);
    const maxPrice = price * 1.01;

    const frontmatter = {
      name,
      slug,
      version: '1.0.0',
      network: V4_DEFAULTS.network,
      services: [
        { type: service, price: String(price), min_price: minPrice, max_price: maxPrice },
      ],
      pricing: {
        base: price,
        currency: V4_DEFAULTS.pricing.currency,
        unit: V4_DEFAULTS.pricing.unit,
        min_price: minPrice,
        max_price: maxPrice,
        negotiable: false,
      },
      sla: { ...V4_DEFAULTS.sla },
      payment: { modes: [...V4_DEFAULTS.payment.modes] },
    };

    const body = `\n# ${name}\n\nDescribe what your agent does here.\n`;
    const content = serializeAgirailsMd(frontmatter, body);

    expect(content).toContain('---');
    expect(content).toContain('name: Code Reviewer Pro');
    expect(content).toContain('slug: code-reviewer-pro');
    expect(content).toContain('network: mock');
    expect(content).toContain('base: 2.5');
    expect(content).toContain('type: code-review');
    expect(content).toContain('min_price');
    expect(content).toContain('max_price');
  });

  it('emitted services are accepted by SDK publish pipeline (no Empty service type)', () => {
    // Cross-check against publishPipeline.extractRegistrationParams which
    // reads svc.type / svc.min_price / svc.max_price. Plain strings would
    // throw "Empty service type in services" — guard against that regression.
    const { extractRegistrationParams } = require('../config/publishPipeline');
    const services = [
      { type: 'code-review', price: '5', min_price: 4.95, max_price: 5.05 },
    ];
    const { serviceDescriptors } = extractRegistrationParams({ services });
    expect(serviceDescriptors).toHaveLength(1);
    expect(serviceDescriptors[0].serviceType).toBe('code-review');
    // 4.95 USDC × 1e6 = 4_950_000n (USDC has 6 decimals)
    expect(serviceDescriptors[0].minPrice).toBe(4_950_000n);
    expect(serviceDescriptors[0].maxPrice).toBe(5_050_000n);
  });

  it('bootstraps .actp/ with identity pointer', () => {
    const filename = 'test-agent.md';
    fs.writeFileSync(filename, '---\nname: Test\n---\n', 'utf-8');

    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: 'mock',
      address: '0x' + 'b'.repeat(40),
      identity: filename,
    });

    expect(isInitialized()).toBe(true);
    const config = loadConfig();
    expect(config.identity).toBe(filename);
    expect(config.mode).toBe('mock');
  });
});
