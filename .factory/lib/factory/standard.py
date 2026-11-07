"""Standard registry: rules from rules.toml, the generated STANDARD.md, tools.lock, repo descriptions (repos/*.toml)
and the content of the copy in the target repo's `.factory/`."""
from __future__ import annotations

import datetime
import re
import shlex
import tomllib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from . import layout
from .model import LANGS, MeasureError, sha256

KNOWN_LANGS = frozenset(LANGS.values()) | {"all", "gha"}
GROUPS = {"K": "Quality", "S": "Security", "P": "Performance budgets"}
RULE_ID = re.compile(r"^([KSP])([1-9][0-9]?)$")
MODULE = re.compile(r"^[a-z][a-z0-9_]*$")
CHECKER = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$")
TIERS = ("A", "B", "C")
BASELINE_POLICIES = ("empty", "only-decrease")
TOOL_KINDS = ("tar.gz", "npm")
URL_SCHEMES = ("https://", "file://")
EXCLUDE_KEY = re.compile(r"^(?:all|[KSP][1-9][0-9]?)$")
NON_CODE_LANGS = frozenset({"md", "gha"})
SYNC_CONFIGS = {
    "all": ("gitleaks.toml", "internal-names.txt", "rule-classes.toml", "sandbox-deny.txt", "zizmor.yml"),
    "py": ("ruff.toml",),
    "ts": ("eslint.base.mjs", "eslint.rules.json", "tsconfig.strict.json"),
    "sol": (".solhint.json",),
}
SYNC_EXECUTABLE = frozenset({layout.rel(layout.CODE_CHECK), layout.rel(layout.STANDARD_BIN)})
SYNC_IGNORE = "/.tools/\n__pycache__/\n"
SYNC_MANAGED_DIRS = frozenset({"bin", "lib", "standard"})
HOOK_MARKER = "# factory-standard pre-commit"
HOOK_TEMPLATE = """#!/bin/sh
{marker}: written and updated by `bin/standard install-hooks <repo> --apply` from the standard's source.
source={source}
copy={copy}
top=$(git rev-parse --show-toplevel) || exit 1
if [ -x "$source/{code_check}" ]; then
    exec "$source/{code_check}" diff --staged --repo "$top"
fi
if [ -x "$top/$copy" ]; then
    printf '%s\\n' "pre-commit: the standard's source is not on this machine ($source); the public copy $copy checks, so internal names are not checked (K9)" >&2
    exec "$top/$copy" diff --staged --repo "$top"
fi
printf '%s\\n' "pre-commit: no code-check (neither $source/{code_check} nor $copy in the repo), commit blocked." >&2
printf '%s\\n' "pre-commit: install the standard's source and run bin/standard install-hooks <repo> --apply, or bin/standard sync <repo>." >&2
exit 1
"""
PUBLIC_LISTS = {
    layout.NAMES: ("# K9: the public copy has no internal names or their fingerprints, since a short name can be\n"
                   "# recovered from its fingerprint with a word list. code-check from the source checks them.\n"),
    layout.DENY: ("# sandbox-run: the public copy has no private trees or their fingerprints, since a short path can\n"
                  "# be recovered from its fingerprint with a word list. The list applies only in the source.\n"),
}


@dataclass(frozen=True)
class Rule:
    """One rule of the standard. `checker` is a module name in lib/factory, or None when another tool enforces it."""
    id: str
    title: str
    text: str
    level: tuple[int, ...]
    enforcer: str
    langs: tuple[str, ...]
    checker: str | None = None
    detail: str | None = None
    terms: tuple[str, ...] = ()

    @property
    def group(self) -> str:
        return self.id[0]

    def order(self) -> tuple[int, int]:
        return (list(GROUPS).index(self.group), int(self.id[1:]))


@dataclass(frozen=True)
class Tool:
    """A pinned tool from tools.lock."""
    name: str
    version: str
    kind: str
    url: str
    sha256: str
    dest: str
    released: datetime.date
    member: str | None = None
    version_args: tuple[str, ...] = ()
    integrity: str | None = None
    archive: str | None = None
    checksum_source: str | None = None
    provenance: str | None = None
    platform: str | None = None


@dataclass(frozen=True)
class Lock:
    """Content of tools.lock: the lock date and tools by name."""
    locked: datetime.date
    tools: dict[str, Tool]


@dataclass(frozen=True)
class Repo:
    """A repo under the standard. A relative `path` in the toml is relative to the toml's directory, and `~` to HOME."""
    id: str
    name: str
    path: Path
    tier: str
    enforce_as: str
    langs: tuple[str, ...]
    proof: tuple[tuple[str, ...], ...]
    base: str
    trust_boundary: tuple[str, ...]
    baseline_path: str
    baseline_policy: str
    publish: tuple[dict, ...] = ()
    public_api: tuple[str, ...] = ()
    forbidden_imports: tuple[str, ...] = ()
    budgets: dict | None = None
    consent: bool = False
    source: Path | None = None
    exclude: dict[str, tuple[str, ...]] = field(default_factory=dict)


@lru_cache(maxsize=256)
def _glob(pattern: str) -> re.Pattern:
    out, index = [], 0
    while index < len(pattern):
        if pattern.startswith("**/", index):
            out.append("(?:.*/)?")
            index += 3
        elif pattern.startswith("**", index):
            out.append(".*")
            index += 2
        else:
            out.append({"*": "[^/]*", "?": "[^/]"}.get(pattern[index], re.escape(pattern[index])))
            index += 1
    return re.compile("".join(out))


def path_matches(path: str, patterns) -> bool:
    """A repo-relative path matches one of the patterns: `**` is any number of directories, `*` and `?` stay
    within one path part."""
    return any(_glob(pattern).fullmatch(path) for pattern in patterns)


def parse_exclude(data: dict, where: str) -> dict[str, tuple[str, ...]]:
    """Table [exclude]: the key is `all` or a rule id, the value a list of path patterns that rule does not look at."""
    raw = data.get("exclude", {})
    if not isinstance(raw, dict):
        raise MeasureError(f"{where}: exclude must be a table")
    bad = sorted(key for key in raw if not EXCLUDE_KEY.match(key))
    if bad:
        raise MeasureError(f"{where}: an exclude key must be all or a rule id, not {', '.join(bad)}")
    return {key: str_list(raw, key, f"{where} [exclude]") for key in sorted(raw)}


def checker_file(checker: str) -> str:
    """Putanja modula provjere relativno prema lib/factory: `checks.paths` → `checks/paths.py`."""
    return checker.replace(".", "/") + ".py"


def read_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise MeasureError(f"{path}: cannot read ({exc})") from exc


def need(data: dict, key: str, kind: type, where: str):
    if key not in data:
        raise MeasureError(f"{where}: fali polje {key}")
    value = data[key]
    if not isinstance(value, kind) or (isinstance(value, (str, list)) and not value and kind is not list):
        raise MeasureError(f"{where}: field {key} must be {kind.__name__} and must not be empty")
    return value


def str_list(data: dict, key: str, where: str, required: bool = True) -> tuple[str, ...]:
    if key not in data and not required:
        return ()
    value = need(data, key, list, where)
    if not all(isinstance(x, str) and x for x in value):
        raise MeasureError(f"{where}: {key} must be a list of non-empty strings")
    return tuple(value)


def only_fields(data: dict, allowed: set[str], where: str) -> None:
    extra = sorted(set(data) - allowed)
    if extra:
        raise MeasureError(f"{where}: nepoznata polja {', '.join(extra)}")


def parse_rule(raw: dict, where: str) -> Rule:
    only_fields(raw, {"id", "title", "text", "level", "enforcer", "langs", "checker", "detail", "terms"}, where)
    rid = need(raw, "id", str, where)
    if not RULE_ID.match(rid):
        raise MeasureError(f"{where}: id {rid} is not of the form K<n>, S<n> or P<n>")
    where = f"{where} {rid}"
    level = need(raw, "level", list, where)
    if not level or not all(isinstance(x, int) and 1 <= x <= 4 for x in level):
        raise MeasureError(f"{where}: level must be a list of levels 1–4")
    langs = str_list(raw, "langs", where)
    unknown = sorted(set(langs) - KNOWN_LANGS)
    if unknown:
        raise MeasureError(f"{where}: nepoznat jezik {', '.join(unknown)}")
    checker = raw.get("checker")
    if checker is not None and (not isinstance(checker, str) or not CHECKER.match(checker)):
        raise MeasureError(f"{where}: checker must be a module name in lib/factory (e.g. checks.paths)")
    detail = raw.get("detail")
    if detail is not None and not isinstance(detail, str):
        raise MeasureError(f"{where}: detail must be text")
    return Rule(id=rid, title=need(raw, "title", str, where), text=need(raw, "text", str, where),
                level=tuple(level), enforcer=need(raw, "enforcer", str, where), langs=langs, checker=checker,
                detail=detail.strip() if detail else None, terms=str_list(raw, "terms", where, required=False))


def load_rules(path: Path) -> list[Rule]:
    """Load and check rules.toml. Every shape error is a MeasureError, never a silent pass."""
    path = Path(path)
    data = read_toml(path)
    only_fields(data, {"meta", "level", "rule"}, str(path))
    raws = data.get("rule")
    if not isinstance(raws, list) or not raws:
        raise MeasureError(f"{path}: no [[rule]] at all")
    rules, seen = [], set()
    for i, raw in enumerate(raws):
        if not isinstance(raw, dict):
            raise MeasureError(f"{path}: rule #{i + 1} is not a table")
        rule = parse_rule(raw, f"{path}: rule #{i + 1}")
        if rule.id in seen:
            raise MeasureError(f"{path}: rule {rule.id} is listed twice")
        seen.add(rule.id)
        rules.append(rule)
    return sorted(rules, key=Rule.order)


def load_meta(path: Path) -> tuple[dict, list[dict]]:
    """Intro and enforcement levels from rules.toml, for the STANDARD.md header."""
    data = read_toml(Path(path))
    meta, levels = data.get("meta", {}), data.get("level", [])
    if not isinstance(meta, dict) or not isinstance(levels, list):
        raise MeasureError(f"{path}: meta must be a table and level a list of tables")
    only_fields(meta, {"title", "intro"}, f"{path} [meta]")
    for lv in levels:
        where = f"{path} [[level]]"
        if not isinstance(lv, dict):
            raise MeasureError(f"{where}: is not a table")
        only_fields(lv, {"id", "name", "text"}, where)
        for key, kind in (("id", int), ("name", str), ("text", str)):
            need(lv, key, kind, where)
    return meta, sorted(levels, key=lambda x: x["id"])


def cell(text: str) -> str:
    return " ".join(text.split()).replace("|", "\\|")


def render_standard(rules: list[Rule], meta: dict | None = None, levels: list[dict] | None = None) -> str:
    """STANDARD.md from the rules. The same input gives the same output regardless of rule order."""
    rules = sorted(rules, key=Rule.order)
    meta = meta or {}
    out = [f"# {meta.get('title', 'The software factory standard')}", "",
           "Generated from `standard/rules.toml` by `bin/standard gen`. Do not edit by hand: "
           "`bin/standard gen --check` and `tests/test_standard.py` fail when they differ.", ""]
    if meta.get("intro"):
        out += [meta["intro"].strip(), ""]
    if levels:
        out += ["## Enforcement levels", ""]
        out += [f"{lv['id']}. **{lv['name']}**: {lv['text'].strip()}" for lv in levels]
        out.append("")
    for group, heading in GROUPS.items():
        members = [r for r in rules if r.group == group]
        if not members:
            continue
        out += [f"## {heading} ({group})", ""]
        if group == "P":
            out += ["| ID | Product | Initial budget | Enforced by |", "|---|---|---|---|"]
            out += [f"| {r.id} | {cell(r.title)} | {cell(r.text)} | {cell(r.enforcer)} |" for r in members]
        else:
            out += ["| ID | Rule | Level | Enforced by | Languages | Check |", "|---|---|---|---|---|---|"]
            for r in members:
                check = f"`factory.{r.checker}`" if r.checker else "—"
                out.append(f"| {r.id} | **{cell(r.title)}**: {cell(r.text)} | {' + '.join(map(str, r.level))} | "
                           f"{cell(r.enforcer)} | {', '.join(r.langs)} | {check} |")
        out.append("")
        for r in members:
            if r.detail or r.terms:
                out += [f"### {r.id}: {r.title}", ""]
                if r.terms:
                    out += ["Vocabulary: " + ", ".join(f"`{t}`" for t in r.terms) + ".", ""]
                if r.detail:
                    out += [r.detail, ""]
    return "\n".join(out).rstrip("\n") + "\n"


def generate(rules_path: Path) -> str:
    """The whole STANDARD.md from one rules.toml: intro, levels and rules."""
    meta, levels = load_meta(rules_path)
    return render_standard(load_rules(rules_path), meta, levels)


def parse_tool(name: str, raw: dict, where: str) -> Tool:
    allowed = {"version", "kind", "url", "sha256", "dest", "released", "member", "version_args", "integrity",
               "archive", "checksum_source", "provenance", "platform"}
    only_fields(raw, allowed, where)
    version = need(raw, "version", str, where)
    if version == "latest" or not re.match(r"^[0-9]+(\.[0-9]+)+$", version):
        raise MeasureError(f"{where}: version {version} is not pinned (an exact version is needed, e.g. 1.2.3)")
    if "sha256" not in raw or not re.match(r"^[0-9a-f]{64}$", str(raw["sha256"])):
        raise MeasureError(f"{where}: sha256 is missing or invalid")
    kind = need(raw, "kind", str, where)
    if kind not in TOOL_KINDS:
        raise MeasureError(f"{where}: kind must be one of {', '.join(TOOL_KINDS)}")
    url = need(raw, "url", str, where)
    if not url.startswith(URL_SCHEMES):
        raise MeasureError(f"{where}: url {url} must be https:// (file:// only for a local test)")
    released = need(raw, "released", datetime.date, where)
    dest = need(raw, "dest", str, where)
    for key in ("dest", "archive", "member"):
        value = raw.get(key)
        if value is not None and (not isinstance(value, str) or value.startswith("/") or ".." in Path(value).parts):
            raise MeasureError(f"{where}: {key} must be a relative path without ..")
    if kind == "tar.gz":
        need(raw, "member", str, where)
    if kind == "npm":
        integrity = need(raw, "integrity", str, where)
        if not integrity.startswith("sha512-"):
            raise MeasureError(f"{where}: integrity must be sha512-…")
    return Tool(name=name, version=version, kind=kind, url=url, sha256=raw["sha256"], dest=dest, released=released,
                member=raw.get("member"), version_args=str_list(raw, "version_args", where, required=False),
                integrity=raw.get("integrity"), archive=raw.get("archive"),
                checksum_source=raw.get("checksum_source"), provenance=raw.get("provenance"),
                platform=raw.get("platform"))


def load_lock(path: Path) -> Lock:
    """Load tools.lock. An unpinned version, a missing sha256 or a url that is not https is a MeasureError."""
    path = Path(path)
    data = read_toml(path)
    only_fields(data, {"locked", "tool"}, str(path))
    locked = need(data, "locked", datetime.date, str(path))
    raws = need(data, "tool", dict, str(path))
    tools = {}
    for name in sorted(raws):
        if not MODULE.match(name.replace("-", "_")):
            raise MeasureError(f"{path}: tool name {name} is not allowed")
        tools[name] = parse_tool(name, raws[name], f"{path}: tool.{name}")
    return Lock(locked=locked, tools=tools)


def resolve_path(raw: str, base: Path, home: Path | None = None) -> Path:
    """`~` expands from HOME; a relative path is relative to `base`."""
    if raw == "~" or raw.startswith("~/"):
        root = home if home is not None else Path.home()
        return (root / raw[2:]).resolve() if raw != "~" else root.resolve()
    p = Path(raw)
    return (p if p.is_absolute() else base / p).resolve()


def parse_proof(data: dict, where: str) -> tuple[tuple[str, ...], ...]:
    value = need(data, "proof", list, where)
    steps = []
    for step in value:
        if not isinstance(step, list) or not step or not all(isinstance(x, str) and x for x in step):
            raise MeasureError(f"{where}: proof is a list of steps, and each step is a list of arguments (no shell)")
        steps.append(tuple(step))
    return tuple(steps)


def load_repo(path: Path, home: Path | None = None) -> Repo:
    """Load one repos/<id>.toml and check its shape."""
    path = Path(path)
    data = read_toml(path)
    where = str(path)
    allowed = {"id", "name", "path", "tier", "enforce_as", "langs", "proof", "base", "trust_boundary", "baseline",
               "publish", "public_api", "forbidden_imports", "budgets", "consent", "exclude"}
    only_fields(data, allowed, where)
    tier, enforce_as = need(data, "tier", str, where), need(data, "enforce_as", str, where)
    if tier not in TIERS or enforce_as not in TIERS:
        raise MeasureError(f"{where}: tier and enforce_as must be A, B or C")
    langs = str_list(data, "langs", where)
    unknown = sorted(set(langs) - KNOWN_LANGS)
    if unknown:
        raise MeasureError(f"{where}: nepoznat jezik {', '.join(unknown)}")
    baseline = need(data, "baseline", dict, where)
    policy = need(baseline, "policy", str, f"{where} [baseline]")
    if policy not in BASELINE_POLICIES:
        raise MeasureError(f"{where}: baseline.policy must be {' or '.join(BASELINE_POLICIES)}")
    publish = data.get("publish", [])
    if not isinstance(publish, list) or not all(isinstance(p, dict) and p.get("kind") for p in publish):
        raise MeasureError(f"{where}: publish is a list of tables with a kind field")
    budgets = data.get("budgets")
    if budgets is not None and not isinstance(budgets, dict):
        raise MeasureError(f"{where}: budgets must be a table")
    consent = data.get("consent", False)
    if not isinstance(consent, bool):
        raise MeasureError(f"{where}: consent must be true or false")
    return Repo(id=need(data, "id", str, where), name=need(data, "name", str, where),
                path=resolve_path(need(data, "path", str, where), path.parent, home), tier=tier,
                enforce_as=enforce_as, langs=langs, proof=parse_proof(data, where), base=need(data, "base", str, where),
                trust_boundary=str_list(data, "trust_boundary", where), baseline_path=need(baseline, "path", str, where),
                baseline_policy=policy, publish=tuple(publish),
                public_api=str_list(data, "public_api", where, required=False),
                forbidden_imports=str_list(data, "forbidden_imports", where, required=False),
                budgets=budgets, consent=consent, source=path, exclude=parse_exclude(data, where))


def load_repos(directory: Path, home: Path | None = None) -> list[Repo]:
    """All repos/*.toml, sorted by id. The same id twice is a MeasureError."""
    repos = [load_repo(p, home) for p in sorted(Path(directory).glob("*.toml"))]
    ids = [r.id for r in repos]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise MeasureError(f"{directory}: the same id in several files: {', '.join(dup)}")
    return sorted(repos, key=lambda r: r.id)


def code_langs(repo: Repo) -> set[str]:
    """The repo's code languages: all of `langs` except documentation and workflows."""
    return set(repo.langs) - NON_CODE_LANGS


def sync_payload(repo: Repo) -> dict[str, bytes]:
    """Content of the copy in `.factory/` by path relative to it: code-check, bin/standard (CI uses it to install
    pinned tools into `.factory/.tools/`), lib/factory, rules, lock, STANDARD.md and configs for the repo's languages.
    The layout is the same as in the source (`layout`). The internal-names and private-trees lists ship empty
    (`PUBLIC_LISTS`), since fingerprints would reveal the names too. A file missing in the source is a MeasureError."""
    sources = [layout.CODE_CHECK, layout.STANDARD_BIN, layout.RULES, layout.LOCK, layout.STANDARD / "STANDARD.md"]
    sources += [p for p in sorted(layout.PACKAGE.rglob("*")) if p.is_file() and "__pycache__" not in p.parts
                and p.suffix != ".pyc"]
    for lang in ["all", *sorted(code_langs(repo))]:
        sources += [layout.CONFIGS / name for name in SYNC_CONFIGS.get(lang, ())
                    if layout.CONFIGS / name not in PUBLIC_LISTS]
    missing = sorted(layout.rel(p) for p in sources if not p.is_file())
    if missing:
        raise MeasureError(f"missing in the source: {', '.join(missing)}")
    payload = {layout.rel(p): p.read_bytes() for p in sources}
    payload.update({layout.rel(path): header.encode("utf-8") for path, header in PUBLIC_LISTS.items()})
    payload[".gitignore"] = SYNC_IGNORE.encode("utf-8")
    return dict(sorted(payload.items()))


def sync_source(payload: dict[str, bytes], commit: str, dirty: bool) -> str:
    """`.factory/SOURCE`: the source commit (with a dirty mark) and the sha256 of every copied file."""
    rows = [f"source {commit}{' dirty' if dirty else ''}\n"]
    return "".join(rows + [f"{sha256(data)}  {rel}\n" for rel, data in sorted(payload.items())])


def parse_source(text: str, where: str) -> dict[str, str]:
    """Managed files from `.factory/SOURCE`: relative path → sha256. A path must stay inside `.factory/` (no `..`,
    absolute path or empty parts) and within the names sync writes (`.gitignore`, `bin/`, `lib/`, `standard/`),
    because sync deletes managed files that are gone from the source and must not delete baseline or suppressions."""
    lines = text.splitlines()
    if not lines or not re.fullmatch(r"source [0-9a-f]{40}( dirty)?", lines[0]):
        raise MeasureError(f"{where}: the first line is not `source <commit>`")
    rows: dict[str, str] = {}
    for n, line in enumerate(lines[1:], start=2):
        digest, sep, rel = line.partition("  ")
        parts = rel.split("/")
        if (not sep or not re.fullmatch(r"[0-9a-f]{64}", digest) or rel.startswith("/") or "\\" in rel
                or any(part in ("", ".", "..") for part in parts) or rel in rows
                or not (rel == ".gitignore" or (len(parts) > 1 and parts[0] in SYNC_MANAGED_DIRS))):
            raise MeasureError(f"{where}:{n}: the line is not `<sha256>  <path inside .factory>`")
        rows[rel] = digest
    return rows


def pre_commit_hook(source: Path) -> str:
    """Content of `.git/hooks/pre-commit`: `code-check diff --staged` from the standard's source at `source`, else the
    public copy in `.factory/` with a warning that internal names (K9) are not checked. Without either, the commit is
    blocked. The source's absolute path goes only into the generated hook, which stays in `.git/hooks`, unshipped."""
    own = layout.rel(layout.CODE_CHECK)
    return HOOK_TEMPLATE.format(marker=HOOK_MARKER, source=shlex.quote(str(source)), code_check=own,
                                copy=shlex.quote(f"{layout.SYNC_DIR}/{own}"))
