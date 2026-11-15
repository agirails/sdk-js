# The factory standard for software

Generated from `standard/rules.toml` by `bin/standard gen`. Do not edit by hand: `bin/standard gen --check` and `tests/test_standard.py` fail when they differ.

One bar for quality and security for all code we build, no matter who writes it: Claude, Codex, another model or a person. A rule lives at the highest level that can enforce it. An existing violation stays in a baseline that may only shrink: a rule fails on new and changed lines and on a violation that a deletion created. The entry point for the check is `bin/code-check`. Exit 0 is clean, exit 1 means new violations, and exit 2 means the check could not measure; exit 2 is never a pass. A performance budget (P) is a report first, and it becomes a gate only when the noise is measured and the budget is written in `standard/repos/<id>.toml`.

## Enforcement levels

1. **Code and architecture**: the bad pattern cannot be written.
2. **Static check**: lint, typecheck, `code-check` and CI; the bad pattern cannot be shipped.
3. **Skills and rules**: for judgment that a machine cannot check.
4. **Human review**: only for what levels 1–3 do not cover yet; each such finding is a candidate for a higher level.

## Quality (K)

| ID | Rule | Level | Enforced by | Languages | Check |
|---|---|---|---|---|---|
| K1 | **One way for the same thing**: New code uses the existing module or API and does not add a parallel one. | 1 + 2 | architecture per repo; forbidden imports in `standard/repos/<id>.toml` | all | — |
| K2 | **A comment is only documentation or a directive**: A comment exists only as documentation of a public symbol or module, a directive with a reason, or `EXTERNAL(...)`. | 2 | `code-check comments` | py, ts, sol, sh | `factory.comments` |
| K3 | **No workaround comments and no TODOs**: Not in a doc comment either. Unfinished work goes into an issue. | 2 | `code-check comments` (vocabulary below, English and Croatian) | all | `factory.comments` |
| K4 | **An error is not swallowed**: No empty `except` or `catch`, no `except Exception: pass`, no `.catch(() => {})` and no empty rejection function in `.then(_, () => {})`. A handler that catches every error and only returns a constant value (`.catch(() => null)`, `catch { return null; }`, `except Exception: return None`) also swallows the error. | 2 | ruff `BLE001`, `S110`, `SIM105`; eslint `no-empty`, `@typescript-eslint/no-floating-promises`; an AST check for empty callbacks in `code-check`, because `no-empty` exempts function bodies | py, ts | `factory.checks.handlers` |
| K5 | **A linter suppression only with the rule name and a reason**: `eslint-disable-next-line <rule> -- reason`, `biome-ignore <category>: reason`, `# noqa: CODE`, `@ts-expect-error reason`. `@ts-ignore` and a bare `# type: ignore` are forbidden. Suppressing a correctness rule requires `factory-allow`; suppressing type checking (`@ts-expect-error`, `# type: ignore[code]`, `# pyright: ignore[code]`) counts as correctness. A suppression for a whole file (`@ts-nocheck`, `# mypy: ignore-errors` and other weaker `mypy:` settings, `# pyright: basic` and `report*=false`) is a violation even with a reason. | 2 | eslint `@eslint-community/eslint-comments/require-description`, `@typescript-eslint/ban-ts-comment`; ruff `PGH003`, `PGH004`; rule classes in `standard/configs/rule-classes.toml` | py, ts | `factory.comments` |
| K6 | **Strict types**: TypeScript `strict` and `noUncheckedIndexedAccess`; the Python SDK and services with type hints and mypy. | 2 | `tsc --noEmit` with `standard/configs/tsconfig.strict.json`; mypy | ts, py | — |
| K7 | **A warning is an error on new lines**: The linter runs with `--max-warnings 0`. | 2 | CI and `code-check` | ts, py | — |
| K8 | **No dead code**: No unused imports, variables or exports. | 2 | ruff `F401`, `F841`; `@typescript-eslint/no-unused-vars` = error; knip for tier A | ts, py | — |
| K9 | **No local paths and no internal infrastructure**: Shipped code and docs do not contain absolute paths of user directories, paths into the internal workspace or names of internal repos. The path patterns are in the check, and the internal names are in `standard/configs/internal-names.txt`. | 2 | `code-check paths` | all, md | `factory.checks.paths` |
| K10 | **Dependencies go one way**: No imports inside functions as a workaround for circular dependencies. | 1 + 2 | ruff `PLC0415` | py | — |
| K11 | **The formatter is the only source of style**: The formatter in check mode decides style, not review. | 2 | `ruff format --check`, `prettier --check` or the repo's formatter, `forge fmt --check` | all | — |
| K12 | **A change in behavior has a test that fails without it**: The test is written before the change and must fail for the right reason. | 3 + 2 | skill `prove`; `code-check` warns about a change in `src/` without a change to tests | all | `factory.checks.testdelta` |
| K13 | **A file or function does not grow past the threshold**: 800 lines per file, 120 per function. Only growth fails. | 2 | `code-check size` | all | `factory.checks.size` |
| K14 | **Module boundaries are written down and enforced through the import graph**: Electron main, preload and renderer are separate; Next.js server code (database, secrets, keys) is never in a client component (`import "server-only"`); the public API of an SDK goes only through `index`. | 1 + 2 | dependency-cruiser (TS), import-linter (Python), boundaries in `standard/repos/<id>.toml` | ts, py | — |
| K15 | **Old and parallel paths are deleted**: A deprecated API has a removal date; dead exports and unused files are deleted. | 1 + 2 | an inventory of paths per repo; knip or vulture; `code-check` fails on `@deprecated` without a date | ts, py, sol | `factory.comments` |
| K16 | **A repeated script becomes a CLI**: A script that agents write in two sessions becomes a CLI in the `scripts/` of a skill or repo. | 3 + 2 | a transcript miner that feeds the skill `correct` | all | — |
| K17 | **TypeScript without escapes from the type system**: No `as` (except `as const`), `!`, `any` or `console.*` in libraries; `switch` is exhaustive; no `no-unsafe-*` violations. | 2 | typescript-eslint `no-explicit-any`, `no-non-null-assertion`, `consistent-type-assertions`, `switch-exhaustiveness-check`, `no-unsafe-*`; eslint `no-console` | ts | — |
| K18 | **No lists kept in sync by hand**: When the same things live in two places, one is generated from the other, or a test fails when they differ. | 1 + 2 | `bin/standard gen --check`; `tests/test_standard.py` | all | — |
| K19 | **Tests are not disabled and not weakened**: An added `.only`, `.skip`, `.fixme`, `.fail`, `xit`, `xfail`, `pytest.skip` or `vm.skip` fails; a removed assertion gives a warning; a new test must fail on a mutation that breaks the behavior. | 2 + 3 | `code-check tests`; skill `prove` | all | `factory.checks.tests_guard` |

### K2: A comment is only documentation or a directive

Allowed on new lines:
- a Python docstring on a public symbol and a module docstring;
- Solidity NatSpec (`///` or `/** */` with `@notice`, `@dev`, `@param`, `@return`, `@custom`) on contracts, functions, events and errors;
- JSDoc/TSDoc directly above an exported declaration or a public member of an exported class;
- a `/** … */` header at the top of a TS or Solidity file;
- `SPDX-License-Identifier`, a shebang, the directives from K5 and `factory-allow`.

A constraint from outside (a dependency, platform, vendor, protocol) may stand next to the call only in the form `EXTERNAL(<dependency>): <rule> <url>`. Encoding the constraint as a type, assert, test or lint is preferred.

No other comment is allowed in the body of code. If code needs an explanation, change the name, the structure or the test. If the background is a decision, it goes into a decision record. When it is not clear whether an exception applies, the comment does not stay. JSDoc on a local or private function fails on new lines.

Words that signal a constraint (IMPORTANT, do not remove, ne diraj, pazi) fail with the message "encode the constraint (type, assert, test, lint), then delete the comment".

The check reads code with a tokenizer per language, not with a regex per line: the string `"// not a comment"` does not fail. Consecutive `//`, `///` and `#` lines are one comment.

### K3: No workaround comments and no TODOs

Vocabulary: `for now`, `TODO`, `FIXME`, `XXX`, `hack`, `kludge`, `band-aid`, `quick fix`, `workaround`, `temporary fix`, `temporary solution`, `temporary hack`, `temporary patch`, `temporarily disabled`, `temporarily skipped`, `temporarily hardcoded`, `privremeno rješenje`, `za sada`, `zasad`, `zaobilazak`.

"temporary" and "temporarily" count only in phrases from the vocabulary. "no workaround", "without workaround" and "workaround mode" do not count. The vocabulary can be evaded ("for now" → "currently"), so a sample of new doc comments is reviewed weekly; the review reports, but does not decide.

## Security (S)

| ID | Rule | Level | Enforced by | Languages | Check |
|---|---|---|---|---|---|
| S1 | **No secrets in the diff or in the history**: A secret does not enter the diff; the history is scanned once, and the report does not contain secret values. The configuration does not take over upstream path allowlists (vendor, node_modules, lockfiles), and a repo `.gitleaksignore` is not honored. | 2 | gitleaks (pinned, `standard/configs/gitleaks.toml` generated from its default configuration) over the diff in `code-check` and in CI | all, md | `factory.checks.external` |
| S2 | **A new dependency is pinned and reviewed**: A lockfile, a pinned version, an audit without high or critical findings, reviewed install scripts. | 2 + 3 | `code-check deps` on a lockfile change (`npm audit --omit=dev --audit-level=high`, osv-scanner or pip-audit); skill `supply-chain-security` for each new dependency | ts, py | — |
| S3 | **GitHub Actions are pinned and minimal**: Actions are pinned to a SHA, `permissions:` is minimal, no `pull_request_target` with a checkout of the PR's code and no `${{ github.event.* }}` in `run:`. A workflow or `action.yml` that cannot be read is not a pass, and shellcheck checks the scripts in `run:`. | 2 | zizmor `--strict-collection`, actionlint and shellcheck (pinned, `standard/configs/zizmor.yml`) | gha | `factory.checks.external` |
| S4 | **Solidity without new high or medium findings**: slither without new high or medium findings, NatSpec on external and public functions, CEI. | 2 + 3 | slither in CI with a baseline; solhint (`standard/configs/.solhint.json`); skill `smart-contract-implementation` | sol | — |
| S5 | **No dangerous calls**: No `eval`, no `exec` with input, no `shell=True` with a variable, no `child_process.exec` with interpolation, no `pickle` over untrusted input and no SQL concatenated from strings. | 2 | ruff `S`; eslint `no-eval`, `no-implied-eval`, `no-new-func`, restricted `child_process.exec` | py, ts | — |
| S6 | **A diff at a trust boundary goes through a security review**: Auth, bridges, egress, permissions, money and signatures go through `blast-radius`, `security-audit` guidance and Codex Security `security-diff-scan` before shipping. Contracts and an SDK major version go into a full audit before release. | 2 + 3 | `code-check` flags a diff that touches `trust_boundary` from `standard/repos/<id>.toml`; `prove` asks for the audit record | all | — |
| S7 | **Repo code runs only in a sandbox**: A check that runs repo code (linter configuration, tests, a repro of a finding) goes through a sandbox that protects both the network and confidentiality. Known limit: the total memory of all processes and the total writes into the writable paths are not limited, because that would require a cgroup over the user systemd bus; per process, the limits are private memory in the heap and in private mappings (RLIMIT_DATA, default 4 GB), address space (RLIMIT_AS, default 4 GB; the call that code-check runs with gitleaks asks for 8 GB, because the pinned gitleaks reserves about 5.4 GB and uses about 0.15 GB) and CPU time, plus the number of processes, the size of one file, tmpfs and output. RLIMIT_DATA does not count the stack (the main stack, MAP_GROWSDOWN, mremap of the stack) or shared mappings, so address space is the upper memory bound of one process. | 1 + 2 | `bin/sandbox-run`; tier B uses only our configuration | all | — |

## Performance budgets (P)

| ID | Product | Initial budget | Enforced by |
|---|---|---|---|
| P1 | Solidity contracts | Gas per function does not grow without a reason. | `forge snapshot --check` in CI; a snapshot change needs a reason in the commit |
| P2 | SDK packages | Package size and import time do not grow by more than 5 %. | `npm pack --dry-run`, `require` time, `python -X importtime` |
| P3 | Web | LCP < 2.5 s, CLS < 0.1, INP < 200 ms on the mobile profile; JS per route does not grow without a reason. | Lighthouse CI or a verify skill over a preview build |
| P4 | Desktop application | No long tasks > 50 ms on the main paths; a frame ≤ 16 ms while scrolling. | a verify skill with a CDP trace |
| P5 | APIs and services | p95 per endpoint is recorded and does not grow by more than 20 %. | a verify skill or a benchmark script |
