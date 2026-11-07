"""Registar standarda: pravila iz rules.toml, generirani STANDARD.md, tools.lock, opisi repoa (repos/*.toml) i sadržaj
kopije u `.factory/` ciljnog repoa."""
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
GROUPS = {"K": "Kvaliteta", "S": "Sigurnost", "P": "Budžeti performansi"}
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
{marker}: upisuje ga i ažurira `bin/standard install-hooks <repo> --apply` iz Harnessa.
harness={harness}
copy={copy}
top=$(git rev-parse --show-toplevel) || exit 1
if [ -x "$harness/{code_check}" ]; then
    exec "$harness/{code_check}" diff --staged --repo "$top"
fi
if [ -x "$top/$copy" ]; then
    printf '%s\\n' "pre-commit: Harness nije na ovom stroju ($harness); provjerava javna kopija $copy, pa interna imena nisu provjerena (K9)" >&2
    exec "$top/$copy" diff --staged --repo "$top"
fi
printf '%s\\n' "pre-commit: nema code-checka (ni $harness/{code_check} ni $copy u repou), pa je commit blokiran." >&2
printf '%s\\n' "pre-commit: instaliraj Harness i pokreni bin/standard install-hooks <repo> --apply, ili bin/standard sync <repo>." >&2
exit 1
"""
PUBLIC_LISTS = {
    layout.NAMES: ("# K9: javna kopija ne nosi interna imena ni njihove otiske, jer se kratko ime iz otiska vraća\n"
                   "# rječnikom. Interna imena provjerava code-check iz Harnessa nad ovim repoom.\n"),
    layout.DENY: ("# sandbox-run: javna kopija ne nosi privatna stabla ni njihove otiske, jer se kratka putanja\n"
                  "# iz otiska vraća rječnikom. Popis vrijedi samo u Harnessu.\n"),
}


@dataclass(frozen=True)
class Rule:
    """Jedno pravilo standarda. `checker` je ime modula u lib/factory ili None kad pravilo provodi drugi alat."""
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
    """Pinani alat iz tools.lock."""
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
    """Sadržaj tools.lock: datum zaključavanja i alati po imenu."""
    locked: datetime.date
    tools: dict[str, Tool]


@dataclass(frozen=True)
class Repo:
    """Repo pod standardom. Relativna `path` u toml-u je relativna prema direktoriju toml-a, a `~` prema HOME."""
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
    """Putanja relativna prema repou odgovara nekom uzorku: `**` je bilo koji broj direktorija, `*` i `?` ostaju
    unutar jednog dijela putanje."""
    return any(_glob(pattern).fullmatch(path) for pattern in patterns)


def parse_exclude(data: dict, where: str) -> dict[str, tuple[str, ...]]:
    """Tablica [exclude]: ključ je `all` ili id pravila, vrijednost popis uzoraka putanja koje to pravilo ne gleda."""
    raw = data.get("exclude", {})
    if not isinstance(raw, dict):
        raise MeasureError(f"{where}: exclude mora biti tablica")
    bad = sorted(key for key in raw if not EXCLUDE_KEY.match(key))
    if bad:
        raise MeasureError(f"{where}: exclude ključ mora biti all ili id pravila, a ne {', '.join(bad)}")
    return {key: str_list(raw, key, f"{where} [exclude]") for key in sorted(raw)}


def checker_file(checker: str) -> str:
    """Putanja modula provjere relativno prema lib/factory: `checks.paths` → `checks/paths.py`."""
    return checker.replace(".", "/") + ".py"


def read_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise MeasureError(f"{path}: ne mogu pročitati ({exc})") from exc


def need(data: dict, key: str, kind: type, where: str):
    if key not in data:
        raise MeasureError(f"{where}: fali polje {key}")
    value = data[key]
    if not isinstance(value, kind) or (isinstance(value, (str, list)) and not value and kind is not list):
        raise MeasureError(f"{where}: polje {key} mora biti {kind.__name__} i ne smije biti prazno")
    return value


def str_list(data: dict, key: str, where: str, required: bool = True) -> tuple[str, ...]:
    if key not in data and not required:
        return ()
    value = need(data, key, list, where)
    if not all(isinstance(x, str) and x for x in value):
        raise MeasureError(f"{where}: {key} mora biti popis nepraznih stringova")
    return tuple(value)


def only_fields(data: dict, allowed: set[str], where: str) -> None:
    extra = sorted(set(data) - allowed)
    if extra:
        raise MeasureError(f"{where}: nepoznata polja {', '.join(extra)}")


def parse_rule(raw: dict, where: str) -> Rule:
    only_fields(raw, {"id", "title", "text", "level", "enforcer", "langs", "checker", "detail", "terms"}, where)
    rid = need(raw, "id", str, where)
    if not RULE_ID.match(rid):
        raise MeasureError(f"{where}: id {rid} nije oblika K<n>, S<n> ili P<n>")
    where = f"{where} {rid}"
    level = need(raw, "level", list, where)
    if not level or not all(isinstance(x, int) and 1 <= x <= 4 for x in level):
        raise MeasureError(f"{where}: level mora biti popis razina 1–4")
    langs = str_list(raw, "langs", where)
    unknown = sorted(set(langs) - KNOWN_LANGS)
    if unknown:
        raise MeasureError(f"{where}: nepoznat jezik {', '.join(unknown)}")
    checker = raw.get("checker")
    if checker is not None and (not isinstance(checker, str) or not CHECKER.match(checker)):
        raise MeasureError(f"{where}: checker mora biti ime modula u lib/factory (npr. checks.paths)")
    detail = raw.get("detail")
    if detail is not None and not isinstance(detail, str):
        raise MeasureError(f"{where}: detail mora biti tekst")
    return Rule(id=rid, title=need(raw, "title", str, where), text=need(raw, "text", str, where),
                level=tuple(level), enforcer=need(raw, "enforcer", str, where), langs=langs, checker=checker,
                detail=detail.strip() if detail else None, terms=str_list(raw, "terms", where, required=False))


def load_rules(path: Path) -> list[Rule]:
    """Učita i provjeri rules.toml. Svaka greška u obliku je MeasureError, nikad tihi prolaz."""
    path = Path(path)
    data = read_toml(path)
    only_fields(data, {"meta", "level", "rule"}, str(path))
    raws = data.get("rule")
    if not isinstance(raws, list) or not raws:
        raise MeasureError(f"{path}: nema nijednog [[rule]]")
    rules, seen = [], set()
    for i, raw in enumerate(raws):
        if not isinstance(raw, dict):
            raise MeasureError(f"{path}: rule #{i + 1} nije tablica")
        rule = parse_rule(raw, f"{path}: rule #{i + 1}")
        if rule.id in seen:
            raise MeasureError(f"{path}: pravilo {rule.id} je upisano dvaput")
        seen.add(rule.id)
        rules.append(rule)
    return sorted(rules, key=Rule.order)


def load_meta(path: Path) -> tuple[dict, list[dict]]:
    """Uvod i razine provedbe iz rules.toml, za zaglavlje STANDARD.md."""
    data = read_toml(Path(path))
    meta, levels = data.get("meta", {}), data.get("level", [])
    if not isinstance(meta, dict) or not isinstance(levels, list):
        raise MeasureError(f"{path}: meta mora biti tablica, a level popis tablica")
    only_fields(meta, {"title", "intro"}, f"{path} [meta]")
    for lv in levels:
        where = f"{path} [[level]]"
        if not isinstance(lv, dict):
            raise MeasureError(f"{where}: nije tablica")
        only_fields(lv, {"id", "name", "text"}, where)
        for key, kind in (("id", int), ("name", str), ("text", str)):
            need(lv, key, kind, where)
    return meta, sorted(levels, key=lambda x: x["id"])


def cell(text: str) -> str:
    return " ".join(text.split()).replace("|", "\\|")


def render_standard(rules: list[Rule], meta: dict | None = None, levels: list[dict] | None = None) -> str:
    """STANDARD.md iz pravila. Isti ulaz daje isti izlaz bez obzira na redoslijed pravila."""
    rules = sorted(rules, key=Rule.order)
    meta = meta or {}
    out = [f"# {meta.get('title', 'Standard tvornice softvera')}", "",
           "Generirano iz `standard/rules.toml` komandom `bin/standard gen`. Ne uređuj ručno: "
           "`bin/standard gen --check` i `tests/test_standard.py` padaju kad se razlikuju.", ""]
    if meta.get("intro"):
        out += [meta["intro"].strip(), ""]
    if levels:
        out += ["## Razine provedbe", ""]
        out += [f"{lv['id']}. **{lv['name']}**: {lv['text'].strip()}" for lv in levels]
        out.append("")
    for group, heading in GROUPS.items():
        members = [r for r in rules if r.group == group]
        if not members:
            continue
        out += [f"## {heading} ({group})", ""]
        if group == "P":
            out += ["| ID | Proizvod | Početni budžet | Provodi |", "|---|---|---|---|"]
            out += [f"| {r.id} | {cell(r.title)} | {cell(r.text)} | {cell(r.enforcer)} |" for r in members]
        else:
            out += ["| ID | Pravilo | Razina | Provodi | Jezici | Provjera |", "|---|---|---|---|---|---|"]
            for r in members:
                check = f"`factory.{r.checker}`" if r.checker else "—"
                out.append(f"| {r.id} | **{cell(r.title)}**: {cell(r.text)} | {' + '.join(map(str, r.level))} | "
                           f"{cell(r.enforcer)} | {', '.join(r.langs)} | {check} |")
        out.append("")
        for r in members:
            if r.detail or r.terms:
                out += [f"### {r.id}: {r.title}", ""]
                if r.terms:
                    out += ["Rječnik: " + ", ".join(f"`{t}`" for t in r.terms) + ".", ""]
                if r.detail:
                    out += [r.detail, ""]
    return "\n".join(out).rstrip("\n") + "\n"


def generate(rules_path: Path) -> str:
    """Cijeli STANDARD.md iz jednog rules.toml: uvod, razine i pravila."""
    meta, levels = load_meta(rules_path)
    return render_standard(load_rules(rules_path), meta, levels)


def parse_tool(name: str, raw: dict, where: str) -> Tool:
    allowed = {"version", "kind", "url", "sha256", "dest", "released", "member", "version_args", "integrity",
               "archive", "checksum_source", "provenance", "platform"}
    only_fields(raw, allowed, where)
    version = need(raw, "version", str, where)
    if version == "latest" or not re.match(r"^[0-9]+(\.[0-9]+)+$", version):
        raise MeasureError(f"{where}: verzija {version} nije pinana (treba točna verzija, npr. 1.2.3)")
    if "sha256" not in raw or not re.match(r"^[0-9a-f]{64}$", str(raw["sha256"])):
        raise MeasureError(f"{where}: fali ili je neispravan sha256")
    kind = need(raw, "kind", str, where)
    if kind not in TOOL_KINDS:
        raise MeasureError(f"{where}: kind mora biti jedno od {', '.join(TOOL_KINDS)}")
    url = need(raw, "url", str, where)
    if not url.startswith(URL_SCHEMES):
        raise MeasureError(f"{where}: url {url} mora biti https:// (file:// samo za lokalni test)")
    released = need(raw, "released", datetime.date, where)
    dest = need(raw, "dest", str, where)
    for key in ("dest", "archive", "member"):
        value = raw.get(key)
        if value is not None and (not isinstance(value, str) or value.startswith("/") or ".." in Path(value).parts):
            raise MeasureError(f"{where}: {key} mora biti relativna putanja bez ..")
    if kind == "tar.gz":
        need(raw, "member", str, where)
    if kind == "npm":
        integrity = need(raw, "integrity", str, where)
        if not integrity.startswith("sha512-"):
            raise MeasureError(f"{where}: integrity mora biti sha512-…")
    return Tool(name=name, version=version, kind=kind, url=url, sha256=raw["sha256"], dest=dest, released=released,
                member=raw.get("member"), version_args=str_list(raw, "version_args", where, required=False),
                integrity=raw.get("integrity"), archive=raw.get("archive"),
                checksum_source=raw.get("checksum_source"), provenance=raw.get("provenance"),
                platform=raw.get("platform"))


def load_lock(path: Path) -> Lock:
    """Učita tools.lock. Nepinana verzija, fali sha256 ili url koji nije https je MeasureError."""
    path = Path(path)
    data = read_toml(path)
    only_fields(data, {"locked", "tool"}, str(path))
    locked = need(data, "locked", datetime.date, str(path))
    raws = need(data, "tool", dict, str(path))
    tools = {}
    for name in sorted(raws):
        if not MODULE.match(name.replace("-", "_")):
            raise MeasureError(f"{path}: ime alata {name} nije dopušteno")
        tools[name] = parse_tool(name, raws[name], f"{path}: tool.{name}")
    return Lock(locked=locked, tools=tools)


def resolve_path(raw: str, base: Path, home: Path | None = None) -> Path:
    """`~` se širi iz HOME, relativna putanja je relativna prema `base`."""
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
            raise MeasureError(f"{where}: proof je popis koraka, a svaki korak je popis argumenata (bez ljuske)")
        steps.append(tuple(step))
    return tuple(steps)


def load_repo(path: Path, home: Path | None = None) -> Repo:
    """Učita jedan repos/<id>.toml i provjeri oblik."""
    path = Path(path)
    data = read_toml(path)
    where = str(path)
    allowed = {"id", "name", "path", "tier", "enforce_as", "langs", "proof", "base", "trust_boundary", "baseline",
               "publish", "public_api", "forbidden_imports", "budgets", "consent", "exclude"}
    only_fields(data, allowed, where)
    tier, enforce_as = need(data, "tier", str, where), need(data, "enforce_as", str, where)
    if tier not in TIERS or enforce_as not in TIERS:
        raise MeasureError(f"{where}: tier i enforce_as moraju biti A, B ili C")
    langs = str_list(data, "langs", where)
    unknown = sorted(set(langs) - KNOWN_LANGS)
    if unknown:
        raise MeasureError(f"{where}: nepoznat jezik {', '.join(unknown)}")
    baseline = need(data, "baseline", dict, where)
    policy = need(baseline, "policy", str, f"{where} [baseline]")
    if policy not in BASELINE_POLICIES:
        raise MeasureError(f"{where}: baseline.policy mora biti {' ili '.join(BASELINE_POLICIES)}")
    publish = data.get("publish", [])
    if not isinstance(publish, list) or not all(isinstance(p, dict) and p.get("kind") for p in publish):
        raise MeasureError(f"{where}: publish je popis tablica s poljem kind")
    budgets = data.get("budgets")
    if budgets is not None and not isinstance(budgets, dict):
        raise MeasureError(f"{where}: budgets mora biti tablica")
    consent = data.get("consent", False)
    if not isinstance(consent, bool):
        raise MeasureError(f"{where}: consent mora biti true ili false")
    return Repo(id=need(data, "id", str, where), name=need(data, "name", str, where),
                path=resolve_path(need(data, "path", str, where), path.parent, home), tier=tier,
                enforce_as=enforce_as, langs=langs, proof=parse_proof(data, where), base=need(data, "base", str, where),
                trust_boundary=str_list(data, "trust_boundary", where), baseline_path=need(baseline, "path", str, where),
                baseline_policy=policy, publish=tuple(publish),
                public_api=str_list(data, "public_api", where, required=False),
                forbidden_imports=str_list(data, "forbidden_imports", where, required=False),
                budgets=budgets, consent=consent, source=path, exclude=parse_exclude(data, where))


def load_repos(directory: Path, home: Path | None = None) -> list[Repo]:
    """Svi repos/*.toml, poredani po id-u. Dvaput isti id je MeasureError."""
    repos = [load_repo(p, home) for p in sorted(Path(directory).glob("*.toml"))]
    ids = [r.id for r in repos]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise MeasureError(f"{directory}: isti id u više datoteka: {', '.join(dup)}")
    return sorted(repos, key=lambda r: r.id)


def code_langs(repo: Repo) -> set[str]:
    """Jezici koda repoa: svi iz `langs` osim dokumentacije i workflowa."""
    return set(repo.langs) - NON_CODE_LANGS


def sync_payload(repo: Repo) -> dict[str, bytes]:
    """Sadržaj kopije u `.factory/` po putanji relativnoj prema njoj: code-check, bin/standard (CI njime instalira
    pinane alate u `.factory/.tools/`), lib/factory, pravila, lock, STANDARD.md i konfiguracije za jezike repoa.
    Raspored je isti kao u Harnessu (`layout`). Popis internih imena i privatnih stabala ide prazan (`PUBLIC_LISTS`),
    jer bi i otisci otkrili imena. Datoteka koja fali u izvoru je MeasureError."""
    sources = [layout.CODE_CHECK, layout.STANDARD_BIN, layout.RULES, layout.LOCK, layout.STANDARD / "STANDARD.md"]
    sources += [p for p in sorted(layout.PACKAGE.rglob("*")) if p.is_file() and "__pycache__" not in p.parts
                and p.suffix != ".pyc"]
    for lang in ["all", *sorted(code_langs(repo))]:
        sources += [layout.CONFIGS / name for name in SYNC_CONFIGS.get(lang, ())
                    if layout.CONFIGS / name not in PUBLIC_LISTS]
    missing = sorted(layout.rel(p) for p in sources if not p.is_file())
    if missing:
        raise MeasureError(f"nedostaje u Harnessu: {', '.join(missing)}")
    payload = {layout.rel(p): p.read_bytes() for p in sources}
    payload.update({layout.rel(path): header.encode("utf-8") for path, header in PUBLIC_LISTS.items()})
    payload[".gitignore"] = SYNC_IGNORE.encode("utf-8")
    return dict(sorted(payload.items()))


def sync_source(payload: dict[str, bytes], commit: str, dirty: bool) -> str:
    """`.factory/SOURCE`: Harness commit (uz oznaku dirty) i sha256 svake kopirane datoteke."""
    rows = [f"harness {commit}{' dirty' if dirty else ''}\n"]
    return "".join(rows + [f"{sha256(data)}  {rel}\n" for rel, data in sorted(payload.items())])


def parse_source(text: str, where: str) -> dict[str, str]:
    """Upravljane datoteke iz `.factory/SOURCE`: relativna putanja → sha256. Putanja mora ostati unutar `.factory/`
    (bez `..`, apsolutne putanje i praznih dijelova) i u imenima koja sync piše (`.gitignore`, `bin/`, `lib/`,
    `standard/`), jer sync briše upravljane datoteke kojih više nema u izvoru, a baseline i suppressions ne smije."""
    lines = text.splitlines()
    if not lines or not re.fullmatch(r"harness [0-9a-f]{40}( dirty)?", lines[0]):
        raise MeasureError(f"{where}: prvi redak nije `harness <commit>`")
    rows: dict[str, str] = {}
    for n, line in enumerate(lines[1:], start=2):
        digest, sep, rel = line.partition("  ")
        parts = rel.split("/")
        if (not sep or not re.fullmatch(r"[0-9a-f]{64}", digest) or rel.startswith("/") or "\\" in rel
                or any(part in ("", ".", "..") for part in parts) or rel in rows
                or not (rel == ".gitignore" or (len(parts) > 1 and parts[0] in SYNC_MANAGED_DIRS))):
            raise MeasureError(f"{where}:{n}: redak nije `<sha256>  <putanja unutar .factory>`")
        rows[rel] = digest
    return rows


def pre_commit_hook(harness: Path) -> str:
    """Sadržaj `.git/hooks/pre-commit`: `code-check diff --staged` iz Harnessa na `harness`, a kad ga na stroju nema,
    javna kopija u `.factory/` uz upozorenje da interna imena (K9) nisu provjerena. Bez ijednog commit je blokiran.
    Apsolutna putanja Harnessa ulazi samo u generirani hook, koji ostaje u `.git/hooks` i ne isporučuje se."""
    own = layout.rel(layout.CODE_CHECK)
    return HOOK_TEMPLATE.format(marker=HOOK_MARKER, harness=shlex.quote(str(harness)), code_check=own,
                                copy=shlex.quote(f"{layout.SYNC_DIR}/{own}"))
