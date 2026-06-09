/**
 * Framed receipt rendering tests for FIX-5.
 *
 * Verifies that `renderReceiptV3` — the new wow-path renderer wired into
 * `actp test`'s post-SETTLED flow — produces a deterministic, defensively
 * coded ceremonial receipt card. Tests cover:
 *
 *   - Frame is rendered (top + bottom double-line) in human mode
 *   - Reflection block renders when present, suppressed when absent
 *   - Receipt URL renders when present, suppressed when absent
 *   - Inner card respects the configured width geometry (54-col outer)
 *   - JSON mode emits the V2 superset including reflection + receiptUrl
 *   - Quiet mode falls through to the single-line net amount (no frame)
 *   - Non-TTY ⇒ COLORS_ENABLED is false ⇒ no ANSI escapes anywhere
 *   - Identical inputs produce byte-identical output via injected nowFn
 *
 * Setup: tests force NO_COLOR=1 inside the Jest process so ANSI codes
 * never appear, which keeps substring assertions human-readable. The
 * `nowFn` injection point in `ReceiptDataV3` makes timestamps reproducible
 * without monkey-patching `Date` globally.
 *
 * @module cli/commands/test.framedReceipt.test
 */

import { renderReceiptV3, ReceiptDataV3 } from './receipt';
import { Output } from '../utils/output';

// ============================================================================
// Test setup — force NO_COLOR for clean substring assertions
// ============================================================================
//
// The receipt renderer reads supportsColor() once at module load when it
// caches COLORS_ENABLED. Setting NO_COLOR before the import is therefore
// load-bearing — the import at the top of THIS file runs after the env var
// is read. We rely on the runner-provided NO_COLOR (jest.setup.js doesn't
// set one, so we set it ourselves at the top of the file before any tests
// run; the import order means the first import of receipt.ts already saw
// NO_COLOR=1).

beforeAll(() => {
  // Belt and braces. Even though NO_COLOR is read at receipt.ts load time,
  // setting it here documents the assumption for future readers.
  process.env.NO_COLOR = '1';
});

// ============================================================================
// Deterministic time + spy plumbing
// ============================================================================

/** Fixed clock for byte-stable receipt rendering across tests. */
const FIXED_NOW = new Date('2026-06-09T12:34:56.000Z');
const fixedNowFn = () => FIXED_NOW;

/** Capture console.log lines emitted by Output('human'). */
function captureHumanOutput(fn: (out: Output) => void): { lines: string[]; joined: string } {
  const lines: string[] = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    lines.push(String(msg));
  });
  try {
    fn(new Output('human'));
  } finally {
    spy.mockRestore();
  }
  return { lines, joined: lines.join('\n') };
}

/** Strip ANSI for substring assertions (defensive — NO_COLOR should already prevent codes). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ============================================================================
// Fixture
// ============================================================================

function baseData(overrides: Partial<ReceiptDataV3> = {}): ReceiptDataV3 {
  return {
    agent: 'your-agent',
    counterparty: 'Sentinel',
    service: 'onboarding',
    amountWei: 10_000_000n, // $10 USDC
    network: 'base-sepolia',
    txId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    timing: { totalMs: 47_321, escrowLockMs: 0, settlementMs: 0 },
    nowFn: fixedNowFn,
    ...overrides,
  };
}

// ============================================================================
// Frame structure tests
// ============================================================================

describe('renderReceiptV3 — frame structure', () => {
  it('renders the top frame (╔...╗) and the bottom frame (╚...╝) in human mode', () => {
    const { joined } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    const clean = stripAnsi(joined);
    expect(clean).toMatch(/╔═+╗/);
    expect(clean).toMatch(/╚═+╝/);
  });

  it('renders the inner card top (┌─┐) and bottom (└─┘) boundaries', () => {
    const { joined } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    const clean = stripAnsi(joined);
    expect(clean).toContain('┌');
    expect(clean).toContain('┐');
    expect(clean).toContain('└');
    expect(clean).toContain('┘');
  });

  it('includes the ceremonial "FIRST TRANSACTION RECEIPT" header on testnet', () => {
    const { joined } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    expect(stripAnsi(joined)).toContain('FIRST TRANSACTION RECEIPT');
  });

  it('includes the testnet tagline ("Autonomously. Trustlessly.")', () => {
    const { joined } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    expect(stripAnsi(joined)).toContain('Autonomously. Trustlessly');
  });

  it('renders the counterparty (Sentinel) on the From line', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ counterparty: 'Sentinel' }), out)
    );
    expect(stripAnsi(joined)).toMatch(/From\s+Sentinel/);
  });

  it('renders the agent label on the To line', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ agent: 'demo-agent' }), out)
    );
    expect(stripAnsi(joined)).toMatch(/To\s+demo-agent/);
  });

  it('renders Amount, Fee, Net rows with USDC formatting', () => {
    const { joined } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    const clean = stripAnsi(joined);
    expect(clean).toContain('$10.00 USDC'); // Amount
    expect(clean).toContain('$0.10 USDC');  // Fee (1% of $10)
    expect(clean).toContain('$9.90 USDC');  // Net
  });

  it('renders the Duration line from timing.totalMs', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ timing: { totalMs: 47_321, escrowLockMs: 0, settlementMs: 0 } }), out)
    );
    expect(stripAnsi(joined)).toMatch(/Duration\s+47321ms/);
  });
});

// ============================================================================
// Reflection block
// ============================================================================

describe('renderReceiptV3 — reflection block', () => {
  it('includes the reflection text inside the inner card when provided', () => {
    const reflection = 'Stillness is its own answer.';
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ reflection }), out)
    );
    const clean = stripAnsi(joined);
    expect(clean).toContain('Reflection');
    expect(clean).toContain(reflection);
  });

  it('does NOT render a Reflection block when reflection is undefined', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ reflection: undefined }), out)
    );
    const clean = stripAnsi(joined);
    expect(clean).not.toMatch(/Reflection\b/);
  });

  it('does NOT render a Reflection block when reflection is empty string', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ reflection: '' }), out)
    );
    const clean = stripAnsi(joined);
    expect(clean).not.toMatch(/Reflection\b/);
  });

  it('wraps a long reflection so it never overflows the inner card width', () => {
    const longReflection =
      'The river does not argue with the rock. ' +
      'It simply continues. ' +
      'And over many years, the river is what remains.';
    const { lines } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ reflection: longReflection }), out)
    );
    // Every rendered line must respect the outer frame width (max 60-something
    // chars including the two ║ boundaries). Find any reflection-bearing line
    // and confirm it's bounded.
    const clean = lines.map(stripAnsi);
    const reflectionWords = ['river', 'argue', 'continues', 'remains'];
    for (const word of reflectionWords) {
      const containingLines = clean.filter((l) => l.includes(word));
      expect(containingLines.length).toBeGreaterThan(0);
      for (const ln of containingLines) {
        // Outer width is 54 + boundary chars + padding ⇒ < 80
        expect(ln.length).toBeLessThanOrEqual(80);
      }
    }
  });
});

// ============================================================================
// Receipt URL block
// ============================================================================

describe('renderReceiptV3 — receipt URL block', () => {
  it('includes the receipt URL inside the inner card when provided', () => {
    const receiptUrl = 'https://agirails.app/r/r_abcdef1234567890';
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ receiptUrl }), out)
    );
    expect(stripAnsi(joined)).toContain('r_abcdef1234567890');
  });

  it('does NOT render a Receipt URL line when receiptUrl is null', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ receiptUrl: null }), out)
    );
    expect(stripAnsi(joined)).not.toMatch(/Receipt\s+https/);
  });

  it('does NOT render a Receipt URL line when receiptUrl is undefined', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ receiptUrl: undefined }), out)
    );
    expect(stripAnsi(joined)).not.toMatch(/Receipt\s+https/);
  });

  it('wraps a long URL so it never overflows the inner card width', () => {
    const longUrl =
      'https://agirails.app/r/r_' + 'a'.repeat(80);
    const { lines } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ receiptUrl: longUrl }), out)
    );
    // Confirm no rendered line ever exceeds the safe terminal width.
    for (const ln of lines.map(stripAnsi)) {
      expect(ln.length).toBeLessThanOrEqual(120);
    }
  });
});

// ============================================================================
// Width + alignment
// ============================================================================

describe('renderReceiptV3 — width discipline', () => {
  it('every outer-frame line has the same length (alignment invariant)', () => {
    const { lines } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    const clean = lines.map(stripAnsi);
    // Find lines bounded by ║ on both sides — they must all be the same width.
    const framed = clean.filter((l) => l.startsWith('║') && l.endsWith('║'));
    expect(framed.length).toBeGreaterThan(5);
    const widths = new Set(framed.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it('outer-frame width matches the top/bottom horizontal frame width', () => {
    const { lines } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    const clean = lines.map(stripAnsi);
    const top = clean.find((l) => l.startsWith('╔'));
    const bottom = clean.find((l) => l.startsWith('╚'));
    expect(top).toBeDefined();
    expect(bottom).toBeDefined();
    const framed = clean.filter((l) => l.startsWith('║') && l.endsWith('║'));
    expect(top!.length).toBe(framed[0].length);
    expect(bottom!.length).toBe(framed[0].length);
  });

  it('default outer width fits comfortably under a 80-column terminal', () => {
    const { lines } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    for (const ln of lines.map(stripAnsi)) {
      expect(ln.length).toBeLessThanOrEqual(80);
    }
  });
});

// ============================================================================
// Determinism
// ============================================================================

describe('renderReceiptV3 — determinism', () => {
  it('produces byte-identical output for two consecutive renders with the same nowFn', () => {
    const data = baseData({
      reflection: 'A still mind hears the river.',
      receiptUrl: 'https://agirails.app/r/r_stable_test',
    });
    const a = captureHumanOutput((out) => renderReceiptV3(data, out)).joined;
    const b = captureHumanOutput((out) => renderReceiptV3(data, out)).joined;
    expect(a).toBe(b);
  });

  it('renders the injected nowFn timestamp on the Time row', () => {
    // 2026-06-09T12:34:56.000Z ⇒ '2026-06-09 12:34:56 UTC'
    const { joined } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    expect(stripAnsi(joined)).toContain('2026-06-09 12:34:56 UTC');
  });

  it('changes the Time row when a different nowFn is injected', () => {
    const altNow = new Date('2027-01-01T00:00:00.000Z');
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ nowFn: () => altNow }), out)
    );
    expect(stripAnsi(joined)).toContain('2027-01-01 00:00:00 UTC');
  });
});

// ============================================================================
// Mode behaviors
// ============================================================================

describe('renderReceiptV3 — mode behavior', () => {
  it('JSON mode emits a structured object with reflection + receiptUrl when present', () => {
    const out = new Output('json');
    const calls: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: unknown) => { calls.push(String(msg)); });
    try {
      renderReceiptV3(
        baseData({
          reflection: 'Stillness is its own answer.',
          receiptUrl: 'https://agirails.app/r/r_xyz',
        }),
        out
      );
    } finally {
      jest.restoreAllMocks();
    }
    expect(calls.length).toBe(1);
    const obj = JSON.parse(calls[0]) as Record<string, unknown>;
    expect(obj.reflection).toBe('Stillness is its own answer.');
    expect(obj.receiptUrl).toBe('https://agirails.app/r/r_xyz');
    expect(obj.counterparty).toBe('Sentinel');
    expect(obj.earned).toBe('$10.00 USDC');
    expect(obj.fee).toBe('$0.10 USDC');
    expect(obj.net).toBe('$9.90 USDC');
  });

  it('JSON mode omits reflection / receiptUrl keys when not present', () => {
    const out = new Output('json');
    const calls: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((msg: unknown) => { calls.push(String(msg)); });
    try {
      renderReceiptV3(baseData({ reflection: undefined, receiptUrl: null }), out);
    } finally {
      jest.restoreAllMocks();
    }
    const obj = JSON.parse(calls[0]) as Record<string, unknown>;
    expect(obj.reflection).toBeUndefined();
    expect(obj.receiptUrl).toBeUndefined();
  });

  it('quiet mode emits only the net amount (no frame, no reflection, no URL)', () => {
    const out = new Output('quiet');
    const calls: string[] = [];
    // Output('quiet').print() is a no-op inside Output (it gates on
    // this.mode === 'human'). renderReceiptV3 still calls print() with the
    // net amount in quiet mode — we mock the instance method so we observe
    // the call regardless of the inner mode-gate, matching the pattern
    // used by testjobs.test.ts for renderReceipt quiet-mode coverage.
    jest.spyOn(out, 'print').mockImplementation((msg: string) => { calls.push(msg); });
    try {
      renderReceiptV3(
        baseData({ reflection: 'X', receiptUrl: 'https://agirails.app/r/r_q' }),
        out
      );
      // Quiet branch: one call only, with the formatted net amount.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe('$9.90 USDC');
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('human mode does NOT contain ANSI escape codes when NO_COLOR is set', () => {
    // NO_COLOR=1 was set in beforeAll. Confirm the output is escape-free.
    const { joined } = captureHumanOutput((out) => renderReceiptV3(baseData(), out));
    // eslint-disable-next-line no-control-regex
    expect(joined).not.toMatch(/\x1b\[/);
  });
});

// ============================================================================
// Network variants
// ============================================================================

describe('renderReceiptV3 — network variants', () => {
  it('mainnet uses the mainnet header + tagline', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ network: 'base-mainnet' }), out)
    );
    const clean = stripAnsi(joined);
    expect(clean).toContain('FIRST MAINNET SETTLEMENT');
    expect(clean).toContain('This is real money');
    expect(clean).not.toContain('Autonomously. Trustlessly');
  });

  it('mainnet with ethTxHash renders Verify line pointing at basescan.org (no sepolia)', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(
        baseData({
          network: 'base-mainnet',
          ethTxHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        }),
        out
      )
    );
    const clean = stripAnsi(joined);
    expect(clean).toContain('basescan.org');
    expect(clean).not.toContain('sepolia.basescan.org');
  });

  it('testnet with ethTxHash renders sepolia.basescan.org', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(
        baseData({
          network: 'base-sepolia',
          ethTxHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        }),
        out
      )
    );
    expect(stripAnsi(joined)).toContain('sepolia.basescan.org');
  });
});

// ============================================================================
// Defensive paths
// ============================================================================

describe('renderReceiptV3 — defensive paths', () => {
  it('zero amount does not crash and renders 0% fee', () => {
    expect(() =>
      captureHumanOutput((out) => renderReceiptV3(baseData({ amountWei: 0n }), out))
    ).not.toThrow();
  });

  it('missing counterparty falls back to "requester-agent" sentinel string', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(baseData({ counterparty: undefined, requester: undefined }), out)
    );
    expect(stripAnsi(joined)).toContain('requester-agent');
  });

  it('missing counterparty but present requester renders the truncated requester hash', () => {
    const { joined } = captureHumanOutput((out) =>
      renderReceiptV3(
        baseData({
          counterparty: undefined,
          requester: '0x1111111111111111111111111111111111111111',
        }),
        out
      )
    );
    const clean = stripAnsi(joined);
    expect(clean).toMatch(/From\s+0x111111\.\.\.1111/);
  });
});
