# Migrating to `@agirails/sdk@4.0.0`

> **Why this version is breaking.** SDK ≤ 3.5.3 shipped a silent failure: provider agents on Base Sepolia and Base Mainnet never saw incoming jobs, because three independent layers — transport, routing, and job semantics — were each broken in a way that masked the others. 4.0.0 fixes the full stack, but doing so required surface-level breaking changes across the runtime interface, the `MockTransaction` type, two CLI commands, and a handful of behaviors that consumers were inadvertently relying on. This document walks every change with a concrete migration recipe.
>
> The protocol-level invariants (8-state machine, escrow solvency, fee bounds, deadlines, access control) are unchanged.

The full design rationale is in [`PRD-event-driven-provider-listening.md`](./PRD-event-driven-provider-listening.md). This document is the **what-to-do** companion.

---

## TL;DR

If you are a typical consumer (Sentinel-style provider, simple CLI user, no custom runtime), the upgrade is:

```bash
npm install @agirails/sdk@^4.0.0
npm run build
```

Your provider source code does not need to change. You only need to read this document if any of the following apply:

- You implemented your own `IACTPRuntime` (subclass / port).
- You construct `MockTransaction` objects directly in test fixtures.
- You depend on `Agent.pause()` continuing to receive jobs (the prior bug).
- You passed `options.input` to `level0/request()` or `Agent.request()` expecting it to reach the provider's handler.
- You ran `actp test` in CI against a `MockRuntime` shim.
- You called `actp pay --service ...` (the flag never officially existed; if you shimmed it locally, see §7).
- Your `actp tx list` workflows depend on listing all-on-chain transactions.

---

## 1. Bump the dependency

```jsonc
// package.json
{
  "dependencies": {
    "@agirails/sdk": "^4.0.0"
  }
}
```

Required: **Node ≥ 18.17**. The SDK uses `ethers` v6.15 conventions; older Node versions are not supported.

```bash
npm install
npm run build   # if you have a build step — TypeScript will surface every breaking change at this point
```

---

## 2. Custom `IACTPRuntime` implementations — add `getTransactionsByProvider`

If you wrote your own runtime class (e.g. for a custom chain or a database-backed mock), TypeScript will fail your build with:

```
error TS2420: Class 'YourRuntime' incorrectly implements interface 'IACTPRuntime'.
  Property 'getTransactionsByProvider' is missing
```

The new required method:

```typescript
/**
 * Returns transactions where the given address is the `provider`,
 * optionally filtered by state. Provider comparisons are case-insensitive
 * — implementations normalize both stored and queried addresses to
 * lowercase before comparing.
 */
getTransactionsByProvider(
  provider: string,
  state?: TransactionState,
  limit?: number
): Promise<MockTransaction[]>;
```

Reference implementations:

- In-memory / mock data → mirror [`MockRuntime.getTransactionsByProvider`](../src/runtime/MockRuntime.ts).
- Event-sourced / on-chain → mirror [`BlockchainRuntime.getTransactionsByProvider`](../src/runtime/BlockchainRuntime.ts) (bounded `EventMonitor.getTransactionHistory` sweep + per-tx hydration).

The previous `getAllTransactions()` method is still on the interface but remains a no-op on `BlockchainRuntime`. The 4.0.0 callers (`Agent.pollForJobs`, `actp agent` watch loop) all moved to `getTransactionsByProvider`.

---

## 3. Direct `MockTransaction` constructors — add `serviceHash`

`MockTransaction` now requires a `serviceHash: string` field. If you construct the type directly anywhere — typically in test fixtures — TypeScript will flag the gap:

```
error TS2741: Property 'serviceHash' is missing in type ...
```

For fixtures that don't care about routing, use ZeroHash:

```typescript
import { ZeroHash } from 'ethers';

const tx: MockTransaction = {
  // ... existing fields ...
  serviceHash: ZeroHash,
};
```

For fixtures that DO need routing (e.g. you're testing `Agent.findServiceHandler`), use the same hash formula `Agent.provide(name)` uses:

```typescript
import { keccak256, toUtf8Bytes } from 'ethers';

const tx: MockTransaction = {
  // ... existing fields ...
  serviceHash: keccak256(toUtf8Bytes('your-service-name')),
};
```

`MockStateManager.loadState()` auto-backfills `serviceHash` for state files persisted by SDK ≤ 3.5.3 — you do **not** need to delete `.actp/mock-state.json` when upgrading.

---

## 4. `Agent.pause()` consumers — drain-on-pause pattern

**Behavior change.** SDK ≤ 3.5.3 had a silent bug: `Agent.pause()` stopped polling but left the on-chain event subscription alive. A "paused" provider would silently keep receiving and dispatching jobs through the subscription path.

4.0.0 correctly stops both paths.

**If you relied on the bug** (e.g., to "drain" pending work by pausing and waiting for incoming jobs to finish), update your shutdown sequence:

```typescript
// Old (silently broken in 3.x):
agent.pause();           // expected: incoming jobs still finish
await waitFor(condition);

// New (4.0.0):
//   - in-flight jobs (already past linkEscrow) complete to DELIVERED.
//   - NEW incoming jobs are blocked until resume() or stop().
//   - For "drain" semantics, let in-flight settle, then stop().
agent.pause();
await agent.drainActiveJobs();   // your own logic, await on activeJobs.size === 0
await agent.stop();
```

A future `agent.drain()` API is on the roadmap for explicit drain semantics. Until then, the in-flight check above is the supported pattern.

Related: `Agent.start()` is now idempotent. Calling `start()` on an already-running or paused agent is a logged noop instead of throwing `AgentLifecycleError`.

---

## 5. Custom `BlockchainRuntime` polling cadence

`BlockchainRuntime` now defaults to `pollingInterval = 1000ms` (down from ethers' 4000ms default). This tightens subscription latency for single-agent operators like Sentinel.

**Multi-agent operators** sharing one RPC endpoint should raise the interval:

```typescript
const runtime = new BlockchainRuntime({
  network: 'base-sepolia',
  signer,
  provider,
  pollingInterval: 2000,   // lower RPC consumption per agent
  sweepBlockWindow: 7200,  // ~4h on Base L2 — tune for your container restart cadence
});
```

For multi-tenant infrastructure with 10+ agents on one wallet, prefer 3000–5000 ms.

---

## 6. Public RPC endpoints — polling floors

Public RPCs (Infura free tier, Cloudflare, public.base-sepolia.io) enforce minimum polling intervals of **2–3 seconds** and may rate-limit or reject the SDK's 1000 ms default.

If you set `BASE_SEPOLIA_RPC` to a public endpoint:

```bash
# Either explicitly raise pollingInterval in code (preferred):
new BlockchainRuntime({ ..., pollingInterval: 3000 });

# Or use a tier-1 provider (Alchemy, Infura paid, etc.) for predictable behavior.
```

The symptom of hitting a polling floor is intermittent 429s in logs and missed subscription events. The SDK does not auto-detect the floor — you must configure it.

---

## 7. `actp pay --service` users

`actp pay` is a Level 0 primitive. It commits funds to a provider address with no handler routing. `--service` never officially existed on `actp pay`; if you (or a downstream tool) added it locally, 4.0.0 parses the flag specifically to reject it:

```bash
$ actp pay 0xProvider 5 --service onboarding
Error: 'actp pay' is a Level 0 primitive and does not accept --service.
For negotiated Level 1 job flow (where a provider's handler runs after quote/accept),
use 'actp request <provider> <amount> --service <name>' instead.
See https://agirails.io/docs/sdk/level-0-vs-level-1
```

Exit code is **64** (`EX_USAGE` from `sysexits.h`) so scripts can distinguish a usage error from a generic ACTP failure:

```bash
actp pay "$ADDR" "$AMOUNT" --service "$SVC"
case $? in
  0)  echo "ok" ;;
  64) echo "usage error — switch to actp request" ;;
  *)  echo "ACTP failure: $?" ;;
esac
```

The migration: replace the `pay --service` call with `actp request <provider> <amount> --service <name>`. See §10 below for the full new command.

---

## 8. `actp test` consumers in CI

**Pre-4.0.0:** `actp test` ran a `MockRuntime` simulation of the earning loop. It worked offline, in any directory, with any agent config.

**4.0.0:** `actp test` runs a real ACTP Level 1 request against the deployed Sentinel agent on Base Sepolia. It requires:

1. **A funded testnet wallet** at `~/.actp/wallets/base-sepolia` (created by `actp init`) **or** `ACTP_KEYSTORE_BASE64` env var.
2. **Small Base Sepolia ETH** for gas (the SDK estimates ~0.001 ETH per full state-machine walk).
3. **Small Base Sepolia USDC** for the $0.05 escrow.
4. **Base Sepolia RPC reachable** — defaults to the SDK's bundled URL; override with `BASE_SEPOLIA_RPC` if needed.

If any of these are missing, `actp test` exits with a clear setup error and a 3-step remediation hint.

**Mock-only CI environments** that previously relied on `actp test` for offline assertion must switch to direct SDK usage with `MockRuntime`:

```typescript
import { ACTPClient, MockRuntime, Agent } from '@agirails/sdk';

const runtime = new MockRuntime();
const client = await ACTPClient.create({ mode: 'mock', requesterAddress: '0xRequester' });
// Compose your test against the runtime directly.
```

If you maintained a CI job that ran `actp test --mock` or similar, that flag no longer exists.

---

## 9. `level0/request()` callers — `options.input` deferral

The Level 0 simple-API `request()` function (also reached via `Agent.request()`) still accepts `options.input` for forward compatibility, but **4.0.0 does not transport it to the provider**. A warning fires on each call:

```
options.input is not transported in 4.0.0 — handler will receive job.input = {}.
A future agirails.request.v1 envelope will restore this path. See PRD §11.
```

**Why:** the only on-chain field that travels with a request is the bytes32 `serviceHash`. The pre-4.0.0 implementation passed JSON (`{service, input, timestamp}`) as `serviceDescription`, which `BlockchainRuntime` then hashed wholesale — producing an on-chain `serviceHash` that could never match a provider's `Agent.provide(name)` hash. Routing was silently broken on real chains. 4.0.0 puts the canonical hash on-chain instead and drops the JSON envelope.

A future `agirails.request.v1` signed envelope on `NegotiationChannel` will restore the input-transport path. Until then:

- **Provider-side**, write your handler to tolerate `job.input === {}`. If your service needs requester data, the requester must coordinate it via a side channel (HTTP webhook, AGIRAILS chat, etc.) keyed by `txId`.
- **Requester-side**, drop the `options.input` argument until the envelope ships.

---

## 10. New `actp request` command — the Level 1 surface

The negotiated Level 1 job flow has its own CLI:

```bash
actp request <provider> <amount> --service <name> \
  [--deadline <iso-or-unix>] \
  [--quote-timeout <ms>] \
  [--delivery-timeout <ms>] \
  [--no-auto-accept] \
  [--network mock|testnet|mainnet] \
  [--json] [-q | --quiet]
```

Differences from `actp pay`:

| Aspect | `actp pay` (Level 0) | `actp request` (Level 1) |
|---|---|---|
| On-chain | INITIATED → COMMITTED in one step | INITIATED → QUOTED → COMMITTED → DELIVERED → SETTLED |
| Routing | `serviceHash = ZeroHash` | `serviceHash = keccak256(toUtf8Bytes(name))` |
| Provider handler | None — funds are committed directly | Provider's `agent.provide(name)` handler runs |
| Quote timeout | N/A | `--quote-timeout` (default 30s); exit code 2 if exceeded |
| Settle | Provider settles after dispute window | Requester settles immediately on DELIVERED (kernel allows this) |

**Programmatic equivalent**: `runRequest({...})` from `@agirails/sdk/cli/lib/runRequest`. Same lifecycle, same timeouts.

---

## 11. `actp tx list` on real chains

`actp tx list` previously returned all on-chain transactions in memory via `getAllTransactions()`. On `BlockchainRuntime` that method is a no-op returning `[]` — the on-chain view is per-address, not global.

4.0.0 emits a clear warning when the list is empty against a `BlockchainRuntime`:

```
[!] actp tx list is not yet supported on testnet/mainnet — the on-chain
    view is per-address, not global. For known txIds use 'actp tx status <txId>';
    for live monitoring use 'actp watch'. A full event-indexed list will land
    in a follow-up.
```

The list command still works fully against `MockRuntime` (offline mode). For real-chain transaction lookups, use:

- `actp tx status <txId>` — single-tx status by ID.
- `actp watch` — live transaction monitoring.

An event-indexed global list will arrive in a 4.x point release.

---

## 12. Sentinel address rotation (`ACTP_SENTINEL_ADDRESS`)

`actp test` resolves Sentinel via a built-in constant table mapping `'sentinel'` → its deployed Base Sepolia address. The address ships baked into every SDK release.

If Sentinel rotates its wallet — key compromise, scheduled migration, or any operational reason — set the environment variable to point at the new deployment without waiting for an SDK republish:

```bash
export ACTP_SENTINEL_ADDRESS=0x<new-sentinel-address>
actp test
```

The override takes precedence over the constant table. The `actp test` output includes `source: 'env'` or `source: 'table'` so operators can see which path resolved.

Empty-string or whitespace-only values are treated as "no override" and fall through to the constant table. Invalid (non-address) values throw a clear `SENTINEL_ADDRESS_INVALID` error with the offending value surfaced for inspection.

Source of truth for the table entry: [`Public Agents/seed-sentinel/sentinel.md`](../../../Public%20Agents/seed-sentinel/sentinel.md) (the `wallet:` field). The SDK constant lives at [`src/cli/lib/resolveAgent.ts`](../src/cli/lib/resolveAgent.ts).

---

## 13. `BlockchainRuntime({ transport: 'wss' })` — reserved, not implemented

The config shape for WSS subscription transport is locked in 4.0.0 but the underlying `WebsocketProvider` integration is **not yet implemented**. Setting `transport: 'wss'` throws at construction time:

```
ValidationError: BlockchainRuntimeConfig: transport='wss' is reserved for a
future release and not yet implemented. Lower `pollingInterval` for tighter
HTTP polling, or pin to the 4.x version that ships WSS.
```

Low-latency operators should use a paid RPC tier and reduce `pollingInterval` instead.

---

## 14. Common first-run failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `No wallet found. Run actp init...` | No keystore for current network | `actp init` to generate, or set `ACTP_KEYSTORE_BASE64` |
| `Agent 'sentinel' is not registered for network 'X'` | Sentinel only exists on Base Sepolia in 4.0.0 | Use `--network base-sepolia` or `network: 'testnet'` |
| `Env var ACTP_SENTINEL_ADDRESS contains an invalid Ethereum address` | Malformed override value | Fix or unset the env var |
| Provider sees zero jobs on testnet | SDK ≤ 3.5.3 (pre-fix) | Upgrade — this is exactly what 4.0.0 fixes |
| Provider sees jobs but handler never runs | Service hash mismatch | Check that `agent.provide(name)` and the requester's `--service` are the same string, byte-for-byte (case-sensitive, no trim from your side) |
| `QuoteTimeout` (exit 2) within 30s | Provider offline, wallet wrong, or rate-limited RPC | Verify provider running; check RPC; cancel the dangling TX with `actp tx cancel <id>` |

---

## 15. Where to file issues

- **SDK bugs / regressions**: GitHub issues on `agirails/sdk-js` with the version (`actp --version`), node version (`node --version`), and a reproducer.
- **Sentinel availability problems**: check `https://agirails.app/a/sentinel` first; if Sentinel is up but `actp test` still fails, file the SDK issue.
- **Protocol-level questions** (state machine, kernel semantics): the kernel repo (`agirails/actp-kernel`) — protocol layer is unchanged in 4.0.0.

---

*Last updated: 2026-05-15. Tracks `@agirails/sdk@4.0.0`.*
