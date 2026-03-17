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
  RankingInfo,
} from '../../api/agirailsApp';

// ============================================================================
// Constants
// ============================================================================

const VALID_SORT = ['reputation', 'price', 'recent'] as const;
const VALID_PAYMENT_MODES = ['actp', 'x402'] as const;
const VALID_RANK = ['llm'] as const;
const VALID_PRIORITY = ['quality', 'price', 'speed'] as const;

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
    .option('--rank <mode>', 'Enable LLM ranking: llm')
    .option('--priority <p>', 'Ranking priority: quality | price | speed', 'quality')
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
  rank?: string;
  priority?: string;
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

  // Validate --rank
  if (options.rank && !(VALID_RANK as readonly string[]).includes(options.rank)) {
    output.errorResult({
      code: 'INVALID_INPUT',
      message: `--rank must be one of: ${VALID_RANK.join(', ')}`,
    });
    process.exit(ExitCode.INVALID_INPUT);
    return;
  }

  // Validate --priority
  if (options.priority && !(VALID_PRIORITY as readonly string[]).includes(options.priority)) {
    output.errorResult({
      code: 'INVALID_INPUT',
      message: `--priority must be one of: ${VALID_PRIORITY.join(', ')}`,
    });
    process.exit(ExitCode.INVALID_INPUT);
    return;
  }

  // --rank=llm requires a search query
  if (options.rank === 'llm' && !query) {
    output.errorResult({
      code: 'INVALID_INPUT',
      message: '--rank=llm requires a search query (e.g. actp find "translate french" --rank llm)',
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
    ...(options.rank        ? { rank: options.rank as DiscoverParams['rank'] }     : {}),
    ...(options.priority    ? { priority: options.priority as DiscoverParams['priority'] } : {}),
    limit,
  };

  const spinner = output.spinner('Searching agents...');

  let result: { agents: DiscoverAgent[]; total: number; ranking?: RankingInfo };

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

  const { agents, total, ranking } = result;

  // JSON mode — raw API response
  if (output.mode === 'json') {
    output.result({ agents, total, ...(ranking ? { ranking } : {}) } as unknown as Record<string, unknown>);
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

  // Show LLM ranking recommendations if present
  if (ranking && ranking.ranked.length > 0) {
    output.blank();
    output.print(fmt.bold('  AI Recommendations') + fmt.dim(` (${ranking.model}, ${ranking.version})`));
    output.print('  ' + fmt.dim('-'.repeat(60)));

    for (let i = 0; i < ranking.ranked.length; i++) {
      const r = ranking.ranked[i];
      const conf = r.confidence === 'high' ? fmt.green(r.confidence)
        : r.confidence === 'medium' ? fmt.yellow(r.confidence)
        : fmt.dim(r.confidence);
      output.print(`  ${i + 1}. ${fmt.cyan(r.slug)} ${fmt.dim('[')}${conf}${fmt.dim(']')}`);
      output.print(`     ${r.reason}`);
      if (r.risk) output.print(`     ${fmt.dim('Risk:')} ${r.risk}`);
    }
  }

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
