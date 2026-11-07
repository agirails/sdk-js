"""S1 tajne (gitleaks) i S3 GitHub Actions (zizmor, actionlint) nad diffom, samo pinanim alatima iz .tools/bin.

Alati čitaju kopiju u privremenom direktoriju, nikad repo: konfiguracija i iznimke iz repoa (`.gitleaksignore`,
`zizmor.yml`, `actionlint.yaml`) ne mogu oslabiti provjeru. `.gitleaksignore` iz diffa se u kopiju upisuje pod drugim
imenom, pa ga gitleaks ne učita, a iz kopije se brišu i iznimke na retku (`gitleaks:allow`, `zizmor: ignore[...]`, u
workflowima i `shellcheck disable=`). Iznimka za S1 ili S3 ide samo kroz `factory-allow` koji je postojao u bazi.
Okolina alata je prazna osim HOME-a, bez mreže (`zizmor --offline`). zizmor radi sa `--strict-collection`, pa
neispravan workflow ili action.yml nije prolaz, a actionlint `run:` skripte provjerava pinanim shellcheckom.

gitleaks ulazi u arhive (`--max-archive-depth`), a UTF-16 tekst čita pretvoren u UTF-8. Ključ S1 nalaza je pravilo i
otisak točnih bajtova redaka tajne (bez spuštanja slova i sažimanja razmaka) iz kopije koju je gitleaks čitao, a za
datoteku s NUL bajtom ili član arhive otisak cijele datoteke, pa tajna koja zamijeni staru tajnu nije uparena s bazom.
Vrijednost tajne se ne čita iz izvještaja, a poruke alata izlaze bez navedenih vrijednosti i dugih nizova
(`public_text`), jer alat u poruku prepisuje izvor.

`standard/configs/gitleaks.toml` je zadana konfiguracija pinanog gitleaksa bez allowlista putanja (vendor,
node_modules, lockfileovi), jer tajna u lockfileu je stvaran slučaj. `[extend] useDefault` ih ne može izostaviti, pa se
datoteka generira (`gitleaks_config`) iz zadane konfiguracije ugrađene u pinani binarni fajl, s otiskom po verziji.
Pravilo koje prepoznaje vlastitu deklaraciju dobiva allowlist samo za točan redak `regex = '''…'''` te deklaracije,
s escapeanom interpunkcijom, pa ni redak izuzeća ne sadrži prepoznati niz. Ista vrijednost u drugom retku je nalaz.
Zato je i deklaracija prilagođenog pravila u gitleaks konfiguraciji repoa S1 nalaz, a prolaz je `factory-allow` iz baze.
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

from .. import baseline, layout, pins, standard
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
FIX_SECRET = "ukloni tajnu iz koda, opozovi je i učitavaj je iz okoline ili spremišta tajni"
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
    """Putanja pinanog alata; alat koji nije instaliran je MeasureError. Alat iz .tools/bin mora biti bajt za bajt iz
    arhive iz tools.lock (`pins`); drugi direktorij je samo za testne zamjene."""
    path = Path(tools_dir) / name
    if not (path.is_file() and os.access(path, os.X_OK)):
        raise MeasureError(f"alat {name} nije instaliran u .tools/bin; pokreni standard install-tools")
    if Path(tools_dir) == TOOLS and pins.verified(name, TOOLS.parent) != path:
        raise MeasureError(f"alat {name} nije na putanji iz tools.lock")
    return path


def public_text(text: str) -> str:
    """Poruka alata bez vrijednosti iz izvora: navedeni dijelovi i nizovi od 20 i više znakova sa slovom i znamenkom
    postaju `…`."""
    text = QUOTED.sub(lambda m: m.group()[0] + "…" + m.group()[0], text)
    return LONG_TOKEN.sub(lambda m: "…" if re.search(r"\d", m.group()) and re.search(r"[A-Za-z]", m.group())
                          else m.group(), text)


def _run(argv: list[str], cwd: Path, ok: frozenset[int]) -> subprocess.CompletedProcess:
    name = Path(argv[0]).name
    try:
        proc = subprocess.run(argv, cwd=cwd, env={"HOME": str(cwd), "NO_COLOR": "1"}, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)
    except subprocess.TimeoutExpired as exc:
        raise MeasureError(f"{name} nije završio u {TIMEOUT} s") from exc
    except OSError as exc:
        raise MeasureError(f"{name} se ne može pokrenuti: {exc.strerror}") from exc
    if proc.returncode not in ok:
        raise MeasureError(f"{name} je završio s kodom {proc.returncode}: {public_text(proc.stderr.strip()[-300:])}")
    return proc


def _relative(path: str) -> PurePosixPath:
    rel = PurePosixPath(path)
    if rel.is_absolute() or not rel.parts or ".." in rel.parts:
        raise MeasureError(f"putanja izvan repoa: {path}")
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
        raise MeasureError(f"kopija za provjeru nije napravljena: {exc.strerror} ({exc.filename})") from exc


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
            raise MeasureError(f"gitleaks izvještaj nema očekivana polja: {exc}") from exc
        rel = _from_root(path, base) if base is not None else _relative(os.path.normpath(path)).as_posix()
        out.append((rule_id, rel, line, max(end, line)))
    return sorted(out)


def parse_gitleaks(records: list, base: Path | None = None) -> list[Finding]:
    """Nalazi iz gitleaks JSON izvještaja. Čitaju se samo RuleID, File, StartLine i EndLine; Secret i Match se ne
    diraju. Ključ je pravilo; `check_secrets` mu dodaje otisak sadržaja."""
    return ordered(Finding("S1", rel, line, f"tajna u diffu (gitleaks {rule_id})", FIX_SECRET, rule_id)
                   for rule_id, rel, line, _ in _leaks(records, base))


def _primary(locations: list) -> dict:
    for location in locations:
        if location.get("symbolic", {}).get("kind") == "Primary":
            return location
    if not locations:
        raise MeasureError("zizmor nalaz nema lokaciju")
    return locations[0]


def parse_zizmor(records: list, base: Path | None = None) -> list[Finding]:
    """Nalazi iz `zizmor --format json` (format pinane verzije): primarna lokacija, redak od 1, High i Medium blokiraju."""
    out = []
    for record in records or []:
        try:
            location = _primary(record["locations"])
            path = location["symbolic"]["key"]["Local"]["verbatim_path"]
            line = int(location["concrete"]["location"]["start_point"]["row"]) + 1
            ident, desc, url = record["ident"], record["desc"], record["url"]
            severity = str(record["determinations"]["severity"]).lower()
        except (KeyError, TypeError, ValueError) as exc:
            raise MeasureError(f"zizmor izvještaj nema očekivana polja: {exc}") from exc
        rel = _from_root(path, base) if base is not None else _relative(path).as_posix()
        feature = normalize(str(location["concrete"].get("feature", "")))
        out.append(Finding("S3", rel, line, f"nesiguran GitHub Actions uzorak ({ident}: {desc})", f"ispravi prema {url}",
                           f"{ident}: {feature}", "error" if severity in BLOCKING else "warning"))
    return ordered(out)


def parse_actionlint(records: list | None, base: Path | None = None) -> list[Finding]:
    """Nalazi iz `actionlint -format '{{json .}}'`; prazan izlaz ili `null` znači da nalaza nema."""
    out = []
    for record in records or []:
        try:
            path, line, kind, message = record["filepath"], int(record["line"]), record["kind"], record["message"]
        except (KeyError, TypeError, ValueError) as exc:
            raise MeasureError(f"actionlint izvještaj nema očekivana polja: {exc}") from exc
        rel = _from_root(path, base) if base is not None else _relative(path).as_posix()
        out.append(Finding("S3", rel, line, f"neispravan workflow ({kind}: {public_text(message)})",
                           "ispravi workflow prema poruci actionlinta", f"{kind}: {normalize(message)}"))
    return ordered(out)


def _json(text: str, name: str) -> list | None:
    try:
        return json.loads(text) if text.strip() else None
    except json.JSONDecodeError as exc:
        raise MeasureError(f"{name} nije vratio JSON: {exc.msg}") from exc


def _staged_names(paths: list[str]) -> dict[str, str]:
    staged = {}
    for path in paths:
        rel = PurePosixPath(path)
        staged[rel.with_name(STAGED_IGNORE).as_posix() if rel.name == GITLEAKS_IGNORE else path] = path
    if len(staged) != len(paths) or any(name in paths and staged[name] != name for name in staged):
        raise MeasureError(f"diff već ima datoteku {STAGED_IGNORE}, pa {GITLEAKS_IGNORE} nema slobodno ime u kopiji")
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
            raise MeasureError(f"gitleaks nije zapisao izvještaj: {exc.strerror}") from exc
        return _leaks(records or [], root)


def _gitleaks(binary: Path, config: Path, files: list[tuple[str, str | bytes]]) -> list[Finding]:
    names = _staged_names([path for path, _ in files])
    original = {path: staged for staged, path in names.items()}
    staged = {original[path]: _scanned(data) for path, data in files}
    out = []
    for rule_id, rel, line, end in _scan(binary, config, staged):
        outer, member = _member(rel, staged)
        data = staged.get(outer, b"")
        message = f"tajna u arhivi (gitleaks {rule_id})" if member else f"tajna u diffu (gitleaks {rule_id})"
        out.append(Finding("S1", names.get(outer, outer), 0 if member else line, message, FIX_SECRET,
                           _content_key(rule_id, data, line, end, member)))
    return ordered(out)


BASELINE_FILE = f"{layout.SYNC_DIR}/baseline.json"
BASELINE_DIGEST = re.compile(r'("key": ")([0-9a-f]{64})(")')


def _baseline_redacted(text: str) -> str | None:
    if not baseline.canonical(text):
        return None
    entries = len(json.loads(text)["entries"])
    redacted, count = BASELINE_DIGEST.subn(lambda m: m.group(1) + "0" * 64 + m.group(3), text)
    return redacted if count == entries else None


def _secret_input(view: FileView) -> str | bytes:
    if view.raw is not None:
        return view.raw
    if view.path == BASELINE_FILE:
        redacted = _baseline_redacted(view.text)
        if redacted is not None:
            return redacted
    return view.text


def check_secrets(views: Iterable[FileView], repo_root: Path, tools_dir: Path = TOOLS,
                  config: Path = CONFIGS / "gitleaks.toml") -> list[Finding]:
    """S1: gitleaks nad cijelim datotekama, a nad izvornim bajtovima kad tekst nije točan sadržaj (`raw`). Je li nalaz
    nov, odlučuje usporedba s bazom u codecheck.

    Ključ unosa baselinea je sha256 otisak nalaza pod imenom `key`, koji gitleaks čita kao tajnu. Zato u
    `.factory/baseline.json` koji je bajt-identičan onome što `baseline.write` zapisuje (`baseline.canonical`: bez
    ponovljenih JSON ključeva, escapeova i drukčijih razmaka) gitleaks vidi kopiju u kojoj su samo vrijednosti `key`
    nule, i samo kad je broj zamjena jednak broju unosa. Putanju, pravilo i commit vidi
    neizmijenjene, a baseline na drugoj putanji ili neispravan baseline skenira se kakav jest. Novi ključ (pa ni lažni
    unos koji bi sakrio 64-hex vrijednost) ne ulazi u baseline bez odobrene izmjene baze: CI uspoređuje baseline glave
    s baselineom baze (`code-check full --base-baseline`)."""
    views = [view for view in views if not view.meta.get("deleted")]
    if not views:
        return []
    return _gitleaks(tool("gitleaks", tools_dir), config, [(view.path, _secret_input(view)) for view in views])


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
    """S3: zizmor (svi workflowi i action.yml) i actionlint (workflowi) nad workflowima iz opsega. Je li nalaz nov,
    odlučuje usporedba s bazom u codecheck."""
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
    """S1 i S3 zajedno nad istim diffom."""
    views = list(views)
    return ordered(check_secrets(views, repo_root, tools_dir) + check_workflows(views, repo_root, tools_dir))


def gitleaks_default(tools_dir: Path = TOOLS) -> bytes:
    """Zadana konfiguracija ugrađena u pinani gitleaks, bajt za bajt; verzija bez otiska ili drugi bajtovi su
    MeasureError."""
    version = standard.load_lock(pins.LOCK).tools["gitleaks"].version
    if version not in GITLEAKS_DEFAULT:
        raise MeasureError(f"gitleaks {version} nema otisak zadane konfiguracije u GITLEAKS_DEFAULT")
    size, digest = GITLEAKS_DEFAULT[version]
    try:
        data = tool("gitleaks", tools_dir).read_bytes()
    except OSError as exc:
        raise MeasureError(f"gitleaks se ne može pročitati: {exc.strerror}") from exc
    start = data.find(GITLEAKS_DEFAULT_START)
    found = data[start:start + size] if start >= 0 and data.count(GITLEAKS_DEFAULT_START) == 1 else b""
    if sha256(found) != digest:
        raise MeasureError(f"gitleaks {version} ne nosi zadanu konfiguraciju s otiskom {digest}")
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
    """Sadržaj standard/configs/gitleaks.toml: zadana konfiguracija pinanog gitleaksa bez komentara i bez allowlista
    putanja. Rezultat se provjerava prema zadanoj konfiguraciji kroz tomllib; razlika je MeasureError."""
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
        raise MeasureError(f"generirana gitleaks konfiguracija nije ispravan TOML: {exc}") from exc
    if ours != _without_path_allowlists(upstream):
        raise MeasureError("generirana gitleaks konfiguracija se razlikuje od zadane osim allowlista putanja")
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
        lines[end:end] = ["[[rules.allowlists]]", 'description = "deklaracija pravila u ovoj datoteci nije tajna"',
                          'regexTarget = "line"', f"regexes = [{json.dumps(exact)}]"]
    text = "\n".join(lines)
    left = _scan_config(text)
    if left:
        raise MeasureError(f"gitleaks javlja vlastitu konfiguraciju: {', '.join(left)}")
    return text


def write_gitleaks_config(path: Path = CONFIGS / "gitleaks.toml") -> None:
    """Upiši `gitleaks_config()` u standard/configs/gitleaks.toml."""
    Path(path).write_text(gitleaks_config(), encoding="utf-8")
