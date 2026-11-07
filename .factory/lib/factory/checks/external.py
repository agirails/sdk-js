"""S1 secrets (gitleaks) and S3 GitHub Actions (zizmor, actionlint) over the diff, only with pinned tools in .tools/bin.

The tools read a copy in a temporary directory, never the repo: configuration and exceptions from the repo
(`.gitleaksignore`, `zizmor.yml`, `actionlint.yaml`) cannot weaken the check. A `.gitleaksignore` from the diff goes to
the copy under another name, so gitleaks does not load it, and inline exceptions are removed from the copy
(`gitleaks:allow`, `zizmor: ignore[...]`, in workflows also `shellcheck disable=`). An S1 or S3 exception goes only
through a `factory-allow` that existed in the base. The tool environment is empty except HOME, with no network
(`zizmor --offline`). zizmor runs with `--strict-collection`, so an invalid workflow or action.yml is not a pass.

actionlint checks `run:` scripts with the pinned shellcheck. gitleaks enters archives (`--max-archive-depth`) and reads
UTF-16 text converted to UTF-8. An S1 finding's key is the rule and the fingerprint of the exact bytes of the secret's
lines (no lowercasing or whitespace collapsing) in the copy gitleaks read, and for a file with a NUL byte or an archive
member the whole file's fingerprint, so a secret that replaces an old one is not matched with the base. The secret
value is not read from the report; tool messages go out without quoted values and long strings (`public_text`).

`standard/configs/gitleaks.toml` is the pinned gitleaks default configuration without path allowlists (vendor,
node_modules, lockfiles), because a secret in a lockfile is a real case. `[extend] useDefault` cannot leave them out, so
the file is generated (`gitleaks_config`) from the default in the pinned binary, with a fingerprint per version.
A rule that matches its own declaration gets an allowlist only for that declaration's exact `regex = '''…'''` line,
with escaped punctuation, so the exclusion line does not contain the matched string. The same value elsewhere is a
finding, so a custom rule's declaration in a repo's gitleaks config is an S1 finding; a base `factory-allow` passes it.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import tomllib
from pathlib import Path, PurePosixPath
from typing import Iterable

from .. import layout, pins, standard
from ..model import FileView, Finding, MeasureError, normalize, ordered, sha256

TOOLS = layout.TOOL_BIN
CONFIGS = layout.CONFIGS
TIMEOUT = 300
WORKFLOW = re.compile(r"^\.github/workflows/[^/]+\.ya?ml$")
ACTION = re.compile(r"(^|/)action\.ya?ml$")
REPO_CONFIGS = frozenset({".github/actionlint.yaml", ".github/actionlint.yml", ".github/zizmor.yml",
                          ".github/zizmor.yaml", "zizmor.yml", "zizmor.yaml"})
WALK_SKIP = frozenset({".git", "node_modules", ".factory", ".tools"})
ZIZMOR_OK = frozenset({0, 10, 11, 12, 13, 14})
BLOCKING = frozenset({"high", "medium"})
FIX_SECRET = "remove the secret from the code, revoke it and load it from the environment or a secret store"
INLINE_IGNORES = re.compile(rb"gitleaks:allow|zizmor:[ \t]*ignore\[[^\]\n]*\]", re.I)
WORKFLOW_IGNORES = re.compile(INLINE_IGNORES.pattern + rb"|shellcheck[ \t]+disable[ \t]*=[ \t]*[\w,-]*", re.I)
ARCHIVE_DEPTH = 8
MEMBER = "!"
QUOTED = re.compile(r"\"[^\"\n]*\"|'[^'\n]*'|`[^`\n]*`")
LONG_TOKEN = re.compile(r"\S{20,}")
UTF16_BOMS = (b"\xff\xfe", b"\xfe\xff")
GITLEAKS_IGNORE = ".gitleaksignore"
STAGED_IGNORE = ".gitleaksignore.factory-kopija"
GITLEAKS_DEFAULT = {"8.30.1": (97731, "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf")}
GITLEAKS_DEFAULT_START = b"# This file has been auto-generated. Do not edit manually.\n"
GITLEAKS_REGENERATE = ("python3 -c 'import sys; sys.path[:0] = [\"lib\"]; from factory.checks import external; "
                       "external.write_gitleaks_config()'")
ALLOWLIST_TABLES = frozenset({"allowlist", "allowlists", "rules.allowlists"})
OWN_RULE_LINE = r"^\n?regex = '{{3}}{}'{{3}}$"
ASCII_PUNCT = re.compile(r"[ -/:-@\[-`{-~]")
TABLE = re.compile(r"^\[\[?([\w.]+)\]\]?\s*$")


def tool(name: str, tools_dir: Path = TOOLS) -> Path:
    """Path of a pinned tool; a tool that is not installed is a MeasureError. A tool from .tools/bin must match the
    archive from tools.lock byte for byte (`pins`); another directory is only for test substitutes."""
    path = Path(tools_dir) / name
    if not (path.is_file() and os.access(path, os.X_OK)):
        raise MeasureError(f"tool {name} is not installed in .tools/bin; run standard install-tools")
    if Path(tools_dir) == TOOLS and pins.verified(name, TOOLS.parent) != path:
        raise MeasureError(f"tool {name} is not at the path from tools.lock")
    return path


def public_text(text: str) -> str:
    """Tool message without values from the source: quoted parts and strings of 20 or more characters with a letter and
    a digit become `…`."""
    text = QUOTED.sub(lambda m: m.group()[0] + "…" + m.group()[0], text)
    return LONG_TOKEN.sub(lambda m: "…" if re.search(r"\d", m.group()) and re.search(r"[A-Za-z]", m.group())
                          else m.group(), text)


def _run(argv: list[str], cwd: Path, ok: frozenset[int]) -> subprocess.CompletedProcess:
    name = Path(argv[0]).name
    try:
        proc = subprocess.run(argv, cwd=cwd, env={"HOME": str(cwd), "NO_COLOR": "1"}, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)
    except subprocess.TimeoutExpired as exc:
        raise MeasureError(f"{name} did not finish in {TIMEOUT} s") from exc
    except OSError as exc:
        raise MeasureError(f"{name} cannot be started: {exc.strerror}") from exc
    if proc.returncode not in ok:
        raise MeasureError(f"{name} exited with code {proc.returncode}: {public_text(proc.stderr.strip()[-300:])}")
    return proc


def _relative(path: str) -> PurePosixPath:
    rel = PurePosixPath(path)
    if rel.is_absolute() or not rel.parts or ".." in rel.parts:
        raise MeasureError(f"path outside the repo: {path}")
    return rel


def _clean(data: str | bytes, ignores: re.Pattern = INLINE_IGNORES) -> bytes:
    return ignores.sub(b"", data.encode("utf-8") if isinstance(data, str) else data)


def _stage(root: Path, files: Iterable[tuple[str, bytes]]) -> None:
    try:
        for rel, data in files:
            target = root / _relative(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    except OSError as exc:
        raise MeasureError(f"copy for the check was not created: {exc.strerror} ({exc.filename})") from exc


def _from_root(path: str, root: Path) -> str:
    candidate = Path(path)
    if candidate.is_absolute():
        candidate = Path(os.path.relpath(candidate, root))
    return _relative(os.path.normpath(candidate).replace(os.sep, "/")).as_posix()


def _leaks(records: list, base: Path | None) -> list[tuple[str, str, int, int]]:
    out = []
    for record in records or []:
        try:
            rule_id, path, line = str(record["RuleID"]), str(record["File"]), int(record["StartLine"])
            end = int(record.get("EndLine") or line)
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise MeasureError(f"gitleaks report lacks the expected fields: {exc}") from exc
        rel = _from_root(path, base) if base is not None else _relative(os.path.normpath(path)).as_posix()
        out.append((rule_id, rel, line, max(end, line)))
    return sorted(out)


def parse_gitleaks(records: list, base: Path | None = None) -> list[Finding]:
    """Findings from a gitleaks JSON report. Only RuleID, File, StartLine and EndLine are read; Secret and Match are
    left unread. The key is the rule; `check_secrets` adds the content fingerprint to it."""
    return ordered(Finding("S1", rel, line, f"secret in the diff (gitleaks {rule_id})", FIX_SECRET, rule_id)
                   for rule_id, rel, line, _ in _leaks(records, base))


def _primary(locations: list) -> dict:
    for location in locations:
        if location.get("symbolic", {}).get("kind") == "Primary":
            return location
    if not locations:
        raise MeasureError("zizmor finding has no location")
    return locations[0]


def parse_zizmor(records: list, base: Path | None = None) -> list[Finding]:
    """Findings from `zizmor --format json` (pinned format): primary location, line from 1, High and Medium block."""
    out = []
    for record in records or []:
        try:
            location = _primary(record["locations"])
            path = location["symbolic"]["key"]["Local"]["verbatim_path"]
            line = int(location["concrete"]["location"]["start_point"]["row"]) + 1
            ident, desc, url = record["ident"], record["desc"], record["url"]
            severity = str(record["determinations"]["severity"]).lower()
        except (KeyError, TypeError, ValueError) as exc:
            raise MeasureError(f"zizmor report lacks the expected fields: {exc}") from exc
        rel = _from_root(path, base) if base is not None else _relative(path).as_posix()
        feature = normalize(str(location["concrete"].get("feature", "")))
        out.append(Finding("S3", rel, line, f"unsafe GitHub Actions pattern ({ident}: {desc})", f"fix per {url}",
                           f"{ident}: {feature}", "error" if severity in BLOCKING else "warning"))
    return ordered(out)


def parse_actionlint(records: list | None, base: Path | None = None) -> list[Finding]:
    """Findings from `actionlint -format '{{json .}}'`; empty output or `null` means there are no findings."""
    out = []
    for record in records or []:
        try:
            path, line, kind, message = record["filepath"], int(record["line"]), record["kind"], record["message"]
        except (KeyError, TypeError, ValueError) as exc:
            raise MeasureError(f"actionlint report lacks the expected fields: {exc}") from exc
        rel = _from_root(path, base) if base is not None else _relative(path).as_posix()
        out.append(Finding("S3", rel, line, f"invalid workflow ({kind}: {public_text(message)})",
                           "fix the workflow according to the actionlint message", f"{kind}: {normalize(message)}"))
    return ordered(out)


def _json(text: str, name: str) -> list | None:
    try:
        return json.loads(text) if text.strip() else None
    except json.JSONDecodeError as exc:
        raise MeasureError(f"{name} did not return JSON: {exc.msg}") from exc


def _staged_names(paths: list[str]) -> dict[str, str]:
    staged = {}
    for path in paths:
        rel = PurePosixPath(path)
        staged[rel.with_name(STAGED_IGNORE).as_posix() if rel.name == GITLEAKS_IGNORE else path] = path
    if len(staged) != len(paths) or any(name in paths and staged[name] != name for name in staged):
        raise MeasureError(f"diff already has {STAGED_IGNORE}, so {GITLEAKS_IGNORE} has no free name in the copy")
    return staged


def _utf8(data: bytes) -> bytes:
    sample = data[:4096]
    odd, even = sample[1::2], sample[0::2]
    if data.startswith(UTF16_BOMS):
        encoding = "utf-16"
    elif len(sample) >= 4 and odd.count(0) >= 0.9 * len(odd) and even.count(0) <= 0.1 * len(even):
        encoding = "utf-16-le"
    elif len(sample) >= 4 and even.count(0) >= 0.9 * len(even) and odd.count(0) <= 0.1 * len(odd):
        encoding = "utf-16-be"
    else:
        return data
    try:
        return data.decode(encoding).encode("utf-8")
    except UnicodeDecodeError:
        return data


def _scanned(data: str | bytes) -> bytes:
    return _clean(data if isinstance(data, str) else _utf8(data))


def _member(path: str, staged: dict[str, bytes]) -> tuple[str, str | None]:
    if path in staged or MEMBER not in path:
        return path, None
    outer = max((name for name in staged if path.startswith(name + MEMBER)), key=len, default=None)
    return (outer, path[len(outer) + 1:]) if outer else (path, None)


def _content_key(rule_id: str, data: bytes, start: int, end: int, member: str | None) -> str:
    if member is None and b"\0" not in data:
        rows = b"\n".join(row.removesuffix(b"\r") for row in data.split(b"\n")[start - 1:end])
        return f"{rule_id}: {sha256(rows)}"
    return f"{rule_id}: {member or ''}: {start}: {sha256(data)}"


def _scan(binary: Path, config: Path, staged: dict[str, bytes]) -> list[tuple[str, str, int, int]]:
    with tempfile.TemporaryDirectory(prefix="factory-gitleaks-") as tmp:
        work, root = Path(tmp), Path(tmp) / "src"
        _stage(root, sorted(staged.items()))
        report = work / "report.json"
        _run([str(binary), "dir", str(root), "--config", str(config), "--report-format", "json", "--report-path",
              str(report), "--redact", "--no-banner", "--no-color", "--exit-code", "0", "--log-level", "error",
              "--max-archive-depth", str(ARCHIVE_DEPTH)], work, frozenset({0}))
        try:
            records = _json(report.read_text(encoding="utf-8"), "gitleaks")
        except OSError as exc:
            raise MeasureError(f"gitleaks did not write a report: {exc.strerror}") from exc
        return _leaks(records or [], root)


def _gitleaks(binary: Path, config: Path, files: list[tuple[str, str | bytes]]) -> list[Finding]:
    names = _staged_names([path for path, _ in files])
    original = {path: staged for staged, path in names.items()}
    staged = {original[path]: _scanned(data) for path, data in files}
    out = []
    for rule_id, rel, line, end in _scan(binary, config, staged):
        outer, member = _member(rel, staged)
        data = staged.get(outer, b"")
        message = f"secret in an archive (gitleaks {rule_id})" if member else f"secret in the diff (gitleaks {rule_id})"
        out.append(Finding("S1", names.get(outer, outer), 0 if member else line, message, FIX_SECRET,
                           _content_key(rule_id, data, line, end, member)))
    return ordered(out)


def check_secrets(views: Iterable[FileView], repo_root: Path, tools_dir: Path = TOOLS,
                  config: Path = CONFIGS / "gitleaks.toml") -> list[Finding]:
    """S1: gitleaks over whole files, and over the original bytes when the text is not the exact content (`raw`). The
    base comparison in codecheck decides whether a finding is new."""
    views = [view for view in views if not view.meta.get("deleted")]
    if not views:
        return []
    return _gitleaks(tool("gitleaks", tools_dir), config,
                     [(view.path, view.raw if view.raw is not None else view.text) for view in views])


def _raise(exc: OSError) -> None:
    raise exc


def _github_files(repo_root: Path, views: list[FileView]) -> Iterable[tuple[str, str | bytes]]:
    repo_root = Path(repo_root)
    for dirpath, dirnames, filenames in os.walk(repo_root, onerror=_raise):
        dirnames[:] = sorted(d for d in dirnames if d not in WALK_SKIP)
        for name in sorted(filenames):
            source = Path(dirpath, name)
            rel = source.relative_to(repo_root).as_posix()
            if rel not in REPO_CONFIGS and not source.is_symlink() and (WORKFLOW.match(rel) or ACTION.search(rel)):
                yield rel, source.read_bytes()
    for view in views:
        yield view.path, view.text


def check_workflows(views: Iterable[FileView], repo_root: Path, tools_dir: Path = TOOLS,
                    config: Path = CONFIGS / "zizmor.yml") -> list[Finding]:
    """S3: zizmor (all workflows and action.yml) and actionlint (workflows) over the workflows in scope. The base
    comparison in codecheck decides whether a finding is new."""
    views = [view for view in views if (WORKFLOW.match(view.path) or ACTION.search(view.path))
             and not view.meta.get("deleted")]
    if not views:
        return []
    zizmor, actionlint = tool("zizmor", tools_dir), tool("actionlint", tools_dir)
    shellcheck = tool("shellcheck", tools_dir)
    with tempfile.TemporaryDirectory(prefix="factory-workflows-") as tmp:
        root = Path(tmp)
        _stage(root, ((rel, _clean(data, WORKFLOW_IGNORES)) for rel, data in _github_files(repo_root, views)))
        targets = sorted(view.path for view in views)
        workflows = [path for path in targets if WORKFLOW.match(path)]
        found = parse_zizmor(_json(_run([str(zizmor), "--format", "json", "--offline", "--strict-collection",
                                         "--config", str(config), *targets], root, ZIZMOR_OK).stdout, "zizmor"), root)
        if workflows:
            lint = [str(actionlint), "-format", "{{json .}}", "-no-color",
                    f"-shellcheck={shellcheck}", "-pyflakes=", *workflows]
            found += parse_actionlint(_json(_run(lint, root, frozenset({0, 1})).stdout, "actionlint"), root)
        return ordered(found)


def check_repo(views: Iterable[FileView], repo_root: Path, tools_dir: Path = TOOLS) -> list[Finding]:
    """S1 and S3 together over the same diff."""
    views = list(views)
    return ordered(check_secrets(views, repo_root, tools_dir) + check_workflows(views, repo_root, tools_dir))


def gitleaks_default(tools_dir: Path = TOOLS) -> bytes:
    """Default configuration embedded in the pinned gitleaks, byte for byte; a version without a fingerprint or other
    bytes are a MeasureError."""
    version = standard.load_lock(pins.LOCK).tools["gitleaks"].version
    if version not in GITLEAKS_DEFAULT:
        raise MeasureError(f"gitleaks {version} has no default configuration fingerprint in GITLEAKS_DEFAULT")
    size, digest = GITLEAKS_DEFAULT[version]
    try:
        data = tool("gitleaks", tools_dir).read_bytes()
    except OSError as exc:
        raise MeasureError(f"gitleaks cannot be read: {exc.strerror}") from exc
    start = data.find(GITLEAKS_DEFAULT_START)
    found = data[start:start + size] if start >= 0 and data.count(GITLEAKS_DEFAULT_START) == 1 else b""
    if sha256(found) != digest:
        raise MeasureError(f"gitleaks {version} does not carry the default configuration with fingerprint {digest}")
    return found


def _allowlist(lines: list[str]) -> list[str]:
    kept, skipping = [], False
    for line in lines:
        if skipping or line.startswith("paths = ["):
            skipping = not line.rstrip().endswith("]")
            continue
        kept.append(line)
    had_paths = len(kept) != len(lines)
    if had_paths and any(line.replace(" ", "") == 'condition="AND"' for line in kept):
        return []
    keys = {line.split("=", 1)[0].strip() for line in kept[1:] if "=" in line}
    return kept if keys & {"regexes", "stopwords", "commits"} else []


def _without_path_allowlists(data: dict) -> dict:
    def clean(table: dict) -> dict | None:
        if "paths" in table and table.get("condition") == "AND":
            return None
        rest = {key: value for key, value in table.items() if key != "paths"}
        return rest if rest.keys() & {"regexes", "stopwords", "commits"} else None

    out = dict(data)
    out["allowlist"] = clean(data["allowlist"])
    out["rules"] = []
    for rule in data["rules"]:
        lists = [kept for kept in (clean(table) for table in rule.get("allowlists", [])) if kept is not None]
        bare = {key: value for key, value in rule.items() if key != "allowlists"}
        out["rules"].append({**bare, "allowlists": lists} if lists else bare)
    return {key: value for key, value in out.items() if value is not None}


def gitleaks_config(default: bytes | None = None) -> str:
    """Content of standard/configs/gitleaks.toml: the pinned gitleaks default configuration without comments or path
    allowlists. The result is checked against the default configuration via tomllib; a difference is a MeasureError."""
    raw = gitleaks_default() if default is None else default
    digest, version = sha256(raw), standard.load_lock(pins.LOCK).tools["gitleaks"].version
    out = [f"# Generirano iz zadane konfiguracije gitleaksa {version} bez allowlista putanja.",
           f"# sha256 zadane konfiguracije: {digest}", f"# Ponovno generiranje: {GITLEAKS_REGENERATE}", ""]
    section: list[str] = []
    in_allowlist = False
    for line in [*raw.decode("utf-8").split("\n"), "[end]"]:
        table = TABLE.match(line)
        if table:
            out += _allowlist(section) if in_allowlist else section
            section, in_allowlist = [], table.group(1) in ALLOWLIST_TABLES
        if not line.startswith("#"):
            section.append(line)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out).rstrip("\n")) + "\n"
    try:
        upstream, ours = tomllib.loads(raw.decode("utf-8")), tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise MeasureError(f"generated gitleaks configuration is not valid TOML: {exc}") from exc
    if ours != _without_path_allowlists(upstream):
        raise MeasureError("generated gitleaks configuration differs from the default beyond path allowlists")
    return _own_lines_allowed(text)


def _scan_config(text: str) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="factory-gitleaks-config-") as tmp:
        config = Path(tmp) / "gitleaks.toml"
        config.write_text(text, encoding="utf-8")
        return sorted({rule_id for rule_id, *_ in _scan(tool("gitleaks"), config, {"gitleaks.toml": _clean(text)})})


def _own_lines_allowed(text: str) -> str:
    rules = _scan_config(text)
    if not rules:
        return text
    regexes = {rule["id"]: rule.get("regex", "") for rule in tomllib.loads(text)["rules"]}
    lines = text.split("\n")
    for rule in rules:
        at = lines.index(f'id = "{rule}"')
        end = next((i for i in range(at, len(lines)) if lines[i] == "[[rules]]"), len(lines))
        while end > at and not lines[end - 1].strip():
            end -= 1
        exact = OWN_RULE_LINE.format(ASCII_PUNCT.sub(lambda m: "\\" + m.group(), regexes[rule]))
        lines[end:end] = ["[[rules.allowlists]]", 'description = "the rule declaration in this file is not a secret"',
                          'regexTarget = "line"', f"regexes = [{json.dumps(exact)}]"]
    text = "\n".join(lines)
    left = _scan_config(text)
    if left:
        raise MeasureError(f"gitleaks reports its own configuration: {', '.join(left)}")
    return text


def write_gitleaks_config(path: Path = CONFIGS / "gitleaks.toml") -> None:
    """Write `gitleaks_config()` to standard/configs/gitleaks.toml."""
    Path(path).write_text(gitleaks_config(), encoding="utf-8")
