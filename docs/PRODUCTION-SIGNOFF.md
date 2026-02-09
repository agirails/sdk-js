AGIRAILS SDK — Production Sign-off

Scope:
- AIP-12 AA Wallet + Gasless Onboarding
- SDK runtime and CLI changes listed in QA-ISSUES-TS-SDK.md

Sign-off status: APPROVED
Date: 2026-02-09

Evidence:
- CI Run #21833391969 (branch: main) — success
  - Node 18/20/22: lint + build + jest
  - CJS smoke tests: require() + sub-path exports + no ESM syntax in dist
  - Test Suites: 47 passed, 47 total
  - Tests: 1506 passed, 1506 total

Blocking issues: CLOSED
- Confirmations configurable (min 1) and threaded through ACTPKernel tx.wait
- CI matrix 18/20/22 + CJS smoke tests
- Ops playbook in place (OPS-PLAYBOOK.md)

Known limitations (accepted):
- EventMonitor does not enforce confirmations itself; relies on ACTPKernel tx.wait confirmations.
- ESM dual-build not provided (CJS-only; documented).
- Optional hardening tests pending (CLI auto-mode, IPFS localhost default, missing CDP key unit tests).

Approver: Codex QA (strict review)
