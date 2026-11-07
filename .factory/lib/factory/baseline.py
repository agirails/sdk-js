"""Baseline postojećih kršenja: broj pojavljivanja po ključu (pravilo, datoteka, otisak normaliziranog teksta), smije
samo padati. Datoteka nosi samo otisak (`Finding.key()`), nikad izvorni tekst retka.

Isti ključ s višestrukošću odlučuje i u diff načinu: nalaz glave nov je kad je na dodanom retku ili kad mu ključ nema
par među nalazima baze (`select_new`)."""
from __future__ import annotations

import json
import os
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from .model import FileView, Finding, MeasureError, ordered

VERSION = 2
FIELDS = ("rule", "path", "key", "count")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
Key = tuple[str, str, str]


@dataclass(frozen=True)
class Entry:
    """Ključ baselinea (`key` je otisak teksta nalaza) s brojem pojavljivanja; u razlici je `count` iznos porasta ili
    pada."""
    rule: str
    path: str
    key: str
    count: int


@dataclass(frozen=True)
class Comparison:
    """Ishod usporedbe cijelog repoa s baselineom: novi nalazi, upareni nalazi i ključevi koji su nestali."""
    new: list[Finding]
    matched: list[Finding]
    resolved: list[Entry]


@dataclass(frozen=True)
class WriteResult:
    """Zapisani baseline, porast koji je dopušten uz razlog, i pad."""
    entries: list[Entry]
    increases: list[Entry]
    resolved: list[Entry]
    reason: str | None


class BaselineIncrease(Exception):
    """Upis bi povećao baseline, a nema dopuštenja s razlogom. `increases` su ključevi i iznos porasta."""

    def __init__(self, increases: list[Entry]):
        names = ", ".join(f"{e.rule} {e.path} +{e.count}" for e in increases)
        super().__init__(f"baseline bi porastao ({names}) → očisti kršenja ili traži odobrenje s razlogom")
        self.increases = increases


def _sorted_entries(entries: Iterable[Entry]) -> list[Entry]:
    return sorted(entries, key=lambda e: (e.path, e.rule, e.key))


def counts(findings: Iterable[Finding]) -> dict[Key, int]:
    """Broj pojavljivanja po ključu nalaza."""
    return dict(Counter(f.key() for f in findings))


def _valid(item: object) -> bool:
    if not isinstance(item, dict) or set(item) != set(FIELDS):
        return False
    texts_ok = all(isinstance(item[name], str) for name in FIELDS[:3]) and DIGEST.match(item["key"]) is not None
    return texts_ok and type(item["count"]) is int and item["count"] >= 1


def load(path: Path) -> dict[Key, int]:
    """Baseline iz JSON-a. Nepostojeća datoteka je prazan baseline; neispravna je MeasureError."""
    path = Path(path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MeasureError(f"baseline {path.name} nije čitljiv: {exc}") from exc
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get("entries"), list):
        raise MeasureError(f"baseline {path.name}: očekuje se version {VERSION} i popis entries")
    out: dict[Key, int] = {}
    for item in data["entries"]:
        if not _valid(item):
            raise MeasureError(f"baseline {path.name}: neispravan unos {item!r}")
        key = (item["rule"], item["path"], item["key"])
        if key in out:
            raise MeasureError(f"baseline {path.name}: ključ se ponavlja {key!r}")
        out[key] = item["count"]
    return out


def written_at(path: Path) -> str | None:
    """Commit na kojem je baseline zapisan (polje `commit`), za prenošenje unosa preimenovanih datoteka."""
    path = Path(path)
    if not path.exists():
        return None
    try:
        commit = json.loads(path.read_text(encoding="utf-8")).get("commit")
    except (OSError, ValueError, AttributeError) as exc:
        raise MeasureError(f"baseline {path.name} nije čitljiv: {exc}") from exc
    if commit is not None and not (isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40,64}", commit)):
        raise MeasureError(f"baseline {path.name}: commit mora biti puni git hash")
    return commit


def rename(base: dict[Key, int], renames: dict[str, str]) -> dict[Key, int]:
    """Prenosi unose preimenovanih datoteka na novu putanju (stara → nova, npr. iz `scope.renames_since`)."""
    out: Counter = Counter()
    for (rule, path, key), count in base.items():
        out[(rule, renames.get(path, path), key)] += count
    return dict(out)


def select_new(head: Iterable[Finding], base: Iterable[Finding], views: Iterable[FileView]) -> list[Finding]:
    """Diff način. `head` su nalazi nad glavom, `base` nad istim datotekama u bazi. Nov je nalaz na dodanom retku, i kad
    isti tekst postoji u bazi, i nalaz čiji ključ nema par u bazi (višestrukost se broji jedan-na-jedan), pa se vidi i
    kršenje nastalo brisanjem. Nalaz izvan opsega je MeasureError."""
    head = list(head)
    by_path = {view.path: view for view in views}
    outside = sorted({f.path for f in head if f.path not in by_path})
    if outside:
        raise MeasureError(f"nalaz za datoteku izvan opsega: {', '.join(outside)}")
    left = Counter(f.key() for f in base)
    new = []
    for finding in ordered(head):
        view = by_path[finding.path]
        if finding.line > 0 and view.added is not None and finding.line in view.added:
            new.append(finding)
        elif left[finding.key()] > 0:
            left[finding.key()] -= 1
        else:
            new.append(finding)
    return new


def compare(findings: Iterable[Finding], base: dict[Key, int]) -> Comparison:
    """Cijeli repo: uparivanje jedan-na-jedan po ključu. Pojavljivanja iznad broja u baselineu su nova (zadnja po
    retku), a ključevi kojih je manje nego u baselineu su riješeni."""
    groups: defaultdict[Key, list[Finding]] = defaultdict(list)
    for finding in ordered(findings):
        groups[finding.key()].append(finding)
    new, matched = [], []
    for key, items in groups.items():
        allowed = base.get(key, 0)
        matched.extend(items[:allowed])
        new.extend(items[allowed:])
    resolved = [Entry(*key, count - len(groups.get(key, ()))) for key, count in base.items()
                if count > len(groups.get(key, ()))]
    return Comparison(ordered(new), ordered(matched), _sorted_entries(resolved))


def growth(head: dict[Key, int], base: dict[Key, int]) -> list[Entry]:
    """Unosi baselinea glave iznad baselinea baze: ključ kojeg u bazi nema ili veći broj pojavljivanja (razlika)."""
    return _sorted_entries(Entry(*key, count - base.get(key, 0)) for key, count in head.items()
                           if count > base.get(key, 0))


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("ključ se ponavlja u JSON objektu")
    return dict(pairs)


def canonical(text: str) -> bool:
    """Je li tekst baseline točno onako kako ga `write` zapisuje: valjan dokument bez ponovljenih JSON ključeva, čija je
    ponovna serijalizacija bajt-identična tekstu. Escapeovi, drukčiji razmaci i ponovljeni ključevi nisu kanonski."""
    try:
        data = json.loads(text, object_pairs_hook=_unique_pairs)
    except ValueError:
        return False
    if not isinstance(data, dict) or set(data) - {"version", "commit", "entries"} or data.get("version") != VERSION:
        return False
    entries, commit = data.get("entries"), data.get("commit")
    if not isinstance(entries, list) or not all(_valid(item) for item in entries):
        return False
    if commit is not None and not isinstance(commit, str):
        return False
    return _serialize([Entry(**item) for item in entries], commit) == text


def _serialize(entries: list[Entry], commit: str | None) -> str:
    doc = {"version": VERSION, **({"commit": commit} if commit else {}), "entries": [asdict(e) for e in entries]}
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def write(path: Path, findings: Iterable[Finding], previous: dict[Key, int], allow_increase: bool = False,
          reason: str | None = None, commit: str | None = None) -> WriteResult:
    """Zapisuje baseline iz nalaza. Pad je uvijek dopušten. Porast ili novi ključ traže allow_increase i neprazan
    razlog, inače BaselineIncrease i datoteka ostaje netaknuta. `commit` je HEAD u trenutku upisa."""
    path = Path(path)
    current = counts(findings)
    increases = _sorted_entries(Entry(*key, count - previous.get(key, 0)) for key, count in current.items()
                                if count > previous.get(key, 0))
    resolved = _sorted_entries(Entry(*key, count - current.get(key, 0)) for key, count in previous.items()
                               if count > current.get(key, 0))
    reason = (reason or "").strip() or None
    if increases and not (allow_increase and reason):
        raise BaselineIncrease(increases)
    entries = _sorted_entries(Entry(*key, count) for key, count in current.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(_serialize(entries, commit), encoding="utf-8")
    os.replace(tmp, path)
    return WriteResult(entries, increases, resolved, reason)
