# Changelog

## [4.9.0] — 2026-06-21

### Fixed

- **Unified CLI network resolution (F-2 — real-money footgun).** The CLI
  resolved the transacting network three inconsistent ways: `actp request`
  used `--network` (hardcoded default `testnet`) and ignored both
  `.actp/config.json` mode and `ACTP_NETWORK`; `actp pay` / `tx` / `mint` /
  `balance` / … used `config.mode` (default `mock`), had no `--network` flag,
  and also ignored `ACTP_NETWORK`; and `ACTP_NETWORK` — advertised in
  `.env.example` as the network selector — was honored nowhere. A second
  agent caught a near-miss where `--network testnet` was accepted but the
  command would have transacted on the mainnet-configured chain. All
  value-moving commands now resolve through a single `resolveNetwork()` with
  one precedence ladder — `--network` flag > `ACTP_NETWORK` > `config.mode` >
  `testnet` — and print the resolved network plus its source. `ACTP_NETWORK`
  is now honored everywhere.

### Security

- **Mainnet escalation guard.** A `--network` flag or `ACTP_NETWORK` may
  freely *downgrade* to testnet/mock, but the resolver will **never** resolve
  to `mainnet` unless `config.mode === 'mainnet'`. A transient flag or env var
  can no longer escalate a non-mainnet config to real funds — moving to
  mainnet requires `actp config --mode mainnet` first. The command fails
  closed (throws before any payment) on a mainnet-over-non-mainnet request.

### Changed

- **`actp request` default network.** Previously always `testnet` regardless
  of config; now honors `ACTP_NETWORK` / `config.mode` when `--network` is
  omitted (still falls back to `testnet` when nothing is set). Scripts that
  relied on the implicit `testnet` default while running under a non-testnet
  config should pass `--network testnet` explicitly.

### Added

- **`--network` flag on `actp pay`** (mock | testnet | mainnet), resolved
  through the same ladder. `tx` / `mint` / `balance` / etc. inherit the
  unified resolution + mainnet guard via `createClient` even without an
  explicit flag.

## [4.8.1] — 2026-06-19

### Added

- **`pollingInterval` config option** on `Agent` (level1) and
  `ACTPClient.create` — threaded into `BlockchainRuntime`, which assigns it
  to `provider.pollingInterval`. Lets long-running daemons widen the ethers
  block-poll cadence (default 1000 ms / 1s) to cut `eth_blockNumber` /
  `eth_getLogs` RPC load — and therefore the compute-unit burn on a metered
  RPC (Alchemy / Infura / QuickNode). Backward compatible: omitting it
  preserves the prior 1s default. Always-on agents on a free-tier RPC should
  set `pollingInterval: 5000–8000`.

## [4.1.1] — 2026-06-04

### Changed

- **`actp test` default amount $0.05 → $10.** The old amount sat exactly
  on the protocol fee floor (`max(1%, $0.05min)`), so every Sentinel
  settlement minted a receipt that read "earned $0" — the demo signal
  we want most was zero. $10 clears the floor cleanly: fee $0.10 (1%),
  net $9.90. Above $5 the fee is purely 1%, making the structure
  visible to anyone reading their first receipt.

  Companion change in
  [agirails/seed-sentinel@19d8f3a](https://github.com/agirails/seed-sentinel/commit/19d8f3a)
  bumped the Sentinel covenant band from $0.05–$10 to $10–$100 so the
  Railway-deployed Sentinel still accepts the new default.

## [4.1.0] — 2026-06-04

### Added

- **Buyer-visible receipt URL on SETTLED.** `RunRequestResult.receiptUrl`
  surfaces an absolute `https://agirails.app/r/r_...` URL when the
  requester-side V2 push to the AGIRAILS Platform succeeds after
  settlement. `actp test` and `actp pay` print it as a `Receipt:` line
  at the end of a successful settle. Null when the push fails — the
  Platform indexer cron is the backstop and still mints the receipt
  within ~5 min.

### Fixed

- **`pushReceiptOnSettled` now uses `client.info.address`** as
  `requesterAddress`. With AutoWallet active (Tier 1, the default for
  published agents), the on-chain requester is the deterministic
  Coinbase smart wallet derived from the EOA — not the EOA itself.
  Passing the EOA produced a smart-wallet / EOA mismatch that the
  server rejected with 422 from `assertOnChainMatches`, and the push
  catch block silently nulled the receipt URL. Tier 2/3 EOA paths are
  unaffected since `info.address` is the EOA there. (#12)
- **V2 receipt POST body now carries `signerAddress`.** The Platform's
  V2 route prefers `body.signerAddress` when reconstructing the typed
  payload for signature verification; without it, the server fell back
  to `participantRole === "requester" ? requesterAddress : agentAddress`,
  which broke smart-wallet buyers signing with their EOA owner. (#11)

### Companion server fix

The matching Platform-side fix landed in
[agirails/agirails.app#36](https://github.com/agirails/agirails.app/pull/36):
`@upstash/redis@1.36.2` auto-deserializes the nonce sentinel `"1"` to
the number `1` via `JSON.parse`, so the server's `stored === "1"` check
rejected every fresh nonce as "invalid or already used". Both shapes
are now accepted. Without the server fix, no V2 push could succeed
regardless of SDK version.

## [4.0.0] — 2026-05-19

### Security

- **Bump `@ethereum-attestation-service/eas-sdk` 1.6.1 → 2.9.x.** Clears the
  transitively-inherited high-severity advisories in `undici`, `hardhat`,
  and `mocha` via `eas-contracts@1.7.1`. Adapted `EASHelper.attest` /
  `EASHelper.revokeAttestation` to read tx hash from `Transaction.receipt.hash`
  (EAS SDK 2.x relocates the field; behavior is otherwise unchanged).
- **npm overrides hardened.** Added `undici ^6.25.0`, `serialize-javascript
  ^7.0.5`, and `mocha ^11` to `package.json#overrides` to pin transitive
  vulnerable versions out of the install tree.
- **Production npm-audit baseline: 0 high, 15 moderate, 28 low** — all
  remaining are dev-tooling transitives with no exploitable runtime path
  in the shipped SDK. (Pre-4.0.0: 10 high.)

First stable Base mainnet release. Closes the 4.0.0-beta cycle.

### Mainnet contracts (Base, chain 8453)

The mainnet kernel was redeployed 2026-05-19 to ship the post-3.5.x
cumulative changes (AIP-14 dispute bonds with per-tx-locked rates,
INV-30 `disputeBondBpsLocked`, M-2 mediator timelock fix, M-3 mediator
hot-swap fee lock, ERC-8004 agentId tracking, dispute-initiator + bond
return logic). Storage-incompatible upgrade — fresh address surface.

- `actpKernel`: `0x048c811352e8a3fECd5b0Ec4AA2c2b94083CC842` (deploy block 46,212,266)
- `escrowVault`: `0x262D5912A9612F0c66dA5d13B4E678D50ebC44b5`
- `agentRegistry`: `0x64Cb18bfb3CC1aCb1370a3B01613391D3561a009` (active after 2-day timelock execute on 2026-05-21)
- `archiveTreasury`: `0x6159A80Ce8362aBB2307FbaB4Ed4D3F4A4231Acc`
- `usdc`: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle native, unchanged)

All four contracts Sourcify EXACT_MATCH verified. Admin / pauser /
feeRecipient = Treasury Safe `0x61fE58E9…b7f2` (2-of-4). Compiler:
solc 0.8.34 + via_ir. Deploy artifact at
`agirails/actp-kernel deployments/base-mainnet.json`.

### Breaking

- **`x402Relay` removed from base-mainnet config.** Deprecated SDK-side
  since 3.3.0; payments route directly buyer→seller via `@x402/fetch`
  + facilitator (EIP-3009 / Permit2). Old mainnet X402Relay
  (`0x81DFb954…09F8`) is NOT redeployed. Sepolia retains it for legacy
  direct-call consumers.

- **Mainnet address surface change.** Integrators that read
  `getNetwork('base-mainnet').contracts.*` migrate automatically.
  Code with hardcoded old kernel/vault/registry/archive addresses must
  swap to the new addresses above. Old contracts stay live and
  isolated — in-flight transactions on the old kernel continue
  normally, but new SDK traffic targets the new kernel.

### Carried forward from 4.0.0-beta.0 through beta.11

- AA bypass cascade fixes (beta.1–beta.9) — Smart Wallet routing for
  `level0/request.ts` and `BuyerOrchestrator.ts`; no raw EOA fallback
- Apex audit closures: FIND-001/-002/-003/-004/-006/-007/-011/-012/-013/-014/-015/-016
- CODEOWNERS review gate (FIND-003)
- Workflow-attested provenance publish (FIND-001)
- AGIRAILS.md parser hardening (FIND-016)
- See `feat/4.0.0-event-driven-provider-listening` git history for the
  full beta-cycle commit log.

### Migration

For most integrators: `npm install @agirails/sdk@latest` after this
version is promoted to `@latest`. The SDK reads addresses from
`getNetwork('base-mainnet')` so consumers going through the network
helper migrate without code changes.

If you hardcoded any old mainnet addresses in your application code,
swap them per the address list above.

---

## [4.0.0-beta.11] — 2026-05-17

Closes the actionable findings from the Apex 2026-05-17 source-level
audit (`2026-05-17-sdk-js-source-audit.md`) — companion deep-dive to
the morning's structural refresh. One new LOW (FIND-016 parser
hardening) plus the three tractable items in the FIND-012 CLI
secret-leakage checklist.

### Fixed

- **`parseAgirailsMd` defence-in-depth (Apex FIND-016)** — the
  AGIRAILS.md YAML parser now enforces a 256 KB hard cap on raw
  content before any YAML / regex work, and tightens `yaml`'s
  `maxAliasCount` from its 100 default down to 10. Canonical
  AGIRAILS.md files are 2-10 KB and never use anchors, so the cap is
  conservative on purpose. Live threat: CLI runs in CI / cloned
  repos / PR workspaces / generated project directories which can
  contain attacker-controlled `AGIRAILS.md` parsed by `health`,
  `verify`, `publish`, or `init` without crossing a network boundary.
  4 new unit tests in `src/config/agirailsmd.test.ts` covering the
  size boundary and alias-count guard.

- **`addToGitignore` covers `.env` patterns (Apex FIND-012b)** — the
  `actp init` ignore-file helper previously added only `.actp/` to
  `.gitignore`; the docker / railway helpers already covered `.env`
  and `.env.*`. This brings gitignore to parity. The function is
  idempotent and migrates pre-existing `.gitignore` files that have
  only `.actp/`. Closes the most common secret-commit footgun for
  downstream consumers who store keystore passwords in a local
  `.env`.

- **`writeEnvExample` ships a documented secrets schema (Apex
  FIND-012b)** — `actp init` now drops a `.env.example` at the
  project root explaining the keystore + RPC schema with **placeholder
  values only**. Two-factor keystore-password pattern called out
  explicitly. Idempotent (won't clobber an operator-customised
  file). Symlink-attack guard mirrors the dockerignore / railwayignore
  helpers. 3 new unit tests covering the happy path, the no-clobber
  property, and the symlink rejection.

- **`PUBLISH_CLIENT_KEY` documented as intentionally embedded (Apex
  FIND-012d)** — the proxy identifier in `src/cli/commands/publish.ts`
  now carries an extended docstring naming the Firebase / Stripe
  publishable-key threat model, explaining the `ag_pub_v1_` prefix
  convention, and confirming the proxy gives the identifier no
  privileged scope. No code change; resolves the soft observation
  from the audit's `publish.ts` review.

### Added

- **Runtime secret handling paragraph in README.md (Apex FIND-012c)**
  — new section under "Security" listing what the SDK reads, what it
  never reads (CLI inline flags for keys / mnemonics / tokens), what
  it logs (addresses only, never the key), and what `actp init` does
  to protect downstream consumers. Public commitment to the secret-
  handling model so downstream agents have a reference to point at
  in their own threat models.

### Investigation findings — no code change in this release

- **FIND-012a (CLI inline-arg audit)**: confirmed **already clean**.
  Zero `.option(` declarations across `src/cli/commands/*.ts` accept
  a private key, mnemonic, signed payload, or API token inline. SDK
  already routes all sensitive material through env vars or the
  encrypted keystore. Documented in the new README section.

- **FIND-006 sub (`elliptic` + `bn.js` reachability)**: `npm ls`
  identified `@irys/sdk@0.2.11` as the sole runtime parent dragging
  in ethers v5 + the `@near-js/*` cluster + `elliptic` + `bn.js`.
  `@irys/sdk` is **already marked deprecated upstream** (npm install
  warning recommends migrating to the Irys datachain client).
  Hardhat's transitive ethers v5 is dev-only and not reachable at
  runtime. Action: full Irys migration is a real engineering task
  (storage API change in `src/storage/ArweaveClient.ts`) and tracked
  as a separate forward item — out of beta.11 scope. No pin on
  `elliptic` since CVE-2025-14505 has no patched version listed on
  GHSA (per Apex audit).

### Known follow-ups (Apex audit; tracked, not blockers for the canary)

- **FIND-001 / FIND-003 / FIND-010** — branch protection / CODEOWNERS /
  `sdk-ts-ci.yml` permissions block. Need GitHub org-admin.
- **FIND-006 (the broader Dependabot cluster)** — auto-updates still
  disabled at repo settings; 26 open alerts.
- **FIND-008** — git tag drift on stable 3.5.3 and the 2.0.1-beta line.
  Retroactive tagging requires tarball-to-commit archeology.
- **FIND-009** — `sdk-ts-ci.yml` uses `npm install`, should be `npm ci`.
- **`@irys/sdk` migration** — replace with the Irys datachain client
  to drop ethers v5 + `@near-js/*` + `elliptic` + `bn.js` runtime
  transitives. Separate cycle.
- **`bn.js` CVE-2026-2739 `maskn(0)` DoS** — reachable via the same
  Irys path; pin in `overrides` once a patched line is published.

## [4.0.0-beta.10] — 2026-05-17

Closes the three Apex 2026-05-17 audit findings that are tractable inside
the SDK repo without org-level admin (FIND-011 SSRF guard, FIND-007 publish
provenance, FIND-004 JS/TS SAST floor). Structural perimeter items that
need GitHub org-admin (branch protection, CODEOWNERS, Dependabot
auto-updates) remain open — tracked separately. No protocol-surface
changes; canary path validated against beta.9 across seven SETTLED runs
remains identical.

### Fixed

- **`RelayChannel` baseUrl SSRF guard (Apex FIND-011)** — the constructor
  now routes `cfg.baseUrl` through `assertSafePeerUrl` (the same helper
  the SDK uses for adversary-writable peer URLs from the on-chain
  registry / agirails.app DB). A downstream agent that reads its relay
  base URL from an env var, config file, or discovery channel can no
  longer be steered at metadata services (169.254.169.254), RFC1918
  hosts, IPv6 loopback, IPv4-mapped IPv6 bypasses, or `*.localhost`.
  Adds the `allowInsecureTargets?: boolean` config field for the
  documented dev / test escape hatch. 8 new unit tests in
  `src/negotiation/RelayChannel.test.ts` covering each guard branch.

### Added

- **`.github/workflows/publish.yml` — tag-driven npm publish with
  provenance (Apex FIND-007)**. Fires on `v*.*.*` and `v*.*.*-*` tag
  push. Verifies tag matches `package.json` version, runs
  `npm ci` + `build` + `test` + `lint`, then publishes with
  `--provenance` (npm OIDC + sigstore attestation) and a dist-tag
  derived from the version suffix (`-beta` → `next`, `-alpha` →
  `alpha`, `-rc` → `rc`, stable → `latest`). All third-party
  actions pinned by full-length commit SHA per the CVE-2025-30066
  class. Closes the forensic gap on prior `4.0.0-beta.0..9`
  publishes (10 unattested releases over two days).

- **`.github/workflows/codeql.yml` — JS/TS SAST baseline (Apex
  FIND-004)**. Runs on PR, push-to-main, and a weekly Monday cron.
  Default `security-extended` + `security-and-quality` query pack
  covers unsafe eval, prototype pollution, regex injection,
  hardcoded crypto primitives, and taint flow analysis through
  fetch / fs / child_process. Complements the secret-scanning
  layer (already enabled at the repo) and the gitleaks step in
  `sdk-ts-ci.yml`.

- **`publishConfig.provenance: true` in `package.json`** — declarative
  fallback so even a direct `npm publish` from a maintainer machine
  attempts attestation. The workflow path (above) is the supported
  publish flow going forward.

### Known follow-ups (Apex audit; tracked, not blockers for the canary)

- **FIND-001 / FIND-003 / FIND-010 — branch protection / CODEOWNERS /
  workflow permissions block on `sdk-ts-ci.yml`**. Need GitHub org-admin
  to apply rulesets; one administrative pass for both `sdk-js` and
  `actp-kernel`.
- **FIND-006 — 26 Dependabot alerts, auto-updates disabled**. Manual
  triage + `overrides` block in `package.json`. Out of scope for this
  release.
- **FIND-008 — git tag drift on `3.5.3`, `2.0.1-beta`, `4.0.0-beta.0..9`**.
  The 4.0.0 line is partially anchored as of this release (the new
  cumulative beta.1..9 commit + the beta.9 tag). Retroactive tagging
  of stable 3.5.3 and the 2.0.1-beta requires tarball-to-commit
  archeology — separate housekeeping pass.
- **FIND-009 — `sdk-ts-ci.yml` uses `npm install`, should be `npm ci`**.
  Mechanical edit, separate PR.
- **FIND-012 — CLI runtime secret-leakage surface audit**. Real work
  (~2-3h) — error-path redaction, `--key-file` over `--key`, `actp
  init` ship a `.gitignore` template. Out of scope for this release;
  tracked.

## [4.0.0-beta.9] — 2026-05-17

Catches a transient RPC propagation race surfaced by the Layer 2
matrix verification against beta.8. Callers typically invoke
`linkEscrow` immediately after `createTransaction`. The createTransaction
UserOp has already been included in a block (the receipt yielded the
txId), but a load-balanced public RPC (e.g. PublicNode) may route the
follow-up `getTransaction` to a node that hasn't yet ingested the
inclusion block. Two of three $5.00 canary attempts surfaced this
mid-flow as a misleading `Transaction not found`. The third attempt
worked once the propagation caught up, confirming a transient race
rather than a state-machine bug.

### Fixed

- **`StandardAdapter.linkEscrow`** — retry-with-backoff on
  `runtime.getTransaction` lookups. Four attempts at 0 / 500ms / 1s
  / 2s covering the typical Base Sepolia propagation window. Genuinely-
  missing txs still surface `Transaction not found` after the last
  attempt, so the failure mode for a real bug is unchanged.

## [4.0.0-beta.8] — 2026-05-17

beta.7 deployed the permanent-revert classifier but it failed to
match the bundler simulation path: `Bundler RPC error -32521` surfaces
the kernel revert reason as an ABI-encoded `Error(string)` blob
(`0x08c379a0...` selector + offset + length + UTF-8 bytes), not the
plaintext reason. Live canary saw the orphan retry storm continue
even with beta.7 deployed — Sentinel re-`Job accepted`-ed the past
deadline tx every poll and the classifier never tripped.

### Fixed

- **`Agent.processJob` retry policy classifier** — now matches each
  permanent revert reason in BOTH plaintext and its hex-encoded
  UTF-8 form. Catches kernel runtime reverts (plaintext message) AND
  bundler simulation reverts (`Error(string)` selector with hex bytes).
  Verified against the real `Transaction expired` revert seen in
  the beta.7 canary logs.

## [4.0.0-beta.7] — 2026-05-17

Tightens the orphan-recovery path that beta.6 opened up. Polling
IN_PROGRESS for recovery is correct, but treating EVERY processJob
failure as a transient retry candidate is wrong: kernel reverts like
"Transaction expired" (deadline elapsed) or "Invalid transition" are
permanent — the same UserOp will revert again on the next poll, every
5 seconds, until the agent restarts. The beta.6 live canary surfaced
this against tx 0xf536316c (orphaned past its 1h deadline): Sentinel
re-`Job accepted` it every 5s and reverted with "Transaction expired"
every 5s, burning Pimlico bundler quota and flooding the logs.

### Fixed

- **`Agent.processJob` retry policy** — error message classifier in
  the catch handler. Six kernel revert reasons treated as permanent
  failures: `Transaction expired`, `Invalid transition`,
  `Only requester`, `Only provider`, `Not authorized`,
  `Not participant`. On a permanent failure the job is marked as
  processed (`processedJobs.set(id, true)`) so subsequent poll
  cycles dedupe it out. Transient failures keep the existing
  delete-and-retry behaviour. The `processedJobs` map is in-memory
  so an operator who fixes the underlying issue can clear it by
  restarting the agent — right blast radius for a recoverable
  config error.

## [4.0.0-beta.6] — 2026-05-17

Live canary after the beta.5 deploy caught an IN_PROGRESS orphan
pattern: Sentinel successfully transitioned a COMMITTED tx to
IN_PROGRESS on-chain, then either the bundler/paymaster
silently failed the second UserOp (DELIVERED) or Sentinel restarted
between the two transitions. With beta.5's COMMITTED-only poll filter,
the tx was unreachable for retry — pollForJobs never returned
IN_PROGRESS jobs, so processJob couldn't re-run.

### Fixed

- **`Agent.pollForJobs`** — on blockchain modes now polls both
  `COMMITTED` (normal entry) and `IN_PROGRESS` (orphan recovery
  entry). Mock mode still polls `INITIATED` only.

- **`Agent.processJob`** — state-gated the IN_PROGRESS transition:
  re-reads tx state right before the call, only sends
  `transitionState(IN_PROGRESS)` when the tx is actually in COMMITTED.
  When the tx is already IN_PROGRESS (orphan-recovery re-entry), skips
  the now-invalid hop and goes straight to the DELIVERED transition.
  When the tx is in a non-workable state (CANCELLED, DISPUTED, etc.),
  bails cleanly with a warning. Test stubs without `runtime.getTransaction`
  default to the COMMITTED entry state — preserves all existing
  92 Agent test assertions.

## [4.0.0-beta.5] — 2026-05-16

Production scenario matrix (Layer 2 of pre-GA verification) caught
a starvation pattern. With beta.4, providers polled both INITIATED
and COMMITTED in parallel. ACTPKernel ≥ 2026-04-15 rejects any
provider-side linkEscrow with "Only requester", so each pre-existing
orphan INITIATED tx in the 7200-block sweep window burned a bundler
`estimateUserOperationGas` call on every 5s poll. The custom-filter
rate-limit dedupe in Sentinel masked the cost but the wasted UserOp
estimates piled up; legitimate COMMITTED txs from fresh canaries
arrived but were starved out of the same poll batch because the
matrix-induced churn pushed effective throughput below the deadline.

### Fixed

- **`Agent.pollForJobs`** — now polls state-by-network:
  - mock: `INITIATED` only (legacy mock-runtime providers drive
    linkEscrow themselves; tests depend on this path)
  - testnet / mainnet: `COMMITTED` only (kernel rejects provider
    linkEscrow on INITIATED; polling INITIATED produces no
    actionable work, only wasted RPC + bundler calls)

- **`Agent.handleIncomingTransaction`** — adds a network-aware guard
  around the provider-side linkEscrow call. On blockchain modes, if
  the subscription path delivers an INITIATED tx, the agent now logs
  a debug line and waits for the next poll cycle (by then the
  requester will have committed, or the tx will have expired). No
  more `Only requester` reverts in the agent log on every poll.

- **`Agent` counter-offer hash path** — the legacy AIP-2.0 fallback
  in `Agent.ts` that submits `transitionState(QUOTED, proof)` from
  the provider went straight to `runtime.transitionState`. Same
  EOA-only bypass shape as the linkEscrow / IN_PROGRESS / DELIVERED
  sites already fixed in beta.2 — surfaced by post-matrix audit
  rather than by canary, since Sentinel's `autoAccept: true` simple
  handler never exercises the counter-offer path. Now routed
  through `client.standard.transitionState`.

- **`SettleOnInteract`** — the background sweep that releases
  expired DELIVERED transactions on each provider interaction
  (pay / startWork / deliver) called `runtime.releaseEscrow` directly.
  Same EOA-only bypass. The sweep is fire-and-forget so the bug only
  surfaced in agent logs as `Failed to settle … insufficient funds`
  warnings; canaries that complete their own settle-on-DELIVERED
  step (every `actp test` / `actp request`) never need it. Backup
  safety net for stuck-DELIVERED edge cases (requester crash, agent
  restart) — now AA-aware. The constructor takes an optional
  `releaseRouter` (typed as a minimal `{ releaseEscrow(escrowId) }`
  surface) which `ACTPClient` wires to `this.standard`. Omitting it
  preserves the legacy runtime-only path, so existing tests pass
  unchanged.

## [4.0.0-beta.4] — 2026-05-16

Completes the requester-driven escrow flow against the production
kernel. With beta.3 the requester correctly links escrow (tx
transitions INITIATED → COMMITTED on-chain), but the canary still
stalled — Sentinel never picked up the now-COMMITTED tx because
`Agent.pollForJobs` only queried `state === 'INITIATED'`. The SDK
was designed around provider-driven escrow linking, which the new
kernel rejects.

### Fixed

- **`Agent.pollForJobs`** — now queries both `INITIATED` and `COMMITTED`
  states in parallel and concatenates results. COMMITTED txs feed into
  the same `handleIncomingTransaction` pipeline; the existing
  `if (tx.state === 'INITIATED')` guard around the (kernel-rejected)
  provider-side linkEscrow short-circuits as designed, the agent
  proceeds directly to start work → deliver. INITIATED polling is kept
  for backwards compatibility with mock-mode tests and any provider
  still wired to the old auto-link pattern.

## [4.0.0-beta.3] — 2026-05-16

Surfaces and fixes a third-leg architecture mismatch revealed by the
beta.2 canary: with provider-side AA routing fixed, Sentinel's
`linkEscrow` attempt now made it through the bundler / paymaster but
the redeployed ACTPKernel (2026-04-15) reverted with `Only requester`
— the kernel requires `msg.sender == txn.requester` for linkEscrow
(ACTPKernel.sol:328). The previously-assumed provider-driven escrow
linking path is rejected on-chain. The requester must drive the
INITIATED → COMMITTED transition.

### Fixed

- **`runRequest` / `actp test` / `actp request`** — now calls
  `client.standard.linkEscrow(txId)` immediately after
  `createTransaction` on testnet / mainnet. The atomic UserOp batches
  USDC.approve + ACTPKernel.linkEscrow, sent from the requester's
  smart wallet so `msg.sender == requester` satisfies the kernel guard.
  Pre-beta.3 the tx sat INITIATED indefinitely while the provider's
  rejected linkEscrow attempts looped in its logs, the requester saw
  `QUOTE_TIMEOUT`. Mock mode is unchanged — mock providers can still
  linkEscrow on their side because `MockRuntime` doesn't enforce the
  requester-only guard.

- **`request()` Level 0 API** — same fix in `src/level0/request.ts`:
  testnet / mainnet callers now linkEscrow as requester before
  polling for delivery.

### Notes for provider authors

- `Agent.handleIncomingTransaction` still attempts `linkEscrow` when it
  observes a tx in INITIATED state. Against the current kernel that
  call reverts with `Only requester`. The error is caught and logged;
  the agent continues to poll. Once the requester has linked escrow
  the tx is in COMMITTED state and the agent's `tx.state === 'INITIATED'`
  guard short-circuits the (dead-on-kernel) linkEscrow attempt and
  the accept flow proceeds normally. The provider-side linkEscrow
  call will be removed in a future cleanup release.

## [4.0.0-beta.2] — 2026-05-16

Provider-side counterpart of the beta.1 hotfix. Surfaced when the
production Sentinel canary against beta.1 confirmed the requester
flow worked end-to-end (createTransaction landed on-chain via
Paymaster) but Sentinel itself reverted with `Token approval failed:
insufficient funds` on its own EOA when trying to accept the job.

### Fixed

- **`Agent.handleIncomingTransaction` / `Agent.processJob`** — three
  provider-side write paths in `src/level1/Agent.ts` (`linkEscrow` on
  job accept, `transitionState(IN_PROGRESS)` on start work,
  `transitionState(DELIVERED)` on deliver) dispatched through
  `client.runtime` directly, bypassing `StandardAdapter`'s
  SmartWalletRouter. AGIRAILS Smart Wallet providers (the default
  `wallet: 'auto'` path) saw the SDK try to sign with their raw EOA —
  which holds no ETH under the gasless model — and the USDC approve
  step of `linkEscrow` reverted with `INSUFFICIENT_FUNDS`. The
  symptom on the requester side was `QUOTE_TIMEOUT`: the provider
  never made it out of poll/accept loop because every accept attempt
  reverted, leaving the tx on-chain INITIATED. All three sites now go
  through `client.standard.*` so AA providers get Paymaster-sponsored
  UserOps; EOA / mock callers still fall through to the same runtime
  path inside the adapter.

## [4.0.0-beta.1] — 2026-05-16

Hotfix for a regression introduced in 4.0.0-beta.0 plus two pre-existing
bypasses uncovered during the audit. No protocol changes.

### Fixed

- **`runRequest` / `actp test` / `actp request`** (4.0.0-beta.0 regression)
  — routed the on-chain `createTransaction` and `releaseEscrow` calls
  through `client.runtime` directly, bypassing `StandardAdapter`'s
  SmartWalletRouter. Requesters with an AGIRAILS Smart Wallet (the
  default `wallet: 'auto'` path) saw the SDK try to sign with their raw
  EOA — which holds no ETH under the gasless model — and the kernel call
  reverted with `INSUFFICIENT_FUNDS`. Now both calls go through
  `client.standard.*` so AA users get Paymaster-sponsored UserOps;
  EOA / mock callers fall through to the same runtime path as before.
  See `src/cli/lib/runRequest.ts:201-220, 268-275`.

- **`request()` Level 0 API** (pre-existing in 3.x) — same shape of bug
  in `src/level0/request.ts`: `createTransaction`, the
  `transitionState(_, 'CANCELLED')` fallback inside the timeout-cancel
  branch, and the mock-mode `releaseEscrow` all dispatched through
  `client.runtime` directly. AA users calling `request('service', ...)`
  hit `INSUFFICIENT_FUNDS` on the first on-chain hop. Now all three sites
  route through `client.standard.*`.

- **`BuyerOrchestrator` / `actp negotiate`** (pre-existing) — the
  orchestrator was constructed with an `IACTPRuntime` and called
  `createTransaction`, `transitionState`, `linkEscrow`, and `acceptQuote`
  directly on it (11 sites). Same AA bypass for the negotiate flow.
  Fix: the constructor now accepts an optional `ACTPClient` as a 6th
  parameter; when provided, internal helpers (`_createTransaction`,
  `_transitionState`, `_linkEscrow`, `_acceptQuote`) route writes
  through `client.standard.*`. When omitted, the orchestrator falls
  back to the legacy direct-runtime path — so existing callers and
  tests that build a `BuyerOrchestrator` with only an `IACTPRuntime`
  keep working unchanged. The `actp negotiate` CLI now passes the
  client through to enable AA routing.

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
