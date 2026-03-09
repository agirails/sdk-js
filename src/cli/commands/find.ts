/**
 * Find Command — Discover agents on agirails.app
 *
 * Queries GET /api/v1/discover and renders results in human,
 * JSON, or quiet (slugs-only) mode.
 *
 * @module cli/commands/find
 */

import { Command } from 'commander';
import { Output, ExitCode, fmt } from '../utils/output';
import { mapError } from '../utils/client';
import {
  discoverAgents,
  DiscoverAgent,
  DiscoverParams,
} from '../../api/agirailsApp';

// ============================================================================
// Constants
// ============================================================================

const VALID_SORT = ['reputation', 'price', 'recent'] as const;
const VALID_PAYMENT_MODES = ['actp', 'x402'] as const;

// ============================================================================
// Command Definition
// ============================================================================

export function createFindCommand(): Command {
  const cmd = new Command('find')
    .description('Discover agents on agirails.app')
    .argument('[query]', 'Free-text search query')
    .option('-c, --capability <cap>', 'Filter by capability (e.g. code-review)')
    .option('--max-price <n>', 'Maximum price in USDC')
    .option('--sort <mode>', 'Sort: reputation | price | recent', 'recent')
    .option('-l, --limit <n>', 'Number of results (1-100)', '20')
    .option('--payment-mode <mode>', 'Filter by payment mode: actp | x402')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Output slugs only, one per line')
    .action(async (query, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runFind(query, options, output);
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
          details: structuredError.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Options Interface
// ============================================================================

interface FindOptions {
  capability?: string;
  maxPrice?: string;
  sort?: string;
  limit?: string;
  paymentMode?: string;
}

// ============================================================================
// Implementation
// ============================================================================

export async function runFind(
  query: string | undefined,
  options: FindOptions,
  output: Output
): Promise<void> {
  const limit = Math.min(100, Math.max(1, parseInt(options.limit ?? '20', 10) || 20));

  // Validate --max-price (strict: reject trailing chars like "10usd", and Infinity)
  if (options.maxPrice) {
    const parsed = Number(options.maxPrice);
    if (isNaN(parsed) || parsed < 0 || !isFinite(parsed)) {
      output.errorResult({
        code: 'INVALID_INPUT',
        message: '--max-price must be a non-negative number (e.g. --max-price 10)',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }
  }

  // Validate --payment-mode
  if (options.paymentMode && !(VALID_PAYMENT_MODES as readonly string[]).includes(options.paymentMode)) {
    output.errorResult({
      code: 'INVALID_INPUT',
      message: `--payment-mode must be one of: ${VALID_PAYMENT_MODES.join(', ')}`,
    });
    process.exit(ExitCode.INVALID_INPUT);
    return;
  }

  // Validate --sort
  if (options.sort && !(VALID_SORT as readonly string[]).includes(options.sort)) {
    output.errorResult({
      code: 'INVALID_INPUT',
      message: `--sort must be one of: ${VALID_SORT.join(', ')}`,
    });
    process.exit(ExitCode.INVALID_INPUT);
    return;
  }

  const params: DiscoverParams = {
    ...(query               ? { search: query }                                   : {}),
    ...(options.capability  ? { capability: options.capability }                   : {}),
    ...(options.paymentMode ? { paymentMode: options.paymentMode }                 : {}),
    ...(options.sort        ? { sort: options.sort as DiscoverParams['sort'] }     : {}),
    ...(options.maxPrice    ? { maxPrice: Number(options.maxPrice) }               : {}),
    limit,
  };

  const spinner = output.spinner('Searching agents...');

  let result: { agents: DiscoverAgent[]; total: number };

  try {
    result = await discoverAgents(params);
    spinner.stop(true);
  } catch (error) {
    spinner.stop(false);
    output.errorResult({
      code: 'NETWORK_ERROR',
      message: `Could not reach agirails.app: ${(error as Error).message}`,
      details: { hint: 'Check your internet connection or try again later.' },
    });
    process.exit(ExitCode.NETWORK_ERROR);
    return;
  }

  const { agents, total } = result;

  // JSON mode — raw API response
  if (output.mode === 'json') {
    output.result({ agents, total } as unknown as Record<string, unknown>);
    return;
  }

  // Quiet mode — slugs only
  if (output.mode === 'quiet') {
    for (const agent of agents) {
      output.raw(agent.slug);
    }
    return;
  }

  // Human mode — table
  if (agents.length === 0) {
    output.blank();
    output.info('No agents found matching your query.');
    output.print('  Try a broader search or remove some filters.');
    return;
  }

  renderAgentTable(agents, output);

  output.blank();
  output.print(
    fmt.dim(`  Showing ${agents.length} of ${total} agent(s).`) +
    (agents.length < total ? fmt.dim(' Use --limit to see more.') : '')
  );
  output.print('');
  output.print(
    '  Pay an agent:  ' + fmt.bold('actp pay agirails.app/a/<slug> <amount>')
  );
}

// ============================================================================
// Table Renderer
// ============================================================================

function renderAgentTable(agents: DiscoverAgent[], output: Output): void {
  const COL = { slug: 20, name: 22, price: 12, caps: 20, mode: 8 } as const;
  const SEP = '  ';

  function trunc(s: string, max: number): string {
    if (s.length <= max) return s.padEnd(max);
    return s.slice(0, max - 1) + '\u2026';
  }

  output.blank();
  const header =
    fmt.bold(trunc('SLUG', COL.slug)) + SEP +
    fmt.bold(trunc('NAME', COL.name)) + SEP +
    fmt.bold(trunc('PRICE', COL.price)) + SEP +
    fmt.bold(trunc('CAPABILITIES', COL.caps)) + SEP +
    fmt.bold(trunc('PAYMENT', COL.mode));

  const lineWidth = COL.slug + COL.name + COL.price + COL.caps + COL.mode + SEP.length * 4;

  output.print('  ' + header);
  output.print('  ' + fmt.dim('-'.repeat(lineWidth)));

  for (const agent of agents) {
    const cfg = agent.published_config;

    const slug = agent.slug ?? '';
    const name = cfg?.name ?? '-';
    const caps = (cfg?.capabilities ?? []).join(', ') || '-';
    const mode = cfg?.payment_mode ?? '-';

    let price = '-';
    if (cfg?.pricing?.amount != null) {
      const amt = Number(cfg.pricing.amount).toFixed(2);
      const cur = cfg.pricing.currency ?? 'USDC';
      price = `${amt} ${cur}`;
    }

    const row =
      fmt.cyan(trunc(slug, COL.slug)) + SEP +
      trunc(name, COL.name) + SEP +
      trunc(price, COL.price) + SEP +
      fmt.dim(trunc(caps, COL.caps)) + SEP +
      trunc(mode, COL.mode);

    output.print('  ' + row);
  }

  output.print('  ' + fmt.dim('-'.repeat(lineWidth)));
}
