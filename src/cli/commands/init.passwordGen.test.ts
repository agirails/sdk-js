/**
 * FIX-3: ACTP_KEY_PASSWORD auto-generation in `actp init`.
 *
 * Tests cover the contract:
 *   1. process.env already set → use as-is, no .env touched.
 *   2. Non-TTY + no env + no .env → generate + write .env.
 *   3. Non-TTY + no env + .env without password → append.
 *   4. Non-TTY + no env + .env with password → use existing (no overwrite).
 *   5. Generated password is 32+ chars with mixed alphabet.
 *   6. .env chmod 600 after write.
 *   7. .env added to .gitignore (created if missing).
 *   8. process.env.ACTP_KEY_PASSWORD set after generation.
 *   9. No password leaked to stdout/stderr (only fingerprint).
 *  10. Fingerprint is stable + deterministic.
 *  11. Empty value in .env is treated as missing.
 *  12. Quoted values in .env are parsed correctly.
 *  13. Append preserves existing .env contents.
 *  14. Read-only fs falls back gracefully (no crash).
 *  15. Idempotency: calling twice in a row uses the same value.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Output } from '../utils/output';
import {
  ensureKeyPassword,
  generateStrongPassword,
  fingerprintPassword,
  readKeyPasswordFromDotenv,
} from './init';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix = 'actp-fix3-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Output instance that captures every print/info/warning/error.
 * `Output` in human mode writes through console — we shadow console
 * locally to verify nothing leaks the raw password.
 */
function captureOutput(): { output: Output; lines: string[] } {
  const lines: string[] = [];
  const out = new Output('human');
  // Patch the three sinks Output exposes.
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  const grab = (label: string) => (...args: unknown[]) => {
    lines.push(`[${label}] ${args.map((a) => String(a)).join(' ')}`);
  };
  console.log = grab('log');
  console.info = grab('info');
  console.warn = grab('warn');
  console.error = grab('error');
  // Restore on next tick via a teardown closure — tests call resetCapture()
  // implicitly when they exit the it block, but we expose a cleanup hook.
  (out as unknown as { __cleanup__: () => void }).__cleanup__ = () => {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
  };
  return { output: out, lines };
}

function cleanupOutput(output: Output): void {
  const hook = (output as unknown as { __cleanup__?: () => void }).__cleanup__;
  if (hook) hook();
}

// ---------------------------------------------------------------------------
// Restore env between tests
// ---------------------------------------------------------------------------

let SAVED_ENV: string | undefined;

beforeEach(() => {
  SAVED_ENV = process.env.ACTP_KEY_PASSWORD;
  delete process.env.ACTP_KEY_PASSWORD;
});

afterEach(() => {
  if (SAVED_ENV === undefined) {
    delete process.env.ACTP_KEY_PASSWORD;
  } else {
    process.env.ACTP_KEY_PASSWORD = SAVED_ENV;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FIX-3 :: generateStrongPassword', () => {
  it('returns a 32-character base64 password', () => {
    const pw = generateStrongPassword();
    expect(pw.length).toBe(32);
  });

  it('uses a mixed alphabet ([A-Za-z0-9+/])', () => {
    // Run several samples — sampling probability of all-lower is < 2^-32
    let sawUpper = false;
    let sawLower = false;
    let sawDigit = false;
    for (let i = 0; i < 64; i++) {
      const pw = generateStrongPassword();
      if (/[A-Z]/.test(pw)) sawUpper = true;
      if (/[a-z]/.test(pw)) sawLower = true;
      if (/[0-9]/.test(pw)) sawDigit = true;
      // The alphabet must always be the base64 alphabet (no spaces, no `=`).
      expect(pw).toMatch(/^[A-Za-z0-9+/]+$/);
    }
    expect(sawUpper).toBe(true);
    expect(sawLower).toBe(true);
    expect(sawDigit).toBe(true);
  });

  it('is non-deterministic — two calls return different values', () => {
    const a = generateStrongPassword();
    const b = generateStrongPassword();
    expect(a).not.toBe(b);
  });
});

describe('FIX-3 :: fingerprintPassword', () => {
  it('returns a 12-hex-char fingerprint', () => {
    const fp = fingerprintPassword('hunter2');
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable for the same input', () => {
    const a = fingerprintPassword('same-password');
    const b = fingerprintPassword('same-password');
    expect(a).toBe(b);
  });

  it('differs across distinct inputs', () => {
    const a = fingerprintPassword('pw-one');
    const b = fingerprintPassword('pw-two');
    expect(a).not.toBe(b);
  });
});

describe('FIX-3 :: readKeyPasswordFromDotenv', () => {
  it('returns undefined when file does not exist', () => {
    const dir = mkTmp();
    try {
      const result = readKeyPasswordFromDotenv(path.join(dir, '.env'));
      expect(result).toBeUndefined();
    } finally {
      rmTmp(dir);
    }
  });

  it('reads a plain ACTP_KEY_PASSWORD line', () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'ACTP_KEY_PASSWORD=secret123\n');
      expect(readKeyPasswordFromDotenv(path.join(dir, '.env'))).toBe('secret123');
    } finally {
      rmTmp(dir);
    }
  });

  it('strips surrounding double quotes', () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'ACTP_KEY_PASSWORD="quoted"\n');
      expect(readKeyPasswordFromDotenv(path.join(dir, '.env'))).toBe('quoted');
    } finally {
      rmTmp(dir);
    }
  });

  it('strips surrounding single quotes', () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, '.env'), "ACTP_KEY_PASSWORD='single'\n");
      expect(readKeyPasswordFromDotenv(path.join(dir, '.env'))).toBe('single');
    } finally {
      rmTmp(dir);
    }
  });

  it('treats an empty value as missing', () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'ACTP_KEY_PASSWORD=\n');
      expect(readKeyPasswordFromDotenv(path.join(dir, '.env'))).toBeUndefined();
    } finally {
      rmTmp(dir);
    }
  });

  it('skips comment lines and finds the real value below', () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(
        path.join(dir, '.env'),
        '# ACTP_KEY_PASSWORD=fake\nOTHER=x\nACTP_KEY_PASSWORD=real\n',
      );
      expect(readKeyPasswordFromDotenv(path.join(dir, '.env'))).toBe('real');
    } finally {
      rmTmp(dir);
    }
  });
});

describe('FIX-3 :: ensureKeyPassword', () => {
  it('source=env when process.env.ACTP_KEY_PASSWORD already set', () => {
    const dir = mkTmp();
    const { output, lines } = captureOutput();
    try {
      process.env.ACTP_KEY_PASSWORD = 'already-set';
      const result = ensureKeyPassword(dir, output);
      expect(result.source).toBe('env');
      expect(result.wroteToDisk).toBe(false);
      // .env must NOT be created in this path.
      expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
      // Fingerprint matches the env value.
      expect(result.fingerprint).toBe(fingerprintPassword('already-set'));
      // No output line contains the raw password.
      expect(lines.join('\n')).not.toContain('already-set');
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('source=generated when no env + no .env (creates .env)', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      const result = ensureKeyPassword(dir, output);
      expect(result.source).toBe('generated');
      expect(result.wroteToDisk).toBe(true);
      // .env created on disk
      const envPath = path.join(dir, '.env');
      expect(fs.existsSync(envPath)).toBe(true);
      const contents = fs.readFileSync(envPath, 'utf-8');
      expect(contents).toMatch(/^ACTP_KEY_PASSWORD=.+$/m);
      // process.env now contains the generated password
      expect(process.env.ACTP_KEY_PASSWORD).toBeDefined();
      expect(process.env.ACTP_KEY_PASSWORD!.length).toBe(32);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('source=dotenv when no env + .env already has the key (does not overwrite)', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'ACTP_KEY_PASSWORD=preserved-value\n');
      const result = ensureKeyPassword(dir, output);
      expect(result.source).toBe('dotenv');
      expect(result.wroteToDisk).toBe(false);
      // Disk value untouched
      const contents = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
      expect(contents).toBe('ACTP_KEY_PASSWORD=preserved-value\n');
      // process.env loaded from .env
      expect(process.env.ACTP_KEY_PASSWORD).toBe('preserved-value');
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('source=generated when no env + .env exists but lacks the key (appends)', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'OTHER_KEY=value\n');
      const result = ensureKeyPassword(dir, output);
      expect(result.source).toBe('generated');
      expect(result.wroteToDisk).toBe(true);
      // Existing line preserved
      const contents = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
      expect(contents).toMatch(/^OTHER_KEY=value$/m);
      expect(contents).toMatch(/^ACTP_KEY_PASSWORD=.+$/m);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('generated password is 32 chars from the base64 alphabet', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      const result = ensureKeyPassword(dir, output);
      expect(result.source).toBe('generated');
      const pw = process.env.ACTP_KEY_PASSWORD!;
      expect(pw.length).toBe(32);
      expect(pw).toMatch(/^[A-Za-z0-9+/]+$/);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('chmods .env to 0o600 after generation', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      const result = ensureKeyPassword(dir, output);
      expect(result.source).toBe('generated');
      const stat = fs.statSync(path.join(dir, '.env'));
      // Mask off file type bits, compare the permission triplet.
      // On systems that don't enforce mode bits (e.g. some CI sandboxes)
      // this may not match exactly — assert at-least owner read+write,
      // and that group+world write are off.
      const mode = stat.mode & 0o777;
      expect(mode & 0o600).toBe(0o600); // owner rw
      expect(mode & 0o022).toBe(0);     // group/world write OFF
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('adds .env to .gitignore (creating it if missing)', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      ensureKeyPassword(dir, output);
      const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      expect(gi).toMatch(/^\.env$/m);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('does not duplicate .env line in existing .gitignore', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env\n');
      ensureKeyPassword(dir, output);
      const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const matches = gi.match(/^\.env$/gm) || [];
      expect(matches.length).toBe(1);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('sets process.env.ACTP_KEY_PASSWORD after generation', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      expect(process.env.ACTP_KEY_PASSWORD).toBeUndefined();
      ensureKeyPassword(dir, output);
      expect(process.env.ACTP_KEY_PASSWORD).toBeDefined();
      expect(process.env.ACTP_KEY_PASSWORD!.length).toBeGreaterThanOrEqual(32);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('NEVER prints the raw password — only the fingerprint', () => {
    const dir = mkTmp();
    const { output, lines } = captureOutput();
    try {
      const result = ensureKeyPassword(dir, output);
      const allOutput = lines.join('\n');
      // Generated password absent.
      expect(allOutput).not.toContain(process.env.ACTP_KEY_PASSWORD!);
      // Fingerprint present.
      expect(allOutput).toContain(result.fingerprint);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('is idempotent — second call reads from .env, returns the same value', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      const first = ensureKeyPassword(dir, output);
      expect(first.source).toBe('generated');
      const generatedPassword = process.env.ACTP_KEY_PASSWORD;

      // Simulate a fresh process: unset env, re-call. It should read from .env.
      delete process.env.ACTP_KEY_PASSWORD;
      const second = ensureKeyPassword(dir, output);
      expect(second.source).toBe('dotenv');
      expect(process.env.ACTP_KEY_PASSWORD).toBe(generatedPassword);
      expect(second.fingerprint).toBe(first.fingerprint);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('does not crash when .env directory is read-only (graceful fallback)', () => {
    const dir = mkTmp();
    const { output, lines } = captureOutput();
    try {
      // Make dir read-only so the .env write fails.
      fs.chmodSync(dir, 0o500);
      let result: ReturnType<typeof ensureKeyPassword> | undefined;
      let threw = false;
      try {
        result = ensureKeyPassword(dir, output);
      } catch {
        threw = true;
      }
      // Restore so afterEach can clean up.
      fs.chmodSync(dir, 0o700);
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      expect(result!.source).toBe('generated');
      // process.env still set so generateWallet can succeed.
      expect(process.env.ACTP_KEY_PASSWORD).toBeDefined();
      // Either it wrote to disk or warned — but never crashed.
      if (!result!.wroteToDisk) {
        expect(lines.some((l) => /Could not write/.test(l))).toBe(true);
      }
    } finally {
      try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('preserves existing dotenv contents when appending', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      const initial = 'A=1\nB=2\n# comment\nC=3\n';
      fs.writeFileSync(path.join(dir, '.env'), initial);
      ensureKeyPassword(dir, output);
      const after = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
      // All original keys present.
      expect(after).toMatch(/^A=1$/m);
      expect(after).toMatch(/^B=2$/m);
      expect(after).toMatch(/^C=3$/m);
      expect(after).toMatch(/^# comment$/m);
      // New key appended.
      expect(after).toMatch(/^ACTP_KEY_PASSWORD=.+$/m);
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('returns envFilePath in the result when .env is read or written', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      const result = ensureKeyPassword(dir, output);
      expect(result.envFilePath).toBe(path.join(dir, '.env'));
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });

  it('omits envFilePath when source=env (no disk lookup)', () => {
    const dir = mkTmp();
    const { output } = captureOutput();
    try {
      process.env.ACTP_KEY_PASSWORD = 'preset';
      const result = ensureKeyPassword(dir, output);
      expect(result.source).toBe('env');
      expect(result.envFilePath).toBeUndefined();
    } finally {
      cleanupOutput(output);
      rmTmp(dir);
    }
  });
});
