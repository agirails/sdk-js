/**
 * `actp serve` — long-running provider daemon focused on the AIP-2.1 quote channel.
 *
 * Loads a ProviderPolicy JSON, constructs a ProviderOrchestrator, opens
 * an HTTP server on the configured port that exposes the AIP-2.1 quote
 * channel surface (`POST /quote-channel/{chainId}/{txId}` per §8.2),
 * and routes incoming buyer counter-offers through
 * orchestrator.evaluateCounter().
 *
 * Scope:
 *  - accept + verify incoming counter-offers via QuoteChannelHandler
 *  - log the policy verdict (accept / reject) per round
 *  - emit a one-line health response on `GET /`
 *
 * Not in scope here:
 *  - On-chain INITIATED-tx detection is handled by `actp agent` or
 *    `new Agent()`. Both use the hybrid subscription + bounded catch-up
 *    sweep on `BlockchainRuntime` since 4.0.0
 *    (PRD-event-driven-provider-listening §5.2, §5.3, §5.8). `actp serve`
 *    intentionally has no on-chain watcher — running it alongside
 *    `actp agent` is the canonical split: `serve` handles the AIP-2.1
 *    quote channel, `agent` handles on-chain INITIATED pickups.
 *  - Sending CounterAcceptMessage back to buyer (no reverse-endpoint
 *    discovery yet — print the verdict, operator handles delivery).
 *
 * @module cli/commands/serve
 */

import { Command } from 'commander';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { Wallet, JsonRpcProvider, type Signer } from 'ethers';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { getNetwork } from '../../config/networks';
import { BlockchainRuntime } from '../../runtime/BlockchainRuntime';
import { MockRuntime } from '../../runtime/MockRuntime';
import { MockStateManager } from '../../runtime/MockStateManager';
import { ProviderOrchestrator } from '../../negotiation/ProviderOrchestrator';
import type { ProviderPolicy } from '../../negotiation/ProviderPolicy';
import {
  QuoteChannelHandler,
  buildChannelPath,
} from '../../transport/QuoteChannel';

// ============================================================================
// Command
// ============================================================================

export function createServeCommand(): Command {
  const cmd = new Command('serve')
    .description('Run a long-running provider daemon (AIP-2.1 quote channel)')
    .requiredOption('--policy <path>', 'Path to ProviderPolicy JSON file')
    .option('--port <num>', 'HTTP port to listen on', '8787')
    .option('--network <name>', 'Network — base-sepolia | base-mainnet | mock', 'base-sepolia')
    .option('--rpc <url>', 'Custom RPC URL override (testnet/mainnet only)')
    .option('--mock', 'Run with MockRuntime instead of BlockchainRuntime (for local testing)')
    .action(async (options) => {
      const output = new Output('human');
      try {
        await runServe(options, output);
      } catch (error) {
        const structured = mapError(error);
        output.errorResult({
          code: structured.code,
          message: structured.message,
          details: structured.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });
  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

interface ServeOptions {
  policy: string;
  port: string;
  network: string;
  rpc?: string;
  mock?: boolean;
}

async function runServe(options: ServeOptions, output: Output): Promise<void> {
  // 1. Load + validate policy.
  if (!existsSync(options.policy)) {
    throw new Error(`Policy file not found: ${options.policy}`);
  }
  const policy = JSON.parse(readFileSync(options.policy, 'utf-8')) as ProviderPolicy;

  // 2. Build runtime AND keep a direct signer reference for the
  //    orchestrator. BlockchainRuntime makes its signer private, so we
  //    hold ours alongside.
  let runtime: BlockchainRuntime | MockRuntime;
  let kernelAddress: string;
  let chainId: number;
  let signerAddress: string;
  let orchestratorSigner: Signer;

  if (options.mock) {
    const stateMgr = new MockStateManager(process.cwd() + '/.actp-serve');
    runtime = new MockRuntime(stateMgr);
    kernelAddress = '0x' + '0'.repeat(40);
    chainId = 84532;
    const mockWallet = Wallet.createRandom();
    orchestratorSigner = mockWallet;
    signerAddress = mockWallet.address;
    output.info('Running in MOCK mode — no real on-chain interaction.');
  } else {
    const networkCfg = getNetwork(options.network);
    if (options.rpc) networkCfg.rpcUrl = options.rpc;

    const { resolvePrivateKey } = await import('../../wallet/keystore');
    const tier = options.network.includes('mainnet') ? 'mainnet'
      : options.network.includes('sepolia') ? 'testnet' : 'mock';
    const privateKey = await resolvePrivateKey(process.cwd(), {
      network: tier as 'mainnet' | 'testnet' | 'mock',
    });
    if (!privateKey) {
      throw new Error('No wallet found. Run `actp init` or set ACTP_KEYSTORE_BASE64.');
    }

    const provider = new JsonRpcProvider(networkCfg.rpcUrl);
    const signer = new Wallet(privateKey, provider);
    orchestratorSigner = signer;
    runtime = new BlockchainRuntime({
      network: options.network as 'base-sepolia' | 'base-mainnet',
      signer,
      provider,
    });
    await runtime.initialize();

    kernelAddress = networkCfg.contracts.actpKernel;
    chainId = networkCfg.chainId;
    signerAddress = await signer.getAddress();
  }

  const orchestrator = new ProviderOrchestrator({
    policy,
    runtime,
    signer: orchestratorSigner,
    kernelAddress,
    chainId,
  });

  // 4. Build channel handler with kernel address per chain.
  const channelHandler = new QuoteChannelHandler({
    kernelAddressByChainId: {
      [chainId]: kernelAddress,
    },
  });

  // 5. Start HTTP server.
  const port = Number(options.port);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, {
        channelHandler,
        orchestrator,
        chainId,
        signerAddress,
        output,
      });
    } catch (err) {
      output.error(`Request handler crashed: ${err instanceof Error ? err.message : String(err)}`);
      res.statusCode = 500;
      res.end('{"error":"internal"}');
    }
  });

  // Slow-loris hardening: bound the time a client can hold a socket open
  // dribbling out a request body. Without this, `readBody` will sit in
  // its `data` listener until the OS-level keepalive ages out.
  // 10s for headers, 15s for the full request — generous for normal
  // peers (a counter-offer body is well under 4 KiB), tight enough to
  // shed slow-trickle attackers in seconds.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  server.listen(port, () => {
    output.success(`actp serve listening on http://0.0.0.0:${port}`);
    output.print(`  Network:        ${options.network}${options.mock ? ' (mock)' : ''}`);
    output.print(`  Provider:       ${signerAddress}`);
    output.print(`  Channel base:   ${buildChannelPath(chainId, '<txId>')}`);
    output.print(`  Health:         GET /`);
    output.print('');
    output.print('Counter-offers POSTed to /quote-channel/{chainId}/{txId} are verified + evaluated.');
    output.print('Verdicts are logged here; v1 does NOT auto-deliver CounterAcceptMessage back to');
    output.print('the buyer — operator handles that out-of-band (see AIP-2.1 §5.3).');
    output.print('');
  });

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    output.info(`\n${signal} received — shutting down…`);
    server.close(() => {
      output.success('Stopped.');
      process.exit(0);
    });
    // Force-exit after 5s if connections hang.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// ============================================================================
// Routing
// ============================================================================

interface RouteContext {
  channelHandler: QuoteChannelHandler;
  orchestrator: ProviderOrchestrator;
  chainId: number;
  signerAddress: string;
  output: Output;
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const url = req.url ?? '/';

  // Health check.
  if (req.method === 'GET' && url === '/') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      provider: ctx.signerAddress,
      chainId: ctx.chainId,
      service: 'actp-serve',
    }));
    return;
  }

  // /quote-channel/{chainId}/{txId}.
  const channelMatch = url.match(/^\/quote-channel\/(\d+)\/(0x[a-fA-F0-9]{64})\/?$/);
  if (req.method === 'POST' && channelMatch) {
    const [, chainIdStr, txId] = channelMatch;
    const pathChainId = Number(chainIdStr);

    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ accepted: false, reason: 'Invalid JSON' }));
      return;
    }

    const result = await ctx.channelHandler.handle(payload, { pathChainId, pathTxId: txId });

    // For counter-offers that pass the channel handler, run the
    // orchestrator's policy verdict and log it.
    if (result.status === 201 || result.status === 200) {
      const p = payload as { type?: string; message?: { counterAmount?: string } };
      if (p?.type === 'agirails.counteroffer.v1' && p.message) {
        try {
          const verdict = await ctx.orchestrator.evaluateCounter(
            p.message as Parameters<typeof ctx.orchestrator.evaluateCounter>[0],
          );
          ctx.output.info(
            `[counter] tx=${txId.slice(0, 12)}… counter=${p.message.counterAmount} → ${verdict.action}: ${verdict.reason}`,
          );
        } catch (err) {
          ctx.output.warning(
            `[counter] tx=${txId.slice(0, 12)}… verification failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * Read a request body with two hard limits — defense in depth alongside
 * the server-level `headersTimeout` / `requestTimeout`:
 *   - byte cap  (64 KiB) to bound memory
 *   - wall-clock deadline (10s) to bound time
 *
 * Both must be enforced here too because a caller could construct the
 * server without our timeouts (e.g. testing with a raw http.Server) and
 * the body cap alone won't shed a peer that sends 1 byte/sec forever.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const MAX_BYTES = 64 * 1024;
    const MAX_MS = 10_000;

    const finish = (err: Error | null, body?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) {
        try { req.destroy(); } catch { /* */ }
        reject(err);
      } else {
        resolve(body ?? '');
      }
    };

    const deadline = setTimeout(() => {
      finish(new Error('Body read timeout'));
    }, MAX_MS);

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        finish(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf-8')));
    req.on('error', (err) => finish(err));
  });
}
