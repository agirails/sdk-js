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

declare module '@x402/core/http' {
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

declare module '@x402/core/client' {
  export * from '@x402/fetch';
}
