/**
 * Agirails Wizard Tests (FIX-2)
 *
 * Verifies the `npx agirails` wizard:
 *   • Runs `runInit({mode:'testnet', wallet:'auto'})` BEFORE `runTest` so
 *     the keystore exists when runTest needs a signer.
 *   • Skips init when a keystore is already present.
 *   • Halts gracefully (no runTest, no crash) when init fails.
 *   • Halts gracefully when the user can't supply a password in non-TTY mode.
 *   • Returns the appropriate exit code in every error path.
 *   • Hands the freshly created {slug}.md filename through to subsequent steps.
 *
 * The wizard is exercised via dependency injection (`WizardDeps`) so we
 * never spawn a child process and never touch the real keystore encrypt
 * path — that's already covered by the wallet-utils tests. The goal here
 * is the ORCHESTRATION contract.
 *
 * @module cli/agirails.wizard.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Output, ExitCode } from './utils/output';
import {
  runWizard,
  buildIdentityFile,
  hasKeystoreDefault,
  defaultWizardDeps,
  __test,
  WizardDeps,
  WizardAnswers,
} from './agirails';
import { parseAgirailsMdV4 } from '../config/agirailsmdV4';
import { saveConfig, CONFIG_DEFAULTS, loadConfig, isInitialized } from './utils/config';

// ============================================================================
// Test scaffolding
// ============================================================================

let testDir: string;
let origCwd: string;
let origEnv: NodeJS.ProcessEnv;
let origIsTTY: boolean | undefined;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agirails-wizard-'));
  origCwd = process.cwd();
  process.chdir(testDir);

  // Snapshot env vars the wizard / keystore look at — restore later.
  origEnv = { ...process.env };
  delete process.env.ACTP_KEY_PASSWORD;
  delete process.env.ACTP_PRIVATE_KEY;
  delete process.env.ACTP_KEYSTORE_BASE64;
  delete process.env.ACTP_DIR;

  origIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
  process.env = origEnv;
  (process.stdin as { isTTY?: boolean }).isTTY = origIsTTY;
});

// ============================================================================
// Helpers
// ============================================================================

interface MockDepsConfig {
  answers?: WizardAnswers | null;
  password?: string | null;
  runInitImpl?: (opts: Record<string, unknown>, output: Output) => Promise<void>;
  runTestImpl?: (output: Output) => Promise<void>;
  hasKeystoreImpl?: (root: string) => boolean;
  isTTY?: boolean;
}

/**
 * Build a `WizardDeps` with safe defaults + per-test overrides. Tracks call
 * counts so assertions can verify *which* steps actually ran.
 */
function makeDeps(cfg: MockDepsConfig = {}): WizardDeps & {
  calls: { collectAnswers: number; ensurePassword: number; runInit: number; runTest: number; hasKeystore: number };
} {
  const calls = { collectAnswers: 0, ensurePassword: 0, runInit: 0, runTest: 0, hasKeystore: 0 };

  // Default: simulate a fresh init that creates the keystore file on the
  // filesystem so subsequent hasKeystore() returns true.
  const defaultRunInit = async (opts: Record<string, unknown>, _output: Output): Promise<void> => {
    const actpDir = path.join(process.cwd(), '.actp');
    fs.mkdirSync(actpDir, { recursive: true });
    fs.writeFileSync(path.join(actpDir, 'keystore.json'), '{"address":"0xabc"}', 'utf-8');
    // Match real runInit by writing a config.json so isInitialized() flips.
    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: (opts.mode as 'mock' | 'testnet' | 'mainnet') ?? 'testnet',
      address: '0x' + 'c'.repeat(40),
    });
  };

  // Default answers — let tests opt out via `answers: null`.
  const defaultAnswers: WizardAnswers = { name: 'Test Agent', service: 'code-review', price: 1.0 };
  const answersValue = cfg.answers === undefined ? defaultAnswers : cfg.answers;

  const deps: WizardDeps = {
    collectAnswers: async (_output: Output): Promise<WizardAnswers | null> => {
      calls.collectAnswers += 1;
      return answersValue;
    },
    ensurePassword: async (_output: Output): Promise<string | null> => {
      calls.ensurePassword += 1;
      const p = cfg.password === undefined ? 'test-password-1234' : cfg.password;
      if (p) process.env.ACTP_KEY_PASSWORD = p;
      return p;
    },
    runInit: async (opts: Record<string, unknown>, output: Output): Promise<void> => {
      calls.runInit += 1;
      if (cfg.runInitImpl) return cfg.runInitImpl(opts, output);
      return defaultRunInit(opts, output);
    },
    runTest: async (output: Output): Promise<void> => {
      calls.runTest += 1;
      if (cfg.runTestImpl) return cfg.runTestImpl(output);
    },
    hasKeystore: cfg.hasKeystoreImpl ?? ((root: string): boolean => {
      calls.hasKeystore += 1;
      return fs.existsSync(path.join(root, '.actp', 'keystore.json'));
    }),
    isTTY: (): boolean => cfg.isTTY ?? true,
  };

  return Object.assign(deps, { calls });
}

function quietOutput(): Output {
  return new Output('quiet');
}

// ============================================================================
// 1. Fresh-state happy path
// ============================================================================

describe('runWizard — fresh state', () => {
  it('runs init then test and returns SUCCESS, writes identity file', async () => {
    const deps = makeDeps();
    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.SUCCESS);
    expect(deps.calls.collectAnswers).toBe(1);
    expect(deps.calls.ensurePassword).toBe(1);
    expect(deps.calls.runInit).toBe(1);
    expect(deps.calls.runTest).toBe(1);

    // Identity file was written
    expect(fs.existsSync(path.join(testDir, 'test-agent.md'))).toBe(true);
    // .actp/keystore.json was created by the mocked runInit
    expect(fs.existsSync(path.join(testDir, '.actp', 'keystore.json'))).toBe(true);
  });

  it('calls runInit with testnet + auto wallet (not mock)', async () => {
    let capturedOpts: Record<string, unknown> | null = null;
    const deps = makeDeps({
      runInitImpl: async (opts, _output) => {
        capturedOpts = opts;
        // Still create the keystore so hasKeystore() returns true downstream.
        const actpDir = path.join(process.cwd(), '.actp');
        fs.mkdirSync(actpDir, { recursive: true });
        fs.writeFileSync(path.join(actpDir, 'keystore.json'), '{}', 'utf-8');
        saveConfig({ ...CONFIG_DEFAULTS, mode: 'testnet', address: '0x' + 'a'.repeat(40) });
      },
    });

    await runWizard(quietOutput(), deps);

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.mode).toBe('testnet');
    expect(capturedOpts!.wallet).toBe('auto');
    // We must NOT auto-trigger init's own post-init test prompt — wizard
    // runs runTest itself.
    expect(capturedOpts!.test).toBe(false);
  });

  it('runs steps in the correct order: collectAnswers → ensurePassword → runInit → runTest', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      runInitImpl: async (_opts, _output) => {
        order.push('runInit');
        const actpDir = path.join(process.cwd(), '.actp');
        fs.mkdirSync(actpDir, { recursive: true });
        fs.writeFileSync(path.join(actpDir, 'keystore.json'), '{}', 'utf-8');
        saveConfig({ ...CONFIG_DEFAULTS, mode: 'testnet', address: '0x' + 'a'.repeat(40) });
      },
      runTestImpl: async (_output) => {
        order.push('runTest');
      },
    });
    // Wrap collectAnswers / ensurePassword to record order as well.
    const origCollect = deps.collectAnswers;
    deps.collectAnswers = async (output: Output) => {
      order.push('collectAnswers');
      return origCollect(output);
    };
    const origEnsure = deps.ensurePassword;
    deps.ensurePassword = async (output: Output) => {
      order.push('ensurePassword');
      return origEnsure(output);
    };

    await runWizard(quietOutput(), deps);

    expect(order).toEqual(['collectAnswers', 'ensurePassword', 'runInit', 'runTest']);
  });
});

// ============================================================================
// 2. Keystore-already-exists fast path
// ============================================================================

describe('runWizard — keystore already exists', () => {
  it('skips init when an identity file + keystore are already on disk', async () => {
    // Pre-create identity + config + keystore
    fs.writeFileSync(
      path.join(testDir, 'existing-agent.md'),
      '---\nname: Existing\nslug: existing-agent\nservices:\n  - type: code-review\n    price: "1"\n---\n# body\n',
      'utf-8'
    );
    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: 'testnet',
      address: '0x' + 'd'.repeat(40),
      identity: 'existing-agent.md',
    });
    const actpDir = path.join(testDir, '.actp');
    fs.writeFileSync(path.join(actpDir, 'keystore.json'), '{}', 'utf-8');

    const deps = makeDeps();
    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.SUCCESS);
    expect(deps.calls.collectAnswers).toBe(0); // wizard skipped
    expect(deps.calls.runInit).toBe(0); // init skipped
    expect(deps.calls.runTest).toBe(1); // test ran
  });

  it('runs init when an identity file exists but keystore is missing', async () => {
    // Identity exists (from a previous stale-mock-config wizard run) but
    // no keystore.
    fs.writeFileSync(
      path.join(testDir, 'orphan-agent.md'),
      '---\nname: Orphan\nslug: orphan-agent\nservices:\n  - type: code-review\n    price: "1"\n---\n# body\n',
      'utf-8'
    );
    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: 'mock',
      address: '0x' + 'e'.repeat(40),
      identity: 'orphan-agent.md',
    });

    const deps = makeDeps();
    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.SUCCESS);
    expect(deps.calls.collectAnswers).toBe(0); // identity exists — don't re-ask
    expect(deps.calls.runInit).toBe(1); // backfill the keystore
    expect(deps.calls.runTest).toBe(1);
  });
});

// ============================================================================
// 3. Init failure paths — must NOT proceed to runTest
// ============================================================================

describe('runWizard — init failure', () => {
  it('returns ERROR and does NOT call runTest when runInit throws', async () => {
    const deps = makeDeps({
      runInitImpl: async () => {
        throw new Error('Network unreachable: ETIMEDOUT base-sepolia.alchemyapi.io');
      },
    });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.ERROR);
    expect(deps.calls.runInit).toBe(1);
    expect(deps.calls.runTest).toBe(0); // critical: did not proceed
  });

  it('returns ERROR when init "succeeds" but leaves no keystore behind', async () => {
    // Simulate a partial / mocked init that returns OK but produces no
    // actual keystore file. The wizard's defensive hasKeystore() check
    // should catch this and stop.
    const deps = makeDeps({
      runInitImpl: async () => {
        // intentionally do nothing
      },
      hasKeystoreImpl: () => false,
    });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.ERROR);
    expect(deps.calls.runInit).toBe(1);
    expect(deps.calls.runTest).toBe(0);
  });

  it('runInit throwing on a stale-mock keystore-backfill also halts before runTest', async () => {
    // Identity present + mock config + no keystore → wizard tries to
    // backfill via runInit; if THAT fails, no runTest.
    fs.writeFileSync(
      path.join(testDir, 'broken.md'),
      '---\nname: Broken\nslug: broken\nservices:\n  - type: code-review\n    price: "1"\n---\n',
      'utf-8'
    );
    saveConfig({ ...CONFIG_DEFAULTS, mode: 'mock', address: '0x' + 'f'.repeat(40), identity: 'broken.md' });

    const deps = makeDeps({
      runInitImpl: async () => {
        throw new Error('RPC error: -32603');
      },
    });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.ERROR);
    expect(deps.calls.runTest).toBe(0);
  });
});

// ============================================================================
// 4. Password & non-TTY handling
// ============================================================================

describe('runWizard — password & non-TTY', () => {
  it('returns INVALID_INPUT when ensurePassword returns null (non-TTY, no env var)', async () => {
    const deps = makeDeps({ password: null, isTTY: false });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.INVALID_INPUT);
    expect(deps.calls.ensurePassword).toBe(1);
    expect(deps.calls.runInit).toBe(0); // no password → no init
    expect(deps.calls.runTest).toBe(0);
  });

  it('proceeds when ACTP_KEY_PASSWORD is already in env (CI-friendly)', async () => {
    process.env.ACTP_KEY_PASSWORD = 'preset-password-12345';
    const deps = makeDeps({ password: 'preset-password-12345', isTTY: false });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.SUCCESS);
    expect(deps.calls.runInit).toBe(1);
    expect(deps.calls.runTest).toBe(1);
  });
});

// ============================================================================
// 5. runTest failure handling
// ============================================================================

describe('runWizard — runTest failure', () => {
  it('returns ERROR but does not crash when runTest throws', async () => {
    const deps = makeDeps({
      runTestImpl: async () => {
        throw new Error('insufficient funds for gas');
      },
    });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.ERROR);
    expect(deps.calls.runInit).toBe(1);
    expect(deps.calls.runTest).toBe(1);
  });

  it('returns ERROR with a clean message when runTest throws a non-Error value', async () => {
    const deps = makeDeps({
      runTestImpl: async () => {
        // Rule `@typescript-eslint/only-throw-error` is not loaded in our
        // eslint config (would need @typescript-eslint v8+; we are on v6);
        // disable directive removed 2026-06-09 to fix CI lint.
        throw 'string error from a buggy library';
      },
    });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.ERROR);
  });
});

// ============================================================================
// 6. Invalid input
// ============================================================================

describe('runWizard — invalid input', () => {
  it('returns INVALID_INPUT when collectAnswers returns null', async () => {
    const deps = makeDeps({ answers: null });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.INVALID_INPUT);
    expect(deps.calls.runInit).toBe(0);
    expect(deps.calls.runTest).toBe(0);
  });

  it('returns INVALID_INPUT when name produces an empty slug', async () => {
    const deps = makeDeps({ answers: { name: '!!!', service: 'code-review', price: 1 } });

    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.INVALID_INPUT);
    expect(deps.calls.runInit).toBe(0);
  });

  it('returns INVALID_INPUT when the slug-derived filename already exists', async () => {
    // Pre-create the file the wizard would write.
    fs.writeFileSync(path.join(testDir, 'test-agent.md'), '# existing\n', 'utf-8');

    const deps = makeDeps();
    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.INVALID_INPUT);
    expect(deps.calls.runInit).toBe(0); // never reached
  });
});

// ============================================================================
// 7. buildIdentityFile (pure function)
// ============================================================================

describe('buildIdentityFile', () => {
  it('produces a V4 frontmatter with services + pricing bands', () => {
    const result = buildIdentityFile({ name: 'My Agent', service: 'code-review', price: 5 });
    expect(result.slug).toBe('my-agent');
    expect(result.filename).toBe('my-agent.md');
    expect(result.content).toContain('name: My Agent');
    expect(result.content).toContain('slug: my-agent');
    expect(result.content).toContain('network: testnet');
    expect(parseAgirailsMdV4(result.content).network).toBe('testnet');
    expect(result.content).toContain('type: code-review');
    expect(result.content).toContain('min_price');
    expect(result.content).toContain('max_price');
  });

  it('throws on a name that produces an empty slug', () => {
    expect(() => buildIdentityFile({ name: '!!!', service: 'code-review', price: 1 })).toThrow(/Invalid agent name/);
  });

  it('clamps min_price at $0.01 even when 99 % of base price would round below', () => {
    const result = buildIdentityFile({ name: 'Tiny', service: 'code-review', price: 0.001 });
    expect(result.content).toMatch(/min_price:\s*0\.01/);
  });
});

// ============================================================================
// 8. hasKeystoreDefault
// ============================================================================

describe('hasKeystoreDefault', () => {
  it('returns true when ACTP_PRIVATE_KEY is set', () => {
    process.env.ACTP_PRIVATE_KEY = '0x' + 'a'.repeat(64);
    expect(hasKeystoreDefault(testDir)).toBe(true);
  });

  it('returns true when ACTP_KEYSTORE_BASE64 is set', () => {
    process.env.ACTP_KEYSTORE_BASE64 = 'eyJmb28iOiJiYXIifQ==';
    expect(hasKeystoreDefault(testDir)).toBe(true);
  });

  it('returns true when .actp/keystore.json exists', () => {
    const actpDir = path.join(testDir, '.actp');
    fs.mkdirSync(actpDir, { recursive: true });
    fs.writeFileSync(path.join(actpDir, 'keystore.json'), '{}', 'utf-8');
    expect(hasKeystoreDefault(testDir)).toBe(true);
  });

  it('returns false when nothing is set', () => {
    expect(hasKeystoreDefault(testDir)).toBe(false);
  });
});

// ============================================================================
// 9. defaultWizardDeps (smoke — just confirm it builds)
// ============================================================================

describe('defaultWizardDeps', () => {
  it('returns a complete WizardDeps object', () => {
    const deps = defaultWizardDeps();
    expect(typeof deps.collectAnswers).toBe('function');
    expect(typeof deps.ensurePassword).toBe('function');
    expect(typeof deps.runInit).toBe('function');
    expect(typeof deps.runTest).toBe('function');
    expect(typeof deps.hasKeystore).toBe('function');
    expect(typeof deps.isTTY).toBe('function');
  });
});

// ============================================================================
// 10. Error-message heuristic (unchanged behavior — guard the contract)
// ============================================================================

describe('looksLikeRunTestSetupError', () => {
  it.each([
    ['No wallet found at .actp/keystore.json', true],
    ["Agent 'sentinel' not resolved", true],
    ['ACTP_SENTINEL_ADDRESS is invalid', true],
    ['insufficient funds for gas', true],
    ['BASE_SEPOLIA_RPC unreachable', true],
    ['resolvePrivateKey returned undefined', true],
    ['Keystore found but ACTP_KEY_PASSWORD is not set.', true],
    ['Random unrelated error', false],
    ['Out of memory', false],
  ])('classifies "%s" as setup error = %s', (message, expected) => {
    expect(__test.looksLikeRunTestSetupError(message)).toBe(expected);
  });
});

// ============================================================================
// 11. extractMessage (defensive — handles non-Error throws)
// ============================================================================

describe('extractMessage', () => {
  it('extracts message from Error', () => {
    expect(__test.extractMessage(new Error('boom'))).toBe('boom');
  });
  it('returns string when thrown value is a string', () => {
    expect(__test.extractMessage('plain string')).toBe('plain string');
  });
  it('JSON-serializes object errors', () => {
    expect(__test.extractMessage({ code: 'E_FOO' })).toBe('{"code":"E_FOO"}');
  });
  it('falls back to String() for circular / unserializable objects', () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const result = __test.extractMessage(circ);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 12. End-to-end: post-wizard, config and identity are in sync
// ============================================================================

describe('runWizard — post-wizard state', () => {
  it('leaves identity file + config + keystore on disk after success', async () => {
    const deps = makeDeps();
    const code = await runWizard(quietOutput(), deps);

    expect(code).toBe(ExitCode.SUCCESS);
    expect(isInitialized()).toBe(true);
    const cfg = loadConfig();
    expect(cfg.mode).toBe('testnet');
    expect(fs.existsSync(path.join(testDir, 'test-agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.actp', 'keystore.json'))).toBe(true);
  });

  it('does NOT write a mock-mode config (the FIX-2 regression we fixed)', async () => {
    const deps = makeDeps();
    await runWizard(quietOutput(), deps);

    const cfg = loadConfig();
    // The pre-FIX-2 wizard wrote `mode: 'mock'` with a random address →
    // resolvePrivateKey returned undefined → crash. After FIX-2, the
    // config must reflect the real testnet wallet that runInit produced.
    expect(cfg.mode).not.toBe('mock');
  });
});
