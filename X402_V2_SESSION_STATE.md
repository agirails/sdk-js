# x402 v2 Integration — Session State Checkpoint

**Snapshot time**: 2026-04-11, ALL BLOKS COMPLETE (A + B + C + satellite repos)
**Purpose**: Restart-safe context so a new Claude session can continue without re-deriving everything

---

## 🎯 Where we are right now

**ALL BLOKS COMPLETE. `@agirails/sdk@3.3.0` ready for publish. 8 commits ahead of origin/main.**

```
5c8098d  fix(x402): close P1 security gaps — asset allowlist, on-chain allowance, opt-in auto-pay
9648a46  fix(lint): unblock prepublishOnly — use TS-aware no-dupe-class-members
ab4d34e  feat(x402): real x402 v2 protocol support (Blok A, buyer side)
9031f27  fix: fast-fail when onTransactionCreated filter is passed without callback   ← pre-Blok A
c85a281  feat: filter onTransactionCreated by requester/provider at RPC level          ← pre-Blok A
+ (uncommitted) fix(x402): deep dive P1/P2 hardening — response validation, HTTP method/body, adapter-aware getStatus
```

**Current state**:
- ✅ Typecheck: 0 errors
- ✅ Lint: 0 errors (6 pre-existing unused-var warnings in unrelated files)
- ✅ Tests: 74 suites, **1931 passing + 1 skipped**, 0 failing
- ✅ `prepublishOnly` ready (blocker was fixed in 9648a46)
- 🔧 Working tree has uncommitted deep dive fixes (5 files changed)
- ⏳ NOT pushed to origin — Damir controls push timing

### Deep dive fixes applied (2026-04-11, round 3)

See `X402_V2_DEEP_DIVE_FINDINGS.md` for full analysis. All 5 issues fixed:

**P1-1: payment-response validation** (`X402Adapter.ts:mapToPayResult`)
- Was: fallback to empty strings on missing `transaction`/`network`/`payer` → silent "success" without settlement proof
- Now: validates tx hash (0x + 64 hex), network (present), payer (0x + 40 hex) → throws `X402SettlementProofMissingError` with specific missing fields

**P1-2: HTTP method/body support** (`adapter.ts` + `X402Adapter.ts:pay`)
- Was: hardcoded `GET` + `{accept: 'application/json'}` → POST/PUT/PATCH paid endpoints unreachable
- Now: `UnifiedPayParams.httpMethod` / `httpBody` / `httpHeaders` (optional, x402-only, ACTP adapters ignore). Default GET. Auto content-type for body.

**P1-3: adapter-aware getStatus** (`ACTPClient.ts`)
- Was: `getStatus()` always delegated to StandardAdapter → x402 txIds not found
- Now: `txAdapterMap` tracks which adapter handled each txId. `getStatus()` routes to correct adapter with fallback to StandardAdapter for prior-session ACTP txIds.

**P2-1: integration test opt-in** (`X402Adapter.integration.test.ts`)
- Added `metadata: { paymentMethod: 'x402' }` to match the opt-in guard.

**P2-2: doc/config drift** (`X402Adapter.ts` + `X402Errors.ts`)
- $10 → $1 in config docstring + error message (matches actual default since P1-3 hardening)
- `ACTPClientConfig.x402.allowedHosts` → `X402AdapterConfig.allowedHosts` (actual config surface)

**What's next**: npm publish + push to origin when Damir approves.

### Satellite repos (also committed, not pushed)
- `n8n-nodes-actp`: removed manual X402Adapter registration (1 commit)
- `openclaw-skill`: updated all x402 examples to 3.3.0 API (1 commit)
- `docs-site`: rewrote x402-protocol.md + adapter-routing.md (1 commit)

---

## 📋 Plan reference

**Authoritative plan**: `X402_V2_IMPLEMENTATION_PLAN.md` (repo root, ~2080 lines, v4.2)

The plan is the source of truth for architectural decisions, scope, and timelines.
It has gone through 6 iterations (v1 → v4.2) based on user feedback and spike findings.
**Read the plan first** before making any architectural decisions — it encodes context
that will otherwise need to be re-derived.

Key plan sections to re-read on restart:
1. Executive summary (lines 11-26)
2. Fiksirane odluke (line ~70, 5 non-negotiable decisions)
3. Phase 1 scope — buyer + seller (line ~430)
4. Error taxonomy (line ~1200)
5. Gas cost model (line ~1280)
6. SLO + compatibility matrix (line ~1400)
7. Timeline v4.1 (line ~1580)

---

## 🏗 Blok A — what was built (buyer-side only)

### New files
- `src/adapters/X402Adapter.ts` — thin wrapper around `@x402/fetch` + `@x402/evm` + `@x402/core`
- `src/adapters/X402Adapter.test.ts` — 39 unit tests (replaced legacy 1067-line suite)
- `src/adapters/X402Adapter.integration.test.ts` — live x402.org/protected test (INTEGRATION=1 guarded, funded Base Sepolia EOA required)
- `src/errors/X402Errors.ts` — 10 typed error classes
- `src/errors/ACTPError.ts` — base class extracted to avoid circular import
- `src/types/x402-modules.d.ts` — ambient declarations (workaround for upstream @x402/* packaging bug)
- `src/__tests__/helpers/mockX402Server.ts` — raw node:http mock (20 lines, no upstream deps)
- `X402_V2_IMPLEMENTATION_PLAN.md` — live plan document
- `X402_V2_SESSION_STATE.md` — THIS FILE

### Modified files
- `src/wallet/IWalletProvider.ts` — added `EIP712TypedData` re-export + optional `signTypedData` + optional `getReadProvider`
- `src/wallet/EOAWalletProvider.ts` — implemented signTypedData (trivial ethers.Wallet delegation) + getReadProvider
- `src/wallet/AutoWalletProvider.ts` — implemented signTypedData via `viem.toCoinbaseSmartAccount` (handles ERC-1271 + ERC-6492 for Smart Wallet) with lazy init mutex + counterfactual address parity check + 6-chain mapping. Also getReadProvider returning ethers JsonRpcProvider.
- `src/types/adapter.ts` — `UnifiedPayParams.amount` optional (x402 URL targets derive from server response)
- `src/types/eip712.ts` — added generic `EIP712TypedData` (moved from wallet/)
- `src/adapters/BasicAdapter.ts` — amount guard (throws ValidationError if undefined for ACTP)
- `src/adapters/StandardAdapter.ts` — same amount guard
- `src/ACTPClient.ts` — auto-registration of X402Adapter when walletProvider.signTypedData exists
- `src/errors/index.ts` — import ACTPError from own file, re-export X402Errors at bottom
- `src/index.ts` — public re-exports for X402Adapter, X402AdapterConfig, X402Error hierarchy
- `src/adapters/index.ts` — dropped legacy exports (X402PayParams, FetchFunction, etc.)
- `.eslintrc.cjs` — switched to `@typescript-eslint/no-dupe-class-members` (overload-aware)
- `package.json` — added `viem ^2.47.12`, `@x402/fetch ~2.9.0`, `@x402/evm ~2.9.0`, `@x402/core ~2.9.0`

---

## 🔑 Non-negotiable decisions (all 5 locked in)

1. **`UnifiedPayParams.amount` is optional.** Required for ACTP adapters; ignored for x402 URL targets (amount comes from server's payment-required response).
2. **`X402Relay` contract is DEPRECATED.** Still deployed on Base mainnet + Sepolia, never used from new adapter. Documented in Solidity + README.
3. **Zero reputation tracking on x402.** ERC-8004 registry never touched. Rationale: x402 is fire-and-forget, no DELIVERED state, no dispute window. Per-tx reputation write would also be economically broken (~$0.50 gas per $0.10 tx).
4. **Docs sweep in separate PRs per repo** (n8n, OpenClaw, claude-skill, agirails.app, sdk-examples) — not bundled in SDK commit.
5. **Minor bump `@agirails/sdk@3.3.0`.** Breaking to internal call sites (just n8n factory in our monorepo), but SemVer is "real" since prior X402Adapter was never real x402 and had zero production users outside our monorepo.

---

## 🧪 Smart Wallet signing flow (verified)

This is the most subtle part of Blok A — write it down so it doesn't need re-deriving.

- **Coinbase Smart Wallet** used (factory `0xBA5ED110...`)
- USDC `transferWithAuthorization` (EIP-3009) does NOT call ERC-1271, so Smart Wallets cannot sign EIP-3009 directly
- **Permit2 path** works because Permit2 supports ERC-1271 (and ERC-6492 for counterfactual)
- `@x402/evm@2.9.0` exports `createPermit2ApprovalTx` and supports Permit2 scheme automatically when server advertises `extra.assetTransferMethod = "permit2"`
- `viem`'s `toCoinbaseSmartAccount` does everything needed: replay-safe hash, 1271 wrapping, 6492 envelope for undeployed wallets. One-call.
- Our `AutoWalletProvider.signTypedData` wraps viem: lazy-constructs viem account via init promise mutex, runs parity check between our `computeSmartWalletAddress` and viem's `getAddress()`, delegates signTypedData.
- Canonical `x402ExactPermit2ProxyAddress = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001` deployed on both Base mainnet and Base Sepolia (verified on-chain 2026-04-11).

## ⚙️ Gas cost model (locked in)

**Settlement gas**: facilitator pays (Coinbase public `facilitator.x402.org` by default, or self-hosted). We are NEVER in the settlement gas loop.

**One-time Permit2 approve**: our paymaster pays, ~$0.50 per (Smart Wallet × chain × token), once. Cached in-memory; on-chain allowance re-checked after restart (P1-2 fix).

**EOA buyers**: our paymaster never touches x402. EOA uses EIP-3009 off-chain signing + facilitator settlement. Zero lifetime gas cost for us.

**Seller side**: zero paymaster involvement. Server hands signed payloads to facilitator; facilitator does all on-chain work.

---

## 🔐 Security posture (hardened by P1 fixes)

After round 2 review:

- **Strict HTTPS only** (`canHandle` rejects `http://`)
- **Asset allowlist** — canonical USDC per chain by default, rejects any other token (P1-1)
- **On-chain allowance check** before Permit2 approve — survives restart/scale (P1-2)
- **Explicit opt-in** for HTTPS URLs — `metadata.paymentMethod: 'x402'` OR host in `allowedHosts` (P1-3)
- **Default cap lowered** from $10 → $1 USDC (P1-3 hardened default)
- **MEV hard cap** — 5 min default on authorization `validBefore`, clamps server-proposed maxTimeoutSeconds
- **Smart Wallet + EIP-3009-only endpoint** fails fast with clear error (no silent signature-for-wrong-scheme)
- **Missing payment-response header** throws `X402SettlementProofMissingError` (not silent SETTLED)

---

## 🧭 Config surface (X402AdapterConfig)

```ts
interface X402AdapterConfig {
  walletProvider: IWalletProvider;                    // required
  allowedNetworks?: ReadonlyArray<string>;             // default: 6 EVM chains
  maxAmountPerTx?: string;                             // default: "1" USDC
  autoApprovePermit2?: boolean;                        // default: true
  maxAuthorizationValidSec?: number;                   // default: 300 (5 min)
  allowedAssets?: ReadonlyArray<string>;               // default: canonical USDC per allowed chain
  allowedHosts?: ReadonlyArray<string>;                // default: [] (requires per-call opt-in)
  fetchImpl?: typeof fetch;                            // tests only
}
```

Auto-registered by `ACTPClient` with defaults. User override via `client.registerAdapter(new X402Adapter({ walletProvider, maxAmountPerTx: "100" }))` to replace.

## 📝 User-facing API shape

```ts
import { ACTPClient } from '@agirails/sdk';

const client = await ACTPClient.create({ /* existing config */ });

// Option A: per-call opt-in
await client.pay({
  to: 'https://x402.org/protected',
  metadata: { paymentMethod: 'x402' },
});

// Option B: host allowlist (requires manual X402Adapter registration with config)
// — currently only via manual construction, no ACTPClientConfig.x402 plumbing yet
```

**Known gap**: Auto-registration uses all defaults. There's no way to pass `allowedHosts` via `ACTPClientConfig.x402.*` yet because ACTPClient constructor doesn't take a config object with that field. This is intentional — plan says "runtime-only, don't touch AGIRAILS.md schema in 3.3.0". Users who want non-default config manually construct X402Adapter and re-register it. Follow-up: decide in Blok C whether to plumb x402 config through ACTPClient factory params.

---

## 🚧 Blok B — what's next (NOT started)

**Goal**: Seller-side middleware. User can stand up a server that accepts x402 v2 payments using the same SDK + same keystore + same Smart Wallet.

**Scope** (per plan v4.1 timeline, Blok B = ~2.35 dana):
- `src/server/` new subfolder + `@agirails/sdk/server` subpath export
- `buildX402Server(client, config)` framework-agnostic helper that returns `{ resourceServer, routes }`
- `paymentRequirements.ts` mapping AGIRAILS.md config + walletProvider address to x402 payment requirements
- User plugs output into `@x402/express`, `@x402/hono`, or `@x402/next` directly — we don't wrap any framework
- Type-level interop test for Hono/Next (compile-time assertion only, no real integration)
- Real integration test with Express + mock Smart Wallet buyer flow (full round-trip Permit2)

**Framework-agnostic fallback** (documented in plan): if user has Fastify/Koa/Hapi/raw http, they can use `resourceServer.handleRequest(req, res)` directly. Plan includes example.

**Default facilitator**: `facilitator.x402.org` public. Override via `buildX402Server` config.

**Permit2 by default**: seller config advertises `extra.assetTransferMethod = "permit2"` so Smart Wallet buyers work out of the box. Users can disable per-route.

**Blok B does NOT include**:
- Onboarding CLI flow (`actp init --role both`) — that's Blok C
- n8n factory update — Blok C
- Docs sweeps (separate PRs, Blok C)
- CHANGELOG + release notes — Blok C

---

## 🧰 Key file paths for fast restart navigation

```
/Users/damir/Arha/AGIRAILS/SDK and Runtime/sdk-js/
├── X402_V2_IMPLEMENTATION_PLAN.md           ← plan (read first)
├── X402_V2_SESSION_STATE.md                 ← THIS file
├── src/adapters/X402Adapter.ts              ← main buyer adapter (~680 lines)
├── src/adapters/X402Adapter.test.ts         ← 39 unit tests
├── src/adapters/X402Adapter.integration.test.ts
├── src/errors/X402Errors.ts                 ← 10 error classes
├── src/errors/ACTPError.ts                  ← extracted base
├── src/wallet/IWalletProvider.ts            ← signTypedData + getReadProvider optionals
├── src/wallet/EOAWalletProvider.ts          ← tier 2 signTypedData
├── src/wallet/AutoWalletProvider.ts         ← tier 1 signTypedData via viem
├── src/types/eip712.ts                      ← generic EIP712TypedData
├── src/types/x402-modules.d.ts              ← ambient decls (upstream packaging workaround)
├── src/__tests__/helpers/mockX402Server.ts  ← raw http mock for tests
└── src/ACTPClient.ts                        ← auto-registration @ line ~670-694
```

**Commits to inspect**: `git log --oneline -6` from within `sdk-js` — last 3 are Blok A + 2 follow-ups.

---

## 🔄 How to resume (restart checklist)

1. **Read `X402_V2_IMPLEMENTATION_PLAN.md`** start to finish (or at least sections listed above)
2. **Read this file** for the "what's already done" picture
3. **`cd "SDK and Runtime/sdk-js" && git log --oneline -6`** to confirm commits match what's documented here
4. **`npm run lint && npx tsc --noEmit && npx jest --runInBand`** to verify clean baseline
5. **Ask Damir**: "Krećem Blok B?" — do not assume scope or push any commits without approval
6. **Never push to origin without explicit "push" from Damir** — 5 commits are ahead and push timing is his call

---

## 🎬 Open questions (if Blok B starts)

- **Plumb `x402` config through ACTPClient factory params?** Currently auto-registration uses all defaults. If users want `allowedHosts`, they must manually construct + re-register. Option in Blok B or Blok C to add `ACTPClientConfig.x402.*` that flows to auto-registration.
- **Hono + Next real integration vs type-level only?** Plan says type-level is sufficient; confirm during implementation if upstream API shape changes.
- **Mock Permit2 server for seller tests**: reuse `src/__tests__/helpers/mockX402Server.ts` as a starting point, but seller-side integration test needs a real Smart Wallet buyer (can use the adapter we already built).
- **Facilitator choice at seller side**: default public, but production users will want to configure. Plan says this is seller responsibility, not ours — document in README.
- **`actp init` CLI update**: not scope for Blok B, deferred to Blok C. Confirm this with Damir before touching onboarding.

---

## 📊 Test counts history

- Baseline before Blok A: 73 suites, 1917 tests
- After Blok A initial: 74 suites, 1917+ tests (legacy X402 test removed, new added)
- After v4.1 post-review fixes: 74 suites, 1923 tests + 1 skipped
- After P1 security fixes: 74 suites, **1931 tests + 1 skipped**
- New X402Adapter test count: **39 tests** (replacing 1067-line legacy suite)

---

## ⚠️ Known open issues / backlog

Documented in plan + this file:

- **Python SDK parity port** — Phase 3, tracked separately, commit target 2 weeks after TS 3.3.0 ships. Not started.
- **`DeliveryProofBuilder`, `QuoteBuilder`, `MessageSigner` silent bug** (Q10 from plan) — these modules call `signer.signTypedData` directly on ethers.Wallet, bypassing the new IWalletProvider.signTypedData path. For Tier 1 Smart Wallet agents, this produces EOA-recoverable signatures that don't validate against the Smart Wallet contract. Verified as NOT urgent during v4.2 spike (grep found zero production callers outside sdk-js itself). Follow-up PR after 3.3.0 ships.
- **`x402.org/protected` integration test** is skipped by default (INTEGRATION=1 env var required, needs funded Base Sepolia EOA via `X402_TEST_PRIVATE_KEY`). Run manually before each release.
- **n8n factory update** (`agirails/n8n-nodes-actp`) — still has `new X402Adapter(requesterAddress, { transferFn, ... })` from legacy constructor. Will break when pulling 3.3.0. Blok C coordination.

---

## 🗣 Damir's communication style (observed during session)

Useful for a fresh Claude to know:

- Writes in Croatian, comfortable with English tech terms
- Expects brutal honesty — explicitly asked "garantiraš li za plan?" and valued a truthful non-binary answer
- Runs his own PR reviews post-commit and catches real issues (P0 lint, P1 asset/allowance/opt-in). Take his findings seriously.
- Decides release strategy himself ("A" — full release, 2-2.5 weeks)
- Off-topic messages can happen ("DRRi 1.3" was from another project, he confirmed ignore)
- Says "sve" when he wants everything fixed at once, not just blockers
- Says "commit" when he wants commit, "push" never implied by "commit"
- Happy with batched multi-fix commits as long as message is clear
- Appreciates concrete recommendations + rationale, not just "what do you want"

---

**End of checkpoint. Restart clean.**
