/**
 * Unit tests for buildX402Server.
 *
 * These tests mock @x402/core and @x402/evm server modules to verify
 * config validation, route mapping, and Permit2 advertisement logic
 * without hitting a real facilitator.
 *
 * @module server/buildX402Server.test
 */

import { buildX402Server, X402ServerConfig } from './buildX402Server';

// ---------------------------------------------------------------------------
// Mocks — intercept @x402/* server imports
// ---------------------------------------------------------------------------

const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockRegister = jest.fn().mockReturnThis();

jest.mock('@x402/core/server', () => ({
  HTTPFacilitatorClient: jest.fn().mockImplementation((config?: { url?: string }) => ({
    url: config?.url ?? 'https://x402.org/facilitator',
    verify: jest.fn(),
    settle: jest.fn(),
    getSupported: jest.fn().mockResolvedValue({ kinds: [] }),
  })),
  x402ResourceServer: jest.fn().mockImplementation(() => ({
    register: mockRegister,
    initialize: jest.fn().mockResolvedValue(undefined),
    hasRegisteredScheme: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('@x402/core/http', () => ({
  x402HTTPResourceServer: jest.fn().mockImplementation((_server: unknown, _routes: unknown) => ({
    initialize: mockInitialize,
    get server() { return _server; },
    get routes() { return _routes; },
    processHTTPRequest: jest.fn(),
    requiresPayment: jest.fn(),
  })),
}));

jest.mock('@x402/evm/exact/server', () => ({
  registerExactEvmScheme: jest.fn().mockImplementation((server: unknown) => server),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function baseConfig(overrides?: Partial<X402ServerConfig>): X402ServerConfig {
  return {
    payTo: VALID_ADDRESS,
    network: 'eip155:84532',
    routes: [
      { route: 'GET /api/data', price: '$0.01', description: 'Test endpoint' },
    ],
    ...overrides,
  };
}

describe('buildX402Server', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ========================================================================
  // Validation
  // ========================================================================

  it('rejects invalid payTo address', async () => {
    await expect(buildX402Server(baseConfig({ payTo: 'not-an-address' }))).rejects.toThrow(
      /payTo must be a valid Ethereum address/
    );
  });

  it('rejects missing network', async () => {
    await expect(buildX402Server(baseConfig({ network: '' }))).rejects.toThrow(
      /network must be a CAIP-2 identifier/
    );
  });

  it('rejects network without colon (non-CAIP-2)', async () => {
    await expect(buildX402Server(baseConfig({ network: 'base-sepolia' }))).rejects.toThrow(
      /network must be a CAIP-2 identifier/
    );
  });

  it('rejects empty routes array', async () => {
    await expect(buildX402Server(baseConfig({ routes: [] }))).rejects.toThrow(
      /at least one route is required/
    );
  });

  it('rejects route without METHOD /path format', async () => {
    await expect(
      buildX402Server(baseConfig({ routes: [{ route: '/api/data', price: '$0.01' }] }))
    ).rejects.toThrow(/route must be "METHOD \/path" format/);
  });

  it('rejects duplicate route keys', async () => {
    await expect(
      buildX402Server(
        baseConfig({
          routes: [
            { route: 'GET /api/data', price: '$0.01' },
            { route: 'GET /api/data', price: '$0.02' },
          ],
        })
      )
    ).rejects.toThrow(/duplicate route/);
  });

  it('rejects invalid per-route payTo', async () => {
    await expect(
      buildX402Server(
        baseConfig({ routes: [{ route: 'GET /api/data', price: '$0.01', payTo: 'bad' }] })
      )
    ).rejects.toThrow(/invalid payTo/);
  });

  it('rejects malformed route pattern (no valid HTTP method)', async () => {
    await expect(
      buildX402Server(baseConfig({ routes: [{ route: 'abc /x', price: '$0.01' }] }))
    ).rejects.toThrow(/route must be "METHOD \/path"/);
  });

  it('rejects route with method but no path', async () => {
    await expect(
      buildX402Server(baseConfig({ routes: [{ route: 'GET ', price: '$0.01' }] }))
    ).rejects.toThrow(/route must be "METHOD \/path"/);
  });

  it('rejects route with leading space', async () => {
    await expect(
      buildX402Server(baseConfig({ routes: [{ route: ' GET /x', price: '$0.01' }] }))
    ).rejects.toThrow(/route must be "METHOD \/path"/);
  });

  it('rejects empty price', async () => {
    await expect(
      buildX402Server(baseConfig({ routes: [{ route: 'GET /api/data', price: '' }] }))
    ).rejects.toThrow(/empty or missing price/);
  });

  it('rejects zero maxTimeoutSeconds', async () => {
    await expect(
      buildX402Server(
        baseConfig({ routes: [{ route: 'GET /api/data', price: '$0.01', maxTimeoutSeconds: 0 }] })
      )
    ).rejects.toThrow(/invalid maxTimeoutSeconds/);
  });

  it('rejects negative maxTimeoutSeconds', async () => {
    await expect(
      buildX402Server(
        baseConfig({ routes: [{ route: 'GET /api/data', price: '$0.01', maxTimeoutSeconds: -5 }] })
      )
    ).rejects.toThrow(/invalid maxTimeoutSeconds/);
  });

  it('rejects NaN maxTimeoutSeconds', async () => {
    await expect(
      buildX402Server(
        baseConfig({ routes: [{ route: 'GET /api/data', price: '$0.01', maxTimeoutSeconds: NaN }] })
      )
    ).rejects.toThrow(/invalid maxTimeoutSeconds/);
  });

  it('rejects invalid per-route network', async () => {
    await expect(
      buildX402Server(
        baseConfig({
          routes: [{ route: 'GET /api/data', price: '$0.01', network: 'base-sepolia' }],
        })
      )
    ).rejects.toThrow(/invalid network/);
  });

  // ========================================================================
  // Happy path
  // ========================================================================

  it('returns httpServer, routes, and resourceServer', async () => {
    const result = await buildX402Server(baseConfig());

    expect(result).toHaveProperty('httpServer');
    expect(result).toHaveProperty('routes');
    expect(result).toHaveProperty('resourceServer');
  });

  it('calls initialize on the HTTP resource server', async () => {
    await buildX402Server(baseConfig());
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('registers EVM exact scheme', async () => {
    const { registerExactEvmScheme } = require('@x402/evm/exact/server');
    await buildX402Server(baseConfig());
    expect(registerExactEvmScheme).toHaveBeenCalledTimes(1);
  });

  // ========================================================================
  // Route mapping
  // ========================================================================

  it('maps single route with correct PaymentOption shape', async () => {
    const result = await buildX402Server(baseConfig());
    const routes = result.routes as unknown as Record<string, { accepts: Array<Record<string, unknown>> }>;

    expect(routes['GET /api/data']).toBeDefined();
    const accepts = routes['GET /api/data'].accepts;
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      payTo: VALID_ADDRESS,
      price: '$0.01',
      maxTimeoutSeconds: 300,
    });
  });

  it('maps multiple routes', async () => {
    const result = await buildX402Server(
      baseConfig({
        routes: [
          { route: 'GET /api/data', price: '$0.01' },
          { route: 'POST /api/generate', price: '$0.50' },
        ],
      })
    );
    const routes = result.routes as Record<string, unknown>;
    expect(Object.keys(routes)).toEqual(['GET /api/data', 'POST /api/generate']);
  });

  it('allows per-route network override', async () => {
    const result = await buildX402Server(
      baseConfig({
        routes: [{ route: 'GET /api/data', price: '$0.01', network: 'eip155:8453' }],
      })
    );
    const routes = result.routes as unknown as Record<string, { accepts: Array<Record<string, unknown>> }>;
    expect(routes['GET /api/data'].accepts[0].network).toBe('eip155:8453');
  });

  it('allows per-route payTo override', async () => {
    const otherAddr = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const result = await buildX402Server(
      baseConfig({
        routes: [{ route: 'GET /api/data', price: '$0.01', payTo: otherAddr }],
      })
    );
    const routes = result.routes as unknown as Record<string, { accepts: Array<Record<string, unknown>> }>;
    expect(routes['GET /api/data'].accepts[0].payTo).toBe(otherAddr);
  });

  it('passes description into route config', async () => {
    const result = await buildX402Server(baseConfig());
    const routes = result.routes as unknown as Record<string, { description?: string }>;
    expect(routes['GET /api/data'].description).toBe('Test endpoint');
  });

  it('allows custom maxTimeoutSeconds per route', async () => {
    const result = await buildX402Server(
      baseConfig({
        routes: [{ route: 'GET /api/data', price: '$0.01', maxTimeoutSeconds: 60 }],
      })
    );
    const routes = result.routes as unknown as Record<string, { accepts: Array<Record<string, unknown>> }>;
    expect(routes['GET /api/data'].accepts[0].maxTimeoutSeconds).toBe(60);
  });

  // ========================================================================
  // Permit2 advertising
  // ========================================================================

  it('advertises Permit2 by default for Smart Wallet compat', async () => {
    const result = await buildX402Server(baseConfig());
    const routes = result.routes as unknown as Record<string, { accepts: Array<Record<string, unknown>> }>;
    expect(routes['GET /api/data'].accepts[0].extra).toEqual({
      assetTransferMethod: 'permit2',
    });
  });

  it('omits Permit2 extra when preferPermit2 = false', async () => {
    const result = await buildX402Server(baseConfig({ preferPermit2: false }));
    const routes = result.routes as unknown as Record<string, { accepts: Array<Record<string, unknown>> }>;
    expect(routes['GET /api/data'].accepts[0].extra).toBeUndefined();
  });

  // ========================================================================
  // Facilitator config
  // ========================================================================

  it('uses default facilitator URL when not specified', async () => {
    const { HTTPFacilitatorClient } = require('@x402/core/server');
    await buildX402Server(baseConfig());
    expect(HTTPFacilitatorClient).toHaveBeenCalledWith({ url: undefined });
  });

  it('passes custom facilitator URL', async () => {
    const { HTTPFacilitatorClient } = require('@x402/core/server');
    await buildX402Server(baseConfig({ facilitatorUrl: 'https://custom.facilitator.io' }));
    expect(HTTPFacilitatorClient).toHaveBeenCalledWith({ url: 'https://custom.facilitator.io' });
  });
});
