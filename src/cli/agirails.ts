/**
 * npx agirails — One Command Entry Point
 *
 * 60-second quickstart: ask 3 questions → generate {slug}.md → mock earning loop → receipt.
 * Re-entrant: if identity already exists, skips onboarding and runs test.
 *
 * @module cli/agirails
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { ethers } from 'ethers';
import { Output, fmt, ExitCode } from './utils/output';
import { resolveIdentityPath, saveConfig, isInitialized, CONFIG_DEFAULTS } from './utils/config';
import { addToGitignore } from './utils/config';
import { runTest } from './commands/test';
import { generateSlug } from '../config/slugUtils';
import { serializeAgirailsMd } from '../config/agirailsmd';
import { V4_DEFAULTS, V4_CONSTRAINTS } from '../config/defaults';

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
    output.print('');
    output.print(fmt.bold('AGIRAILS') + fmt.dim(' — your agent earns in 60 seconds'));
    output.print('');

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

      // Generate slug
      const slug = generateSlug(name.trim());

      // Build frontmatter
      const frontmatter = {
        name: name.trim(),
        slug,
        version: '1.0.0',
        network: V4_DEFAULTS.network,
        services: [service],
        pricing: {
          base: price,
          currency: V4_DEFAULTS.pricing.currency,
          unit: V4_DEFAULTS.pricing.unit,
        },
        sla: { ...V4_DEFAULTS.sla },
        payment: { modes: [...V4_DEFAULTS.payment.modes] },
      };

      // Build body
      const body = `\n# ${name.trim()}\n\nDescribe what your agent does here.\n\n## How to Request This Service\n\nExplain how clients should structure their requests.\n`;

      // Write {slug}.md
      const filename = `${slug}.md`;
      const content = serializeAgirailsMd(frontmatter, body);
      fs.writeFileSync(filename, content, 'utf-8');

      output.print('');
      output.success(`Created ${fmt.bold(filename)}`);

      // Bootstrap .actp/
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
      }

      // Run mock earning loop
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
    process.exit(ExitCode.ERROR);
  }
}

main();
