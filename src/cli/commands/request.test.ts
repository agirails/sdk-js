/**
 * actp request CLI — focused parser + flag-shape tests (PRD §5.6.1).
 *
 * Full end-to-end coverage of `runRequest` lives in
 * `src/cli/lib/runRequest.test.ts`. This file covers the thin commander
 * layer: the `parsePositiveInt` argument parser hardening and the
 * `--no-auto-accept` flag-default shape.
 */

import { Command } from 'commander';
import { parsePositiveInt, createRequestCommand } from './request';

describe('parsePositiveInt (PRD §5.6.1)', () => {
  it('returns the parsed value for a clean integer string', () => {
    expect(parsePositiveInt('30000', 1, '--quote-timeout')).toBe(30000);
  });

  it('returns the fallback when raw is undefined or empty', () => {
    expect(parsePositiveInt(undefined, 1234, '--x')).toBe(1234);
    expect(parsePositiveInt('', 5678, '--x')).toBe(5678);
  });

  it('rejects decimal strings instead of silently truncating', () => {
    // parseInt("30.5", 10) === 30 — that was the §5.6 bug. We must throw.
    expect(() => parsePositiveInt('30.5', 1, '--quote-timeout')).toThrow(
      /decimals.*not accepted/i
    );
  });

  it('rejects underscore-separated numbers (parseInt would silently take "30")', () => {
    expect(() => parsePositiveInt('30_000', 1, '--quote-timeout')).toThrow(
      /Invalid --quote-timeout/
    );
  });

  it('rejects comma-separated numbers', () => {
    expect(() => parsePositiveInt('30,000', 1, '--x')).toThrow(/Invalid --x/);
  });

  it('rejects scientific notation', () => {
    expect(() => parsePositiveInt('1e6', 1, '--x')).toThrow(/Invalid --x/);
  });

  it('rejects negative integers', () => {
    expect(() => parsePositiveInt('-1', 1, '--x')).toThrow(/Invalid --x/);
  });

  it('rejects zero', () => {
    expect(() => parsePositiveInt('0', 1, '--x')).toThrow(/positive integer/);
  });

  it('rejects non-numeric strings', () => {
    expect(() => parsePositiveInt('abc', 1, '--x')).toThrow(/Invalid --x/);
  });
});

describe('createRequestCommand flag shape (PRD §5.6.1)', () => {
  it('defaults autoAccept to true and exposes --no-auto-accept as the off-switch', () => {
    // Commander's --no-X idiom should yield options.autoAccept === true by
    // default, and false when --no-auto-accept is passed. The previous
    // `.option('--auto-accept', '...', true)` form had no working off-switch.
    const cmd = createRequestCommand();
    // Build a parent program so commander's parse-from-array works cleanly.
    const program = new Command().exitOverride();
    program.addCommand(cmd);

    // Suppress the action handler — we only care about parsed options.
    // (action is async and would try to hit the runtime; we don't want that.)
    let observed: Record<string, unknown> | undefined;
    cmd.action(async (...args) => {
      observed = args[args.length - 2] as Record<string, unknown>;
    });

    // Default path: autoAccept stays true.
    program.parse(
      ['node', 'actp', 'request', '0x' + '1'.repeat(40), '0.05', '--service', 'onboarding'],
      { from: 'node' }
    );
    expect(observed?.autoAccept).toBe(true);

    // Off-switch path: --no-auto-accept flips to false.
    program.parse(
      ['node', 'actp', 'request', '0x' + '1'.repeat(40), '0.05', '--service', 'onboarding', '--no-auto-accept'],
      { from: 'node' }
    );
    expect(observed?.autoAccept).toBe(false);
  });
});
