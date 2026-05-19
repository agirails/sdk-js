/**
 * Skip-gate for the blockchain-runtime e2e suite (PRD §8.2).
 *
 * Two prerequisites must be present for these tests to run:
 *   1. `BASE_SEPOLIA_RPC` env var pointing at an upstream RPC anvil can fork.
 *   2. `CI_TEST_KEYSTORE_BASE64` env var containing a base64-encoded BIP-39
 *      mnemonic. The HD wallet helper derives ephemeral child wallets per
 *      test slot so a single funded mnemonic backs the whole suite.
 *
 * When either is missing, `describeAnvilSuite` substitutes Jest's
 * `describe.skip` — local devs without setup see green, no test failure.
 * In CI, the GitHub Action sets both secrets and the suite runs in full.
 *
 * @module __e2e__/blockchain-runtime/helpers/skipGate
 */

export interface AnvilSuitePrereqs {
  /** True when both env vars are present. */
  ready: boolean;
  /** Sorted list of missing prereq names — for skip-message diagnostics. */
  missing: string[];
}

export function checkAnvilSuitePrereqs(): AnvilSuitePrereqs {
  const missing: string[] = [];
  if (!process.env.BASE_SEPOLIA_RPC) missing.push('BASE_SEPOLIA_RPC');
  if (!process.env.CI_TEST_KEYSTORE_BASE64) missing.push('CI_TEST_KEYSTORE_BASE64');
  return { ready: missing.length === 0, missing };
}

/**
 * Drop-in for `describe()`. Runs the suite when both env vars are set;
 * delegates to `describe.skip` (with a diagnostic name) otherwise.
 *
 * @example
 * ```ts
 * describeAnvilSuite('subscription delivery', () => {
 *   let anvil: AnvilHandle;
 *   beforeAll(async () => { anvil = await startAnvilFork(); });
 *   afterAll(async () => { await anvil.stop(); });
 *   it('...', async () => { ... });
 * });
 * ```
 */
export function describeAnvilSuite(name: string, body: () => void): void {
  const prereqs = checkAnvilSuitePrereqs();
  if (prereqs.ready) {
    describe(name, body);
    return;
  }
  describe.skip(
    `${name}  [skipped — missing: ${prereqs.missing.join(', ')}]`,
    body
  );
}
