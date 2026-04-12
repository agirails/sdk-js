/**
 * buildX402Server — factory that maps AGIRAILS agent config into
 * a ready-to-use x402 v2 resource server + route definitions.
 *
 * Design: we never wrap or re-export framework middleware. The output
 * plugs directly into @x402/express, @x402/hono, @x402/next, or raw
 * @x402/core processHTTPRequest for any framework.
 *
 * @module server/buildX402Server
 */

import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { x402HTTPResourceServer, type RoutesConfig, type PaymentOption } from '@x402/core/http';
import { registerExactEvmScheme } from '@x402/evm/exact/server';

// ============================================================================
// Types
// ============================================================================

/**
 * A single paid route definition.
 */
export interface X402RouteDefinition {
  /** HTTP method + path pattern, e.g. "GET /api/premium" or "POST /api/generate" */
  route: string;

  /** Price in human-readable USD, e.g. "$0.10" or "0.50" */
  price: string;

  /** Short description shown in the payment prompt */
  description?: string;

  /**
   * Override CAIP-2 network for this specific route.
   * Default: top-level `config.network`.
   */
  network?: string;

  /**
   * Override payTo address for this specific route.
   * Default: top-level `config.payTo`.
   */
  payTo?: string;

  /** Max authorization validity in seconds. Default: 300 (5 min). */
  maxTimeoutSeconds?: number;
}

/**
 * Configuration for buildX402Server.
 */
export interface X402ServerConfig {
  /**
   * Address that receives payments. Typically the agent's wallet address
   * from `client.getAddress()`.
   */
  payTo: string;

  /**
   * CAIP-2 network identifier, e.g. "eip155:8453" (Base) or "eip155:84532" (Base Sepolia).
   * Applied to all routes unless overridden per-route.
   */
  network: string;

  /** Paid route definitions. */
  routes: X402RouteDefinition[];

  /**
   * Facilitator URL. Default: "https://x402.org/facilitator" (Coinbase public).
   * Override for self-hosted or third-party facilitators.
   */
  facilitatorUrl?: string;

  /**
   * Advertise Permit2 support so Smart Wallet buyers work out of the box.
   * Default: true.
   */
  preferPermit2?: boolean;
}

/**
 * Result from buildX402Server.
 */
export interface X402ServerResult {
  /**
   * HTTP resource server instance. Pass this as the second argument to
   * upstream middleware: `paymentMiddleware(routes, httpServer)`.
   *
   * For frameworks without a dedicated @x402 adapter, use
   * `httpServer.processHTTPRequest(context)` directly.
   */
  httpServer: x402HTTPResourceServer;

  /**
   * Route config object matching the shape expected by @x402/express,
   * @x402/hono, and @x402/next middleware.
   */
  routes: RoutesConfig;

  /** The underlying x402ResourceServer (for advanced hook registration). */
  resourceServer: x402ResourceServer;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build a configured x402 v2 resource server from simple route definitions.
 *
 * Async because it calls `httpServer.initialize()` which fetches facilitator
 * capabilities and validates that all route schemes are supported.
 *
 * @param config - Server configuration
 * @returns Ready-to-use server + routes
 * @throws {Error} If facilitator is unreachable or route schemes unsupported
 *
 * @example
 * ```typescript
 * // Express
 * import { buildX402Server } from '@agirails/sdk/server';
 * import { paymentMiddleware } from '@x402/express';
 * import express from 'express';
 *
 * const { httpServer, routes } = await buildX402Server({
 *   payTo: client.getAddress(),
 *   network: 'eip155:84532',
 *   routes: [{ route: 'GET /api/data', price: '$0.01' }],
 * });
 *
 * const app = express();
 * app.use(paymentMiddleware(routes, httpServer));
 * app.get('/api/data', (req, res) => res.json({ data: 42 }));
 * app.listen(3000);
 * ```
 *
 * @example
 * ```typescript
 * // Hono
 * import { buildX402Server } from '@agirails/sdk/server';
 * import { paymentMiddleware } from '@x402/hono';
 * import { Hono } from 'hono';
 *
 * const { httpServer, routes } = await buildX402Server({
 *   payTo: '0xYourAddress',
 *   network: 'eip155:8453',
 *   routes: [{ route: 'GET /api/premium', price: '$0.10' }],
 * });
 *
 * const app = new Hono();
 * app.use('*', paymentMiddleware(routes, httpServer));
 * ```
 */
export async function buildX402Server(
  config: X402ServerConfig
): Promise<X402ServerResult> {
  if (!config.payTo || !/^0x[0-9a-f]{40}$/i.test(config.payTo)) {
    throw new Error(
      `buildX402Server: payTo must be a valid Ethereum address, got "${config.payTo}"`
    );
  }
  if (!config.network || !config.network.includes(':')) {
    throw new Error(
      `buildX402Server: network must be a CAIP-2 identifier (e.g. "eip155:8453"), got "${config.network}"`
    );
  }
  if (!config.routes || config.routes.length === 0) {
    throw new Error('buildX402Server: at least one route is required');
  }

  // 1. Facilitator client
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });

  // 2. Resource server with EVM exact scheme
  const resourceServer = new x402ResourceServer(facilitator);
  registerExactEvmScheme(resourceServer);

  // 3. Build route config
  const routesConfig: Record<string, { accepts: PaymentOption[]; description?: string }> = {};

  const seen = new Set<string>();

  for (const def of config.routes) {
    if (!def.route || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*$/.test(def.route)) {
      throw new Error(
        `buildX402Server: route must be "METHOD /path" format (e.g. "GET /api/data"), got "${def.route}"`
      );
    }

    if (seen.has(def.route)) {
      throw new Error(
        `buildX402Server: duplicate route "${def.route}". Each route must be unique.`
      );
    }
    seen.add(def.route);

    const routePayTo = def.payTo ?? config.payTo;
    if (!/^0x[0-9a-f]{40}$/i.test(routePayTo)) {
      throw new Error(
        `buildX402Server: route "${def.route}" has invalid payTo "${routePayTo}"`
      );
    }

    const routeNetwork = def.network ?? config.network;
    if (!routeNetwork.includes(':')) {
      throw new Error(
        `buildX402Server: route "${def.route}" has invalid network "${routeNetwork}" (must be CAIP-2)`
      );
    }

    if (!def.price || (typeof def.price === 'string' && def.price.trim() === '')) {
      throw new Error(
        `buildX402Server: route "${def.route}" has empty or missing price`
      );
    }
    if (typeof def.price === 'string') {
      const trimmed = def.price.trim();
      if (!/^\$?\d+(\.\d+)?$/.test(trimmed)) {
        throw new Error(
          `buildX402Server: route "${def.route}" has invalid price "${def.price}" (expected format: "$0.10" or "0.50")`
        );
      }
      if (parseFloat(trimmed.replace('$', '')) <= 0) {
        throw new Error(
          `buildX402Server: route "${def.route}" price must be > 0, got "${def.price}"`
        );
      }
    }

    const timeout = def.maxTimeoutSeconds ?? 300;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `buildX402Server: route "${def.route}" has invalid maxTimeoutSeconds ${def.maxTimeoutSeconds} (must be > 0)`
      );
    }

    const paymentOption: PaymentOption = {
      scheme: 'exact',
      network: routeNetwork,
      payTo: routePayTo,
      price: def.price,
      maxTimeoutSeconds: timeout,
    };

    // Advertise Permit2 so Smart Wallet buyers work out of the box
    if (config.preferPermit2 !== false) {
      paymentOption.extra = { assetTransferMethod: 'permit2' };
    }

    routesConfig[def.route] = {
      accepts: [paymentOption],
      description: def.description,
    };
  }

  // 4. HTTP resource server
  const httpServer = new x402HTTPResourceServer(
    resourceServer,
    routesConfig as RoutesConfig
  );

  // 5. Initialize (fetches facilitator capabilities, validates routes)
  try {
    await httpServer.initialize();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`buildX402Server: failed to initialize — ${msg}`);
  }

  return {
    httpServer,
    routes: routesConfig as RoutesConfig,
    resourceServer,
  };
}
