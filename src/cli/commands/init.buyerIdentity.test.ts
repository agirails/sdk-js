/**
 * AIP-18 DEC-4: generateBuyerIdentityFile() — minimal `{slug}.md` scaffold
 * for pay-only buyers so `actp publish` has an input to read.
 *
 * Contract covered:
 *   1. Writes a `{slug}.md` named after generateSlug(name).
 *   2. Frontmatter parses as a valid V4 config (intent: pay,
 *      servicesNeeded non-empty, name/slug/wallet/network set).
 *   3. resolveIdentityPath() finds the generated file.
 *   4. Idempotent: does not overwrite an existing file (returns filename).
 *   5. Wallet address is lowercased.
 *   6. `mode: testnet` → `network: testnet`; `mode: mainnet` → `network: mainnet`.
 *   7. Falls back to slug `buyer` when name produces an empty slug.
 *   8. Body contains the budget-privacy notice (committable guidance).
 *   9. Atomic write — no `.tmp` left behind on success.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Output } from '../utils/output';
import { generateBuyerIdentityFile } from './init';
import { parseAgirailsMdV4 } from '../../config/agirailsmdV4';
import { resolveIdentityPath } from '../utils/config';

function mkTmp(prefix = 'actp-buyer-id-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Silent Output sink — we only inspect filesystem effects.
function silentOutput(): Output {
  return new Output('quiet');
}

describe('generateBuyerIdentityFile (AIP-18 DEC-4 scaffold)', () => {
  let dir: string;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { rmTmp(dir); });

  test('writes `{slug}.md` named after generateSlug(name)', () => {
    const filename = generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'My Trader Bot',
      walletAddress: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
      mode: 'testnet',
      output: silentOutput(),
    });

    expect(filename).toBe('my-trader-bot.md');
    expect(fs.existsSync(path.join(dir, filename))).toBe(true);
  });

  test('generated frontmatter parses as a valid V4 buyer config', () => {
    const filename = generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'wow-buyer',
      walletAddress: '0x0123456789AbCdEf0123456789AbCdEf01234567',
      mode: 'testnet',
      output: silentOutput(),
    });

    const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
    const v4 = parseAgirailsMdV4(content);

    expect(v4.intent).toBe('pay');
    expect(v4.name).toBe('wow-buyer');
    expect(v4.slug).toBe('wow-buyer');
    expect(v4.servicesNeeded.length).toBeGreaterThan(0);
    expect(v4.servicesNeeded).toContain('onboarding');
    expect(v4.network).toBe('testnet');
    expect(v4.wallet).toBe('0x0123456789abcdef0123456789abcdef01234567');
    expect(v4.budget).toBe(10);
    // Pay-only files MUST have no services (the V4 parser tolerates empty
    // services only when intent === 'pay').
    expect(v4.services).toEqual([]);
  });

  test('resolveIdentityPath() locates the generated file', () => {
    generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'discoverable',
      walletAddress: '0x1111111111111111111111111111111111111111',
      mode: 'testnet',
      output: silentOutput(),
    });

    const resolved = resolveIdentityPath(dir);
    expect(resolved).not.toBeNull();
    expect(path.basename(resolved!)).toBe('discoverable.md');
  });

  test('idempotent — does not clobber an existing file', () => {
    const filename = 'preexisting.md';
    const filePath = path.join(dir, filename);
    const sentinelBody = `---
name: preexisting
slug: preexisting
intent: pay
servicesNeeded:
  - custom-cap
---

User wrote this by hand.
`;
    fs.writeFileSync(filePath, sentinelBody, 'utf-8');

    const returned = generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'preexisting',
      walletAddress: '0x2222222222222222222222222222222222222222',
      mode: 'testnet',
      output: silentOutput(),
    });

    expect(returned).toBe('preexisting.md');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(sentinelBody);
  });

  test('lowercases wallet address before writing', () => {
    const filename = generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'case-test',
      walletAddress: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
      mode: 'testnet',
      output: silentOutput(),
    });

    const v4 = parseAgirailsMdV4(fs.readFileSync(path.join(dir, filename), 'utf-8'));
    expect(v4.wallet).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  test('mode: mainnet → network: mainnet', () => {
    const filename = generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'mainnet-buyer',
      walletAddress: '0x3333333333333333333333333333333333333333',
      mode: 'mainnet',
      output: silentOutput(),
    });

    const v4 = parseAgirailsMdV4(fs.readFileSync(path.join(dir, filename), 'utf-8'));
    expect(v4.network).toBe('mainnet');
  });

  test('falls back to slug `buyer` when name slugifies to empty string', () => {
    const filename = generateBuyerIdentityFile({
      projectRoot: dir,
      // Whitespace + punctuation only — generateSlug returns ''
      name: '   ---   ',
      walletAddress: '0x4444444444444444444444444444444444444444',
      mode: 'testnet',
      output: silentOutput(),
    });

    expect(filename).toBe('buyer.md');
    expect(fs.existsSync(path.join(dir, 'buyer.md'))).toBe(true);
  });

  test('body contains budget-privacy notice', () => {
    const filename = generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'privacy-check',
      walletAddress: '0x5555555555555555555555555555555555555555',
      mode: 'testnet',
      output: silentOutput(),
    });

    const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
    // The notice tells the user budget stays local. Look for the
    // committable-guidance sentence so the parser body extraction can
    // change without breaking the test on cosmetic edits.
    expect(content).toMatch(/budget/i);
    expect(content).toMatch(/stays on disk|private|local/i);
  });

  test('atomic write — no .tmp file left on success', () => {
    const filename = generateBuyerIdentityFile({
      projectRoot: dir,
      name: 'atomic',
      walletAddress: '0x6666666666666666666666666666666666666666',
      mode: 'testnet',
      output: silentOutput(),
    });

    expect(fs.existsSync(path.join(dir, filename))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${filename}.tmp`))).toBe(false);
  });
});
