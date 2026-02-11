# AGIRAILS Go-Live QA Gate

> Final release gate for public and financial accountability.
> Last updated: 2026-02-11

---

## 1) Policy

This checklist is outcome-based, not time-based.  
AI-assisted delivery can compress timelines, but **cannot** bypass release gates.

Release rule:
- If any `P0` gate is red: **NO-GO**
- If any `P1` gate is red: **NO-GO** for GA (canary allowed only with explicit risk sign-off)
- Green means objective evidence is attached (CI links, logs, dashboards, tx traces)

---

## 2) Hard Gates (P0)

| Gate | Owner | Acceptance Criteria | Evidence Required |
|---|---|---|---|
| P0-1 Deterministic CI | QA Lead | `tsc`, `eslint`, full tests green on clean clone | CI run URL + commit SHA |
| P0-2 Critical Path E2E | SDK Lead | Lazy publish scenarios `A/B1/B2/C/none` pass on testnet+mainnet fork | E2E report + artifacts |
| P0-3 Financial Guardrails | Infra/FinOps | Paymaster caps, per-address limits, rate limits enabled | Config screenshots + policy export |
| P0-4 Rollback Controls | SRE | Kill-switches for AA/lazy-publish/paymaster live and tested | Runbook + rollback drill output |
| P0-5 Security Baseline | Security Owner | No open critical/high vulns on release scope | Signed security checklist |
| P0-6 Observability | SRE | Dashboards + alerting for error/cost/latency/abuse active | Dashboard links + alert test |
| P0-7 Incident Readiness | Eng Manager | Named on-call + severity runbook + paging test passed | Pager test record |

---

## 3) Strong Gates (P1)

| Gate | Owner | Acceptance Criteria | Evidence Required |
|---|---|---|---|
| P1-1 Canary Stability | SRE | Canary runs with no SLO breach over defined window | Canary report |
| P1-2 Chaos/Fault Injection | QA/SRE | RPC/bundler/paymaster/file faults handled without data corruption | Chaos test report |
| P1-3 Concurrency Safety | SDK Lead | Parallel `publish`/`pay` stress tests pass, no duplicate activation | Stress test logs |
| P1-4 Abuse Resilience | Security/Infra | Replay/tamper/rate abuse tests pass | Abuse test report |
| P1-5 Cost Predictability | FinOps | Sponsored gas within budget envelope under load | Cost model + real run data |

---

## 4) Test Pack Required Before GA

1. Full regression: `npm test -- --no-coverage` on release commit.
2. Scenario matrix:
   - no pending
   - A first activation
   - B1 registered+unlisted
   - B2 config update
   - C stale pending cleanup
3. Network-scoped pending files:
   - `pending-publish.base-sepolia.json`
   - `pending-publish.base-mainnet.json`
   - legacy fallback behavior
4. Fresh-project bootstrap:
   - no prior `actp init`
   - wallet created
   - config bootstrapped correctly
5. Failure-mode tests:
   - RPC down
   - paymaster reject
   - bundler timeout
   - file permission errors
6. Recovery tests:
   - retry after failed activation
   - no duplicate on-chain actions
   - stale pending removed safely

---

## 5) Production SLO + Auto-Rollback

Auto-rollback trigger if any condition persists beyond allowed window:

1. `activation_success_rate < 99.0%`
2. `payment_success_rate < 99.5%`
3. `p95 payment latency > 2x baseline`
4. `paymaster spend/hour > budget threshold`
5. `fallback_to_eoa rate` spikes above normal envelope

Required metrics:
1. activation success/fail by scenario
2. paymaster sponsorship success/fail
3. fallback reasons
4. retries per operation
5. gas spend per tx and per address
6. error rate by component (RPC, bundler, paymaster, filesystem)

---

## 6) Sign-Off Template

Release: `____________________`  
Commit: `____________________`  
Date: `____________________`

| Role | Name | Decision | Notes |
|---|---|---|---|
| QA Lead |  | GO / NO-GO |  |
| SDK Lead |  | GO / NO-GO |  |
| SRE/Infra |  | GO / NO-GO |  |
| Security |  | GO / NO-GO |  |
| FinOps |  | GO / NO-GO |  |
| Final Accountable Owner |  | GO / NO-GO |  |

Final rule:
- Any `NO-GO` from Security, SRE, or Final Accountable Owner blocks release.

