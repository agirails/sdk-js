/**
 * Pay Command Tests
 *
 * Tests slug URL resolution in runPay().
 *
 * @module cli/commands/pay.test
 */

import { runPay, PAY_SERVICE_REJECTION_MESSAGE } from './pay';
import { Output } from '../utils/output';
import * as agirailsApp from '../../api/agirailsApp';
import * as clientUtil from '../utils/client';

jest.mock('../../api/agirailsApp');
jest.mock('../utils/client');

const mockDiscover = agirailsApp.discoverAgents as jest.MockedFunction<
  typeof agirailsApp.discoverAgents
>;

const mockCreateClient = clientUtil.createClient as jest.MockedFunction<
  typeof clientUtil.createClient
>;

// Helper to mock process.exit
function mockExit(): jest.SpyInstance {
  return jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('EXIT');
  });
}

const WALLET = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';

const AGENT_FIXTURE: agirailsApp.DiscoverAgent = {
  slug: 'arha',
  wallet_address: WALLET,
  published_config: {
    name: 'Arha',
    capabilities: ['code-review'],
    pricing: { amount: 5, currency: 'USDC', unit: 'task' },
    payment_mode: 'actp',
  },
  status: 'published',
};

function quietOutput(): Output {
  return new Output('quiet');
}

describe('pay slug resolution', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = mockExit();
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('resolves agirails.app/a/<slug> to wallet address', async () => {
    mockDiscover.mockResolvedValue({ agents: [AGENT_FIXTURE], total: 1 });
    const mockPay = jest.fn().mockResolvedValue({
      txId: '0x123',
      state: 'COMMITTED',
      provider: WALLET,
      requester: '0x0000000000000000000000000000000000000001',
      amount: '5000000',
      deadline: 9999999999,
    });
    mockCreateClient.mockResolvedValue({
      basic: { pay: mockPay },
    } as any);

    await runPay('agirails.app/a/arha', '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput());

    expect(mockDiscover).toHaveBeenCalledWith({ search: 'arha', limit: 10 });
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({ to: WALLET })
    );
  });

  it('resolves https:// prefixed slug URL', async () => {
    mockDiscover.mockResolvedValue({ agents: [AGENT_FIXTURE], total: 1 });
    const mockPay = jest.fn().mockResolvedValue({
      txId: '0x123', state: 'COMMITTED', provider: WALLET,
      requester: '0x01', amount: '5000000', deadline: 9999999999,
    });
    mockCreateClient.mockResolvedValue({ basic: { pay: mockPay } } as any);

    await runPay('https://agirails.app/a/arha', '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput());

    expect(mockDiscover).toHaveBeenCalledWith({ search: 'arha', limit: 10 });
    expect(mockPay).toHaveBeenCalledWith(expect.objectContaining({ to: WALLET }));
  });

  it('resolves www. prefixed slug URL', async () => {
    mockDiscover.mockResolvedValue({ agents: [AGENT_FIXTURE], total: 1 });
    const mockPay = jest.fn().mockResolvedValue({
      txId: '0x123', state: 'COMMITTED', provider: WALLET,
      requester: '0x01', amount: '5000000', deadline: 9999999999,
    });
    mockCreateClient.mockResolvedValue({ basic: { pay: mockPay } } as any);

    await runPay('https://www.agirails.app/a/arha', '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput());

    expect(mockDiscover).toHaveBeenCalledWith({ search: 'arha', limit: 10 });
    expect(mockPay).toHaveBeenCalledWith(expect.objectContaining({ to: WALLET }));
  });

  it('normalizes uppercase slug from URL to lowercase', async () => {
    mockDiscover.mockResolvedValue({ agents: [AGENT_FIXTURE], total: 1 });
    const mockPay = jest.fn().mockResolvedValue({
      txId: '0x123', state: 'COMMITTED', provider: WALLET,
      requester: '0x01', amount: '5000000', deadline: 9999999999,
    });
    mockCreateClient.mockResolvedValue({ basic: { pay: mockPay } } as any);

    await runPay('agirails.app/a/Arha', '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput());

    expect(mockDiscover).toHaveBeenCalledWith({ search: 'arha', limit: 10 });
  });

  it('finds correct agent among fuzzy results', async () => {
    const fuzzyAgent: agirailsApp.DiscoverAgent = {
      slug: 'arha-dev', wallet_address: '0x0000000000000000000000000000000000000099',
    };
    mockDiscover.mockResolvedValue({ agents: [fuzzyAgent, AGENT_FIXTURE], total: 2 });
    const mockPay = jest.fn().mockResolvedValue({
      txId: '0x123', state: 'COMMITTED', provider: WALLET,
      requester: '0x01', amount: '5000000', deadline: 9999999999,
    });
    mockCreateClient.mockResolvedValue({ basic: { pay: mockPay } } as any);

    await runPay('agirails.app/a/arha', '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput());

    // Should pick the exact match, not the fuzzy one
    expect(mockPay).toHaveBeenCalledWith(expect.objectContaining({ to: WALLET }));
  });

  it('exits with error when slug not found', async () => {
    mockDiscover.mockResolvedValue({ agents: [], total: 0 });

    await expect(
      runPay('agirails.app/a/nonexistent', '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput())
    ).rejects.toThrow('EXIT');

    expect(exitSpy).toHaveBeenCalled();
  });

  it('exits when API returns fuzzy results but no exact match', async () => {
    const fuzzyOnly: agirailsApp.DiscoverAgent = {
      slug: 'arha-dev', wallet_address: '0x0000000000000000000000000000000000000099',
    };
    mockDiscover.mockResolvedValue({ agents: [fuzzyOnly], total: 1 });

    await expect(
      runPay('agirails.app/a/arha', '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput())
    ).rejects.toThrow('EXIT');

    expect(exitSpy).toHaveBeenCalled();
  });

  it('passes 0x address through without calling discoverAgents', async () => {
    const mockPay = jest.fn().mockResolvedValue({
      txId: '0x123', state: 'COMMITTED', provider: WALLET,
      requester: '0x01', amount: '5000000', deadline: 9999999999,
    });
    mockCreateClient.mockResolvedValue({ basic: { pay: mockPay } } as any);

    await runPay(WALLET, '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput());

    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockPay).toHaveBeenCalledWith(expect.objectContaining({ to: WALLET }));
  });
});

// ============================================================================
// PRD §5.9 — --service rejection
// ============================================================================

describe('pay --service rejection (PRD §5.9)', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = mockExit();
    // Output(.error) routes through console.error in quiet/json modes.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits with code 64 (EX_USAGE) when --service is passed', async () => {
    await expect(
      runPay(WALLET, '5', { deadline: '+24h', disputeWindow: '172800', service: 'onboarding' }, quietOutput())
    ).rejects.toThrow('EXIT');

    expect(exitSpy).toHaveBeenCalledWith(64);
  });

  it('prints the canonical directive pointing at actp request', async () => {
    await expect(
      runPay(WALLET, '5', { deadline: '+24h', disputeWindow: '172800', service: 'whatever' }, quietOutput())
    ).rejects.toThrow('EXIT');

    // We don't pin on the full message — it's stable but allowed to evolve.
    // The two load-bearing phrases must be present so user-facing copy
    // doesn't drift away from PRD intent.
    const allErrorCalls = errorSpy.mock.calls.flat().join(' ');
    expect(allErrorCalls).toMatch(/Level 0 primitive/);
    expect(allErrorCalls).toMatch(/actp request <provider> <amount> --service <name>/);
  });

  it('exposes the canonical message as a constant for downstream tooling', () => {
    expect(PAY_SERVICE_REJECTION_MESSAGE).toMatch(/Level 0 primitive/);
    expect(PAY_SERVICE_REJECTION_MESSAGE).toMatch(/actp request/);
  });

  it('does not reject when --service is absent (back-compat)', async () => {
    const mockPay = jest.fn().mockResolvedValue({
      txId: '0x123', state: 'COMMITTED', provider: WALLET,
      requester: '0x01', amount: '5000000', deadline: 9999999999,
    });
    mockCreateClient.mockResolvedValue({ basic: { pay: mockPay } } as any);

    // service omitted — the rejection path must not fire.
    await runPay(WALLET, '5', { deadline: '+24h', disputeWindow: '172800' }, quietOutput());

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockPay).toHaveBeenCalled();
  });
});
