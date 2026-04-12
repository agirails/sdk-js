/**
 * Server Module — x402 v2 seller-side helpers.
 *
 * Framework-agnostic: builds a configured `x402HTTPResourceServer` + routes
 * object that plugs directly into upstream middleware (`@x402/express`,
 * `@x402/hono`, `@x402/next`) or any framework via the raw processHTTPRequest
 * API from `@x402/core`.
 *
 * @module server
 *
 * @example
 * ```typescript
 * import { buildX402Server } from '@agirails/sdk/server';
 * import { paymentMiddleware } from '@x402/express';
 * import express from 'express';
 *
 * const { httpServer, routes } = await buildX402Server({
 *   payTo: '0xYourAddress',
 *   network: 'eip155:84532',
 *   routes: [
 *     { route: 'GET /api/premium', price: '$0.10', description: 'Premium content' },
 *   ],
 * });
 *
 * const app = express();
 * app.use(paymentMiddleware(routes, httpServer));
 * app.get('/api/premium', (req, res) => res.json({ secret: '...' }));
 * app.listen(3000);
 * ```
 */

export { buildX402Server } from './buildX402Server';
export type {
  X402ServerConfig,
  X402RouteDefinition,
  X402ServerResult,
} from './buildX402Server';
