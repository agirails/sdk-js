/**
 * npx agirails — One Command Entry Point
 *
 * 60-second quickstart: ask 3 questions → generate {slug}.md → bootstrap a
 * real testnet wallet (Smart Wallet + 1K test USDC) → run a real Sentinel
 * onboarding request on Base Sepolia → reflection. PRD-event-driven-provider-
 * listening §5.7 replaced the prior MockRuntime earning-loop simulation with
 * a live Level 1 request against the deployed Sentinel agent.
 *
 * FIX-2 (2026-06): the wizard previously wrote a `mock` config with a random
 * address and immediately invoked `runTest({ network: 'testnet' })`. The
 * downstream `resolvePrivateKey` returned `undefined` and ACTPClient crashed.
 * The wizard now runs `runInit({ mode: 'testnet', wallet: 'auto' })` BEFORE
 * `runTest` so the keystore + Smart Wallet exist and the first transaction
 * has a real signer behind it.
 *
 * Re-entrant: if identity already exists, skips onboarding and runs test.
 *
 * @module cli/agirails
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { ethers } from 'ethers';
import { Output, fmt, ExitCode, ExitCodeValue } from './utils/output';
import {
  resolveIdentityPath,
  saveConfig,
  updateConfig,
  isInitialized,
  CONFIG_DEFAULTS,
  getActpDir,
} from './utils/config';
import { addToGitignore } from './utils/config';
import { validateSlug } from '../config/slugUtils';
import { runTest as runTestDefault } from './commands/test';
import { runInit as runInitDefault } from './commands/init';
import { generateSlug } from '../config/slugUtils';
import { serializeAgirailsMd } from '../config/agirailsmd';
import { V4_DEFAULTS, V4_CONSTRAINTS } from '../config/defaults';
import { Command } from 'commander';
import { createFindCommand } from './commands/find';

// ============================================================================
// readline helper
// ============================================================================

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ============================================================================
// Service type menu
// ============================================================================

const SERVICE_MENU = V4_CONSTRAINTS.KNOWN_SERVICES.map((s, i) => `  ${i + 1}. ${s}`).join('\n');

// ============================================================================
// Dependency-injection seams for testability
// ============================================================================

/**
 * Wizard answers — populated either by interactive prompts or supplied
 * directly by callers (tests, automation).
 */
export interface WizardAnswers {
  name: string;
  service: string;
  price: number;
}

/**
 * Injection seams so tests can drive the wizard without spawning interactive
 * subprocesses. Production code provides the real defaults — see
 * `defaultWizardDeps()`.
 */
export interface WizardDeps {
  /** Collect the 3 wizard answers (name / service / price). */
  collectAnswers: (output: Output) => Promise<WizardAnswers | null>;
  /** Resolve / prompt for the ACTP_KEY_PASSWORD before runInit. */
  ensurePassword: (output: Output) => Promise<string | null>;
  /** Run keystore + Smart Wallet bootstrap (defaults to commands/init.runInit). */
  runInit: (opts: Record<string, unknown>, output: Output) => Promise<void>;
  /** Run the Sentinel test transaction (defaults to commands/test.runTest). */
  runTest: (output: Output) => Promise<void>;
  /** Predicate — does the project already have a usable keystore? */
  hasKeystore: (projectRoot: string) => boolean;
  /** Is stdin a TTY right now? Exposed so tests can flip CI / interactive paths. */
  isTTY: () => boolean;
}

/**
 * Production wiring for the wizard. Tests substitute individual fields.
 */
export function defaultWizardDeps(): WizardDeps {
  return {
    collectAnswers: collectAnswersInteractive,
    ensurePassword: ensurePasswordDefault,
    runInit: async (opts, output) => {
      // runInit's signature is `(options, output, cmd?)`. The wizard doesn't
      // have a Commander instance, and `isExplicit(...)` calls inside runInit
      // safely fall back to "not explicit" when `cmd` is undefined, so all
      // CLI-flag values we pass are treated as defaults that AGIRAILS.md /
      // {slug}.md may override. That's exactly what we want during wizard
      // onboarding — the freshly written {slug}.md is the source of truth.
      //
      // runInit's InitOptions interface isn't exported from commands/init.ts.
      // Round-tripping through `unknown` keeps strict mode happy and is the
      // explicitly-sanctioned escape hatch for "I know the shape, the type
      // checker can't see it through the module boundary."
      await runInitDefault(opts as unknown as Parameters<typeof runInitDefault>[0], output);
    },
    runTest: runTestDefault,
    hasKeystore: hasKeystoreDefault,
    // process.stdin.isTTY is `true | undefined`. Normalize to boolean so
    // tests can stub without TS narrowing pain.
    isTTY: () => Boolean(process.stdin.isTTY),
  };
}

/**
 * A keystore is "present" when `.actp/keystore.json` exists OR the user
 * has provided `ACTP_KEYSTORE_BASE64` / `ACTP_PRIVATE_KEY` env vars. Any
 * of those satisfies `resolvePrivateKey()` in `runTest`.
 */
export function hasKeystoreDefault(projectRoot: string = process.cwd()): boolean {
  try {
    if (process.env.ACTP_PRIVATE_KEY && process.env.ACTP_PRIVATE_KEY.length > 0) return true;
    if (process.env.ACTP_KEYSTORE_BASE64 && process.env.ACTP_KEYSTORE_BASE64.length > 0) return true;
    const keystorePath = path.join(getActpDir(projectRoot), 'keystore.json');
    return fs.existsSync(keystorePath);
  } catch {
    return false;
  }
}

// ============================================================================
// Interactive collectors
// ============================================================================

async function collectAnswersInteractive(output: Output): Promise<WizardAnswers | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = await ask(rl, fmt.cyan('? ') + 'What does your agent do? (name) ' + fmt.dim('> '));
    if (!name.trim()) {
      output.error('Agent name is required.');
      return null;
    }

    output.print('');
    output.print(fmt.dim('Service types:'));
    output.print(SERVICE_MENU);
    const serviceInput = await ask(
      rl,
      fmt.cyan('? ') + 'Pick a service type ' + fmt.dim('[1-7, or custom] > ')
    );
    const serviceIdx = parseInt(serviceInput, 10);
    const service = (serviceIdx >= 1 && serviceIdx <= V4_CONSTRAINTS.KNOWN_SERVICES.length)
      ? V4_CONSTRAINTS.KNOWN_SERVICES[serviceIdx - 1]
      : serviceInput.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'automation';

    const priceInput = await ask(
      rl,
      fmt.cyan('? ') + 'Base price in USDC? ' + fmt.dim('[default: 1.00] > ')
    );
    const price = parseFloat(priceInput) || 1.0;

    return { name: name.trim(), service, price };
  } finally {
    rl.close();
  }
}

/**
 * Resolve ACTP_KEY_PASSWORD.
 *
 * Priority:
 *   1. Existing env var (developer-set / CI secret)
 *   2. Interactive prompt (TTY only)
 *   3. Auto-generated password (non-TTY — see FIX-3 follow-up; current
 *      behavior is to surface a clear error so the user can set the env
 *      var explicitly).
 *
 * Returns the password (already written to process.env.ACTP_KEY_PASSWORD)
 * or `null` if no password could be obtained.
 */
async function ensurePasswordDefault(output: Output): Promise<string | null> {
  if (process.env.ACTP_KEY_PASSWORD && process.env.ACTP_KEY_PASSWORD.length >= 8) {
    return process.env.ACTP_KEY_PASSWORD;
  }

  if (!process.stdin.isTTY) {
    // Non-TTY without an explicit password — fail closed with a clear hint
    // instead of letting `runInit` throw a generic error. FIX-3 will replace
    // this branch with auto-generated passwords + claim-code persistence.
    output.error(
      'ACTP_KEY_PASSWORD is required in non-interactive environments.\n' +
        'Set ACTP_KEY_PASSWORD=<min 8 chars> and re-run, or use --interactive.'
    );
    return null;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(
        fmt.cyan('? ') + 'Pick a password to encrypt your wallet ' + fmt.dim('(min 8 chars) > '),
        resolve
      );
    });
    const password = answer.trim();
    if (password.length < 8) {
      output.error('Password must be at least 8 characters.');
      return null;
    }
    process.env.ACTP_KEY_PASSWORD = password;
    return password;
  } finally {
    rl.close();
  }
}

// ============================================================================
// Wizard orchestrator (the testable core)
// ============================================================================

/**
 * Build the V4 frontmatter + body for a fresh {slug}.md from wizard answers.
 *
 * Extracted so tests can verify the structure without going through the
 * full wizard flow.
 */
export function buildIdentityFile(answers: WizardAnswers): { filename: string; content: string; slug: string } {
  const slug = generateSlug(answers.name);
  const slugError = validateSlug(slug);
  if (slugError) {
    throw new Error(`Invalid agent name: ${slugError}`);
  }

  const minPrice = Math.max(0.01, answers.price * 0.99);
  const maxPrice = answers.price * 1.01;
  const frontmatter = {
    name: answers.name,
    slug,
    version: '1.0.0',
    // Default to testnet — the wizard's whole point is to put the user on
    // Base Sepolia with a real keystore and a real Sentinel transaction.
    network: 'base-sepolia',
    services: [
      {
        type: answers.service,
        price: String(answers.price),
        min_price: minPrice,
        max_price: maxPrice,
      },
    ],
    pricing: {
      base: answers.price,
      currency: V4_DEFAULTS.pricing.currency,
      unit: V4_DEFAULTS.pricing.unit,
      min_price: minPrice,
      max_price: maxPrice,
      negotiable: false,
    },
    sla: { ...V4_DEFAULTS.sla },
    payment: { modes: [...V4_DEFAULTS.payment.modes] },
  };

  const body = `\n# ${answers.name}\n\nDescribe what your agent does here.\n\n## How to Request This Service\n\nExplain how clients should structure their requests.\n`;
  const content = serializeAgirailsMd(frontmatter, body);
  return { filename: `${slug}.md`, content, slug };
}

/**
 * Orchestrate the wizard. Pure-ish: every side effect goes through `deps`,
 * so the test suite can verify behavior without ever touching the network,
 * the keystore encrypt path, or a real Sentinel deployment.
 *
 * Returns the exit code instead of calling process.exit so callers (and
 * tests) can decide what to do with failures.
 */
export async function runWizard(output: Output, deps: WizardDeps = defaultWizardDeps()): Promise<ExitCodeValue> {
  try {
    // ── Re-entrant fast path ────────────────────────────────────────────
    // If an identity file already exists, skip onboarding entirely and
    // jump straight to the test transaction. We still require a keystore
    // — if there's an identity but no wallet, init must run.
    const existingIdentity = resolveIdentityPath();
    if (existingIdentity) {
      output.print(fmt.dim('Identity found: ' + existingIdentity));
      output.print('');

      if (!deps.hasKeystore(process.cwd())) {
        // Identity but no keystore — typical for users who ran the wizard
        // before FIX-2 landed and left a stale mock config behind. Run
        // init now so runTest has something to sign with.
        const password = await deps.ensurePassword(output);
        if (!password) return ExitCode.INVALID_INPUT;
        try {
          await deps.runInit({ mode: 'testnet', wallet: 'auto', force: true, test: false }, output);
        } catch (error) {
          output.error('Wallet bootstrap failed: ' + extractMessage(error));
          printSetupHint(output);
          return ExitCode.ERROR;
        }
      }

      try {
        await deps.runTest(output);
        return ExitCode.SUCCESS;
      } catch (error) {
        return handleTestError(error, output);
      }
    }

    // ── Banner ──────────────────────────────────────────────────────────
    if (output.mode === 'human') {
      try {
        const { renderBanner } = await import('./utils/banner');
        output.print('');
        output.print(renderBanner());
        output.print('');
        output.print(fmt.dim('Your agent earns in 60 seconds.'));
        output.print('');
      } catch {
        // Banner failure is purely cosmetic — never block the wizard on it.
      }
    }

    // ── Collect answers ────────────────────────────────────────────────
    const answers = await deps.collectAnswers(output);
    if (!answers) {
      return ExitCode.INVALID_INPUT;
    }

    // ── Build & write {slug}.md ────────────────────────────────────────
    let identity: { filename: string; content: string; slug: string };
    try {
      identity = buildIdentityFile(answers);
    } catch (error) {
      output.error(extractMessage(error));
      return ExitCode.INVALID_INPUT;
    }

    if (fs.existsSync(identity.filename)) {
      output.error(`File already exists: ${identity.filename}. Remove it or choose a different name.`);
      return ExitCode.INVALID_INPUT;
    }

    try {
      fs.writeFileSync(identity.filename, identity.content, 'utf-8');
    } catch (error) {
      output.error('Could not write identity file: ' + extractMessage(error));
      return ExitCode.ERROR;
    }

    output.print('');
    output.success(`Created ${fmt.bold(identity.filename)}`);

    // ── Resolve password BEFORE runInit ────────────────────────────────
    // We deliberately resolve the password before *any* on-chain or
    // keystore-encrypt work — that way we can fail fast if no password
    // is available, and the user doesn't see a half-baked .actp/ dir.
    const password = await deps.ensurePassword(output);
    if (!password) {
      // ensurePassword already printed the actionable error.
      return ExitCode.INVALID_INPUT;
    }

    // ── Run init: keystore + Smart Wallet + mint test USDC ─────────────
    // runInit picks up the freshly written {slug}.md via its own scan logic
    // and uses it to pre-fill the .actp/config.json values, so we don't
    // need to push answers in twice.
    try {
      await deps.runInit(
        {
          mode: 'testnet',
          wallet: 'auto',
          // We *just* wrote the file; if it existed before, we already
          // bailed above. `force: false` keeps init from clobbering a
          // pre-existing .actp/ that the user might still want.
          force: false,
          // Don't run the post-init prompt — we run runTest ourselves
          // immediately after so we have full control over UX.
          test: false,
        },
        output
      );
    } catch (error) {
      output.error('Wallet bootstrap failed: ' + extractMessage(error));
      printSetupHint(output);
      // Critical: do NOT proceed to runTest. Without a keystore, runTest
      // crashes hard with a "Cannot read property 'getAddress' of
      // undefined" stack — exactly what FIX-2 set out to eliminate.
      return ExitCode.ERROR;
    }

    // ── Defensive fallback for an init that "succeeded" but left no
    // keystore behind (e.g. test mocks, partial failures). Without this
    // guard, runTest would still crash — so we treat it as a hard stop.
    if (!deps.hasKeystore(process.cwd())) {
      output.error('Wallet bootstrap completed but no keystore was found at .actp/keystore.json.');
      printSetupHint(output);
      return ExitCode.ERROR;
    }

    // ── Backfill identity pointer if init didn't pick it up ────────────
    // runInit writes config.json — but its identity-detection scan can
    // miss freshly-created files in rare race conditions. Always make
    // sure the pointer is set after init.
    if (isInitialized() && !resolveIdentityPath()) {
      try {
        updateConfig({ identity: identity.filename });
      } catch {
        // updateConfig failing here is non-fatal — runTest's own
        // resolveIdentityPath() will still find the file via the scan.
      }
    }

    // ── Run the Sentinel test transaction ──────────────────────────────
    output.print('');
    try {
      await deps.runTest(output);
    } catch (error) {
      return handleTestError(error, output);
    }

    // ── Next steps ─────────────────────────────────────────────────────
    output.print('');
    output.section('Next Steps');
    output.print(`  1. Edit your agent: ${fmt.bold(identity.filename)}`);
    output.print(`  2. Go live on testnet: ${fmt.bold('actp publish')}`);
    output.print(`  3. Your agent page: ${fmt.cyan(`agirails.app/a/${identity.slug}`)} ${fmt.dim('(after publish)')}`);
    output.print('');
    return ExitCode.SUCCESS;
  } catch (error) {
    // Last-resort catch — should be unreachable given the inner try/catch
    // blocks above, but better to surface a clean message than a stack.
    output.error(extractMessage(error));
    return ExitCode.ERROR;
  }
}

/**
 * Map a runTest error to a structured output + the right exit code.
 * Mirrors the existing setup-hint heuristic so users with no wallet / no
 * funds / missing Sentinel address still get actionable next-step guidance.
 */
function handleTestError(error: unknown, output: Output): ExitCodeValue {
  const message = extractMessage(error);
  output.error(message);
  if (looksLikeRunTestSetupError(message)) {
    printSetupHint(output);
  }
  return ExitCode.ERROR;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function printSetupHint(output: Output): void {
  output.print('');
  output.print(
    'agirails now runs a real onboarding request against Sentinel on Base Sepolia.\n' +
      'First-run setup:\n' +
      '  1. `actp init` to generate a wallet (or set ACTP_KEYSTORE_BASE64).\n' +
      '  2. Fund the wallet with a small amount of Base Sepolia ETH (gas) + test USDC.\n' +
      '  3. Rerun `npx agirails`.\n' +
      "Override Sentinel's address with ACTP_SENTINEL_ADDRESS=0x... if needed."
  );
}

// ============================================================================
// Main entry point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const quietMode = args.includes('-q') || args.includes('--quiet');

  const output = new Output(jsonMode ? 'json' : quietMode ? 'quiet' : 'human');

  // FIX-2: the wizard previously bootstrapped a mock config with a random
  // address and called runTest in testnet mode → crash. We now invoke
  // runInit({mode:'testnet',wallet:'auto'}) before runTest, so the keystore
  // and Smart Wallet exist by the time runTest needs a signer.
  //
  // Backwards-compat note for existing mock configs: if a previous wizard
  // run left a `.actp/config.json` in `mode: 'mock'` with a random address
  // and no keystore, treat that as the "no real onboarding yet" state and
  // re-run the wizard. Identity is preserved (we don't overwrite the .md),
  // but the config gets upgraded by runInit.
  if (isInitialized()) {
    try {
      const { loadConfig } = await import('./utils/config');
      const cfg = loadConfig();
      const looksLikeStaleMock =
        cfg.mode === 'mock' && !defaultWizardDeps().hasKeystore(process.cwd());
      if (looksLikeStaleMock && resolveIdentityPath()) {
        output.print(
          fmt.dim(
            'Detected stale mock config — upgrading to testnet wallet so the Sentinel transaction can run.'
          )
        );
      }
    } catch {
      // ignore — runWizard handles missing/broken config gracefully
    }
  }

  const code = await runWizard(output, defaultWizardDeps());
  process.exit(code);
}

/** Heuristic — match the four most common runRequest / resolveAgent first-run
 *  failure-message shapes so the setup hint only fires when actionable. */
function looksLikeRunTestSetupError(message: string): boolean {
  return (
    /no wallet found/i.test(message) ||
    /resolvePrivateKey/i.test(message) ||
    /Agent ['"]?sentinel['"]?/i.test(message) ||
    /ACTP_SENTINEL_ADDRESS/i.test(message) ||
    /insufficient funds/i.test(message) ||
    /BASE_SEPOLIA_RPC/i.test(message) ||
    /keystore/i.test(message) ||
    /ACTP_KEY_PASSWORD/i.test(message)
  );
}

// Internal helpers exposed for unit tests only. Not part of the public CLI API.
export const __test = {
  looksLikeRunTestSetupError,
  handleTestError,
  extractMessage,
  // Retain the pre-FIX-2 mock-config bootstrap so legacy callers can still
  // construct a mock config inline (used by agirails.test.ts and as a
  // fallback if the wizard ever needs to fall back to mock mode).
  bootstrapMockConfig: (filename: string): void => {
    const randomAddress = ethers.Wallet.createRandom().address;
    saveConfig({
      ...CONFIG_DEFAULTS,
      mode: 'mock',
      address: randomAddress,
      identity: filename,
    });
    addToGitignore();
  },
};

// ============================================================================
// Subcommand routing: agirails find [query] [options]
// ============================================================================

const isMainModule = require.main === module;
const subCmd = process.argv[2];

if (isMainModule) {
  if (subCmd === 'find') {
    const sub = new Command('agirails');
    sub.addCommand(createFindCommand());
    sub.parse(process.argv);
  } else {
    main().catch((error) => {
      // Final safety net — runWizard should already have caught & printed,
      // but if something escapes (e.g. an import failure) we still want a
      // single-line error rather than a raw stack trace.
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(message);
      process.exit(1);
    });
  }
}
