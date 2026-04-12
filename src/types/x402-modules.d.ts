/**
 * Minimal ambient module declarations for @x402/* packages.
 *
 * Workaround for upstream packaging bug: `@x402/fetch`, `@x402/evm`, and
 * `@x402/core` ship .d.ts files at `dist/cjs/index.d.ts` and expose them via
 * `package.json#exports` "types" subkey, but TypeScript's classic "node"
 * module resolution doesn't read exports maps. The top-level `types` field
 * in upstream `package.json` points to `./dist/index.d.ts` which does not
 * exist, causing TS2307 errors.
 *
 * Rather than switch our whole project to `moduleResolution: "node16"` (which
 * would ripple through hundreds of existing imports), we declare the minimal
 * surface we need here. Shapes are verified against the published tarballs
 * during the x402 integration spike (2026-04-11).
 *
 * When upstream fixes their manifest, this file can be deleted.
 *
 * @module types/x402-modules
 */

declare module '@x402/fetch' {
  export type PaymentRequirements = {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
    [key: string]: unknown;
  };

  export type PaymentRequired = {
    x402Version: number;
    accepts: PaymentRequirements[];
    error?: string;
    [key: string]: unknown;
  };

  export type PaymentResponse = {
    transaction?: string;
    network?: string;
    amount?: string;
    payer?: string;
    payTo?: string;
    [key: string]: unknown;
  };

  export type PaymentPayload = {
    x402Version: number;
    payload: unknown;
    [key: string]: unknown;
  };

  export type SchemeRegistration = {
    network: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any;
    x402Version?: number;
  };

  export type BeforePaymentCreationContext = {
    paymentRequired: PaymentRequired;
    selectedRequirements: PaymentRequirements;
  };

  export type BeforePaymentCreationHook = (
    ctx: BeforePaymentCreationContext
  ) => Promise<void | { abort: true; reason: string }>;

  export type SelectPaymentRequirements = (
    x402Version: number,
    requirements: ReadonlyArray<PaymentRequirements>
  ) => PaymentRequirements;

  export type x402ClientConfig = {
    schemes?: SchemeRegistration[];
    paymentRequirementsSelector?: SelectPaymentRequirements;
  };

  export class x402Client {
    static fromConfig(config: x402ClientConfig): x402Client;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register(network: string, client: any): x402Client;
    onBeforePaymentCreation(hook: BeforePaymentCreationHook): x402Client;
    createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload>;
  }

  export class x402HTTPClient {
    constructor(client: x402Client);
  }

  export function wrapFetchWithPayment(
    fetch: typeof globalThis.fetch,
    client: x402Client | x402HTTPClient
  ): typeof globalThis.fetch;

  export function wrapFetchWithPaymentFromConfig(
    fetch: typeof globalThis.fetch,
    config: x402ClientConfig
  ): typeof globalThis.fetch;

  export function decodePaymentResponseHeader(header: string): PaymentResponse;
}

declare module '@x402/evm' {
  export type ClientEvmSigner = {
    readonly address: `0x${string}`;
    signTypedData(params: {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`>;
  };

  export class ExactEvmScheme {
    readonly scheme: 'exact';
    constructor(signer: ClientEvmSigner);
    createPaymentPayload(
      x402Version: number,
      paymentRequirements: unknown,
      context?: unknown
    ): Promise<unknown>;
  }

  export function createPermit2ApprovalTx(tokenAddress: `0x${string}`): {
    to: string;
    data: string;
    value?: string;
  };

  export const PERMIT2_ADDRESS: `0x${string}`;
  export const x402ExactPermit2ProxyAddress: `0x${string}`;
}

declare module '@x402/core/client' {
  export * from '@x402/fetch';
}

// ---------------------------------------------------------------------------
// Server-side ambient declarations (Blok B — seller middleware)
// ---------------------------------------------------------------------------

declare module '@x402/core/server' {
  export interface FacilitatorConfig {
    url?: string;
    createAuthHeaders?: () => Promise<{
      verify: Record<string, string>;
      settle: Record<string, string>;
      supported: Record<string, string>;
    }>;
  }

  export interface FacilitatorClient {
    verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
    settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
    getSupported(): Promise<unknown>;
  }

  export class HTTPFacilitatorClient implements FacilitatorClient {
    readonly url: string;
    constructor(config?: FacilitatorConfig);
    verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
    settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
    getSupported(): Promise<unknown>;
  }

  export class x402ResourceServer {
    constructor(facilitatorClients?: FacilitatorClient | FacilitatorClient[]);
    register(network: string, server: unknown): x402ResourceServer;
    hasRegisteredScheme(network: string, scheme: string): boolean;
    registerExtension(extension: unknown): this;
    onBeforeVerify(hook: unknown): x402ResourceServer;
    onAfterVerify(hook: unknown): x402ResourceServer;
    onBeforeSettle(hook: unknown): x402ResourceServer;
    onAfterSettle(hook: unknown): x402ResourceServer;
    initialize(): Promise<void>;
    verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
    settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
    enhancePaymentRequirements(
      requirements: unknown,
      supportedKinds: unknown,
      extensionKeys: unknown
    ): Promise<unknown>;
  }
}

declare module '@x402/core/http' {
  // Re-export everything from existing declaration above plus server types
  import { x402ResourceServer } from '@x402/core/server';

  export interface PaymentOption {
    scheme: string;
    payTo: string | ((context: unknown) => string | Promise<string>);
    price: string | number | { amount: string; asset: string };
    network: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  }

  export interface RouteConfig {
    accepts: PaymentOption | PaymentOption[];
    resource?: string;
    description?: string;
    mimeType?: string;
    customPaywallHtml?: string;
    unpaidResponseBody?: unknown;
    settlementFailedResponseBody?: unknown;
    extensions?: Record<string, unknown>;
  }

  export type RoutesConfig = Record<string, RouteConfig> | RouteConfig;

  export interface HTTPResponseInstructions {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
    isHtml?: boolean;
  }

  export interface HTTPRequestContext {
    adapter: unknown;
    path: string;
    method: string;
    paymentHeader?: string;
    routePattern?: string;
  }

  export type HTTPProcessResult =
    | { type: 'no-payment-required' }
    | { type: 'payment-verified'; paymentPayload: unknown; paymentRequirements: unknown }
    | { type: 'payment-error'; response: HTTPResponseInstructions };

  export class x402HTTPResourceServer {
    constructor(resourceServer: x402ResourceServer, routes: RoutesConfig);
    get server(): x402ResourceServer;
    get routes(): RoutesConfig;
    initialize(): Promise<void>;
    processHTTPRequest(
      context: HTTPRequestContext,
      paywallConfig?: unknown
    ): Promise<HTTPProcessResult>;
    processSettlement(
      paymentPayload: unknown,
      requirements: unknown,
      declaredExtensions?: unknown,
      transportContext?: unknown,
      settlementOverrides?: unknown
    ): Promise<unknown>;
    requiresPayment(context: HTTPRequestContext): boolean;
  }

  export function decodePaymentRequiredHeader(header: string): {
    x402Version: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accepts: any[];
    [key: string]: unknown;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function decodePaymentResponseHeader(header: string): any;

  export function encodePaymentRequiredHeader(payload: unknown): string;
  export function encodePaymentResponseHeader(payload: unknown): string;
}

declare module '@x402/evm/exact/server' {
  import { x402ResourceServer } from '@x402/core/server';

  export interface EvmResourceServerConfig {
    networks?: string[];
  }

  export class ExactEvmScheme {
    readonly scheme: 'exact';
    registerMoneyParser(parser: unknown): ExactEvmScheme;
    getAssetDecimals(asset: string, network: string): number;
    parsePrice(price: unknown, network: string): Promise<{ amount: string; asset: string }>;
    enhancePaymentRequirements(
      requirements: unknown,
      supportedKind: unknown,
      extensionKeys: string[]
    ): Promise<unknown>;
  }

  export function registerExactEvmScheme(
    server: x402ResourceServer,
    config?: EvmResourceServerConfig
  ): x402ResourceServer;
}
