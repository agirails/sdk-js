/**
 * Find Command Tests
 *
 * Tests runFind() logic with mocked discoverAgents().
 *
 * @module cli/commands/find.test
 */

import { runFind } from './find';
import { Output } from '../utils/output';
import * as agirailsApp from '../../api/agirailsApp';

jest.mock('../../api/agirailsApp');

const mockDiscover = agirailsApp.discoverAgents as jest.MockedFunction<
  typeof agirailsApp.discoverAgents
>;

// Capture console output
let lines: string[];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  console.warn = (...args: unknown[]) => lines.push(args.join(' '));
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  jest.clearAllMocks();
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
});

// ============================================================================
// Fixtures
// ============================================================================

const AGENT_FIXTURE: agirailsApp.DiscoverAgent = {
  slug: 'code-reviewer',
  wallet_address: '0xabcd',
  published_config: {
    name: 'Code Reviewer',
    capabilities: ['code-review', 'refactor'],
    pricing: { amount: 2.5, currency: 'USDC', unit: 'task' },
    payment_mode: 'actp',
  },
  published_at: '2026-01-01T00:00:00Z',
  status: 'published',
};

// Helper to mock process.exit
function mockExit(): jest.SpyInstance {
  return jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('EXIT');
  });
}

// ============================================================================
// Human mode
// ============================================================================

describe('runFind — human mode', () => {
  it('renders table when agents are found', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [AGENT_FIXTURE], total: 1 });
    const output = new Output('human');
    await runFind(undefined, {}, output);
    const joined = lines.join('\n');
    expect(joined).toContain('code-reviewer');
    expect(joined).toContain('Code Reviewer');
    expect(joined).toContain('2.50 USDC');
  });

  it('shows empty state when no agents found', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind('nonexistent', {}, output);
    expect(lines.join('\n')).toContain('No agents found');
  });

  it('shows count footer with total', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [AGENT_FIXTURE], total: 42 });
    const output = new Output('human');
    await runFind(undefined, {}, output);
    expect(lines.join('\n')).toContain('1 of 42');
  });

  it('handles agent with no published_config gracefully', async () => {
    const bare: agirailsApp.DiscoverAgent = {
      slug: 'bare-agent',
      wallet_address: '0x1234',
    };
    mockDiscover.mockResolvedValueOnce({ agents: [bare], total: 1 });
    const output = new Output('human');
    await runFind(undefined, {}, output);
    expect(lines.join('\n')).toContain('bare-agent');
  });
});

// ============================================================================
// JSON mode
// ============================================================================

describe('runFind — json mode', () => {
  it('outputs raw API response as JSON', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [AGENT_FIXTURE], total: 1 });
    const output = new Output('json');
    await runFind(undefined, {}, output);
    const jsonLine = lines.find((l) => l.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.total).toBe(1);
    expect(parsed.agents[0].slug).toBe('code-reviewer');
  });
});

// ============================================================================
// Quiet mode
// ============================================================================

describe('runFind — quiet mode', () => {
  it('outputs one slug per line', async () => {
    mockDiscover.mockResolvedValueOnce({
      agents: [AGENT_FIXTURE, { ...AGENT_FIXTURE, slug: 'translator-bot' }],
      total: 2,
    });
    const output = new Output('quiet');
    await runFind(undefined, {}, output);
    expect(lines).toContain('code-reviewer');
    expect(lines).toContain('translator-bot');
  });
});

// ============================================================================
// Parameter forwarding
// ============================================================================

describe('runFind — params forwarding', () => {
  it('passes query as search param', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind('translation', { limit: '5' }, output);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'translation', limit: 5 })
    );
  });

  it('passes capability filter', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind(undefined, { capability: 'code-review' }, output);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'code-review' })
    );
  });

  it('passes maxPrice to API', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind(undefined, { maxPrice: '10' }, output);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ maxPrice: 10 })
    );
  });

  it('clamps limit to 1-100 range', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind(undefined, { limit: '999' }, output);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 })
    );
  });

  it('defaults limit to 20', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind(undefined, {}, output);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 })
    );
  });
});

// ============================================================================
// Input validation
// ============================================================================

describe('runFind — input validation', () => {
  it('rejects non-numeric --max-price', async () => {
    const exitSpy = mockExit();
    const output = new Output('human');
    await expect(runFind(undefined, { maxPrice: 'abc' }, output)).rejects.toThrow('EXIT');
    expect(lines.join('\n')).toContain('--max-price must be a non-negative number');
    exitSpy.mockRestore();
  });

  it('rejects negative --max-price', async () => {
    const exitSpy = mockExit();
    const output = new Output('human');
    await expect(runFind(undefined, { maxPrice: '-5' }, output)).rejects.toThrow('EXIT');
    expect(lines.join('\n')).toContain('--max-price must be a non-negative number');
    exitSpy.mockRestore();
  });

  it('rejects invalid --sort value', async () => {
    const exitSpy = mockExit();
    const output = new Output('human');
    await expect(runFind(undefined, { sort: 'foobar' }, output)).rejects.toThrow('EXIT');
    expect(lines.join('\n')).toContain('--sort must be one of');
    exitSpy.mockRestore();
  });

  it('accepts valid --sort values', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind(undefined, { sort: 'price' }, output);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'price' })
    );
  });

  it('rejects --max-price with trailing text (e.g. "10usd")', async () => {
    const exitSpy = mockExit();
    const output = new Output('human');
    await expect(runFind(undefined, { maxPrice: '10usd' }, output)).rejects.toThrow('EXIT');
    expect(lines.join('\n')).toContain('--max-price must be a non-negative number');
    exitSpy.mockRestore();
  });

  it('rejects --max-price Infinity', async () => {
    const exitSpy = mockExit();
    const output = new Output('human');
    await expect(runFind(undefined, { maxPrice: 'Infinity' }, output)).rejects.toThrow('EXIT');
    expect(lines.join('\n')).toContain('--max-price must be a non-negative number');
    exitSpy.mockRestore();
  });

  it('rejects invalid --payment-mode', async () => {
    const exitSpy = mockExit();
    const output = new Output('human');
    await expect(runFind(undefined, { paymentMode: 'stripe' }, output)).rejects.toThrow('EXIT');
    expect(lines.join('\n')).toContain('--payment-mode must be one of: actp, x402');
    exitSpy.mockRestore();
  });

  it('accepts valid --payment-mode', async () => {
    mockDiscover.mockResolvedValueOnce({ agents: [], total: 0 });
    const output = new Output('human');
    await runFind(undefined, { paymentMode: 'x402' }, output);
    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMode: 'x402' })
    );
  });
});

// ============================================================================
// Network error
// ============================================================================

describe('runFind — network error', () => {
  it('outputs structured error and exits on API failure', async () => {
    mockDiscover.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const output = new Output('human');
    const exitSpy = mockExit();
    await expect(runFind(undefined, {}, output)).rejects.toThrow('EXIT');
    expect(lines.join('\n')).toContain('Could not reach agirails.app');
    exitSpy.mockRestore();
  });

  it('outputs JSON error in json mode', async () => {
    mockDiscover.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const output = new Output('json');
    const exitSpy = mockExit();
    await expect(runFind(undefined, {}, output)).rejects.toThrow('EXIT');
    const errorLine = lines.find((l) => l.includes('NETWORK_ERROR'));
    expect(errorLine).toBeDefined();
    exitSpy.mockRestore();
  });
});
