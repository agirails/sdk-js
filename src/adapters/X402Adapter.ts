/**
 * X402Adapter — real x402 v2 protocol support.
 *
 * Thin wrapper around official @x402/fetch + @x402/evm + @x402/core packages.
 * Replaces the legacy custom `x-payment-*` HTTP flow (which was never real x402)
 * with proper EIP-3009 / Permit2 wire format for full interoperability with
 * any x402 v2 seller (Coinbase demo, third-party servers, AGIRAILS sellers).
 *
 * Architecture:
 * - Buyer signs EIP-3009 authorization or Permit2 witness OFF-CHAIN
 * - Facilitator (server-configured) submits on-chain tx and pays gas
 * - Buyer is always gassless for x402 by protocol design
 * - Smart Wallet buyers use Permit2 path (ERC-1271 + ERC-6492 via viem)
 * - EOA buyers use either path
 *
 * Zero fee layer: payTo goes directly to seller. X402Relay is never used.
 * Zero reputation hooks: ERC-8004 registry never touched on x402 payments.
 *
 * See /Users/damir/Arha/AGIRAILS/SDK and Runtime/sdk-js/X402_V2_IMPLEMENTATION_PLAN.md
 * for full architecture rationale and Smart Wallet signing flow.
 *
 * @module adapters/X402Adapter
 */

import {
  x402Client,
  wrapFetchWithPayment,
  decodePaymentResponseHeader,
  type PaymentRequirements,
  type BeforePaymentCreationContext,
} from '@x402/fetch';
import {
  ExactEvmScheme,
  PERMIT2_ADDRESS,
  createPermit2ApprovalTx,
  type ClientEvmSigner,
} from '@x402/evm';

import { IAdapter, TransactionStatus, AdapterTransactionState } from './IAdapter';
import {
  UnifiedPayParams,
  UnifiedPayResult,
  AdapterMetadata,
} from '../types/adapter';
import { IWalletProvider, EIP712TypedData } from '../wallet/IWalletProvider';
import {
  X402ConfigError,
  X402UnsupportedWalletError,
  X402NetworkNotAllowedError,
  X402AmountExceededError,
  X402ApprovalFailedError,
  X402SettlementProofMissingError,
  X402PaymentFailedError,
  X402PublishRequiredError,
  isPaymasterGateError,
} from '../errors/X402Errors';
import { sdkLogger } from '../utils/Logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for X402Adapter.
 *
 * Auto-registered by ACTPClient when walletProvider implements signTypedData.
 * Manual instantiation is supported but rarely needed — in most cases use
 * ACTPClient auto-registration defaults or register a custom adapter instance.
 */
export interface X402AdapterConfig {
  /**
   * Wallet provider for signing payment authorizations.
   * Both `EOAWalletProvider` (Tier 2) and `AutoWalletProvider` (Tier 1 Smart Wallet)
   * are supported as long as the provider implements the optional
   * `signTypedData` method.
   */
  walletProvider: IWalletProvider;

  /**
   * Optional CAIP-2 network allowlist (e.g. `["eip155:8453", "eip155:84532"]`).
   *
   * Leave undefined (default) to allow ANY EVM network @x402/evm supports —
   * this is the "works with anyone" interop default. Set an explicit list
   * only if you want to restrict your agent to specific chains.
   */
  allowedNetworks?: ReadonlyArray<string>;

  /**
   * Per-transaction safety cap in human-readable USD (e.g. "1" for $1 USDC).
   * Protects against accidentally paying unexpectedly high prices.
   * Default: "1"
   */
  maxAmountPerTx?: string;

  /**
   * Automatically run one-time Permit2 USDC approve on first Smart Wallet
   * x402 payment. The approve is sponsored by the existing paymaster and
   * costs nothing to the user in gas. Default: true.
   */
  autoApprovePermit2?: boolean;

  /**
   * MEV hard cap on signed authorization validity window in seconds.
   * Facilitator/server may propose longer `maxTimeoutSeconds`, but we clamp
   * to this value before signing. Default: 300 (5 minutes).
   */
  maxAuthorizationValidSec?: number;

  /**
   * Allowlist of asset token contract addresses the adapter will pay.
   *
   * Undefined (default) = all canonical USDC addresses on the configured
   * `allowedNetworks` (see `DEFAULT_USDC_BY_NETWORK`). Set to a specific
   * list to restrict further, or pass an empty array to allow any asset
   * (NOT recommended — removes the safety check entirely).
   *
   * P1-1: prevents a server from advertising a different token (e.g., USDT
   * on the same network, or a scam token) and having the adapter sign a
   * payment for it. The cap check in `parseUsdcAmount` / `formatUsdcAmount`
   * assumes 6 decimals, which is only accurate for USDC-family stables.
   * Honoring a non-USDC asset with different decimals would also break the
   * `maxAmountPerTx` cap.
   *
   * Addresses are compared case-insensitively.
   */
  allowedAssets?: ReadonlyArray<string>;

  /**
   * Allowlist of HTTPS hosts the adapter will pay without requiring explicit
   * opt-in via `metadata.paymentMethod === 'x402'`.
   *
   * Undefined or empty (default) = no host allowlist; callers must always
   * opt in explicitly unless they trust every HTTPS URL their code hits.
   * Set to specific hostnames (e.g. `['x402.org', 'api.mycoinbase.com']`) to
   * whitelist trusted servers for auto-pay.
   *
   * P1-3: prevents accidental `client.pay({ to: 'https://unrelated.com' })`
   * from triggering a silent x402 charge. See `routeHttpsWithOptIn` flow in
   * selectRequirements gate.
   */
  allowedHosts?: ReadonlyArray<string>;

  /**
   * Optional fetch override for tests. Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Default networks if allowedNetworks is undefined.
 *
 * Hand-maintained because @x402/core exposes `Network` as a structural string
 * pattern (`${string}:${string}`), not a canonical enum. Review on each
 * @x402/evm upgrade to keep in sync with upstream scheme support.
 */
const DEFAULT_EVM_NETWORKS: ReadonlyArray<string> = [
  'eip155:1', // Ethereum mainnet
  'eip155:8453', // Base mainnet
  'eip155:84532', // Base Sepolia
  'eip155:10', // Optimism
  'eip155:42161', // Arbitrum One
  'eip155:137', // Polygon
];

/**
 * Canonical USDC contract address per supported EVM network (CAIP-2 keys).
 *
 * Source: Circle's official deployment list as of 2026-04. Keep in sync with
 * `DEFAULT_EVM_NETWORKS`. Used as the default `allowedAssets` allowlist so
 * the adapter refuses to sign payments in any other token.
 *
 * Addresses stored lowercase so comparisons can use `.toLowerCase()` on
 * server-provided asset addresses directly.
 */
const DEFAULT_USDC_BY_NETWORK: Record<string, string> = {
  'eip155:1':     '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Ethereum USDC
  'eip155:8453':  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // Base Sepolia USDC
  'eip155:10':    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // Optimism USDC
  'eip155:42161': '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // Arbitrum USDC
  'eip155:137':   '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // Polygon USDC
};

/**
 * Internal record of a completed x402 payment, kept for `getStatus` lookups.
 */
interface X402PaymentRecord {
  txId: string;
  amount: bigint;
  network: string;
  payer: string;
  payTo: string;
  settledAt: number;
}

// ============================================================================
// X402Adapter
// ============================================================================

export class X402Adapter implements IAdapter {
  public readonly metadata: AdapterMetadata = {
    id: 'x402',
    name: 'x402 v2',
    usesEscrow: false,
    supportsDisputes: false,
    requiresIdentity: false,
    settlementMode: 'atomic', // x402 is stateless HTTP; settlement is atomic via facilitator
    priority: 70,
  };

  private readonly x402: InstanceType<typeof x402Client>;
  private readonly fetchWithPayment: typeof fetch;
  private readonly maxAmountPerTx: bigint;
  private readonly maxAuthorizationValidSec: number;
  /**
   * Cached resolved allowed-network list. Computed once at construction; used
   * on every selectRequirements call without re-running resolveAllowedNetworks.
   */
  private readonly allowedNetworks: ReadonlyArray<string>;

  /**
   * Cached lowercase set of allowed asset (token contract) addresses.
   * Undefined means user explicitly passed an empty array, which is our
   * sentinel for "any asset" (NOT recommended — skips the safety check).
   */
  private readonly allowedAssetsLc: ReadonlySet<string> | undefined;

  /**
   * Cached lowercase set of allowed host names. Empty means no host allowlist
   * (user must always opt in via metadata.paymentMethod for every URL).
   */
  private readonly allowedHostsLc: ReadonlySet<string>;

  /** network:tokenAddress → cached approved state */
  private readonly permit2ApprovedCache = new Set<string>();

  /** network:tokenAddress → in-flight approve promise (coalesces concurrent callers) */
  private readonly permit2InflightApprovals = new Map<string, Promise<void>>();

  /** Completed payment records for getStatus() lookups */
  private readonly payments = new Map<string, X402PaymentRecord>();

  constructor(private readonly config: X402AdapterConfig) {
    if (typeof config.walletProvider.signTypedData !== 'function') {
      throw new X402ConfigError(
        'X402Adapter requires a walletProvider with signTypedData() support. ' +
          'Both EOAWalletProvider and AutoWalletProvider implement this in @agirails/sdk@3.3.0+.'
      );
    }

    const signer = this.walletProviderToClientEvmSigner(config.walletProvider);
    const scheme = new ExactEvmScheme(signer);
    // I1: compute and cache allowed network list once — selectRequirements
    // runs on every payment, so we must avoid re-resolving per-call.
    this.allowedNetworks = resolveAllowedNetworks(config.allowedNetworks);

    // P1-1: resolve allowed assets. Undefined → canonical USDC per network.
    // Empty array → sentinel for "allow any asset" (explicit opt-out).
    // Non-empty array → user-provided override.
    if (config.allowedAssets === undefined) {
      const defaults = this.allowedNetworks
        .map((n) => DEFAULT_USDC_BY_NETWORK[n])
        .filter((a): a is string => typeof a === 'string');
      this.allowedAssetsLc = new Set(defaults.map((a) => a.toLowerCase()));
    } else if (config.allowedAssets.length === 0) {
      this.allowedAssetsLc = undefined; // sentinel: any asset
    } else {
      this.allowedAssetsLc = new Set(config.allowedAssets.map((a) => a.toLowerCase()));
    }

    // P1-3: resolve allowed hosts. Default empty = always require opt-in.
    this.allowedHostsLc = new Set(
      (config.allowedHosts ?? []).map((h) => h.toLowerCase())
    );

    // Build x402 client via fromConfig with all scheme registrations up front,
    // plus our paymentRequirementsSelector. Hook is registered on the returned
    // client instance (fromConfig does not take hooks).
    this.x402 = x402Client.fromConfig({
      schemes: this.allowedNetworks.map((network) => ({ network, client: scheme })),
      paymentRequirementsSelector: this.selectRequirements.bind(this),
    });

    // onBeforePaymentCreation hook runs AFTER selectRequirements picks a
    // requirement and BEFORE signing. We await Permit2 approve for Smart
    // Wallet buyers inside the hook — single roundtrip, no race.
    this.x402.onBeforePaymentCreation(this.beforePaymentCreationHook.bind(this));

    // Wrap global fetch with the configured x402Client. This yields a fetch
    // function that transparently retries on 402 with a signed payment payload.
    this.fetchWithPayment = wrapFetchWithPayment(
      config.fetchImpl ?? fetch,
      this.x402
    );

    // P1-3: hardened default cap lowered from $10 → $1. Reduces blast radius
    // of accidental `client.pay({to: 'https://...'})` calls. Users who need
    // higher caps must opt in explicitly via config.
    this.maxAmountPerTx = parseUsdcAmount(config.maxAmountPerTx ?? '1');
    this.maxAuthorizationValidSec = config.maxAuthorizationValidSec ?? 300;
  }

  // ==========================================================================
  // IAdapter implementation
  // ==========================================================================

  /**
   * STRICT HTTPS ONLY. `http://` is rejected at the canHandle level to prevent
   * MITM interception of signed payment payloads. Integration tests that need
   * localhost use a dedicated test flag (not exposed to end users).
   *
   * P1-3: canHandle returns true for any HTTPS URL so the router can select
   * this adapter, but `validate()` enforces explicit opt-in before payment
   * actually executes. This keeps the declarative "any HTTPS is x402-capable"
   * shape while protecting against accidental auto-pay.
   */
  canHandle(params: UnifiedPayParams): boolean {
    return /^https:\/\//i.test(params.to);
  }

  validate(params: UnifiedPayParams): void {
    if (!params.to || typeof params.to !== 'string') {
      throw new X402ConfigError('x402: params.to must be a non-empty string URL');
    }
    if (!this.canHandle(params)) {
      throw new X402ConfigError(
        `x402: refusing non-HTTPS target ${params.to}. Only https:// URLs are supported ` +
          `to prevent MITM interception of signed payment payloads.`
      );
    }

    // P1-3: Explicit opt-in gate. A URL is allowed to trigger a payment only if:
    //   (a) caller set `metadata.paymentMethod === 'x402'`, OR
    //   (b) the target host is in the allowedHosts allowlist.
    // Without one of these, throw so an accidental `client.pay({to: 'https://...'})`
    // call doesn't silently cost money.
    const explicitOptIn = params.metadata?.paymentMethod === 'x402';
    let hostAllowed = false;
    if (this.allowedHostsLc.size > 0) {
      try {
        const host = new URL(params.to).hostname.toLowerCase();
        hostAllowed = this.allowedHostsLc.has(host);
      } catch {
        // fall through — invalid URL will surface below
      }
    }

    if (!explicitOptIn && !hostAllowed) {
      throw new X402ConfigError(
        `x402: refusing to auto-pay ${params.to}. HTTPS URLs trigger x402 payments ` +
          `only when the caller explicitly opts in. Either:\n` +
          `  (a) pass metadata: { paymentMethod: 'x402' } to client.pay(), or\n` +
          `  (b) add the host to X402AdapterConfig.allowedHosts.\n` +
          `This safeguard prevents accidental charges from unrelated HTTPS calls.`
      );
    }
  }

  async pay(params: UnifiedPayParams): Promise<UnifiedPayResult> {
    this.validate(params);

    sdkLogger.debug('x402 payment attempt', { to: params.to });

    let res: Response;
    try {
      const method = params.httpMethod ?? 'GET';
      const headers: Record<string, string> = { accept: 'application/json' };
      if (params.httpHeaders) {
        Object.assign(headers, params.httpHeaders);
      }
      if (params.httpBody && !headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = 'application/json';
      }
      const fetchInit: RequestInit = { method, headers };
      if (params.httpBody && method !== 'GET' && method !== 'DELETE') {
        fetchInit.body = params.httpBody;
      }
      res = await this.fetchWithPayment(params.to, fetchInit);
    } catch (e) {
      // Hook aborts bubble up here as "Payment creation aborted: {reason}"
      if (e instanceof Error && /aborted/i.test(e.message)) {
        throw new X402PaymentFailedError(
          `x402 payment aborted before signing: ${e.message}`
        );
      }
      throw new X402PaymentFailedError(
        `x402 payment failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    if (!res.ok) {
      throw new X402PaymentFailedError(
        `x402 payment returned HTTP ${res.status} ${res.statusText}`
      );
    }

    const responseHeader = res.headers.get('payment-response');
    return await this.mapToPayResult(res, responseHeader, params);
  }

  async getStatus(txId: string): Promise<TransactionStatus> {
    const record = this.payments.get(txId);
    if (!record) {
      throw new Error(
        `x402 payment ${txId} not found. x402 payments are atomic and stateless; ` +
          `only payments made through this adapter instance are tracked.`
      );
    }

    // B4: state consistency — pay() returns `UnifiedPayResult.state = 'COMMITTED'`
    // (the type only allows 'COMMITTED' | 'IN_PROGRESS'), so getStatus() must
    // also return 'COMMITTED' for the same tx. Despite the name, for x402 this
    // COMMITTED is effectively SETTLED — facilitator has confirmed on-chain
    // settlement by the time mapToPayResult writes the record here, so there's
    // no work-in-progress phase to worry about. Callers should NOT interpret
    // 'COMMITTED' on an x402 record as "waiting for provider" — release is
    // not required and lifecycle methods throw.
    return {
      state: 'COMMITTED' as AdapterTransactionState,
      canStartWork: false,
      canDeliver: false,
      canRelease: false,
      canDispute: false,
      amount: formatUsdcAmount(record.amount),
      provider: record.payTo,
      requester: record.payer,
    };
  }

  async startWork(_txId: string): Promise<void> {
    throw new Error(
      'x402 is stateless — no lifecycle methods. ' +
        'The HTTP response IS the delivery. Use ACTP adapters for stateful transactions.'
    );
  }

  async deliver(_txId: string, _proof?: string): Promise<void> {
    throw new Error(
      'x402 is stateless — no lifecycle methods. ' +
        'The HTTP response IS the delivery. Use ACTP adapters for stateful transactions.'
    );
  }

  async release(_escrowId: string, _attestationUID?: string): Promise<void> {
    throw new Error(
      'x402 has no escrow to release — payment settles instantly via the facilitator. ' +
        'Use ACTP adapters for escrow-based transactions.'
    );
  }

  // ==========================================================================
  // @x402 hook + selector
  // ==========================================================================

  /**
   * Registered as `onBeforePaymentCreation` hook on the x402Client in the
   * constructor. Runs AFTER selectRequirements has chosen a target and BEFORE
   * the scheme client signs the payload.
   *
   * For Smart Wallet + Permit2 flow, this is where we ensure the one-time
   * Permit2 approve has been submitted and confirmed. The hook is awaited by
   * @x402/core's createPaymentPayload, so we can block signing until the
   * approve lands — no double roundtrip, no race.
   *
   * Return `{ abort: true, reason }` to cancel the payment cleanly.
   */
  private async beforePaymentCreationHook(
    ctx: BeforePaymentCreationContext
  ): Promise<void | { abort: true; reason: string }> {
    const walletInfo = this.config.walletProvider.getWalletInfo();
    if (walletInfo.tier !== 'auto') return; // EOA doesn't need Permit2 approve
    if (this.config.autoApprovePermit2 === false) return;

    const reqs = ctx.selectedRequirements;
    const method = (reqs.extra as Record<string, unknown> | undefined)
      ?.assetTransferMethod;
    if (method !== 'permit2') return; // EIP-3009 path doesn't need approve

    try {
      await this.ensurePermit2Approved(reqs.network, reqs.asset);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sdkLogger.warn('x402 Permit2 approve failed, aborting payment', { error: msg });
      return {
        abort: true,
        reason: msg,
      };
    }
  }

  /**
   * Registered as `paymentRequirementsSelector` on the x402Client.
   * Called after server's payment-required is parsed, before signing.
   *
   * Picks the best requirement from `accepts[]` based on:
   *   1. scheme === "exact" AND network in our allowlist
   *   2. Wallet tier: Smart Wallet prefers Permit2, EOA prefers EIP-3009
   *   3. Amount within maxAmountPerTx safety cap
   *   4. Clamps maxTimeoutSeconds to maxAuthorizationValidSec (MEV cap)
   */
  private selectRequirements(
    _version: number,
    requirements: ReadonlyArray<PaymentRequirements>
  ): PaymentRequirements {
    const allowed = this.allowedNetworks; // I1: cached

    // P1-1: filter by scheme + network + asset. Asset check rejects any
    // token that's not in our allowlist (canonical USDC per chain by default).
    // Without this, a malicious or misconfigured server could advertise
    // USDT/DAI/scam-token and we'd sign a payment with wrong decimals,
    // bypassing the maxAmountPerTx cap silently.
    const candidates = requirements.filter((r) => {
      if (r.scheme !== 'exact') return false;
      if (!allowed.includes(r.network)) return false;
      if (this.allowedAssetsLc && typeof r.asset === 'string') {
        if (!this.allowedAssetsLc.has(r.asset.toLowerCase())) return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      const seen = requirements
        .map((r) => `${r.scheme}@${r.network}(${(r.asset ?? '').slice(0, 10)}...)`)
        .join(', ');
      const assetInfo = this.allowedAssetsLc
        ? `, allowed assets: [${[...this.allowedAssetsLc].map((a) => a.slice(0, 10) + '...').join(', ')}]`
        : '';
      throw new X402NetworkNotAllowedError(
        `x402: no accepted requirement. Server offered [${seen}], ` +
          `allowed networks: [${allowed.join(', ')}]${assetInfo}.`
      );
    }

    // Wallet-tier-aware ordering
    const walletInfo = this.config.walletProvider.getWalletInfo();
    const isPermit2 = (r: PaymentRequirements): boolean =>
      (r.extra as Record<string, unknown> | undefined)?.assetTransferMethod === 'permit2';

    const prioritized =
      walletInfo.tier === 'auto'
        ? [...candidates].sort((a, b) => Number(isPermit2(b)) - Number(isPermit2(a)))
        : candidates;

    // Smart Wallet + no Permit2 = unsupported, fail early with clear message
    if (walletInfo.tier === 'auto' && !prioritized.some(isPermit2)) {
      throw new X402UnsupportedWalletError(
        `x402: Smart Wallet cannot pay this endpoint. Server only offers EIP-3009, ` +
          `which requires the USDC holder to be an EOA. Either use a Tier 2 (EOA) wallet ` +
          `for this endpoint, or ask the server operator to advertise Permit2 support ` +
          `(extra.assetTransferMethod = "permit2").`
      );
    }

    const chosen = prioritized[0];
    const amountBig = BigInt(chosen.amount);
    if (amountBig > this.maxAmountPerTx) {
      throw new X402AmountExceededError(
        `x402: required amount ${chosen.amount} (${formatUsdcAmount(amountBig)} USD) ` +
          `exceeds maxAmountPerTx ${this.maxAmountPerTx.toString()} ` +
          `(${this.config.maxAmountPerTx ?? '1'} USD).`
      );
    }

    // MEV hard cap on authorization validity
    const serverTimeout = chosen.maxTimeoutSeconds ?? this.maxAuthorizationValidSec;
    return {
      ...chosen,
      maxTimeoutSeconds: Math.min(serverTimeout, this.maxAuthorizationValidSec),
    };
  }

  // ==========================================================================
  // Permit2 approve (lazy, one-time, coalesced)
  // ==========================================================================

  private async ensurePermit2Approved(network: string, token: string): Promise<void> {
    const key = `${network}:${token.toLowerCase()}`;
    if (this.permit2ApprovedCache.has(key)) return;

    // Coalesce concurrent calls for the same (network, token).
    // B1 fix: register the inflight promise BEFORE the IIFE's first await
    // so concurrent callers that arrive mid-construction see it and wait
    // instead of launching a duplicate approve.
    const inflight = this.permit2InflightApprovals.get(key);
    if (inflight) return await inflight;

    const doApprove = async (): Promise<void> => {
      try {
        // P1-2: check on-chain allowance BEFORE sending approve. The in-memory
        // `permit2ApprovedCache` is only a fast path — after a process restart
        // or horizontal scale, the cache is empty but the on-chain allowance
        // may already be set from a prior run. Without this check we'd pay
        // for the approve again.
        const alreadyApproved = await this.readPermit2AllowanceIsSet(token);
        if (alreadyApproved) {
          this.permit2ApprovedCache.add(key);
          sdkLogger.debug('x402 Permit2 approve: allowance already set on-chain, skipping', {
            network,
            token,
          });
          return;
        }

        sdkLogger.info('x402 Permit2 approve: submitting one-time USDC approve', {
          network,
          token,
        });

        // Verified v4.2 spike: createPermit2ApprovalTx takes positional
        // tokenAddress (0x${string}), returns { to, data, value? }.
        const approvalTx = createPermit2ApprovalTx(token as `0x${string}`);

        await this.config.walletProvider.sendTransaction({
          to: approvalTx.to,
          data: approvalTx.data,
          value: '0',
        });

        this.permit2ApprovedCache.add(key);
        sdkLogger.info('x402 Permit2 approve confirmed', { network, token });
      } catch (e) {
        if (isPaymasterGateError(e)) {
          throw new X402PublishRequiredError();
        }
        throw new X402ApprovalFailedError(
          `Permit2 approve failed for ${network}:${token}: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      } finally {
        this.permit2InflightApprovals.delete(key);
      }
    };

    // Register BEFORE invoking — Promise constructor is synchronous so any
    // concurrent caller that polls `.get(key)` after this line sees it.
    const approvalPromise = doApprove();
    this.permit2InflightApprovals.set(key, approvalPromise);
    return await approvalPromise;
  }

  /**
   * P1-2: Read `USDC.allowance(smartWallet, PERMIT2_ADDRESS)` via the wallet
   * provider's read provider and return true if already >= a sensible threshold
   * (half of max uint256 — Permit2 approves are typically MAX_UINT256).
   *
   * Returns false if the wallet provider doesn't expose a read provider
   * (older wallet implementations) — callers then fall back to submitting
   * the approve unconditionally, which is the safe (but slightly wasteful)
   * default.
   *
   * Uses eth_call with the standard ERC-20 allowance ABI selector to avoid
   * pulling in additional contract ABIs.
   */
  private async readPermit2AllowanceIsSet(token: string): Promise<boolean> {
    if (typeof this.config.walletProvider.getReadProvider !== 'function') {
      return false; // no read capability — submit approve unconditionally
    }
    const rawProvider = this.config.walletProvider.getReadProvider();
    // Duck-type: ethers v6 provider has `.call({to, data}): Promise<string>`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providerAny = rawProvider as any;
    if (!providerAny || typeof providerAny.call !== 'function') return false;

    // ERC-20 allowance(address owner, address spender) — selector 0xdd62ed3e
    const owner = this.config.walletProvider.getAddress().toLowerCase().replace(/^0x/, '');
    const spender = PERMIT2_ADDRESS.toLowerCase().replace(/^0x/, '');
    const data =
      '0xdd62ed3e' +
      owner.padStart(64, '0') +
      spender.padStart(64, '0');

    try {
      const result: string = await providerAny.call({ to: token, data });
      if (!result || result === '0x') return false;
      const allowance = BigInt(result);
      // Permit2 approve is typically MAX_UINT256. Treat any value above
      // half-max as "already approved" to tolerate partial-spend scenarios.
      const THRESHOLD = (1n << 255n);
      return allowance >= THRESHOLD;
    } catch (e) {
      sdkLogger.debug('x402 allowance read failed, falling back to submit', {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  // ==========================================================================
  // Response mapping
  // ==========================================================================

  private async mapToPayResult(
    res: Response,
    paymentResponseHeader: string | null,
    params: UnifiedPayParams
  ): Promise<UnifiedPayResult> {
    // FIX v4.1: missing payment-response header is NOT silent success.
    // x402 spec: facilitator sets this header ONLY after on-chain settlement
    // is confirmed. Without it we have no settlement proof — reorg, pending
    // mempool, facilitator bug, or malicious server could all be causes.
    if (!paymentResponseHeader) {
      throw new X402SettlementProofMissingError();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let decoded: any;
    try {
      decoded = decodePaymentResponseHeader(paymentResponseHeader);
    } catch (e) {
      throw new X402SettlementProofMissingError(
        `Failed to decode payment-response header: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }

    const rawTxHash: string | undefined = decoded?.transaction;
    const rawNetwork: string | undefined = decoded?.network;
    const rawPayer: string | undefined = decoded?.payer;
    const payTo: string | undefined = decoded?.payTo;
    const amount = decoded?.amount;

    // P1: Validate critical settlement proof fields instead of falling back
    // to empty values. Without a valid tx hash we have no on-chain proof.
    const missing: string[] = [];
    if (!rawTxHash || !/^0x[0-9a-f]{64}$/i.test(rawTxHash)) missing.push('transaction');
    if (!rawNetwork) missing.push('network');
    if (!rawPayer || !/^0x[0-9a-f]{40}$/i.test(rawPayer)) missing.push('payer');
    if (missing.length > 0) {
      throw new X402SettlementProofMissingError(
        `payment-response header decoded but missing/invalid fields: ${missing.join(', ')}. ` +
          `Decoded values: transaction=${rawTxHash ?? 'undefined'}, network=${rawNetwork ?? 'undefined'}, ` +
          `payer=${rawPayer ?? 'undefined'}. Do not treat as settled.`
      );
    }

    // After validation gate, these are guaranteed non-undefined.
    const txHash = rawTxHash as string;
    const network = rawNetwork as string;
    const payer = rawPayer as string;
    const amountBig = safeBigInt(amount ?? '0');

    this.payments.set(txHash, {
      txId: txHash,
      amount: amountBig,
      network,
      payer,
      payTo: payTo ?? '',
      settledAt: Date.now(),
    });

    sdkLogger.info('x402 settlement confirmed', {
      txHash,
      network,
      amount: String(amount ?? '0'),
    });

    return {
      txId: txHash,
      escrowId: null,
      adapter: 'x402',
      state: 'COMMITTED',
      success: true,
      amount: formatUsdcAmount(amountBig),
      response: res,
      releaseRequired: false,
      provider: payTo || params.to,
      requester: payer,
      deadline: new Date(Date.now() + this.maxAuthorizationValidSec * 1000).toISOString(),
      erc8004AgentId: params.erc8004AgentId,
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Bridge our IWalletProvider.signTypedData to @x402/evm's ClientEvmSigner
   * structural type. Only `address` + `signTypedData` are required for the
   * `exact` scheme flow we use.
   *
   * B3: no outer try/catch here — each IWalletProvider implementation is the
   * error-converting boundary and already throws X402SignatureFailedError on
   * failure. Wrapping here would produce double-nested error messages like
   * "walletProvider.signTypedData failed: EOA signTypedData failed: ...".
   */
  private walletProviderToClientEvmSigner(wp: IWalletProvider): ClientEvmSigner {
    return {
      address: wp.getAddress() as `0x${string}`,
      async signTypedData(params) {
        const typedData: EIP712TypedData = {
          domain: params.domain as Record<string, unknown>,
          types: params.types as Record<
            string,
            Array<{ name: string; type: string }>
          >,
          primaryType: params.primaryType,
          message: params.message as Record<string, unknown>,
        };
        const sig = await wp.signTypedData!(typedData);
        return sig as `0x${string}`;
      },
    };
  }
}

// ============================================================================
// Local helpers
// ============================================================================

/**
 * Parse human-readable USD amount like "10" or "0.50" to USDC 6-decimal bigint.
 */
function parseUsdcAmount(usd: string): bigint {
  const trimmed = usd.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new X402ConfigError(
      `Invalid maxAmountPerTx "${usd}" — must be a non-negative decimal with at most 6 digits after the point.`
    );
  }
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole + fracPadded);
}

/**
 * Format USDC 6-decimal bigint back to human-readable USD string.
 */
function formatUsdcAmount(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Resolve the effective allowed-network list. Undefined / empty user config
 * means "allow all EVM networks @x402/evm supports" — maximal interop default.
 */
function resolveAllowedNetworks(
  allowed?: ReadonlyArray<string>
): ReadonlyArray<string> {
  if (allowed && allowed.length > 0) return allowed;
  return DEFAULT_EVM_NETWORKS;
}

/**
 * Parse any reasonable amount representation (raw int string, decimal string,
 * bigint, or number) into a USDC 6-decimal bigint.
 *
 * B2 fix: the previous version rejected decimal strings (regex `^\d+$`) and
 * silently returned 0n, which caused zero-amount records when a facilitator
 * reported settlement amounts like `"0.01"` instead of `"10000"`.
 *
 * Behavior:
 *   - "10000"   → 10000n (raw 6-decimal)
 *   - "0.01"    → 10000n (parsed as USD, normalized to 6 decimals)
 *   - "10"      → 10000000n (treated as whole-USD if no decimal)
 *   - number 5  → 5000000n
 *   - 5n        → 5n (bigint passed through)
 *
 * Ambiguity warning: a bare integer string like "10" could be either raw
 * 6-decimal (0.00001 USDC) or whole USD (10 USDC). We use a heuristic: if
 * the string contains a decimal point, parse as USD. Otherwise parse as raw.
 * This matches the x402 spec which uses raw 6-decimal strings consistently.
 */
function safeBigInt(v: unknown): bigint {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v < 0) return 0n;
      // Whole number: treat as raw 6-decimal (spec-compliant shape)
      if (Number.isInteger(v)) return BigInt(v);
      // Decimal number: treat as USD, convert to 6-decimal
      return parseUsdcAmount(v.toString());
    }
    if (typeof v === 'string') {
      const trimmed = v.trim().replace(/^\$/, '');
      if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
      if (/^\d+\.\d{1,6}$/.test(trimmed)) return parseUsdcAmount(trimmed);
    }
  } catch {
    // fall through
  }
  return 0n;
}
