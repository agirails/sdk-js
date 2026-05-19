/**
 * npx agirails — One Command Entry Point
 *
 * 60-second quickstart: ask 3 questions → generate {slug}.md → real Sentinel
 * onboarding request on Base Sepolia → reflection. PRD-event-driven-provider-
 * listening §5.7 replaced the prior MockRuntime earning-loop simulation with
 * a live Level 1 request against the deployed Sentinel agent.
 * Re-entrant: if identity already exists, skips onboarding and runs test.
 *
 * @module cli/agirails
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { ethers } from 'ethers';
import { Output, fmt, ExitCode } from './utils/output';
import { resolveIdentityPath, saveConfig, updateConfig, isInitialized, CONFIG_DEFAULTS } from './utils/config';
import { addToGitignore } from './utils/config';
import { validateSlug } from '../config/slugUtils';
import { runTest } from './commands/test';
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
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const quietMode = args.includes('-q') || args.includes('--quiet');

  const output = new Output(jsonMode ? 'json' : quietMode ? 'quiet' : 'human');

  try {
    // Re-entrant: if identity exists, skip onboarding
    const existingIdentity = resolveIdentityPath();
    if (existingIdentity) {
      output.print(fmt.dim('Identity found: ' + existingIdentity));
      output.print('');
      await runTest(output);
      return;
    }

    // Banner
    if (output.mode === 'human') {
      const { renderBanner } = await import('./utils/banner');
      output.print('');
      output.print(renderBanner());
      output.print('');
      output.print(fmt.dim('Your agent earns in 60 seconds.'));
      output.print('');
    }

    // Interactive questions
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      // Q1: Agent name
      const name = await ask(rl, fmt.cyan('? ') + 'What does your agent do? (name) ' + fmt.dim('> '));
      if (!name.trim()) {
        output.error('Agent name is required.');
        process.exit(ExitCode.INVALID_INPUT);
      }

      // Q2: Service type
      output.print('');
      output.print(fmt.dim('Service types:'));
      output.print(SERVICE_MENU);
      const serviceInput = await ask(rl, fmt.cyan('? ') + 'Pick a service type ' + fmt.dim('[1-7, or custom] > '));
      const serviceIdx = parseInt(serviceInput, 10);
      const service = (serviceIdx >= 1 && serviceIdx <= V4_CONSTRAINTS.KNOWN_SERVICES.length)
        ? V4_CONSTRAINTS.KNOWN_SERVICES[serviceIdx - 1]
        : serviceInput.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'automation';

      // Q3: Base price
      const priceInput = await ask(rl, fmt.cyan('? ') + 'Base price in USDC? ' + fmt.dim('[default: 1.00] > '));
      const price = parseFloat(priceInput) || 1.00;

      rl.close();

      // Generate and validate slug
      const slug = generateSlug(name.trim());
      const slugError = validateSlug(slug);
      if (slugError) {
        output.error(`Invalid agent name: ${slugError}`);
        process.exit(ExitCode.INVALID_INPUT);
      }

      // Build frontmatter.
      //
      // Services emit as objects { type, price, min_price, max_price } —
      // not plain strings — because the SDK publish pipeline
      // (`extractRegistrationParams`) reads `svc.type` and `svc.min_price`/
      // `svc.max_price` to populate per-service on-chain price bands on
      // AgentRegistry. Plain strings throw "Empty service type" at publish.
      // Default band is 1% around base price to avoid the 0..1000 USDC
      // fallback when min/max are absent.
      const minPrice = Math.max(0.01, price * 0.99);
      const maxPrice = price * 1.01;
      const frontmatter = {
        name: name.trim(),
        slug,
        version: '1.0.0',
        network: V4_DEFAULTS.network,
        services: [
          {
            type: service,
            price: String(price),
            min_price: minPrice,
            max_price: maxPrice,
          },
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

      // Build body
      const body = `\n# ${name.trim()}\n\nDescribe what your agent does here.\n\n## How to Request This Service\n\nExplain how clients should structure their requests.\n`;

      // Write {slug}.md (guard against overwriting existing files)
      const filename = `${slug}.md`;
      if (fs.existsSync(filename)) {
        output.error(`File already exists: ${filename}. Remove it or choose a different name.`);
        process.exit(ExitCode.INVALID_INPUT);
      }
      const content = serializeAgirailsMd(frontmatter, body);
      fs.writeFileSync(filename, content, 'utf-8');

      output.print('');
      output.success(`Created ${fmt.bold(filename)}`);

      // Bootstrap .actp/ or backfill identity pointer
      if (!isInitialized()) {
        const randomAddress = ethers.Wallet.createRandom().address;
        saveConfig({
          ...CONFIG_DEFAULTS,
          mode: 'mock',
          address: randomAddress,
          identity: filename,
        });
        addToGitignore();
        output.success('Initialized .actp/ (mock mode)');
      } else if (!resolveIdentityPath()) {
        // Existing config without identity pointer — backfill it
        updateConfig({ identity: filename });
        output.success('Updated .actp/config.json with identity pointer');
      }

      // Run a real Sentinel onboarding request on Base Sepolia. Requires a
      // wallet at ~/.actp/wallets/base-sepolia (or ACTP_KEYSTORE_BASE64) and
      // small testnet ETH + USDC. The PRD §5.7 rewrite intentionally
      // dropped the pre-4.0.0 MockRuntime simulation — "mock success" was a
      // lie and onboarding deserves the real loop.
      output.print('');
      await runTest(output);

      // Next steps
      output.print('');
      output.section('Next Steps');
      output.print(`  1. Edit your agent: ${fmt.bold(filename)}`);
      output.print(`  2. Go live on testnet: ${fmt.bold('actp publish')}`);
      output.print(`  3. Your agent page: ${fmt.cyan(`agirails.app/a/${slug}`)} ${fmt.dim('(after publish)')}`);
      output.print('');
    } finally {
      rl.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(message);
    // Surface the 4.0.0 setup expectation that runTest() now imposes. The
    // common first-run failure modes — no keystore, no testnet ETH, no
    // sentinel address — all flow through here, and a bare error message
    // gives a new developer nothing to act on. The hint is conditional on
    // the error shape so non-runtime errors (e.g. file-write failures
    // earlier in onboarding) don't get the wrong remediation glued on.
    if (looksLikeRunTestSetupError(message)) {
      output.print('');
      output.print(
        'agirails now runs a real onboarding request against Sentinel on Base Sepolia.\n' +
        'First-run setup:\n' +
        "  1. `actp init` to generate a wallet (or set ACTP_KEYSTORE_BASE64).\n" +
        "  2. Fund the wallet with a small amount of Base Sepolia ETH (gas) + test USDC.\n" +
        "  3. Rerun `npx agirails`.\n" +
        'Override Sentinel\'s address with ACTP_SENTINEL_ADDRESS=0x... if needed.'
      );
    }
    process.exit(ExitCode.ERROR);
  }
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
    /BASE_SEPOLIA_RPC/i.test(message)
  );
}

// ============================================================================
// Subcommand routing: agirails find [query] [options]
// ============================================================================

const subCmd = process.argv[2];
if (subCmd === 'find') {
  const sub = new Command('agirails');
  sub.addCommand(createFindCommand());
  sub.parse(process.argv);
} else {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
