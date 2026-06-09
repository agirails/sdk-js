/**
 * Tests for the Tweet/Share offer wired into `actp test` (FIX-4).
 *
 * The Purple Cow moment — after a successful settlement, the CLI offers
 * to open X with a pre-filled tweet. This file pins:
 *
 *  1. TTY + accept (Enter / y / yes) → `openUrl` called with the intent URL
 *  2. TTY + decline ("n") → no browser, no clipboard touch
 *  3. Non-TTY → silent skip (CI / piped consumers never block)
 *  4. json / quiet modes → silent skip
 *  5. No receiptUrl + unsettled → uses the mock template (no chain artifact)
 *  6. Receipt URL present → tweet text includes the receipt URL
 *  7. Special characters round-trip through URL-encoding
 *  8. Tweet text length stays under 280 chars across templates
 *  9. "c" answer → `copyToClipboard` called, browser NOT opened
 * 10. openUrl() returns false → fallback to clipboard, returns 'failed'
 * 11. openUrl() + copy both fail → still degrades to printing the URL
 * 12. Prompt throws (stdin closed) → treated as decline, not a crash
 *
 * The implementation is dependency-injected via `ShareDeps`, so the tests
 * never touch real readline / browser / clipboard — they just observe
 * which stubs got called and assert on the returned action string.
 *
 * @module cli/commands/test.shareOffer.test
 */

import { describe, it, expect, jest } from '@jest/globals';
import { offerShareOnX, type ShareDeps, type ShareInput } from './test';
import { Output } from '../utils/output';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a `ShareDeps` stub with sensible defaults that the tests can
 * override piece by piece.
 */
function makeDeps(overrides: Partial<ShareDeps> = {}): ShareDeps {
  return {
    prompt: jest.fn(async () => '') as ShareDeps['prompt'],
    openUrl: jest.fn(() => true) as ShareDeps['openUrl'],
    copyToClipboard: jest.fn(() => true) as ShareDeps['copyToClipboard'],
    isTty: jest.fn(() => true) as ShareDeps['isTty'],
    ...overrides,
  };
}

/**
 * Canonical settled result with a receipt URL — the happy path.
 */
const SETTLED_WITH_RECEIPT: ShareInput = {
  txId: '0xabcd' + '00'.repeat(30),
  receiptUrl: 'https://agirails.app/r/r_test12345',
  settled: true,
};

/**
 * Settled but no receipt URL (push failed / mock).
 */
const SETTLED_NO_RECEIPT: ShareInput = {
  txId: '0xefef' + '00'.repeat(30),
  receiptUrl: null,
  settled: true,
};

/**
 * Mock / unsettled result — no receipt, no chain artifact.
 */
const UNSETTLED: ShareInput = {
  txId: '0x9999' + '00'.repeat(30),
  receiptUrl: null,
  settled: false,
};

// ============================================================================
// Output capture
// ============================================================================

let lines: string[];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  console.warn = (...args: unknown[]) => lines.push('[warn] ' + args.join(' '));
  console.error = (...args: unknown[]) => lines.push('[error] ' + args.join(' '));
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
});

// ============================================================================
// Mode gates
// ============================================================================

describe('offerShareOnX — mode gates', () => {
  it('skips silently in json mode', async () => {
    const deps = makeDeps();
    const out = new Output('json');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('skipped');
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.copyToClipboard).not.toHaveBeenCalled();
  });

  it('skips silently in quiet mode', async () => {
    const deps = makeDeps();
    const out = new Output('quiet');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('skipped');
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it('skips silently when stdout is not a TTY', async () => {
    const deps = makeDeps({ isTty: jest.fn(() => false) as ShareDeps['isTty'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('skipped');
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.openUrl).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Accept paths
// ============================================================================

describe('offerShareOnX — accept paths', () => {
  it('TTY + empty answer (Enter) → openUrl called with the intent URL', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => '') as ShareDeps['prompt'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('tweet');
    expect(deps.openUrl).toHaveBeenCalledTimes(1);
    const url = (deps.openUrl as jest.Mock).mock.calls[0][0] as string;
    expect(url.startsWith('https://twitter.com/intent/tweet?text=')).toBe(true);
  });

  it('TTY + "y" → openUrl called', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => 'y') as ShareDeps['prompt'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('tweet');
    expect(deps.openUrl).toHaveBeenCalledTimes(1);
  });

  it('TTY + "YES" (case-insensitive, whitespace) → openUrl called', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => '  YES  ') as ShareDeps['prompt'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('tweet');
    expect(deps.openUrl).toHaveBeenCalledTimes(1);
  });

  it('accepted tweet URL contains the receipt URL when one is present', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => '') as ShareDeps['prompt'] });
    const out = new Output('human');
    await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    const url = (deps.openUrl as jest.Mock).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/^https:\/\/twitter\.com\/intent\/tweet\?text=/, ''));
    expect(decoded).toContain('agirails.app/r/r_test12345');
  });
});

// ============================================================================
// Decline path
// ============================================================================

describe('offerShareOnX — decline', () => {
  it('TTY + "n" → no browser, no clipboard, returns declined', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => 'n') as ShareDeps['prompt'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('declined');
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.copyToClipboard).not.toHaveBeenCalled();
  });

  it('TTY + "no" (full word) → declined', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => 'no') as ShareDeps['prompt'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('declined');
  });

  it('prompt throws (stdin closed) → declined, not a crash', async () => {
    const deps = makeDeps({
      prompt: jest.fn(async () => {
        throw new Error('stdin closed');
      }) as ShareDeps['prompt'],
    });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('declined');
    expect(deps.openUrl).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Copy path
// ============================================================================

describe('offerShareOnX — copy-only', () => {
  it('TTY + "c" → copyToClipboard called, browser NOT opened', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => 'c') as ShareDeps['prompt'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('copy');
    expect(deps.copyToClipboard).toHaveBeenCalledTimes(1);
    expect(deps.openUrl).not.toHaveBeenCalled();
    const copied = (deps.copyToClipboard as jest.Mock).mock.calls[0][0] as string;
    expect(copied.startsWith('https://twitter.com/intent/tweet?text=')).toBe(true);
  });

  it('TTY + "copy" (full word) → copyToClipboard called', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => 'copy') as ShareDeps['prompt'] });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('copy');
    expect(deps.copyToClipboard).toHaveBeenCalledTimes(1);
  });

  it('copy answer + OSC 52 unsupported → still returns copy, prints URL', async () => {
    const deps = makeDeps({
      prompt: jest.fn(async () => 'c') as ShareDeps['prompt'],
      copyToClipboard: jest.fn(() => false) as ShareDeps['copyToClipboard'],
    });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('copy');
    const joined = lines.join('\n');
    expect(joined).toContain('https://twitter.com/intent/tweet?text=');
  });
});

// ============================================================================
// Browser-open failure
// ============================================================================

describe('offerShareOnX — browser open failure', () => {
  it('openUrl returns false → falls back to clipboard, returns failed', async () => {
    const deps = makeDeps({
      prompt: jest.fn(async () => '') as ShareDeps['prompt'],
      openUrl: jest.fn(() => false) as ShareDeps['openUrl'],
      copyToClipboard: jest.fn(() => true) as ShareDeps['copyToClipboard'],
    });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('failed');
    expect(deps.copyToClipboard).toHaveBeenCalledTimes(1);
    const joined = lines.join('\n');
    expect(joined).toMatch(/Could not open browser/i);
  });

  it('openUrl AND clipboard both fail → still degrades to printing the URL', async () => {
    const deps = makeDeps({
      prompt: jest.fn(async () => '') as ShareDeps['prompt'],
      openUrl: jest.fn(() => false) as ShareDeps['openUrl'],
      copyToClipboard: jest.fn(() => false) as ShareDeps['copyToClipboard'],
    });
    const out = new Output('human');
    const action = await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(action).toBe('failed');
    const joined = lines.join('\n');
    expect(joined).toContain('https://twitter.com/intent/tweet?text=');
  });
});

// ============================================================================
// Template selection
// ============================================================================

describe('offerShareOnX — template selection', () => {
  it('settled + no receipt → testnet template (txId in tweet)', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => '') as ShareDeps['prompt'] });
    const out = new Output('human');
    await offerShareOnX(SETTLED_NO_RECEIPT, out, deps);
    const url = (deps.openUrl as jest.Mock).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/^https:\/\/twitter\.com\/intent\/tweet\?text=/, ''));
    // testnet template references basescan
    expect(decoded).toContain('basescan');
    // no receipt URL in tweet text
    expect(decoded).not.toContain('agirails.app/r/');
  });

  it('unsettled + no receipt → mock template (no chain artifact)', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => '') as ShareDeps['prompt'] });
    const out = new Output('human');
    await offerShareOnX(UNSETTLED, out, deps);
    const url = (deps.openUrl as jest.Mock).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/^https:\/\/twitter\.com\/intent\/tweet\?text=/, ''));
    // mock template references "earned its first"
    expect(decoded).toContain('earned its first');
    expect(decoded).not.toContain('basescan');
  });
});

// ============================================================================
// URL encoding
// ============================================================================

describe('offerShareOnX — URL encoding', () => {
  it('special characters are URL-encoded in the intent URL', async () => {
    const deps = makeDeps({ prompt: jest.fn(async () => '') as ShareDeps['prompt'] });
    const out = new Output('human');
    await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    const url = (deps.openUrl as jest.Mock).mock.calls[0][0] as string;
    // Newlines should be %0A in the URL — never raw \n
    expect(url).not.toContain('\n');
    // Spaces should be %20 (encodeURIComponent encodes spaces as %20)
    expect(url).not.toMatch(/text=[^%]* /);
    // @ should be encoded as %40
    expect(url).toContain('%40');
  });

  it('tweet displayed text stays under 280 chars across all templates', async () => {
    for (const fixture of [SETTLED_WITH_RECEIPT, SETTLED_NO_RECEIPT, UNSETTLED]) {
      const deps = makeDeps({ prompt: jest.fn(async () => '') as ShareDeps['prompt'] });
      const out = new Output('human');
      await offerShareOnX(fixture, out, deps);
      const url = (deps.openUrl as jest.Mock).mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url.replace(/^https:\/\/twitter\.com\/intent\/tweet\?text=/, ''));
      expect(decoded.length).toBeLessThanOrEqual(280);
    }
  });
});

// ============================================================================
// Reachability — prompt always shown in human + TTY
// ============================================================================

describe('offerShareOnX — reachability', () => {
  it('prompt is shown exactly once in human + TTY mode', async () => {
    const promptSpy = jest.fn(async () => 'n') as ShareDeps['prompt'];
    const deps = makeDeps({ prompt: promptSpy });
    const out = new Output('human');
    await offerShareOnX(SETTLED_WITH_RECEIPT, out, deps);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const joined = lines.join('\n');
    expect(joined).toContain('Share your first AGIRAILS transaction on X?');
  });
});
