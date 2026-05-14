# PRD: Event-Driven Provider Listening + Service Routing + Job Semantics

**Target version:** `@agirails/sdk@4.0.0` (breaking)
**Status:** Draft v5 — pending implementation
**Authors:** Arha + Damir, 2026-05-13 v5 (supersedes 2026-05-13 v4/v3/v2, 2026-05-12 v1)
**Drivers:**
- Sentinel (Seed #0) deploy on 2026-05-12 confirmed `Agent.provide()` is a silent noop on Base Sepolia/Mainnet for SDK ≤ 3.5.3.
- v1 audit (2026-05-13) identified that transport fix alone produces a broken half-state. v2 expanded scope to all three failure layers.
- v2 adversarial review (2026-05-13, three feature-dev subagents) surfaced six HIGH and seven MED issues, addressed in v3.
- v3 code-alignment pass (2026-05-13) fixed SDK/contract terminology drift (`serviceHash` vs `serviceTypeHash`) and the request-path hash mismatch that would have made hash routing fail after implementation.
- v4 final-check pass (2026-05-13) verified ACTPKernel allows requester-side immediate `DELIVERED → SETTLED` (ACTPKernel.sol:700-704), tightened return-type contracts, and deferred unspecified relay request-envelope work since `NegotiationChannel` does not yet carry a `request.v1` message type.

---

## 1. Problem statement

`Agent.provide()` claims end-to-end provider behavior on any network mode (`mock`, `testnet`, `mainnet`). It works on `mock`. On real chains it fails at **three** independent layers, all of which must be fixed together for the Sentinel onboarding flow to function:

### Layer A — Transport (provider doesn't see incoming TX)

1. `Agent.pollForJobs()` ([`src/level1/Agent.ts:786-799`](../src/level1/Agent.ts#L786-L799)) duck-type-checks for `getTransactionsByProvider`; falls back to `runtime.getAllTransactions()`.
2. `BlockchainRuntime.getAllTransactions()` ([`src/runtime/BlockchainRuntime.ts:630-635`](../src/runtime/BlockchainRuntime.ts#L630-L635)) is a deliberate noop returning `[]`.
3. `getTransactionsByProvider` exists only on `MockRuntime` ([`src/runtime/MockRuntime.ts:576`](../src/runtime/MockRuntime.ts#L576)).
4. `EventMonitor.onTransactionCreated({provider}, cb)` ([`src/protocol/EventMonitor.ts:161+`](../src/protocol/EventMonitor.ts#L161)) already works and is tested. It is wired into the SDK at exactly one site (settlement sweep), not into provider listening.

**Severity note:** `actp agent` CLI ([`src/cli/commands/agent.ts:151`](../src/cli/commands/agent.ts#L151)) calls `runtime.getAllTransactions()` against `BlockchainRuntime`, which always returns `[]`. The command has been **completely non-functional on any real chain since `BlockchainRuntime` was introduced** — zero transactions ever picked up. The v1 PRD framing of "broken on real chain" undersells the severity; this is a since-introduction silent failure.

### Layer B — Routing (provider can't pick the right handler)

5. On-chain `ACTPKernel.createTransaction` stores service as `bytes32 serviceHash`. The full service-name string never reaches chain. `serviceTypeHash` is the AgentRegistry descriptor name for the same `keccak256(toUtf8Bytes(serviceName))` value, not the ACTPKernel transaction field.
6. `BlockchainRuntime.getTransaction()` ([`src/runtime/BlockchainRuntime.ts:606`](../src/runtime/BlockchainRuntime.ts#L606)) returns `serviceDescription: ''` because there is nothing to read from chain.
7. `Agent.findServiceHandler()` ([`src/level1/Agent.ts:921`](../src/level1/Agent.ts#L921)) implements a 5-step dispatch: (a) JSON-parse `{service:string}`, (b) legacy `service:NAME;input:JSON` format, (c) exact string match against the in-memory `services` Map, (d) bytes32 hash detection → explicit `return undefined` with log (this is where on-chain TXs die today), (e) plain string exact match. Steps (a–c, e) all key on the service-name string. Step (d) acknowledges the hash case but has no routing path — it logs and gives up.
8. The `MockTransaction` type ([`src/runtime/types/MockState.ts:110`](../src/runtime/types/MockState.ts#L110)) has a `serviceDescription: string` field but **no `serviceHash` field**. Layer B fix requires adding this field — a breaking type-level change.

### Layer C — Job semantics (`actp pay` never creates a job)

9. `actp pay` ([`src/cli/commands/pay.ts`](../src/cli/commands/pay.ts)) does **not** currently accept `--service` (verified: no such option in the command definition today). The user story "developer runs `actp pay <sentinel> 0.05 --service onboarding`" from v1 was a false premise — that surface never existed.
10. `BasicAdapter.pay` ([`src/adapters/BasicAdapter.ts:221`](../src/adapters/BasicAdapter.ts#L221)) hard-codes `serviceHash = ZeroHash` and routes through the batched AA path that calls `payACTPBatched` directly, returning `state: 'COMMITTED'`. The legacy EOA path ([`BasicAdapter.ts:277-303`](../src/adapters/BasicAdapter.ts#L277-L303)) calls `createTransaction` then `linkEscrow` in immediate sequence. Both paths skip `INITIATED`.
11. `Agent.pollForJobs()` filters for `INITIATED` only ([`Agent.ts:788`](../src/level1/Agent.ts#L788)). No `INITIATED` ever exists for a `pay` call → provider has nothing to listen for at the protocol level, even if Layer A and B are fixed.
12. `actp test` ([`src/cli/commands/test.ts:156`](../src/cli/commands/test.ts#L156)) uses `MockRuntime`, doesn't auto-find Sentinel, and never touches a real chain. The user story "`npx actp test` → real Sentinel → real reflection" has no surface today.

### Net effect

From 3.4.x through 3.5.3, no JS SDK consumer running `Agent.provide()` against Base Sepolia or Base Mainnet has ever received an executable job. Layer A is the most visible failure; Layers B and C ensure even a transport fix does not produce an end-to-end working flow.

---

## 2. Goals + non-goals

### Goals

- `Agent.provide(name, handler)` works end-to-end on Base Sepolia and Base Mainnet with the same handler signature as `mock`.
- A clean, separated job request surface (`actp request`) exists for Level 1 negotiated flow, distinct from `actp pay` (Level 0 direct primitive).
- `npx actp test` against Base Sepolia auto-finds Sentinel, submits a real `request`, walks the full state machine `INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED`, prints the day's reflection. Requires a configured requester wallet with small Base Sepolia ETH + test USDC (or an explicit future faucet/sponsor feature, out of scope here). The CLI uses the requester key to settle immediately after delivery; non-requester settlement still waits for the 1h+ dispute window enforced by the contract.
- A provider boot **after** an incoming `request` recovers it via catch-up sweep within 60 s (within the bounded block window).
- `Agent.pause()` and `Agent.resume()` correctly stop and restart subscription (no jobs delivered while paused).
- `actp agent` CLI no longer loses transactions on transient quote failures.
- Existing Sentinel source code (`/Users/damir/Arha/AGIRAILS/Public Agents/seed-sentinel/src/agent.ts`) requires zero changes beyond `package.json` SDK bump.

### Non-goals (4.0.0)

- Generic on-chain transaction indexer (the V2 comment in `BlockchainRuntime.ts:631`).
- Per-provider service-name namespace (`keccak256(provider || name)`). Acknowledged limitation — see §A.1.
- Multi-replica HA provider (shared wallet, nonce coordination).
- `lastSeenBlock` persistence across container restarts. Each boot re-sweeps within a configurable window.
- WebSocket transport as default. Opt-in only.
- Off-chain service-metadata CID resolver.
- Cross-runtime `IMockRuntime` interface unification.
- `actp pay` semantic change. `pay` remains a Level 0 primitive (no INITIATED phase, no handler routing).
- IN_PROGRESS recovery after container death.

---

## 3. User stories

**P-1 — Provider operator (Damir, Sentinel).**
*"I run `npm run dev` on Railway against testnet. A developer in Berlin runs `npx actp test`. Within 5 s, my handler fires with the parsed `request`, returns the day's reflection, and the buyer's escrow settles. No `getAllTransactions not implemented` warnings. If Railway restarts mid-job, the catch-up sweep on next boot finds any pending INITIATED jobs from the configured window."*

**P-2 — Onboarding developer (`actp test`).**
*"I run `npx actp test` from a shell where my ACTP test wallet is configured and funded. The CLI auto-finds Sentinel, submits a real Level 1 request for $0.05 USDC, walks me through every state transition with timestamps, and prints the reflection. Total time to reflection + requester-side settle target: under 15 s on healthy Base Sepolia RPC. If wallet/funds are missing, I get a precise setup error instead of a mock success. Phase 0 exit criterion #2 passes."*

**P-3 — SDK maintainer.**
*"I read the SDK source and the testnet provider-listening pathway is no longer a documented V2 gap. There are real `BlockchainRuntime` integration tests in CI that prove the full request → settle flow works. The pause/resume contract is enforceable. Service routing keys off on-chain data only; no hidden off-chain registry."*

**P-4 — Future provider (post-Sentinel).**
*"I register a service with `agent.provide('translate', handler)`. My provider receives `request` calls targeting my service hash. Other services I haven't registered are ignored at the routing layer, not at the handler layer. I can run multiple services on one wallet without collisions."*

---

## 4. Architecture

Three layers, each addressed independently and composed by `Agent`:

```
                                      Base Sepolia / Mainnet
                                              │
                                              ▼
                          ┌─── LAYER A: Transport ─────────────────────┐
                          │  EventMonitor.onTransactionCreated         │
                          │      ({provider}, cb)  (subscription)      │
                          │              +                             │
                          │  EventMonitor.getTransactionHistory        │
                          │      (range)  (bounded catch-up sweep)     │
                          └────────────────┬───────────────────────────┘
                                           │  MockTransaction (hydrated)
                                           │  + state === 'INITIATED' guard
                                           ▼
                          ┌─── LAYER B: Routing ───────────────────────┐
                          │  Agent.findServiceHandler(tx)              │
                          │    → match by tx.serviceHash               │
                          │    → Map<bytes32, ServiceHandler>          │
                          └────────────────┬───────────────────────────┘
                                           │
                                           ▼
                          ┌─── LAYER C: Execution ─────────────────────┐
                          │  Agent.handleIncomingTransaction(tx)       │
                          │    - processingLocks (atomic, try/finally) │
                          │    - processedJobs LRU                     │
                          │    - shouldAutoAccept (filter+pricing)     │
                          │    - linkEscrow                            │
                          │    - processJob(handler)                   │
                          │    - DELIVERED → settlement sweep          │
                          └────────────────────────────────────────────┘

                    Job source: `actp request` (Level 1, NEW)
                    `actp pay` stays Level 0 (no job, no handler)
```

**Composition invariants:**

- Subscription is **primary** (1–2 s on default HTTP, sub-second on WSS opt-in).
- Catch-up sweep is **secondary** — bounded `queryFilter` over recent blocks. Resilient to WSS drops, RPC blips, container restarts, missed events.
- Both paths produce identical `MockTransaction` shape and funnel through `handleIncomingTransaction`. Subscription handler **re-validates** `state === 'INITIATED'` after hydration to absorb the INITIATED→CANCELLED race.
- Dedup at `processingLocks` (atomic, released in `finally`) + `processedJobs` LRU ensures exactly-once execution.
- Routing keys exclusively off `tx.serviceHash` — fully on-chain, no off-chain resolver needed for routing.

**Terminology invariant (prevents implementation drift):**

- `serviceHash` = ACTPKernel transaction field, EventMonitor return field, and new `MockTransaction` field.
- `serviceTypeHash` = AgentRegistry service-descriptor field. It uses the same hash formula for service names, but it is not the transaction/runtime field name.
- For routing, `actp request --service <name>` must put `keccak256(toUtf8Bytes(name))` on-chain as `serviceHash`. It must **not** pass JSON request metadata to `createTransaction.serviceDescription` and let `BlockchainRuntime.validateServiceHash()` hash the JSON; that would produce `keccak256('{"service":"onboarding",...}')`, which will never match `agent.provide('onboarding')`.
- Handler input is not recoverable from `serviceHash`. In 4.0.0, `actp request` does **not** carry `--input` / `--metadata` — `job.input` is `{}` for every on-chain-sourced job. When a future `agirails.request.v1` envelope is added to `NegotiationChannel` (§11), it will be the only path for requester-supplied input/metadata; the on-chain hash will remain only the routing key.

---

## 5. Detailed design

### 5.1 `IACTPRuntime` interface — add required method (breaking)

[`src/runtime/IACTPRuntime.ts`](../src/runtime/IACTPRuntime.ts), after `getAllTransactions` declaration:

```typescript
/**
 * Gets transactions filtered by provider address and optional state.
 *
 * MockRuntime: queries in-memory state.
 * BlockchainRuntime: composes EventMonitor.getTransactionHistory over a
 *   bounded fromBlock window + hydrates each result via getTransaction().
 *
 * @param provider Provider Ethereum address
 * @param state    Optional state filter (e.g. 'INITIATED'); omit for all states
 * @param limit    Max results (default 100, 0 = unlimited)
 */
getTransactionsByProvider(
  provider: string,
  state?: TransactionState,
  limit?: number
): Promise<MockTransaction[]>;
```

**Breaking change.** This is a required interface method. Custom `IACTPRuntime` implementations downstream must add it. TypeScript will surface this as a compile-time error on upgrade — that is intentional. No `BaseACTPRuntime` scaffold with default-throw is provided; converting a compile-time contract violation into a runtime exception hides the requirement at exactly the wrong moment. See decision §A.5.

`getAllTransactions()` stays on the interface for `MockRuntime` introspection use cases.

All implementations must normalize provider comparisons (`ethers.getAddress(...).toLowerCase()` or equivalent). The current `MockRuntime.getTransactionsByProvider` uses case-sensitive equality; update it in the same PR so mock and chain behavior do not diverge on checksummed vs lowercase addresses.

### 5.2 `BlockchainRuntime` — transport layer + type extension

[`src/runtime/BlockchainRuntime.ts`](../src/runtime/BlockchainRuntime.ts) — extend the existing `BlockchainRuntimeConfig` interface, do not introduce a parallel options type:

```typescript
interface BlockchainRuntimeConfig {
  // ... existing fields ...
  /** Block window for getTransactionsByProvider catch-up sweep. Default 7200 (~4h on Base L2). */
  sweepBlockWindow?: number;
  /** ethers JsonRpcProvider polling interval in ms. Default 1000. Set to 2000+ for multi-agent operators. */
  pollingInterval?: number;
  /** Transport type. Default 'http' (uses jsonRpcUrl). 'wss' uses wssUrl for subscription latency below 1s. */
  transport?: 'http' | 'wss';
  /** Required if transport === 'wss'. */
  wssUrl?: string;
}
```

Constructor sets `this.provider.pollingInterval = config.pollingInterval ?? 1000` and stores `this.sweepBlockWindow = config.sweepBlockWindow ?? 7200`.

`getTransactionsByProvider` implementation:

```typescript
async getTransactionsByProvider(
  provider: string,
  state?: TransactionState,
  limit: number = 100
): Promise<MockTransaction[]> {
  const currentBlock = await this.provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - this.sweepBlockWindow);

  const history = await this.events.getTransactionHistory(
    provider, 'provider', { fromBlock, toBlock: 'latest' }
  );
  const recentFirst = history.sort((a, b) =>
    (b.blockNumber ?? 0) - (a.blockNumber ?? 0) || (b.logIndex ?? 0) - (a.logIndex ?? 0)
  );

  const stateMap: Record<number, TransactionState> = {
    0: 'INITIATED', 1: 'QUOTED', 2: 'COMMITTED', 3: 'IN_PROGRESS',
    4: 'DELIVERED', 5: 'SETTLED', 6: 'DISPUTED', 7: 'CANCELLED',
  };

  const results: MockTransaction[] = [];
  const expectedProvider = ethers.getAddress(provider).toLowerCase();
  for (const h of recentFirst) {
    const mapped = stateMap[h.state as number];
    if (state !== undefined && mapped !== state) continue;
    const hydrated = await this.getTransaction(h.txId);
    if (!hydrated) continue;
    if (hydrated.provider.toLowerCase() !== expectedProvider) continue;
    results.push(hydrated);
    if (limit > 0 && results.length >= limit) break;
  }
  return results.reverse(); // process selected jobs oldest-first
}
```

`EventMonitor.getTransactionHistory` must include enough ordering metadata (`blockNumber`, `logIndex`) for the newest-`limit` selection above. Without this, `queryFilter`'s old-to-new ordering can select the oldest 100 transactions in a busy window and miss the newest pending jobs.

Subscription helper:

```typescript
/**
 * Public method on the BlockchainRuntime class (NOT on IACTPRuntime). Public
 * visibility is intentional so Agent.subscribeIfBlockchain() can detect support
 * with a structural `if ('subscribeProviderJobs' in runtime)` check — keeping
 * the rest of the runtime contract narrow. MockRuntime deliberately does not
 * implement this; mock providers receive jobs via polling against in-memory state.
 */
subscribeProviderJobs(
  provider: string,
  onJob: (tx: MockTransaction) => void
): () => void {
  return this.events.onTransactionCreated(
    { provider },
    async ({ txId }) => {
      try {
        const tx = await this.getTransaction(txId);
        if (!tx) {
          sdkLogger.warn('subscribeProviderJobs: tx not yet visible, sweep will retry', { txId });
          return;
        }
        // State re-validation: subscription fired on TransactionCreated, but by hydration
        // time the TX may have moved to CANCELLED/QUOTED. Sweep will pick up legitimate
        // INITIATED TXs we miss here.
        if (tx.state !== 'INITIATED') {
          sdkLogger.debug('subscribeProviderJobs: tx no longer INITIATED, skipping', {
            txId, state: tx.state,
          });
          return;
        }
        onJob(tx);
      } catch (err) {
        sdkLogger.warn('subscribeProviderJobs: hydration error', { txId, err });
      }
    }
  );
}
```

**`getTransaction()` extension (Layer B fix).** Method must populate `serviceHash: string` on the returned `MockTransaction`. The kernel emits `serviceHash` in `TransactionCreated` events and exposes it through `getTransaction(bytes32)` ([`ACTPKernel.sol`](../../../Protocol/actp-kernel/src/ACTPKernel.sol); SDK wrapper [`src/protocol/ACTPKernel.ts`](../src/protocol/ACTPKernel.ts)). Do not call a `transactions(bytes32)` view; the current ABI exposes `getTransaction(bytes32)`.

**`MockTransaction` type extension.** Add `serviceHash: string` to the type definition at [`src/runtime/types/MockState.ts:110`](../src/runtime/types/MockState.ts#L110). For `MockRuntime`, this field is set during `createTransaction`: if `serviceDescription` is already bytes32, pass it through; if it is a raw string, store `keccak256(toUtf8Bytes(serviceDescription))`; if omitted, store `ZeroHash`. This is a **breaking type-level change** — listed explicitly in §6 and the CHANGELOG.

**Polling latency.** With `pollingInterval = 1000`, subscription median latency on testnet is ~1–2 s (one block + one poll). Sub-second is achievable only with WSS opt-in. The PRD does **not** promise sub-second on the default path. Multi-agent operators sharing one RPC endpoint should set `pollingInterval = 2000` or higher — see migration doc.

### 5.3 `Agent` — wire subscription, fix pause/resume, idempotent start, exception-safe dedup

[`src/level1/Agent.ts`](../src/level1/Agent.ts):

```typescript
private pollingIntervalId?: NodeJS.Timeout;
private jobSubscriptionCleanup?: () => void;
private handlersByHash: Map<string, ServiceHandlerEntry> = new Map();

async start(): Promise<void> {
  if (this._status === 'running' || this._status === 'paused') {
    this.logger.warn('Agent.start() called on already-started agent — noop');
    return;
  }
  // existing init
  this.startPolling();
  this.subscribeIfBlockchain();
  this._status = 'running';
  this.emit('started');
}

async pause(): Promise<void> {
  if (this._status !== 'running') return;
  this.stopPolling();
  this.unsubscribe();              // FIX: was missing in 3.5.3
  this._status = 'paused';
  this.emit('paused');
}

async resume(): Promise<void> {
  if (this._status !== 'paused') return;
  this.startPolling();
  this.subscribeIfBlockchain();
  this._status = 'running';
  this.emit('resumed');
}

async stop(): Promise<void> {
  this.stopPolling();
  this.unsubscribe();
  // existing drain logic
}

private subscribeIfBlockchain(): void {
  if (this.jobSubscriptionCleanup) {
    this.logger.warn('Agent: subscription already active, refusing to double-subscribe');
    return;
  }
  const runtime = this._client.runtime;
  if ('subscribeProviderJobs' in runtime) {
    this.jobSubscriptionCleanup = (runtime as BlockchainRuntime)
      .subscribeProviderJobs(this.address, (tx) => {
        this.handleIncomingTransaction(tx).catch((err) =>
          this.emit('error', err)
        );
      });
    this.logger.info('Subscribed to on-chain TransactionCreated events');
  }
}

private unsubscribe(): void {
  if (this.jobSubscriptionCleanup) {
    this.jobSubscriptionCleanup();
    this.jobSubscriptionCleanup = undefined;
  }
}
```

`start()` must wrap init + `startPolling()` + `subscribeIfBlockchain()` in a failure cleanup path. If subscription setup throws after polling starts, call `stopPolling()` and `unsubscribe()` before rethrowing so a half-started agent does not leak timers or event listeners.

`pollForJobs()` simplified:

```typescript
private async pollForJobs(): Promise<void> {
  if (!this._client) return;
  try {
    const pending = await this._client.runtime.getTransactionsByProvider(
      this.address, 'INITIATED', 100
    );
    for (const tx of pending) await this.handleIncomingTransaction(tx);
  } catch (err) {
    this.logger.error('Poll error', {}, err as Error);
    this.emit('error', err);
  }
}
```

**`handleIncomingTransaction` exception safety.** The body must release `processingLocks` in a `finally` block. Poison TXs (malformed payload, handler throws, hydration fails post-lock-acquire) must not permanently occupy a slot:

```typescript
private async handleIncomingTransaction(tx: MockTransaction): Promise<void> {
  if (this.processingLocks.has(tx.id) || this.processedJobs.has(tx.id)) return;
  this.processingLocks.add(tx.id);
  try {
    // existing handler dispatch, linkEscrow, processJob, etc.
    this.processedJobs.set(tx.id, Date.now());
  } finally {
    this.processingLocks.delete(tx.id);
  }
}
```

### 5.4 `Agent.findServiceHandler` — hash matching (Layer B)

The current 5-step dispatch (described in §1 Layer B point 7) is replaced with a hash-first, string-fallback strategy. Hash routing is primary; the legacy paths remain only to preserve `MockRuntime` test fixtures that use string keys.

```typescript
provide<TInput, TOutput>(
  name: string,
  handler: (input: TInput) => Promise<TOutput>,
  opts?: ProvideOptions
): void {
  const hash = keccak256(toUtf8Bytes(name)).toLowerCase();
  if (this.handlersByHash.has(hash)) {
    throw new Error(`Service '${name}' already registered`);
  }
  this.handlersByHash.set(hash, { name, handler, opts });
}

private findServiceHandler(tx: MockTransaction): ServiceHandlerEntry | undefined {
  // Primary: hash match (on-chain Layer B path)
  const hash = tx.serviceHash?.toLowerCase();
  if (hash && hash !== ZeroHash.toLowerCase()) {
    const byHash = this.handlersByHash.get(hash);
    if (byHash) return byHash;
  }
  // Fallback: existing 5-step string dispatch (preserves MockRuntime test surface)
  return this.findServiceHandlerByString(tx);  // existing 5-step logic, refactored
}
```

**Backward compatibility:** Sentinel's `agent.provide('onboarding', handler)` in 4.0.0 internally computes `keccak256(toUtf8Bytes('onboarding'))`. Verification (via [`AgentRegistry.computeServiceTypeHash`](../src/protocol/AgentRegistry.ts#L115), [`publishPipeline.ts`](../src/config/publishPipeline.ts#L188), and the published Sentinel identity at `agent_id: 5844`): the AgentRegistry `serviceTypeHash` and the ACTPKernel transaction `serviceHash` must use the same formula. **No `.toLowerCase()` is applied** to the service name before hashing — this contradicts a stale doc-comment at [`src/types/agent.ts:11`](../src/types/agent.ts#L11) which the same PR fixes (see §5.10).

**Job construction:** Hash routing returns a `ServiceHandlerEntry` with the original `name`. `createJobFromTransaction` must accept that matched entry and use `entry.name` as `job.service` when `tx.serviceDescription` is empty/hash-only. `job.input` is `{}` for all on-chain-sourced jobs in 4.0.0 — there is no requester-input transport layer yet. Do not try to reverse `serviceHash` into a service name or payload. A future `agirails.request.v1` envelope on `NegotiationChannel` is the planned channel for requester-supplied input/metadata (§11).

**Edge case:** `tx.serviceHash === ZeroHash` (from a `pay` call) → hash branch skipped → string fallback returns undefined → handler not dispatched. TX is logged with reason `pay_zerohash_ignored` for operator observability, not silently dropped.

### 5.5 `EventMonitor` — accept optional block range, return ordering metadata

[`src/protocol/EventMonitor.ts:90`](../src/protocol/EventMonitor.ts#L90) `getTransactionHistory` adds a third optional parameter and returns a widened element type carrying SDK-local log ordering metadata:

```typescript
/** SDK-local widening of the canonical Transaction type. blockNumber + logIndex
 *  are sourced from the on-chain event log, not from ACTPKernel state. They exist
 *  so consumers (catch-up sweeps) can select the newest `limit` events deterministically. */
export type TransactionWithLogMeta = Transaction & {
  blockNumber?: number;
  logIndex?: number;
};

async getTransactionHistory(
  address: string,
  role: 'requester' | 'provider' = 'requester',
  range?: { fromBlock?: number; toBlock?: number | 'latest' }
): Promise<TransactionWithLogMeta[]>
```

Backward compatible at the value level — `range === undefined` keeps current behavior (genesis → latest), and `TransactionWithLogMeta` is `Transaction` plus two optional fields, so existing consumers that only read canonical fields compile unchanged. Direct consumers that destructure the return array must update their type annotation (compile-time surface).

### 5.6 New CLI command — `actp request` (Layer C)

New file: `src/cli/commands/request.ts`. There is no existing `ACTPClient.request()` method in the SDK; this command must use a new shared helper (`src/cli/lib/runRequest.ts`) or refactor `src/level0/request.ts` / `BuyerOrchestrator` into a reusable Level 1 requester flow.

```bash
actp request <provider> <amount> --service <name> [--deadline <iso>] [--quote-timeout <ms>] [--auto-accept]
```

**Note on handler input.** 4.0.0 does not expose `--input` / `--metadata` flags. Provider-side `job.input` is `{}` for all real-chain requests. This is sufficient for Sentinel (covenant accepts "any JSON or empty"). Arbitrary requester→provider payload requires a new signed envelope type (`agirails.request.v1`) on `NegotiationChannel`, which today carries only `quote.v1` / `counteroffer.v1` / `counteraccept.v1`. That envelope is out of scope here — see §11.

**Note on negotiated multi-round flow.** 4.0.0 implements the **poll-only, autoAccept-friendly path** for `runRequest`: the requester creates the TX, then polls `getTransaction(txId)` to observe state transitions while a provider whose `shouldAutoAccept` returns `true` drives INITIATED → COMMITTED on its own side (via `Agent.handleIncomingTransaction` → `linkEscrow`). This is the Sentinel onboarding path. The `counteraccept.v1` envelope over `NegotiationChannel.subscribeTxId` described in step 6 below is **deferred to a 4.x follow-up** for the cases where the provider quotes a different amount, where the requester wants explicit accept-with-different-amount control, or where multi-round counter-offers are required (currently exercised by `BuyerOrchestrator`). For Sentinel + autoAccept the two paths are functionally equivalent; deferring the channel wiring keeps the 4.0.0 `runRequest` surface ~80 LOC simpler and avoids re-implementing the `BuyerOrchestrator` quote channel in a second site.

Internally:
1. Resolve `<provider>` (address or known agent slug, e.g. `sentinel` → `resolveAgent` table).
2. `serviceHash = keccak256(toUtf8Bytes(name))`.
3. Create on-chain TX through `runtime.createTransaction({ provider, amount, serviceDescription: serviceHash, deadline, ... })` → state `INITIATED`. This intentionally passes the bytes32 hash, not JSON. The same fix must be applied to `src/level0/request.ts` and `src/negotiation/BuyerOrchestrator.ts` if they are used as requester surfaces.
4. Subscribe to the relay channel for incoming quote (`subscribeTxId` on the existing `NegotiationChannel`), with `--quote-timeout` (default `30000` ms) bound. If no quote arrives within the timeout:
   - Print actionable error: `No quote received within Xms. Provider may be offline. TX <id> remains on-chain INITIATED; you can cancel with 'actp cancel <id>' or retry.`
   - Exit code `2` (timeout). On-chain TX persists for manual handling.
5. On quote received: print quote details, prompt `--auto-accept` or wait for user `y`.
6. On accept: post a `counteraccept.v1` envelope through `NegotiationChannel` (no on-chain `acceptQuote` is required when the quote is accepted unchanged), then call `linkEscrow(txId)` → state `COMMITTED`. If the quote is accepted with a different amount, send `counteroffer.v1` first and re-enter the quote loop at step 4.
7. Provider's handler runs → `DELIVERED`.
8. Requester immediately settles after delivery (`DELIVERED → SETTLED`) when the CLI is invoked with the requester signer. ACTPKernel allows this without waiting for the dispute window ([`ACTPKernel.sol:700-704`](../../../Protocol/actp-kernel/src/ACTPKernel.sol#L700-L704)). If the caller is not the requester, settlement waits until `txn.disputeWindow` passes.
9. Print transition log with timestamps and the returned payload.

### 5.7 Rewrite `actp test` — real Sentinel hit with override

[`src/cli/commands/test.ts`](../src/cli/commands/test.ts) — replace MockRuntime path entirely. Uses new helper `resolveAgent`:

```typescript
// src/cli/lib/resolveAgent.ts
export interface ResolvedAgent {
  slug: string;
  address: string;
  network: string;
  source: 'env' | 'table';
}

export class AgentNotFoundError extends Error {
  constructor(public slug: string, public network: string) {
    super(`Agent '${slug}' not registered on network '${network}'`);
  }
}

export class InvalidAgentAddressError extends Error {
  constructor(public envVar: string, public value: string) {
    super(`Env var ${envVar} contains invalid Ethereum address: ${value}`);
  }
}

const KNOWN_AGENTS: Record<string, Record<string, string>> = {
  sentinel: {
    'base-sepolia': '0x3813A642C57CF3c20ff1170C0646c309B4bf6d64',
  },
};

const ENV_OVERRIDES: Record<string, string> = {
  sentinel: 'ACTP_SENTINEL_ADDRESS',
};

export function resolveAgent(slug: string, network: string): ResolvedAgent {
  // Env var override path (rotation escape hatch — see §A.6)
  const envVar = ENV_OVERRIDES[slug];
  if (envVar && process.env[envVar]) {
    const value = process.env[envVar];
    if (!isAddress(value)) throw new InvalidAgentAddressError(envVar, value);
    return { slug, address: value, network, source: 'env' };
  }
  // Constant table
  const addr = KNOWN_AGENTS[slug]?.[network];
  if (!addr) throw new AgentNotFoundError(slug, network);
  return { slug, address: addr, network, source: 'table' };
}
```

The `test.ts` command then:

```typescript
export async function test(opts: TestOptions) {
  const sentinel = resolveAgent('sentinel', 'base-sepolia');  // throws on miss
  console.log(`→ Requesting onboarding service from Sentinel (${sentinel.address}, source: ${sentinel.source})`);
  const result = await runRequest({
    provider: sentinel.address,
    amount: '0.05',
    service: 'onboarding',
    deadline: addSeconds(new Date(), 3600).toISOString(),
    autoAccept: true,
    network: 'base-sepolia',
    quoteTimeout: 30_000,
    onTransition: (state, txId, ts) =>
      console.log(`  [${ts.toISOString()}] ${state.padEnd(12)} ${txId}`),
  });
  console.log(`\n✓ Reflection:\n  ${result.reflection}\nTotal time: ${result.elapsedMs} ms`);
}
```

### 5.8 `actp agent` CLI — fix transport + transient-quote race

[`src/cli/commands/agent.ts:149-156`](../src/cli/commands/agent.ts#L149-L156) — two fixes:

```diff
-    const all = await runtime.getAllTransactions();
-    for (const t of all) {
-      if (seen.has(t.id)) continue;
-      if (t.state !== 'INITIATED') { seen.add(t.id); continue; }
-      if (t.provider.toLowerCase() !== signerAddress.toLowerCase()) continue;
-      seen.add(t.id);
-      // ... orchestrator.quote(t) here — if it throws, t is in `seen` and never retried
+    // chainId is sourced once at command init from getNetwork(opts.network).chainId
+    // (e.g. 84532 for base-sepolia); pass it into the watchTimer closure.
+    const pending = await runtime.getTransactionsByProvider(
+      signerAddress, 'INITIATED', 100
+    );
+    for (const t of pending) {
+      if (seen.has(t.id) || inflight.has(t.id)) continue;
+      inflight.add(t.id);
+      try {
+        const serviceType = serviceNameForHash(t.serviceHash, policy.services);
+        if (!serviceType) {
+          logger.warn('Unknown service hash, skipping quote', { txId: t.id, serviceHash: t.serviceHash });
+          seen.add(t.id);          // deterministic skip; not a transient failure
+          continue;
+        }
+        const req: IncomingRequest = {
+          txId: t.id,
+          consumer: `did:ethr:${chainId}:${t.requester.toLowerCase()}`,
+          offeredAmount: String(t.amount),
+          maxPrice: String(t.amount),
+          deadline: Number(t.deadline) || Math.floor(Date.now() / 1000) + 3600,
+          serviceType,
+          currency: policy.pricing.min_acceptable.currency,
+          unit: policy.pricing.min_acceptable.unit,
+        };
+        await orchestrator.quote(req, providerDID);
+        seen.add(t.id);            // only mark seen after success
+      } catch (err) {
+        logger.warn('Quote failed, will retry on next sweep', { txId: t.id, err });
+      } finally {
+        inflight.delete(t.id);
+      }
+    }
```

`serviceNameForHash` computes `keccak256(toUtf8Bytes(serviceName))` for every configured policy service and compares against `t.serviceHash.toLowerCase()`. The current fallback (`policy.services[0] ?? 'default'`) is not acceptable after hash routing because it can quote the wrong service.

### 5.9 `actp pay` CLI — explicit `--service` rejection

The `pay` command does not currently accept `--service`. 4.0.0 adds parsing for the flag specifically to reject it with a directive:

```typescript
// src/cli/commands/pay.ts
if (opts.service) {
  console.error(
    `Error: 'actp pay' is a Level 0 primitive and does not accept --service.\n` +
    `For negotiated Level 1 job flow (where a provider's handler runs after quote/accept),\n` +
    `use 'actp request <provider> <amount> --service <name>' instead.\n` +
    `See https://agirails.io/docs/sdk/level-0-vs-level-1`
  );
  process.exit(64);  // EX_USAGE
}
```

Error message text is **canonical** and reused by any test that verifies the rejection path.

### 5.10 `actp serve` docstring update

[`src/cli/commands/serve.ts:14-16`](../src/cli/commands/serve.ts#L14-L16):

```diff
- * Out of scope for v1 (Phase 5):
- *  - on-chain event listening (no automatic submitQuote on incoming
- *    INITIATED txs — caller still drives via Agent.ts or manual code)
+ * On-chain INITIATED tx detection is handled by `actp agent` or `new Agent()`
+ * (both use hybrid subscription + catch-up sweep via BlockchainRuntime since
+ * 4.0.0). `actp serve` focuses solely on the AIP-2.1 quote channel.
```

### 5.11 Fix misleading `ServiceDescriptor` type comment

[`src/types/agent.ts:11`](../src/types/agent.ts#L11) currently documents:

```typescript
// hash = keccak256(lowercase(serviceType))
```

This is wrong — no call site in the SDK applies `.toLowerCase()` before hashing. For all-lowercase names (like Sentinel's `onboarding`) the bug is invisible. For mixed-case service names, a consumer who reads this comment and lowercases their input before calling `Agent.provide()` will produce a different hash than `actp request --service NameWithCaps` puts on chain.

Fix in the same PR:

```diff
- // hash = keccak256(lowercase(serviceType))
+ // hash = keccak256(toUtf8Bytes(serviceType))    — case-sensitive, no normalization
```

---

## 6. API impact (4.0.0 surface)

| Surface | 3.5.3 | 4.0.0 | Notes |
|---|---|---|---|
| `Agent.provide(name, handler, opts)` | string-keyed | hash-keyed primary, string-fallback | Same signature, same external behavior for valid Level 1 requests |
| `Agent.start()` | poll only | poll + subscription on BlockchainRuntime; idempotent | Double-start is now a logged noop, was previously undefined |
| `Agent.pause()` | poll-only stop (subscription leaked) | poll + subscription stop | **BREAKING + Fix** — see §7 and CHANGELOG |
| `Agent.resume()` | poll-only restart (subscription state undefined) | poll + subscription restart | **BREAKING + Fix** — see §7 |
| `Agent.on('job:received')` | identical | identical | Latency: bounded by `pollingInterval` (default 1 s) |
| `IACTPRuntime.getTransactionsByProvider(...)` | MockRuntime only (duck-type) | **Required interface method** | **BREAKING** — compile-time enforced |
| `IACTPRuntime.getAllTransactions()` | noop on BlockchainRuntime | noop on BlockchainRuntime | Unchanged |
| `MockTransaction` type | no `serviceHash` field | `serviceHash: string` added | **BREAKING (type-level)** — see §7 |
| `BlockchainRuntime` constructor | implicit defaults | `{ sweepBlockWindow, pollingInterval, transport, wssUrl }` options | Additive |
| `BlockchainRuntime.subscribeProviderJobs(...)` | — | New (private) | Not on interface; subscription handler re-validates `state === 'INITIATED'` |
| `BlockchainRuntime.getTransaction()` | `serviceDescription: ''`, no `serviceHash` | populated `serviceHash` | **Required for routing**, behavior change |
| `EventMonitor.getTransactionHistory(addr, role, range?)` | 2 params | 3 params (3rd optional) | Backward compatible |
| `actp pay` | no `--service` flag | parses `--service` only to reject with directive error | **BREAKING (CLI)** — new flag added, immediately rejected; documents the L0/L1 split |
| `actp request` | — | New command | Level 1 negotiated flow surface |
| `actp test` | MockRuntime, no Sentinel | BlockchainRuntime, real Sentinel hit, `ACTP_SENTINEL_ADDRESS` override | **BREAKING (behavior)** — finally does what the name says |
| `actp agent` | broken transport + `seen` race | both fixed | Bug fix |

**Breaking changes summary:** (1) `IACTPRuntime` interface, (2) `MockTransaction` type, (3) `Agent.pause/resume` semantic, (4) `actp pay --service` rejection (newly parsed flag), (5) `actp test` behavior change. Justifies 4.0.0 major bump.

**Reference:** `MIN_DISPUTE_WINDOW = 1 hours` at [`Protocol/actp-kernel/src/ACTPKernel.sol:52`](../../../Protocol/actp-kernel/src/ACTPKernel.sol#L52). v1 PRD's `disputeWindow: 1` was invalid — fixed in §8.

---

## 7. Migration plan

### Sentinel (`/Users/damir/Arha/AGIRAILS/Public Agents/seed-sentinel/`)

```diff
  // package.json
- "@agirails/sdk": "^3.5.3"
+ "@agirails/sdk": "^4.0.0"
```

Then `npm ci && npm run build` (rebuilds `dist/` against new types). Source changes required: **none**. Verified:

- `src/agent.ts` uses `new Agent({...})`, `agent.provide('onboarding', handler)`, `agent.on(...)`, `agent.start()`, `agent.stop()`.
- `agent.provide('onboarding', handler)` in 4.0.0 internally computes `keccak256(toUtf8Bytes('onboarding'))`, matches the `serviceHash` that `actp request --service onboarding` puts on chain. The same value also matches Sentinel's AgentRegistry `serviceTypeHash` (verified across `AgentRegistry.ts`, `publishPipeline.ts`, `register.ts`).

### Other internal consumers

- **lead-gen-agent**: Python + Modal + webhooks; no `Agent.provide()` consumption; unaffected.
- **Examples in `examples/`**: any using `MockTransaction` literal constructors must add `serviceHash: '0x...'` field. Update in same PR.

### External consumers — `docs/MIGRATION-4.0.md`

New doc covers:

1. **Bump `@agirails/sdk` to `^4.0.0`** (require Node ≥ 18.17).
2. **Custom `IACTPRuntime` implementers:** add `getTransactionsByProvider`. Reference `MockRuntime` (in-memory) or `BlockchainRuntime` (event-sourced). TypeScript will surface this as a compile error on upgrade — that is intentional.
3. **`MockTransaction` literal constructors:** if you construct `MockTransaction` objects directly (e.g. in test fixtures), add `serviceHash: '0x' + '0'.repeat(64)` (ZeroHash) or the actual hash. TypeScript will surface this as a compile error.
4. **`Agent.pause()` consumers — drain-on-pause pattern:** if you relied on the prior bug to keep receiving `job:received` events while paused (e.g., to drain pending work), this no longer happens. The intended pattern: in-flight jobs (already past `linkEscrow`) continue to completion. New incoming jobs are blocked until `resume()`. If you need true drain semantics, pause is the wrong surface — let in-flight settle, then `stop()`.
5. **Custom polling cadence:** if you operate multiple providers sharing one RPC endpoint, set `pollingInterval: 2000` (or higher) in the `BlockchainRuntime` constructor. The 1000 ms default optimizes for single-agent latency at the cost of RPC reads per agent.
6. **Public RPC endpoints:** Public RPCs (Infura free, Cloudflare, etc.) enforce polling floors of 2–3 s. If you set `BASE_SEPOLIA_RPC` to a public endpoint, the SDK's 1000 ms default will be throttled or rejected. Use Alchemy or another tier-1 provider for predictable behavior.
7. **`actp pay --service` users:** the flag never existed in the SDK; some downstream tools may have shimmed it. Drop the flag, or migrate that flow to `actp request`.
8. **`actp test` consumers in CI:** `actp test` now requires Base Sepolia connectivity + small ETH float for gas. Mock-only environments must instead use the SDK directly with `MockRuntime`.

### Sentinel canary (Phase 0)

After 4.0.0-beta.0 publishes:

1. Bump Sentinel's `package.json` to `4.0.0-beta.0`, deploy to Railway staging.
2. From a clean dev machine, run `npx actp test` 10× over 24 h. Confirm: every call delivers a reflection, every TX walks to `SETTLED`, no error logs.
3. Promote `4.0.0-beta.0` → `4.0.0` GA on npm.
4. Sentinel production deploy bumps to `^4.0.0`.

---

## 8. Testing strategy

The SDK has **zero** `BlockchainRuntime` e2e tests today. 4.0.0 ships the first suite.

### 8.1 Unit tests (added)

- `BlockchainRuntime.getTransactionsByProvider`: stubbed `EventMonitor` + stubbed `getTransaction`. Assert filter, limit, hash field present, mapping correctness.
- `BlockchainRuntime.getTransaction`: returns populated `serviceHash`.
- `Agent.findServiceHandler`: hash match path; missing-hash returns undefined; `ZeroHash` returns undefined; string fallback path still works for MockRuntime test fixtures.
- `Agent.provide`: duplicate service name throws.
- `Agent.start` called twice on running agent: noop with warn log, no duplicate subscription created.
- `Agent.pause` + `Agent.resume`: subscription cleanup called; no duplicate subscriptions after resume; idempotent re-pause / re-resume.
- `Agent.handleIncomingTransaction`: idempotent — same `tx` twice does not double-process; if handler throws, `processingLocks` is released (assert `processingLocks.has(tx.id) === false` after rejection).
- `actp agent` watchTimer: transient quote failure leaves TX out of `seen`, retries next sweep; `inflight` prevents concurrent re-entry within one sweep.
- `EventMonitor.getTransactionHistory(range)`: explicit `range` flows through to `queryFilter`.
- `resolveAgent`: env var override path; invalid address in env var throws `InvalidAgentAddressError`; unknown slug throws `AgentNotFoundError`; constant table fallback returns `source: 'table'`.
- `actp pay --service` rejection: exits with code 64 and canonical error message.
- `keccak256(toUtf8Bytes('onboarding'))` equals both the transaction `serviceHash` used by `actp request` and the AgentRegistry `serviceTypeHash` Sentinel publishes — explicit constant assertion test, no regression once committed.

### 8.2 Anvil-forked e2e tests (added)

**Location:** `src/__e2e__/blockchain-runtime/`
**Approach:** Anvil **pinned version** (declared in `package.json` `devDependencies` + `engines`) forked from Base Sepolia at a fixed block. Enables `evm_setNextBlockTimestamp` for dispute-window fast-forward (kernel min 1h, per `ACTPKernel.sol:52`).

**Setup:**
- One BIP-39 mnemonic stored as GitHub Secret `CI_TEST_KEYSTORE_BASE64`. HD-derived child wallets per test slot.
- Anvil started in CI with `--fork-url $BASE_SEPOLIA_RPC --fork-block-number <pinned>`.
- `MockUSDC.mint(addr, amount)` for USDC funding.
- `evm_setNextBlockTimestamp(now + 3601)` + `evm_mine` to settle past dispute window.

**Test cases (all must pass for 4.0.0 GA):**

1. **Subscription delivery:** requester `actp request`s; provider's `agent.on('job:received')` fires within 5 s.
2. **Catch-up sweep happy path:** provider boots after the requester's tx (same fork block); `pollForJobs` recovers within 10 s.
3. **Catch-up sweep boundary:** TX created at `currentBlock - 7201`; sweep with default window does NOT recover. Documents the operational boundary. Operators are warned via §7 bullet 5.
4. **Hash routing happy path:** `agent.provide('onboarding', h1)` + `agent.provide('translate', h2)` + incoming `request --service translate` → only `h2` fires.
5. **Hash routing miss:** incoming TX with unknown `serviceHash` → no handler fires, agent logs warning with `reason: 'no_handler_for_hash'`, does not crash.
6. **`pay` ignored at routing:** ZeroHash → no handler dispatched; agent logs `reason: 'pay_zerohash_ignored'` for observability.
7. **Subscription state guard:** simulate subscription firing for a TX that was CANCELLED by the requester before hydration → handler not dispatched, no error emitted.
8. **Concurrent requests:** 3 requesters submit in parallel; provider receives all 3, handlers run, all `SETTLED`.
9. **Full state walk:** `INITIATED → QUOTED → COMMITTED → IN_PROGRESS → DELIVERED → SETTLED` with time-travel for 1h dispute window.
10. **Pause stops events:** request submitted while agent paused → no `job:received` fires; resume → catch-up sweep picks it up.
11. **Pause exceeds deadline:** TX submitted with 30-min deadline; agent paused 35 min via `evm_setNextBlockTimestamp`; agent resumes; sweep finds TX; assert handler logs `reason: 'deadline_expired'` and skips `linkEscrow` (which would revert).
12. **Multi-handler error isolation:** `provide('a', throwingHandler)` + `provide('b', goodHandler)`. Request for `a` fails; subsequent request for `b` succeeds. Assert `processingLocks` clean between.
13. **Quote retry:** orchestrator.quote throws once, then succeeds; TX walks to QUOTED on second sweep; `seen` reflects only after success.
14. **Start-twice idempotence:** `await agent.start(); await agent.start();` — only one subscription active (verify via internal handle count).
15. **Handler throws → dedup released:** simulate handler throwing; assert `processingLocks.has(tx.id) === false` after error emission; because `processedJobs` was not set, retry is desired, so verify the second sweep DOES re-process.
16. **RPC drop:** poison provider URL mid-test; surfaced via `agent.on('error')` without crash.

**Skip pattern:** `describe.skip` when `CI_TEST_KEYSTORE_BASE64` is absent.

### 8.3 Real-network e2e — nightly + release tags

A separate `npm run test:base-sepolia` suite hits the real Base Sepolia testnet. **Runs on nightly CI cron (not just release tags)** — the original bug was undetected precisely because no real-chain test ever ran. Nightly cadence provides early signal on Alchemy behavior, eventual-consistency races, and finality differences that Anvil fork doesn't replicate.

Test cases (real-network):
- **R1:** `npx actp test` against deployed Sentinel — full walk to SETTLED using requester-side immediate settlement after delivery. A separate slow-path assertion may verify non-requester settlement only after the dispute window.
- **R2:** Boot provider against fresh INITIATED TX; assert subscription picks it up within real Alchemy polling cadence.

### 8.4 CI integration

`.github/workflows/ci.yml`:

- **PR jobs:** unit + anvil-fork e2e (~3 min total).
- **`push: main`:** above + sentinel canary check.
- **Nightly cron (`0 4 * * *` UTC):** real-network e2e suite (~5 min for requester-side settlement; optional slow-path dispute-window test can run separately).
- **Release tags:** full suite.

`jest.config.js` `projects` split: `unit`, `blockchain-fork-e2e`, `blockchain-real-e2e`.

**Cost analysis:** Anvil fork e2e free (local). Real-network e2e on Base Sepolia: 6 state transitions × ~150k gas × 0.001 gwei effective ≈ 0.0009 ETH per full walk × 1 nightly run = ~0.027 ETH/month ≈ $0.10/month at current Sepolia ETH (zero monetary cost).

---

## 9. Rollout plan

**Version:** `4.0.0` — major bump (breaking interface + breaking type + breaking CLI + behavior changes).

**Sequence:**

1. Branch: `feat/4.0.0-event-driven-provider-listening`.
2. Implement §5.1–5.11 in commit order:
   - 5.1 interface change (required method)
   - 5.5 EventMonitor range param
   - 5.2 BlockchainRuntime impl + `MockTransaction` type extension + constructor options
   - 5.4 Agent hash-routing
   - 5.3 Agent subscription + pause/resume + idempotent start + try/finally
   - 5.11 ServiceDescriptor doc-comment fix
   - 5.6 `actp request` command + `--quote-timeout`
   - 5.7 `actp test` rewrite + `resolveAgent` with env-var override
   - 5.8 `actp agent` CLI fixes
   - 5.9 `actp pay --service` rejection
   - 5.10 `actp serve` docstring
3. Unit suite passes locally.
4. Anvil-fork e2e suite passes locally with `CI_TEST_KEYSTORE_BASE64=... npm run test:fork-e2e`.
5. Open PR. CI runs unit + fork-e2e.
6. Publish `4.0.0-beta.0` from branch.
7. Sentinel canary: bump dep to `4.0.0-beta.0`, deploy to Railway staging, run `npx actp test` 10× over 24 h, confirm all reflections delivered + all SETTLED.
8. Nightly cron picks up real-network e2e for 3 nights pre-GA; zero failures required.
9. Promote to `4.0.0` GA on npm.
10. Update [`AGIRAILS.md`](../../../../Platform/agirails.app/web/public/protocol/AGIRAILS.md) Quick Start to document `actp request` + `actp test` on real chain.
11. Publish `docs/MIGRATION-4.0.md`.

**Estimated effort:** 5–6 dev days + 1 day test infra + 3 days nightly observation + 24 h Sentinel canary ≈ 9–10 calendar days.

---

## 10. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Subscription + sweep dedup race | Low | Med | `processingLocks` (Set, `finally`-released) + `processedJobs` (LRUCache) handle both paths atomically. Test cases 14–15 verify. |
| RPC `queryFilter` rate limits on Alchemy free tier | Med | Med | Bounded `fromBlock` window (default 7200, configurable). Document Alchemy paid tier for production in MIGRATION-4.0. |
| WSS connection drops (if user opts in) | Med | Med | Catch-up sweep absorbs subscription gap. |
| Container restart > sweepBlockWindow elapsed | Low | Med | Sweep window tunable; default 7200 blocks (~4h on Base L2). Operators with longer restart cycles configure higher window. Documented in MIGRATION-4.0 + test case 3. |
| `actp pay --service` rejection surprises | Med | Low | Canonical directive error message in §5.9. Migration doc bullet 7. Was never a real surface in 3.5.3. |
| Sentinel address rotation breaks `actp test` | Low | High | `ACTP_SENTINEL_ADDRESS` env var override (§5.7). Future: on-chain `AgentRegistry.resolveAgent`. |
| Sentinel `keccak256('onboarding')` hash mismatch with `actp request --service onboarding` | Low | High | Same `keccak256(toUtf8Bytes(name))` formula across all 4 call sites (Agent.provide, request CLI, AgentRegistry.computeServiceTypeHash, publishPipeline). Explicit unit test asserts the constant matches Sentinel's published hash. |
| `getTransaction` fails to populate `serviceHash` correctly | Low | High | Hard-required for Layer B. Unit test asserts presence on every hydration. Anvil e2e test 4 (hash routing) catches end-to-end. |
| Stale `dist/` after Sentinel SDK bump (forgotten `npm run build`) | Med | Med | Migration doc step explicit. Sentinel CI / Dockerfile rebuild on every deploy regardless. |
| Custom downstream runtimes break on upgrade | Med | Low | Compile-time error is the feature, not a bug. Migration doc bullet 2. |
| Anvil version drift across CI / local | Med | Med | Pinned version in `package.json` + `engines` field. CI step verifies installed anvil matches pin. |
| Public RPC polling-floor throttling | Med | Med | MIGRATION-4.0 bullet 6 documents the polling-floor caveat. |
| Contract address drift between docs and `networks.ts` | Med | Low | Tests defer to `getNetwork('base-sepolia')`. CHANGELOG note. |
| Kernel doesn't support requester-immediate settlement (blocks <15s `actp test` target) | Verified false | High | Verified against [`ACTPKernel.sol:700-704`](../../../Protocol/actp-kernel/src/ACTPKernel.sol#L700-L704): `_enforceTiming` only requires `block.timestamp > txn.disputeWindow` when `msg.sender != txn.requester`. Requester can call `DELIVERED → SETTLED` immediately. R1 e2e test asserts this path. |

---

## 11. Out of scope / future work

- **V2 generic on-chain indexer** (`BlockchainRuntime.getAllTransactions`).
- **`lastSeenBlock` persistence** across restarts.
- **IN_PROGRESS recovery** after container death mid-handler.
- **Per-provider service-name namespace** (`keccak256(provider || name)`) — current shared namespace is fine for the first dozen providers; revisit before registry has hundreds.
- **Off-chain metadata CID resolver**.
- **AgentRegistry on-chain `resolveAgent`** — replaces hardcoded constant table.
- **WSS as default transport** — opt-in only in 4.0.0.
- **Multi-replica provider support**.
- **`actp serve` subscription wiring**.
- **`actp pay` reputation/preauth**.
- **True drain-on-pause semantics** — explicit `agent.drain()` API as alternative to bug-coincidence pattern.
- **`agirails.request.v1` envelope** — signed requester→provider payload on `NegotiationChannel` carrying arbitrary `input` / `metadata` for the handler. Adds a fourth member to the `NegotiationMessage` discriminated union, a new builder/verifier in `src/builders/`, and provider-side subscription + envelope-arrival timing on top of on-chain `INITIATED` detection. Deferred because Sentinel's covenant ("any JSON or empty") does not need it; future providers needing arbitrary requester input must wait for this envelope.

---

## Appendix A — Files touched (summary)

| File | Change | LOC est. |
|---|---|---|
| `src/runtime/IACTPRuntime.ts` | Add `getTransactionsByProvider` to interface (required) | +15 |
| `src/runtime/types/MockState.ts` | Add `serviceHash: string` field to `MockTransaction` | +2 |
| `src/runtime/BlockchainRuntime.ts` | `getTransactionsByProvider` + `subscribeProviderJobs` + constructor options + `getTransaction` populates `serviceHash` + WSS transport | +100 |
| `src/runtime/MockRuntime.ts` | `createTransaction` stores `serviceHash` derived from `serviceDescription`; provider comparisons normalized | +8 |
| `src/level1/Agent.ts` | Subscription wiring, pause/resume cleanup, idempotent start, `try/finally` dedup, hash routing | +80 / -30 |
| `src/protocol/EventMonitor.ts` | Optional `range` param on `getTransactionHistory`; attach log ordering metadata | +10 |
| `src/level0/request.ts` | Stop hashing JSON metadata as routing key; pass service-name hash on-chain and use relay payload for input | +20 / -10 |
| `src/negotiation/BuyerOrchestrator.ts` | Same service-name hash fix for requester-created TXs | +15 / -5 |
| `src/cli/commands/pay.ts` | Reject `--service` with directive error | +15 |
| `src/cli/commands/request.ts` | **New** — Level 1 CLI surface + `--quote-timeout` | +200 |
| `src/cli/commands/test.ts` | Rewrite for real Sentinel hit | +120 / -100 |
| `src/cli/commands/agent.ts` | `getTransactionsByProvider` + `inflight` set + retry | +20 / -15 |
| `src/cli/commands/serve.ts` | Docstring update | +3 / -3 |
| `src/cli/lib/runRequest.ts` | **New** — shared requester flow used by `actp request` and `actp test` | +120 |
| `src/cli/lib/resolveAgent.ts` | **New** — slug resolver with env-var override | +55 |
| `src/types/agent.ts` | Fix misleading hash doc-comment | +1 / -1 |
| `src/__e2e__/blockchain-runtime/` | **New** — 16 anvil-fork e2e tests | +600 |
| `src/__e2e__/blockchain-real/` | **New** — 2 nightly real-network e2e tests | +180 |
| `src/__e2e__/helpers/anvil-fork-helpers.ts` | **New** | +180 |
| `jest.config.js` | Projects split (unit, fork-e2e, real-e2e) | +35 / -10 |
| `package.json` | Bump 4.0.0, scripts, anvil pinned dep, engines | +8 / -1 |
| `.github/workflows/ci.yml` | PR jobs + main + nightly cron + release-tag jobs | +90 |
| `docs/MIGRATION-4.0.md` | **New** | +250 |
| `CHANGELOG.md` | 4.0.0 entry | +75 |
| **Total** | | **+2200 / -175** |

## Appendix B — CHANGELOG 4.0.0 entry (draft)

```markdown
## [4.0.0] — 2026-05-XX

### BREAKING

- `IACTPRuntime`: added required method `getTransactionsByProvider(provider, state?, limit?)`.
  Custom runtime implementers must add this method. Compile-time enforced — TypeScript will
  surface this as a build error on upgrade. See `docs/MIGRATION-4.0.md`.
- `MockTransaction` type: added required field `serviceHash: string`. Direct constructors
  of `MockTransaction` objects (e.g. in test fixtures) must include this field. Compile-time
  enforced.
- `actp pay` CLI: `--service` flag is parsed only to reject with a directive error. For
  negotiated Level 1 job flow, use the new `actp request` command instead. (See Fixed.)
- `actp test` CLI: now hits the real deployed Sentinel on Base Sepolia. Previously used
  `MockRuntime`. Requires `BASE_SEPOLIA_RPC` env var and a small ETH float. `ACTP_SENTINEL_ADDRESS`
  env var available as override (rotation escape hatch).
- `Agent.pause()` / `Agent.resume()`: now correctly stop/restart subscriptions on
  `BlockchainRuntime`. Code that relied on the previous bug (paused agent still receiving
  events) will see different behavior. See Fixed and `docs/MIGRATION-4.0.md` bullet 4.

### Added

- `actp request <provider> <amount> --service <name>` — Level 1 negotiated job flow CLI.
  Supports `--quote-timeout` (default 30s), `--deadline`, `--auto-accept`.
  `--input` / `--metadata` are deferred — they require a new `agirails.request.v1`
  envelope on `NegotiationChannel`, which is out of scope for 4.0.0 (see §11).
  Provider-side `job.input` is `{}` for all on-chain-sourced jobs in 4.0.0.
- `Agent.provide(name, handler)` is now keyed by `keccak256(toUtf8Bytes(name))`. Same external
  signature; routing matches against on-chain `serviceHash`.
- `BlockchainRuntime` constructor options: `sweepBlockWindow`, `pollingInterval`, `transport`
  ('http' | 'wss'), `wssUrl`.
- `BlockchainRuntime.subscribeProviderJobs(provider, onJob)` — private subscription wired
  into `Agent.start()` / `Agent.resume()`. Re-validates `state === 'INITIATED'` after hydration
  to absorb INITIATED→CANCELLED races.
- `resolveAgent(slug, network)` helper with `ACTP_SENTINEL_ADDRESS` env-var override path.
- `EventMonitor.getTransactionHistory(addr, role, range?)` — optional range param.
- First `BlockchainRuntime` e2e suite: 16 anvil-fork tests gated on `CI_TEST_KEYSTORE_BASE64`,
  plus 2 nightly real-network tests against Base Sepolia.

### Changed

- `BlockchainRuntime` provider `pollingInterval` defaults to `1000ms`. Multi-agent operators
  should configure `2000ms` or higher; public RPC endpoints have polling floors.
- `BlockchainRuntime.getTransaction()` now populates `serviceHash` on the returned
  `MockTransaction`.
- `Agent.start()` is now idempotent — double-start is a logged noop, no duplicate subscription.
- `Agent.handleIncomingTransaction()` releases `processingLocks` in a `finally` block.
  Poison TXs no longer permanently occupy slots.
- `Agent.pollForJobs()` calls `runtime.getTransactionsByProvider()` directly.
- `actp agent` CLI: uses `getTransactionsByProvider`. Transient quote failures no longer mark
  TXs as `seen` — they are retried on the next sweep via an `inflight` set.
- Requester surfaces (`actp request`, `level0/request.ts`, `BuyerOrchestrator`) put the
  service-name hash on-chain as `serviceHash`. In 4.0.0, no requester-supplied input or
  metadata is carried — `job.input` is `{}`. A future `agirails.request.v1` envelope on
  `NegotiationChannel` will add that path (out of scope; tracked under §11).
- `actp serve` docstring updated.
- Doc-comment fix: `ServiceDescriptor.hash` formula is `keccak256(toUtf8Bytes(serviceType))` —
  no `.toLowerCase()`. Comment in `src/types/agent.ts` corrected.

### Fixed

- `Agent.provide()` on Base Sepolia / Base Mainnet now actually delivers `job:received`
  events and dispatches to the correct handler. Previously a three-layer silent failure
  (transport, routing, job semantics).
- Hash routing no longer fails due to JSON metadata hashing. Before this PR, requester paths
  could pass `{"service":...}` as `serviceDescription`; `BlockchainRuntime` then hashed the
  whole JSON object, producing a value that could never match `agent.provide(serviceName)`.
- `Agent.pause()` no longer leaves a live subscription firing handlers in the background.
  (Listed under BREAKING because consumers may have relied on this bug. Cross-reference.)
- `actp agent` no longer permanently loses TXs to transient quote failures.
- `actp agent` no longer silently sees zero transactions on real chains — was 100% non-functional
  on `BlockchainRuntime` since 3.x introduction.

### Migration

See `docs/MIGRATION-4.0.md` for upgrade steps. Sentinel and other internal consumers require
only a `package.json` version bump + `npm run build`.
```

---

## Appendix C — Decision log

### A.1 Service routing: hash matching vs CID resolution

**Decision:** Hash matching (`tx.serviceHash` → `Map<bytes32, handler>`), with shared global namespace for service names in 4.0.0.

**Considered:** Off-chain IPFS CID resolver. Per-provider namespace via `keccak256(provider_address || name)`.

**Rationale:** Hash matching is fully on-chain, requires no new dependencies, and matches the existing publish flow. Per-provider namespace is the right long-term answer but unnecessary while the registry has fewer than ~dozens of providers — collisions are statistically negligible until the population grows.

**Acknowledged limitation:** `keccak256('translate')` is identical for every provider. Two providers cannot independently disambiguate their offerings at the routing layer. Future 4.x versions will scope to `keccak256(provider || name)`. Documented as out-of-scope (§11) explicitly, not silently deferred.

**Adversarial-injection safety:** A requester sending a fabricated `serviceHash` that doesn't match any registered handler → `findServiceHandler` returns undefined → TX logged with `reason: 'no_handler_for_hash'` and skipped. No info leakage, no crash.

### A.2 `actp pay` vs new `actp request`

**Decision:** New `actp request` command. `actp pay` stays a Level 0 primitive with `--service` parsed only to reject.

**Considered:** Refactor `actp pay --service` to internally invoke Level 1 flow.

**Rationale:** State machine separates Level 0 (`pay` → COMMITTED immediately) from Level 1 (`request` → INITIATED → QUOTED → COMMITTED). The CLI mirrors this. `request` is the honest surface for negotiated work.

**Trade-off accepted:** Two CLI commands. The directive error message points users to the correct command. Off-chain analytics labeling for `pay` calls is removed in 4.0.0 with no current replacement (out of scope §11).

### A.3 Polling interval default

**Decision:** Override ethers default from 4000ms to 1000ms in `BlockchainRuntime`. Configurable via constructor. Multi-agent and public-RPC caveats documented in MIGRATION-4.0.

**Considered:** Keep ethers default; document WSS opt-in. Default to 2000ms as a compromise.

**Rationale:** Sentinel canary needs 1–2 s latency for usable onboarding UX. The trade-off cost is RPC reads — negligible for single-agent on Alchemy paid tier, but real for multi-agent or public-RPC operators. Migration doc bullets 5 + 6 make this explicit.

**Trade-off accepted:** Default optimizes for the Sentinel onboarding case. Multi-agent operators must opt out.

### A.4 Dispute-window testing strategy

**Decision:** Anvil **pinned version** forked from Base Sepolia, with `evm_setNextBlockTimestamp` for time travel. Real-network e2e on **nightly cron** (not just release tags) + release tags.

**Considered:** Test directly on Base Sepolia with `disputeWindow: 1` (v1 PRD — invalid). Real-network e2e only on release tags (v2 — insufficient coverage given that the original bug was undetected for the same reason).

**Rationale:** Anvil fork gives deterministic, fast, free time-travel for the full state walk. Nightly real-network e2e provides early signal on Alchemy behavior, RPC eventual-consistency, and finality races that Anvil doesn't replicate. Pinned anvil version prevents reproducibility regressions from upstream anvil releases.

### A.5 Drop `BaseACTPRuntime`

**Decision:** No abstract base class with default-throw implementations. `IACTPRuntime` carries the required method; TypeScript compile-time enforcement is the contract.

**Considered:** Ship `BaseACTPRuntime` with `getTransactionsByProvider` throwing `NotImplementedError` by default, framed as "easing migration."

**Rationale:** Converting a compile-time contract violation into a runtime exception hides the requirement exactly when the implementer is most equipped to find it. A downstream consumer extending `BaseACTPRuntime` and shipping without override gets a green build, passing unit tests against `MockRuntime`, and a production crash on the first real-chain call. That is strictly worse than a compile-time error during upgrade. The 100-year hyperstructure test prefers auditability — TypeScript types are more auditable than runtime errors.

### A.6 Sentinel address resolution

**Decision:** Hardcoded constant table with `ACTP_SENTINEL_ADDRESS` env-var override path. Future: on-chain `AgentRegistry.resolveAgent`.

**Considered:** Hardcoded constant only (v2 — silent outage vector on Sentinel rotation). Remote fetch at SDK build time (fragile).

**Rationale:** Constant table is fine for the default path. Env var override is the rotation escape hatch — if Sentinel's wallet is compromised or rotated, operators set `ACTP_SENTINEL_ADDRESS` to the new address without waiting for an SDK republish. On-chain registry is the eventual answer but adds complexity not justified in 4.0.0.

---

*PRD v5 complete. Addresses six HIGH and seven MED findings from v2 adversarial review, v3 code-alignment gaps against the current SDK/contracts, and v4 final-check findings (kernel ABI verification for requester-immediate settle, return-type widening, request-envelope deferral, chainId source, JSDoc visibility note, cosmetic cleanup). Implementation owner: TBD. Estimated effort: 9–10 calendar days end-to-end.*
