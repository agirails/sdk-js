# Changelog

## [4.0.0-beta.0] — 2026-05-15

> **BREAKING release.** Closes a since-3.x silent failure: provider agents on Base
> Sepolia / Base Mainnet never actually saw incoming jobs. Three layers were
> broken in a way that masked each other — transport, routing, and job
> semantics. 4.0.0 fixes the full stack. Protocol-level invariants
> (state machine, escrow solvency, fee bounds) are unchanged.
>
> Full design: [`docs/PRD-event-driven-provider-listening.md`](docs/PRD-event-driven-provider-listening.md).
> Upgrade guide: [`docs/MIGRATION-4.0.md`](docs/MIGRATION-4.0.md).

### BREAKING

- **`IACTPRuntime` interface** — added required method
  `getTransactionsByProvider(provider, state?, limit?): Promise<MockTransaction[]>`.
  Custom runtime implementations must add this method on upgrade. TypeScript
  enforces it at compile time. See MIGRATION-4.0 §2.
- **`MockTransaction` type** — added required field `serviceHash: string`. Direct
  literal constructors of `MockTransaction` (test fixtures) must include the
  field. `MockStateManager.loadState()` auto-backfills the field for state files
  persisted by SDK ≤ 3.5.3, so `.actp/mock-state.json` does not need to be
  deleted. See MIGRATION-4.0 §3.
- **`Agent.pause()` / `Agent.resume()`** — now correctly stop/restart on-chain
  event subscriptions. Pre-4.0.0 `pause()` left the subscription firing in the
  background — a silent bug. Consumers who relied on that behavior must
  update their drain-on-pause logic. See MIGRATION-4.0 §4. (See also Fixed.)
- **`Agent.start()`** — now idempotent. Calling `start()` on an already-running
  or paused agent is a logged noop instead of throwing `AgentLifecycleError`.
- **`actp test` CLI** — replaces the pre-4.0.0 MockRuntime simulation with a
  real ACTP Level 1 request against the deployed Sentinel agent on Base
  Sepolia. Requires a funded testnet wallet, small ETH for gas, and small
  test USDC. Mock-only environments must use the SDK with `MockRuntime`
  directly. See MIGRATION-4.0 §8.
- **`actp pay --service` CLI** — `--service` is parsed only to reject with a
  canonical directive pointing at `actp request`. Exit code 64 (`EX_USAGE`).
  See MIGRATION-4.0 §7.
- **`BlockchainRuntime` constructor** — added required `transport: 'wss'`
  rejection: declaring it throws `ValidationError` at construction time since
  the underlying WebsocketProvider integration is not yet implemented. The
  config shape is locked for forward compatibility.
- **`level0/request()` `options.input`** — accepted but no longer transported
  on-chain. Provider handlers now receive `job.input = {}` for all
  on-chain-sourced jobs. A future `agirails.request.v1` envelope on
  `NegotiationChannel` will restore that transport path. See MIGRATION-4.0 §9.

### Added

- **`actp request <provider> <amount> --service <name>`** — new Level 1
  negotiated job-flow CLI. Supports `--quote-timeout` (default 30s),
  `--delivery-timeout` (default 5min), `--deadline`, `--no-auto-accept`,
  `--network`. `QuoteTimeout` surfaces as exit code 2.
- **`Agent.provide(name, handler)`** — internally keyed by
  `keccak256(toUtf8Bytes(name))` for on-chain routing. Same external
  signature; jobs sourced from `BlockchainRuntime` now route to the correct
  handler via the on-chain `serviceHash` field.
- **`BlockchainRuntime` constructor options** — `sweepBlockWindow`
  (default 7200 ≈ 4h on Base L2), `pollingInterval` (default 1000ms),
  `transport` ('http' | 'wss'), `wssUrl`.
- **`BlockchainRuntime.subscribeProviderJobs(provider, onJob)`** — wired
  into `Agent.start()` / `Agent.resume()`. Re-validates
  `state === 'INITIATED'` after hydration to absorb the
  INITIATED→CANCELLED race between event emission and the contract read.
- **`BlockchainRuntime.getTransactionsByProvider()`** — bounded
  EventMonitor-backed sweep. Newest-first selection by `(blockNumber, logIndex)`
  so a busy window doesn't truncate the freshest jobs at `limit`.
- **`resolveAgent(slug, network)`** helper — slug → on-chain agent identity
  lookup for SDK-internal references. Supports `ACTP_SENTINEL_ADDRESS`
  env-var override as a rotation escape hatch. Trims whitespace; rejects
  invalid addresses with a directive error.
- **`serviceNameForHash(hash, services)`** helper — exact reverse-lookup
  used by `actp agent` to route on-chain `serviceHash` to a configured
  service name. Pure function, no I/O.
- **`EventMonitor.getTransactionHistory(addr, role, range?)`** — optional
  `range` parameter for bounded `queryFilter` scans. Returns
  `TransactionWithLogMeta[]` with `blockNumber` + `logIndex` for
  deterministic newest-first selection.
- First `BlockchainRuntime` unit test coverage — placeholder + real
  implementation tests for `getTransactionsByProvider`,
  `subscribeProviderJobs`, hash routing, and state-guard semantics.

### Changed

- **`BlockchainRuntime` polling cadence** — `provider.pollingInterval`
  defaults to 1000ms (down from ethers' 4000ms default). Multi-agent
  operators sharing one RPC and operators using public RPCs (which have
  2–3s polling floors) should raise the interval. See MIGRATION-4.0 §5+§6.
- **`BlockchainRuntime.getTransaction()`** — now populates `serviceHash`
  on the returned `MockTransaction`. Required for hash-based routing.
- **`Agent.handleIncomingTransaction()`** — single shared acceptance
  pipeline reached from both polling and subscription paths. Releases
  `processingLocks` in a `finally` block so poison TXs no longer
  permanently occupy slots. Lifecycle status guard early-returns on
  paused / stopping / stopped agents.
- **`Agent.findServiceHandler()`** — hash-first dispatch via
  `handlersByHash` map, with the existing 5-step string fallback
  preserved for MockRuntime test fixtures.
- **`Agent.pollForJobs()`** — calls `getTransactionsByProvider()`
  directly. The duck-type guard and `getAllTransactions()` fallback are
  removed.
- **`actp agent` watch loop** — replaces `getAllTransactions()` (no-op
  on real chains) with `getTransactionsByProvider`. Adds an `inflight`
  set so concurrent sweep ticks don't re-enter the same TX. Marks `seen`
  only AFTER `orchestrator.quote()` resolves successfully — transient
  failures now retry on the next sweep instead of dropping the TX.
  Uses `serviceNameForHash` instead of the prior
  `policy.services[0] ?? 'default'` fallback.
- **`actp serve`** — docstring updated to reflect the new scope split:
  `serve` is now AIP-2.1 quote channel only; `actp agent` handles
  on-chain INITIATED detection. Running them together is canonical.
- **Requester surfaces** (`runRequest`, `level0/request`,
  `BuyerOrchestrator`) — put the bytes32 routing key on-chain as
  `serviceDescription`. Pre-4.0.0 they passed JSON
  (`{service, input, timestamp}`), which `BlockchainRuntime.validateServiceHash`
  then hashed wholesale — producing an on-chain `serviceHash` that could
  never match a provider's `Agent.provide(name)` hash.
- **`ServiceDescriptor.serviceTypeHash` doc-comment** — corrected from
  `keccak256(lowercase(serviceType))` to
  `keccak256(toUtf8Bytes(serviceType))` (case-sensitive, no
  normalization). Stale comment was a latent footgun for mixed-case
  service names.

### Fixed

- **`Agent.provide()` on Base Sepolia / Base Mainnet** — now actually
  delivers `job:received` events and dispatches to the correct handler.
  Pre-4.0.0 was a three-layer silent failure (transport, routing, job
  semantics).
- **`Agent.pause()`** — no longer leaves a live subscription firing
  handlers in the background. (Cross-referenced under BREAKING because
  consumers may have relied on the bug.)
- **`actp agent`** — no longer silently sees zero transactions on real
  chains. The watch loop has been 100% non-functional on
  `BlockchainRuntime` since 3.x introduction; this is the first version
  it actually works.
- **`actp agent` quote retry race** — transient `orchestrator.quote()`
  failures (relay 5xx, signer disconnect) no longer permanently drop the
  TX. `seen` is only marked after success; `inflight` prevents
  concurrent re-entry within a single sweep.
- **`actp tx list`** — emits a clear warning when run against
  `BlockchainRuntime` with empty results, instead of silently reporting
  zero transactions. Points users at `actp tx status` and `actp watch`
  until the event-indexed global list lands in a 4.x point release.
- **`agirails.ts` first-run setup** — onboarding catch path now surfaces
  a 3-step setup walkthrough when `runTest()` fails with a recognizable
  setup-error shape (no wallet, missing RPC, sentinel not resolved,
  insufficient funds).
- **Requester-side routing-key bug** — see Changed for full detail. Pre-4.0.0
  every `level0/request` and `BuyerOrchestrator` call produced an unmatchable
  on-chain `serviceHash` even after provider-side hash routing was in place.
  This was the primary architectural reason Sentinel onboarding failed on
  real chains.

### Migration

See [`docs/MIGRATION-4.0.md`](docs/MIGRATION-4.0.md) for the full migration
guide. Sentinel and other internal consumers require only a `package.json`
version bump + `npm run build`. Custom `IACTPRuntime` implementations and
direct `MockTransaction` constructors get compile-time errors that point at
the exact fix.

---

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
