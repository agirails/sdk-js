/**
 * x402 v2 protocol errors.
 *
 * All extend ACTPError for consistency with the rest of the SDK error
 * hierarchy. Users can catch any x402 error with `catch (e instanceof X402Error)`,
 * catch any SDK error with `catch (e instanceof ACTPError)`, or catch specific
 * failure modes with the subclass types.
 *
 * @module errors/X402Errors
 */

import { ACTPError } from './ACTPError';

/**
 * Base class for all x402-related errors.
 * Catch this to handle any x402 failure in one clause.
 */
export class X402Error extends ACTPError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, code, undefined, details);
    this.name = 'X402Error';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when X402Adapter constructor receives invalid config.
 *
 * Most common cause: walletProvider does not implement the optional
 * `signTypedData()` method that x402 v2 requires for EIP-712 signing.
 *
 * @cause x402 adapter configuration is missing or invalid (no wallet, no recipient address, malformed scheme).
 * @fix Read the error `details` for the specific config gap. See /recipes/per-call-api for canonical setup.
 * @recovery user-action
 */
export class X402ConfigError extends X402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'X402_CONFIG_ERROR', details);
    this.name = 'X402ConfigError';
  }
}

/**
 * Thrown when paymaster rejects sponsored tx because agent isn't published
 * in AgentRegistry. The one-time Permit2 approve needed to enable Smart Wallet
 * x402 payments requires the agent to pass the paymaster policy gate.
 *
 * @cause Attempted x402 settlement before publishing the agent (no AgentID, no AgentRegistry entry).
 * @fix Run `actp publish` to register the agent. See /recipes/keystore-and-deployment.
 * @recovery user-action
 */
export class X402PublishRequiredError extends X402Error {
  constructor() {
    super(
      'Paymaster rejected gas sponsorship because this agent is not published.\n' +
        'Run `actp publish` to activate sponsorship, then retry your payment.\n' +
        '(One-time setup — subsequent x402 payments will work automatically.)',
      'X402_PUBLISH_REQUIRED'
    );
    this.name = 'X402PublishRequiredError';
  }
}

/**
 * Thrown when a Smart Wallet tries to pay a server that only offers
 * the EIP-3009 transferWithAuthorization scheme.
 *
 * USDC `transferWithAuthorization` requires the signer to be the token
 * holder, and it does NOT delegate to ERC-1271 for contract wallets.
 * Smart Wallets must use the Permit2 path, which the server must advertise
 * by setting `extra.assetTransferMethod = "permit2"` in payment requirements.
 *
 * @cause Configured wallet provider does not implement the EIP-3009 typed-data signing required by x402, or the server only offers EIP-3009 (not Permit2) and the wallet is a Smart Wallet.
 * @fix Switch to `wallet=auto` (Coinbase Smart Wallet supports it via Permit2) or use an EOA wallet that implements `signTypedData_v4` per EIP-712. Or ask the server to advertise Permit2.
 * @recovery user-action
 */
export class X402UnsupportedWalletError extends X402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'X402_UNSUPPORTED_WALLET', details);
    this.name = 'X402UnsupportedWalletError';
  }
}

/**
 * Thrown when the server's payment-required response offers no network
 * that the client's `allowedNetworks` configuration accepts.
 *
 * @cause x402 v2 only supports mainnet on AGIRAILS; attempted use on testnet or mock.
 * @fix Switch network to `mainnet`, or use ACTP escrow on testnet for development.
 * @recovery user-action
 */
export class X402NetworkNotAllowedError extends X402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'X402_NETWORK_NOT_ALLOWED', details);
    this.name = 'X402NetworkNotAllowedError';
  }
}

/**
 * Thrown when the server's required payment amount exceeds the client's
 * `maxAmountPerTx` safety cap. Default cap is $1 USDC.
 *
 * @cause x402 server-issued price exceeds the consumer's max acceptable amount (per `pay()` config or app guard).
 * @fix Raise `maxAmountPerTx`, or treat the call as too expensive and route to ACTP escrow with negotiated pricing.
 * @recovery user-action
 */
export class X402AmountExceededError extends X402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'X402_AMOUNT_EXCEEDED', details);
    this.name = 'X402AmountExceededError';
  }
}

/**
 * Thrown when the one-time Permit2 approve transaction fails for any reason
 * other than paymaster gate (which throws X402PublishRequiredError instead).
 *
 * @cause USDC `transferWithAuthorization` (EIP-3009) authorization step failed. Common: signature replay, expired authorization, or insufficient balance.
 * @fix Re-sign with a fresh nonce; check USDC balance; verify the EIP-3009 typed-data domain matches Base mainnet.
 * @recovery retry-safe
 */
export class X402ApprovalFailedError extends X402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'X402_APPROVAL_FAILED', details);
    this.name = 'X402ApprovalFailedError';
  }
}

/**
 * Thrown when walletProvider.signTypedData() fails to produce a signature.
 *
 * @cause EIP-712 typed-data signing of the x402 payment authorization failed at the wallet provider level.
 * @fix Confirm the wallet's chainId matches the network. For `wallet=auto`, ensure the keystore is loaded and the Smart Wallet is registered.
 * @recovery must-investigate
 */
export class X402SignatureFailedError extends X402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'X402_SIGNATURE_FAILED', details);
    this.name = 'X402SignatureFailedError';
  }
}

/**
 * Thrown when HTTP payment completes (200 OK) but the server did not return
 * a `payment-response` header confirming on-chain settlement.
 *
 * Per x402 v2 spec, facilitator sets this header ONLY after settlement is
 * mined and confirmed. Absence means the payment is UNCONFIRMED. It may have
 * been lost to a reorg, stuck in mempool, or the facilitator/server may be
 * misbehaving. Do not treat as success.
 *
 * @cause x402 settlement attempted but the prior payment authorization proof isn't on file (server lost state, replayed stale request, or facilitator/server misbehavior).
 * @fix Re-initiate the payment flow from `pay()` with a new authorization. Verify the settlement on-chain via tx hash before treating as final. State is per-request, not persisted across SDK reboots.
 * @recovery retry-safe
 */
export class X402SettlementProofMissingError extends X402Error {
  constructor(message?: string) {
    super(
      message ??
        'Server returned 200 but no `payment-response` header. Settlement is ' +
          'unconfirmed. This may indicate reorg, facilitator failure, or protocol mismatch. ' +
          'Do not consider the payment final without on-chain verification.',
      'X402_SETTLEMENT_PROOF_MISSING'
    );
    this.name = 'X402SettlementProofMissingError';
  }
}

/**
 * Thrown when the payment attempt returns a non-2xx HTTP status after
 * signing and submitting the payment payload.
 *
 * @cause x402 transfer transaction failed on-chain (revert during USDC transfer step) or server returned non-2xx.
 * @fix Read the tx hash from error details, inspect on Basescan. Often: balance check failed, recipient invalid, or paymaster rejected sponsorship.
 * @recovery must-investigate
 */
export class X402PaymentFailedError extends X402Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'X402_PAYMENT_FAILED', details);
    this.name = 'X402PaymentFailedError';
  }
}

/**
 * Helper: detect whether an error from the wallet provider indicates the
 * paymaster policy gate (agent not published / not allowlisted / quota).
 *
 * Used by X402Adapter.ensurePermit2Approved to convert generic paymaster
 * errors into the more actionable X402PublishRequiredError.
 *
 * Pattern verified in PaymasterClient.ts:112 which throws messages like:
 *   "Gas sponsorship unavailable: {upstream error}"
 *   "Gas sponsorship temporarily unavailable — both Coinbase and Pimlico paymasters failed"
 */
export function isPaymasterGateError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /gas sponsorship|paymaster|policy|sponsorship|unauthorized/i.test(e.message);
}
