# Changelog

## [3.3.0] — 2026-04-11

> **BREAKING CHANGE**: `X402Adapter` constructor signature completely changed.
> If you manually construct `new X402Adapter(...)` anywhere in your code, you
> MUST update it before upgrading. See migration section below.
> If you only call `client.pay(...)`, no changes needed — X402Adapter is now
> auto-registered.

### Breaking
- `X402Adapter` rewritten as thin wrapper around official `@x402/fetch` + `@x402/evm` packages for real x402 v2 protocol support. The adapter now speaks the actual x402 v2 wire protocol (payment-required header, EIP-3009/Permit2 signing, CAIP-2 networks) instead of the prior custom AGIRAILS HTTP payment flow.
- `X402AdapterConfig` shape — constructor now takes `{ walletProvider, allowedNetworks?, maxAmountPerTx?, autoApprovePermit2?, maxAuthorizationValidSec?, allowedAssets?, allowedHosts? }` instead of prior `{ requesterAddress, expectedNetwork, transferFn, feeCollector, ... }`.
- `UnifiedPayParams.amount` is now optional. For x402 URL targets the field is ignored (amount comes from server's payment-required response); for ACTP address targets the field is still required.

### Added
- Auto-registration: `X402Adapter` is automatically registered on `ACTPClient` when walletProvider is present. No need to call `registerAdapter()` manually.
- Full x402 v2 protocol support with real wire format, EIP-3009 + Permit2 flows.
- Smart Wallet buyer support via Permit2 path (ERC-1271 + ERC-6492).
- `@agirails/sdk/server` subpath with `buildX402Server()` framework-agnostic helper for seller-side x402 middleware setup.
- `UnifiedPayParams.httpMethod`, `httpBody`, `httpHeaders` for x402 paid POST/PUT/PATCH endpoints.
- Adapter-aware `client.getStatus()` routing — correctly delegates to the adapter that handled the payment.
- Payment-response validation: `mapToPayResult` validates tx hash, network, and payer before returning success.
- Error class taxonomy: `X402Error`, `X402ConfigError`, `X402PublishRequiredError`, `X402UnsupportedWalletError`, `X402NetworkNotAllowedError`, `X402AmountExceededError`, `X402ApprovalFailedError`, `X402SignatureFailedError`, `X402SettlementProofMissingError`, `X402PaymentFailedError`.
- `actp init` shows x402 seller snippet in "Next steps" when intent is earn/both.

### Security
- Strict HTTPS only for x402 (`http://` rejected at `canHandle`).
- Asset allowlist — canonical USDC per chain by default, rejects other tokens.
- On-chain Permit2 allowance check before submitting approve (survives restart).
- Explicit opt-in for HTTPS URLs — `metadata.paymentMethod: 'x402'` or host in `allowedHosts`.
- Default per-tx cap lowered from $10 to $1 USDC.
- MEV hard cap — 5 min default on signed authorization validity.

### Deprecated
- `X402Relay` contract on Base mainnet + Base Sepolia (no longer used by SDK, kept deployed for historical compatibility).

### Removed
- Custom `x-payment-required` / `x-payment-tx-id` header flow (never part of actual x402 spec).
- X402Relay routing from any SDK code path.
- Zero reputation tracking on x402 payments — reputation is ACTP-exclusive.

### Dependencies
- Added: `viem ^2.47.12`, `@x402/fetch ~2.9.0`, `@x402/evm ~2.9.0`, `@x402/core ~2.9.0`

### Migration
Any code currently constructing `X402Adapter` manually with `{ requesterAddress, transferFn, ... }` config must be updated to the new `{ walletProvider }` form. Known call sites in AGIRAILS ecosystem:
- `agirails/n8n-nodes-actp` — update factory to use auto-registration (remove manual `new X402Adapter()`)
- `agirails/openclaw-skill` SKILL.md examples — update in separate PR
- All docs site examples — update in separate PRs per repo

If you only use `client.pay(...)` without manually constructing `X402Adapter`, no changes are needed.
