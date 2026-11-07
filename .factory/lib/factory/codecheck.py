"""code-check: jedini ulaz u provjeru standarda nad diffom, cijelim repoom ili snapshotom, i upis baselinea.

Koje provjere postoje i koja pravila svaka javlja čita se iz standard/rules.toml (polje `checker`), pa popis ne živi
na dva mjesta. Exit: 0 čisto, 1 nova kršenja (samo greške; upozorenja nikad ne padaju), 2 nije izmjereno.

U diffu se provjere vrte nad glavom i nad istim datotekama u bazi. Nov je nalaz na dodanom retku i nalaz glave čiji
ključ nema par u bazi (jedan-na-jedan), pa se vidi i kršenje nastalo brisanjem. Datoteka bez jezika koja nije tekst
ide u S1 kao bajtovi; datoteka koda koja se ne može pročitati je exit 2. Baza koja se ne može izmjeriti ne ruši diff:
svi nalazi glave u toj datoteci su novi, uz napomenu. Kad je repos/<id>.toml dio diffa, vrijedi samo izuzeće koje je
bilo i u bazi, pa diff ne može izuzeti sam sebe.

Valjana `factory-allow` iznimka pokriva nalaz istog pravila u svom retku, a kad stoji sama u retku, u retku ispod.
U diffu vrijedi samo iznimka koja je postojala u bazi, i to samo za nalaz s ključem koji je u bazi pokrivala, pa je
brisanje ne premješta na drugi nalaz. Nova iznimka je popuštanje i traži odobrenje izvan ovog alata.
Neispravna ili istekla iznimka (K5) javlja se i na nepromijenjenom retku datoteke u diffu i nikad ne ulazi u baseline.
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
import tomllib
import traceback
from collections import Counter
from dataclasses import asdict, dataclass, field, replace
from datetime import date
from pathlib import Path
from typing import Iterable

from . import baseline, comments, layout, scope, standard, tsfacts
from .checks import paths
from .model import FileView, Finding, MeasureError, ordered, plural

RULES = layout.RULES
REPOS = layout.REPOS
CLEAN, VIOLATIONS, UNMEASURED = 0, 1, 2
JSON_VERSION = 2


@dataclass(frozen=True)
class Checker:
    """Modul provjere u lib/factory i pravila koja mu rules.toml dodjeljuje."""
    module: str
    rules: frozenset[str]


@dataclass
class Report:
    """Ishod jednog pokretanja: prijavljeni nalazi, iznimke, preskočene i izuzete datoteke, baza i exit."""
    mode: str
    findings: list[Finding] = field(default_factory=list)
    allowed: list[Finding] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    lossy: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    files: int = 0
    excluded_files: int = 0
    excluded_findings: int = 0
    config: str | None = None
    base: dict | None = None
    baseline: dict | None = None
    error: str | None = None
    exit: int = CLEAN


def registry(rules_path: Path = RULES) -> list[Checker]:
    """Provjere iz rules.toml, poredane po imenu modula."""
    bound: dict[str, set[str]] = {}
    for rule in standard.load_rules(rules_path):
        if rule.checker:
            bound.setdefault(rule.checker, set()).add(rule.id)
    return [Checker(module, frozenset(rules)) for module, rules in sorted(bound.items())]


def _call(module, views: list[FileView], repo_root: Path) -> list[Finding]:
    if hasattr(module, "scan_many"):
        return list(module.scan_many(views))
    if hasattr(module, "check_repo"):
        return list(module.check_repo(views, repo_root))
    if hasattr(module, "check"):
        return [finding for view in views for finding in _check_one(module, view)]
    raise MeasureError(f"provjera {module.__name__} nema scan_many, check_repo ni check")


def _check_one(module, view: FileView) -> list[Finding]:
    try:
        return list(module.check(view))
    except MeasureError as exc:
        raise MeasureError(str(exc) if view.path in str(exc) else f"{view.path}: {exc}") from exc


def _prefetch(views: list[FileView]) -> None:
    pairs = [(view.path, view.text) for view in views if view.lang == "ts"]
    pairs += [(view.path, view.old_text) for view in views if view.lang == "ts" and view.old_text is not None]
    if pairs:
        tsfacts.prefetch(pairs)


def collect(checkers: Iterable[Checker], views: list[FileView], repo_root: Path,
            only: frozenset[str] | None = None) -> list[Finding]:
    """Nalazi svih provjera. Nalaz za pravilo koje rules.toml ne veže uz tu provjeru je MeasureError."""
    _prefetch(views)
    out: list[Finding] = []
    for checker in checkers:
        if only is not None and not checker.rules & only:
            continue
        module = importlib.import_module(f".{checker.module}", __package__)
        try:
            found = _call(module, views, repo_root)
        except MeasureError as exc:
            raise MeasureError(f"provjera {checker.module}: {exc}") from exc
        stray = sorted({f.rule for f in found} - checker.rules)
        if stray:
            raise MeasureError(f"provjera {checker.module} javlja {', '.join(stray)}, a rules.toml joj to ne dodjeljuje")
        out += [f for f in found if only is None or f.rule in only]
    return ordered(out)


def _only(text: str | None, checkers: list[Checker]) -> frozenset[str] | None:
    if not text:
        return None
    wanted = frozenset(part.strip() for part in text.split(",") if part.strip())
    known = frozenset().union(*(c.rules for c in checkers))
    unknown = sorted(wanted - known)
    if unknown:
        raise MeasureError(f"--only: pravilo {', '.join(unknown)} nema provjeru u code-checku")
    return wanted


def repo_config(repo: Path, repos_dir: Path) -> standard.Repo | None:
    """Opis repoa iz repos/*.toml čija je putanja upravo `repo`; None kad repo nije opisan."""
    matches = [r for r in standard.load_repos(repos_dir) if r.path == repo.resolve()]
    return matches[0] if matches else None


def _base_exclude(view: FileView) -> dict[str, tuple[str, ...]]:
    if view.base is None or view.base.meta.get("skipped"):
        return {}
    try:
        data = tomllib.loads(view.base.text)
    except tomllib.TOMLDecodeError:
        return {}
    return standard.parse_exclude(data, f"baza {view.path}")


def _bound_to_base(report: Report, config: standard.Repo | None, repo: Path,
                   views: list[FileView]) -> standard.Repo | None:
    if config is None or config.source is None or not config.exclude:
        return config
    source = config.source.resolve()
    rel = source.relative_to(repo).as_posix() if source.is_relative_to(repo) else None
    view = next((v for v in views if v.path == rel), None)
    if view is None:
        return config
    base = _base_exclude(view)
    kept = {key: tuple(p for p in patterns if p in base.get(key, ())) for key, patterns in config.exclude.items()}
    dropped = sorted(f"{key} {p}" for key, patterns in config.exclude.items() for p in patterns if p not in kept[key])
    if dropped:
        report.notes.append(f"izuzeće dodano u diffu ne vrijedi dok nije u bazi ({rel}): {', '.join(dropped)}")
    return replace(config, exclude={key: patterns for key, patterns in kept.items() if patterns})


def _exclude(report: Report, config: standard.Repo | None, views: list[FileView]) -> list[FileView]:
    if config is None or not config.exclude:
        return views
    report.config = f"repos/{config.source.name}" if config.source else f"repos/{config.id}.toml"
    kept = [view for view in views if not standard.path_matches(view.path, config.exclude.get("all", ()))]
    report.excluded_files = len(views) - len(kept)
    return kept


def _drop_excluded(config: standard.Repo | None, findings: list[Finding]) -> list[Finding]:
    if config is None:
        return findings
    return [f for f in findings if not standard.path_matches(f.path, config.exclude.get(f.rule, ()))]


def _never_excused(finding: Finding) -> bool:
    return finding.rule == "K5" and finding.fix == comments.FIX_ALLOW


def _covers(allow: comments.FactoryAllow, finding: Finding, view: FileView, today: date) -> bool:
    if allow.rule != finding.rule or allow.problems(today):
        return False
    if view.added is not None and (allow.line in view.added or finding.line in view.added):
        return False
    return finding.line == (allow.line + 1 if allow.own_line else allow.line)


def _allow_id(allow: comments.FactoryAllow) -> tuple:
    return allow.rule, allow.reason, allow.until, allow.approver


def _covering(findings: list[Finding], views: list[FileView]) -> list[tuple[Finding, list[tuple]]]:
    by_path = {view.path: view for view in views}
    allows = {path: comments.allowances(by_path[path]) for path in sorted({f.path for f in findings})
              if path in by_path and "factory-allow" in by_path[path].text}
    today = date.today()
    return [(f, [] if _never_excused(f) else [_allow_id(a) for a in allows.get(f.path, ())
                                               if _covers(a, f, by_path[f.path], today)]) for f in findings]


def _approved(base: list[Finding], views: list[FileView]) -> Counter:
    return Counter((f.key(), hits[0]) for f, hits in _covering(base, views) if hits)


def _excuse(report: Report, findings: list[Finding], views: list[FileView],
            approved: Counter | None = None) -> list[Finding]:
    kept = []
    for finding, hits in _covering(findings, views):
        hit = next((a for a in hits if approved is None or approved[(finding.key(), a)] > 0), None)
        if hit is not None and approved is not None:
            approved[(finding.key(), hit)] -= 1
        (report.allowed if hit is not None else kept).append(finding)
    return kept


def _base_findings(report: Report, checkers: list[Checker], views: list[FileView], repo: Path,
                   only: frozenset[str] | None) -> list[Finding]:
    try:
        return collect(checkers, views, repo, only)
    except MeasureError:
        found = []
        for view in views:
            try:
                found += collect(checkers, [view], repo, only)
            except MeasureError as exc:
                report.notes.append(f"baza {view.path} se ne može izmjeriti ({exc}); svi nalazi u njoj su novi")
        return found


def _measure(report: Report, args, views: list[FileView], repo: Path) -> list[Finding]:
    checkers = registry(Path(args.rules))
    only = _only(args.only, checkers)
    if (only is None or "K9" in only) and not paths.load_names():
        report.notes.append("K9: popis internih imena je prazan (javna kopija), pa se gledaju samo lokalne putanje; "
                            "interna imena provjerava code-check iz izvora standarda")
    config = repo_config(repo, Path(args.repos))
    if report.mode == "diff":
        config = _bound_to_base(report, config, repo, views)
    views = _exclude(report, config, views)
    report.skipped = sorted((v.path, v.meta["skipped"]) for v in views if v.meta.get("skipped"))
    report.lossy = sorted(v.path for v in views if v.meta.get("lossy"))
    unread = scope.unreadable(views)
    if unread:
        raise MeasureError(f"datoteka se ne može pročitati: {', '.join(unread)} → spremi je kao UTF-8 ili je izuzmi u "
                           "standard/repos/<id>.toml")
    measured = [v for v in views if not v.meta.get("skipped") or v.raw is not None]
    report.files = sum(not v.meta.get("skipped") and not v.meta.get("deleted") for v in views)
    if not report.files and report.mode != "diff":
        raise MeasureError(f"nijedna datoteka nije izmjerena u {repo.name}; provjeri --repo i exclude")
    head = collect(checkers, measured, repo, only)
    found = _drop_excluded(config, head)
    report.excluded_findings = len(head) - len(found)
    if report.mode != "diff":
        return _excuse(report, found, measured)
    bases = [v.base for v in measured if v.base is not None and (not v.base.meta.get("skipped") or v.base.raw)]
    base = _drop_excluded(config, _base_findings(report, checkers, bases, repo, only)) if bases else []
    new = baseline.select_new(found, base, measured)
    found = ordered(new + [f for f in found if _never_excused(f) and f not in new])
    return _excuse(report, found, measured, _approved(base, bases))


def _verdict(findings: list[Finding]) -> int:
    return VIOLATIONS if any(f.severity == "error" for f in findings) else CLEAN


def run_diff(args) -> Report:
    """Diff prema bazi, indeksu ili snapshotu: javlja se ono što je na novim redcima i ono čega u bazi nije bilo."""
    repo = Path(args.repo).resolve()
    report = Report("diff")
    if args.snapshot:
        if not args.base_dir:
            raise MeasureError("--snapshot traži --base-dir")
        views = scope.views_for_snapshot(repo, Path(args.snapshot), Path(args.base_dir))
    else:
        ref, commit, note = scope.resolve_base(repo, args.base)
        report.base = {"ref": ref, "commit": commit, "note": note}
        views = scope.views_for_diff(repo, args.base, staged=args.staged)
    try:
        report.findings = _measure(report, args, views, repo)
    except MeasureError as exc:
        raise MeasureError("; ".join([str(exc), *report.notes])) from exc
    report.exit = _verdict(report.findings)
    return report


def _split_baselinable(findings: list[Finding]) -> tuple[list[Finding], list[Finding], list[Finding]]:
    never = [f for f in findings if _never_excused(f)]
    warnings = [f for f in findings if f.severity != "error" and not _never_excused(f)]
    known = [f for f in findings if f.severity == "error" and not _never_excused(f)]
    return known, never, warnings


def _baseline_for(repo: Path, path: Path) -> dict:
    base = baseline.load(path)
    written = baseline.written_at(path)
    return baseline.rename(base, scope.renames_since(repo, written)) if written else base


def run_full(args) -> Report:
    """Cijeli repo kao izvještaj; s --baseline pada samo ono što je iznad baselinea. S --base-baseline pada i kad
    baseline glave ima unos kojeg u baselineu baze nema ili ga ima više (CI: baseline smije samo padati)."""
    repo = Path(args.repo).resolve()
    if args.base_baseline and not args.baseline:
        raise MeasureError("--base-baseline traži --baseline (baseline glave koji se uspoređuje s bazom)")
    report = Report("full", ignored=scope.ignored_for_full(repo))
    found = _measure(report, args, scope.views_for_full(repo), repo)
    if not args.baseline:
        report.findings = found
        return report
    known, never, warnings = _split_baselinable(found)
    head = _baseline_for(repo, Path(args.baseline))
    result = baseline.compare(known, head)
    report.findings = ordered(result.new + never + warnings)
    report.baseline = {"matched": len(result.matched), "new": len(result.new) + len(never),
                       "resolved": [asdict(e) for e in result.resolved]}
    report.exit = _verdict(report.findings)
    if args.base_baseline:
        grown = baseline.growth(head, _baseline_for(repo, Path(args.base_baseline)))
        report.baseline["grown"] = [asdict(e) for e in grown]
        if grown:
            shown = ", ".join(f"{e.rule} {e.path} +{e.count}" for e in grown[:20])
            report.exit = VIOLATIONS
            report.error = (f"baseline glave raste prema bazi ({len(grown)}): {shown} → popravi nalaz umjesto upisa u "
                            "baseline; porast traži odobrenu izmjenu baze")
    return report


def run_baseline(args) -> Report:
    """Upis baselinea iz cijelog repoa. Porast traži --allow-increase i razlog; istekla iznimka se ne upisuje."""
    repo = Path(args.repo).resolve()
    report = Report("baseline", ignored=scope.ignored_for_full(repo))
    known, never, _ = _split_baselinable(_measure(report, args, scope.views_for_full(repo), repo))
    if never:
        report.findings, report.exit = never, VIOLATIONS
        report.error = "neispravna ili istekla factory-allow iznimka ne ulazi u baseline → ispravi je ili obriši"
        return report
    target = Path(args.write)
    try:
        written = baseline.write(target, known, _baseline_for(repo, target), args.allow_increase, args.reason,
                                 scope.head(repo))
    except baseline.BaselineIncrease as exc:
        report.exit, report.error = VIOLATIONS, str(exc)
        return report
    report.baseline = {"entries": len(written.entries), "increases": [asdict(e) for e in written.increases],
                       "resolved": [asdict(e) for e in written.resolved], "reason": written.reason}
    return report


def _by_rule(findings: list[Finding]) -> str:
    counts = Counter(f.rule for f in findings)
    return f" ({', '.join(f'{rule} {n}' for rule, n in sorted(counts.items()))})" if counts else ""


def summary(report: Report) -> str:
    """Zadnji redak izlaza: kršenja i upozorenja po pravilu, broj datoteka, iznimke i baza."""
    errors = [f for f in report.findings if f.severity == "error"]
    warnings = [f for f in report.findings if f.severity != "error"]
    parts = [f"{plural(len(errors), 'kršenje', 'kršenja', 'kršenja')}{_by_rule(errors)}, "
             f"{plural(len(warnings), 'upozorenje', 'upozorenja', 'upozorenja')}{_by_rule(warnings)}",
             plural(report.files, "datoteka", "datoteke", "datoteka"), f"iznimke: {len(report.allowed)}"]
    if report.base:
        ref, commit = report.base["ref"], report.base["commit"]
        parts.append(f"baza {commit[:12]}" if ref == commit else f"baza {ref} {commit[:12]}")
    if report.baseline and "matched" in report.baseline:
        parts.append(f"baseline: {report.baseline['matched']} upareno, {report.baseline['new']} iznad, "
                     f"{len(report.baseline['resolved'])} riješeno")
    if report.baseline and "entries" in report.baseline:
        parts.append(f"baseline zapisan: {plural(report.baseline['entries'], 'unos', 'unosa', 'unosa')}")
    return f"code-check {report.mode}: " + "; ".join(parts)


def text(report: Report) -> str:
    """Izlaz za čovjeka: nalazi po putanji, retku i pravilu, pa napomene i sažetak u zadnjem retku."""
    if report.exit == UNMEASURED:
        return f"code-check: nije izmjereno: {report.error}\n"
    lines = [f.render() for f in report.findings]
    lines += [f"iznimka {f.render()}" for f in report.allowed]
    lines += [f"preskočeno: {path} ({reason})" for path, reason in report.skipped]
    lines += [f"čitano sa zamjenskim znakovima: {path} (nije UTF-8; S1 gleda bajtove)" for path in report.lossy]
    if report.ignored:
        lines.append(f"ignorirano: {', '.join(report.ignored)}")
    lines += [f"napomena: {note}" for note in report.notes]
    if report.config and (report.excluded_files or report.excluded_findings):
        lines.append(f"izuzeto po {report.config}: {plural(report.excluded_files, 'datoteka', 'datoteke', 'datoteka')}"
                     f", {plural(report.excluded_findings, 'nalaz', 'nalaza', 'nalaza')}")
    if report.base and report.base["note"]:
        lines.append(f"napomena: {report.base['note']}")
    if report.error:
        lines.append(report.error)
    return "\n".join([*lines, summary(report)]) + "\n"


def document(report: Report) -> str:
    """Izlaz za stroj: stabilan JSON sa sortiranim ključevima i nalazima."""
    errors = sum(f.severity == "error" for f in report.findings)
    doc = {"version": JSON_VERSION, "mode": report.mode, "exit": report.exit, "error": report.error,
           "findings": [f.public() for f in report.findings], "allowed": [f.public() for f in report.allowed],
           "skipped": [{"path": p, "reason": r} for p, r in report.skipped], "lossy": report.lossy,
           "ignored": report.ignored, "notes": report.notes, "base": report.base,
           "baseline": report.baseline,
           "excluded": {"config": report.config, "files": report.excluded_files, "findings": report.excluded_findings},
           "summary": {"errors": errors, "warnings": len(report.findings) - errors, "files": report.files,
                       "allowed": len(report.allowed), "text": summary(report)}}
    return json.dumps(doc, sort_keys=True, ensure_ascii=False, indent=2) + "\n"


def parser() -> argparse.ArgumentParser:
    """Argumenti: diff, full i baseline, sa zajedničkim --repo, --json, --only, --repos i --rules."""
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--repo", default=".", metavar="DIR")
    common.add_argument("--json", action="store_true")
    common.add_argument("--only", metavar="RULES", help="popis pravila odvojen zarezom, npr. K3,K4")
    common.add_argument("--repos", default=str(REPOS), metavar="DIR", help="direktorij s repos/*.toml")
    common.add_argument("--rules", default=str(RULES), metavar="FILE", help="rules.toml s popisom provjera")
    ap = argparse.ArgumentParser(prog="code-check", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    diff = sub.add_parser("diff", parents=[common], help="nova kršenja prema bazi; exit 1 kad ih ima")
    diff.add_argument("--base", metavar="REF")
    diff.add_argument("--staged", action="store_true")
    diff.add_argument("--snapshot", metavar="MANIFEST")
    diff.add_argument("--base-dir", metavar="DIR")
    full = sub.add_parser("full", parents=[common], help="izvještaj cijelog repoa; s --baseline pada iznad njega")
    full.add_argument("--baseline", metavar="FILE")
    full.add_argument("--base-baseline", metavar="FILE", help="baseline baze; baseline glave ne smije biti veći")
    base = sub.add_parser("baseline", parents=[common], help="upis baselinea koji smije samo padati")
    base.add_argument("--write", required=True, metavar="FILE")
    base.add_argument("--allow-increase", action="store_true")
    base.add_argument("--reason", metavar="TEXT")
    return ap


COMMANDS = {"diff": run_diff, "full": run_full, "baseline": run_baseline}


def main(argv: list[str] | None = None) -> int:
    """Pokreni naredbu i ispiši izvještaj na stdout. Svaka greška mjerenja je exit 2 i kaže što nije izmjereno."""
    args = parser().parse_args(argv)
    if args.command == "diff" and args.snapshot and (args.base or args.staged):
        parser().error("--snapshot se ne kombinira s --base ni --staged")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        report = COMMANDS[args.command](args)
    except MeasureError as exc:
        report = Report(args.command, error=str(exc), exit=UNMEASURED)
    except OSError as exc:
        report = Report(args.command, error=f"{exc.strerror}: {exc.filename}", exit=UNMEASURED)
    except Exception as exc:
        traceback.print_exc()
        report = Report(args.command, error=f"interna greška {type(exc).__name__}: {exc}", exit=UNMEASURED)
    sys.stdout.write(document(report) if args.json else text(report))
    return report.exit
