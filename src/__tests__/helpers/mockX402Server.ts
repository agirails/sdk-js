/**
 * Raw node:http mock x402 v2 server for unit/integration tests.
 *
 * Returns a 402 `payment-required` response, verifies that the retry carries
 * a `payment-signature` header, and replies with a mock `payment-response`
 * header so tests can validate the buyer-side parse/sign/retry/map loop end
 * to end without touching a real facilitator or on-chain settlement.
 *
 * Design notes:
 * - Raw `node:http`, no Express dependency. Keeps the test surface small and
 *   isolates "what we're testing" (our X402Adapter) from upstream middleware.
 * - Payload is Base64-encoded JSON matching the x402 v2 wire format.
 * - Factory signature supports both EIP-3009 (`extra.assetTransferMethod` omitted)
 *   and Permit2 (`extra.assetTransferMethod = "permit2"`) scenarios via options.
 * - Server listens on a random port (port 0) so multiple tests can run in parallel.
 *
 * @module __tests__/helpers/mockX402Server
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface MockX402ServerOptions {
  /** CAIP-2 network. Default: "eip155:84532" (Base Sepolia) */
  network?: string;
  /** USDC amount as string (6 decimals). Default: "10000" (0.01 USDC) */
  amount?: string;
  /** Token contract address. Default: Base Sepolia USDC */
  asset?: string;
  /** Payment destination. Default: test provider address */
  payTo?: string;
  /** Set Permit2 transfer method. Default: EIP-3009 */
  permit2?: boolean;
  /** maxTimeoutSeconds advertised in requirements. Default: 300 */
  maxTimeoutSeconds?: number;
  /** Settlement tx hash returned in payment-response. Default: "0xmockhash" */
  settlementTxHash?: string;
  /**
   * When true, the retry request will receive HTTP 200 but NO payment-response
   * header. Used to test X402SettlementProofMissingError handling.
   */
  omitPaymentResponse?: boolean;
}

export interface MockX402ServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
  /** Count of initial 402 hits (useful for retry verification) */
  getInitialRequestCount: () => number;
  /** Count of retry requests (carrying payment-signature) */
  getRetryRequestCount: () => number;
}

const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DEFAULT_PAY_TO = '0x0000000000000000000000000000000000000001';

/**
 * Start a mock x402 v2 server on a random localhost port.
 *
 * Returns a handle with `.url` (e.g., `http://localhost:54321`), `.close()`
 * to tear down, and counters for asserting the number of round-trips.
 *
 * @example
 * ```ts
 * const server = await startMockX402Server({ permit2: true });
 * try {
 *   const res = await fetch(server.url);
 *   expect(res.status).toBe(402);
 * } finally {
 *   await server.close();
 * }
 * ```
 */
export function startMockX402Server(
  options: MockX402ServerOptions = {}
): Promise<MockX402ServerHandle> {
  const payload = buildPaymentRequiredPayload(options);
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');

  const settlementResponse = {
    transaction: options.settlementTxHash ?? '0xmockhash',
    network: options.network ?? 'eip155:84532',
    amount: options.amount ?? '10000',
    payer: '0xmockbuyer',
    payTo: options.payTo ?? DEFAULT_PAY_TO,
  };
  const encodedResponse = Buffer.from(JSON.stringify(settlementResponse)).toString('base64');

  let initialRequestCount = 0;
  let retryRequestCount = 0;

  return new Promise((resolve, reject) => {
    const server: Server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const hasPaymentSignature =
          Boolean(req.headers['payment-signature']) ||
          Boolean(req.headers['x-payment']) ||
          Boolean(req.headers['PAYMENT-SIGNATURE']);

        if (!hasPaymentSignature) {
          // First hit — return 402 with payment-required
          initialRequestCount++;
          res.statusCode = 402;
          res.setHeader('content-type', 'application/json');
          res.setHeader('payment-required', encodedPayload);
          res.end('{}');
          return;
        }

        // Retry with signed payment — accept and return settlement proof
        retryRequestCount++;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        if (!options.omitPaymentResponse) {
          res.setHeader('payment-response', encodedResponse);
        }
        res.end(JSON.stringify({ ok: true }));
      }
    );

    server.on('error', (err) => reject(err));

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
        getInitialRequestCount: () => initialRequestCount,
        getRetryRequestCount: () => retryRequestCount,
      });
    });
  });
}

function buildPaymentRequiredPayload(options: MockX402ServerOptions) {
  const network = options.network ?? 'eip155:84532';
  const extra: Record<string, unknown> = { name: 'USDC', version: '2' };
  if (options.permit2) {
    extra.assetTransferMethod = 'permit2';
  }

  return {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: 'http://mock/x402',
      description: 'Mock x402 v2 test endpoint',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network,
        amount: options.amount ?? '10000',
        asset: options.asset ?? BASE_SEPOLIA_USDC,
        payTo: options.payTo ?? DEFAULT_PAY_TO,
        maxTimeoutSeconds: options.maxTimeoutSeconds ?? 300,
        extra,
      },
    ],
  };
}
