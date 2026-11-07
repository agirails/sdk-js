"""Baseline of existing violations: occurrence count per key (rule, file, fingerprint of the normalised text), which
may only shrink. The file carries only the fingerprint (`Finding.key()`), never the source text of the line.

The same key with multiplicity also decides in diff mode: a head finding is new when it is on an added line or when its
key has no match among the base findings (`select_new`)."""
from __future__ import annotations

import json
import os
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from .model import FileView, Finding, MeasureError, ordered

VERSION = 3
FIELDS = ("rule", "path", "fp", "count")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
Key = tuple[str, str, str]


@dataclass(frozen=True)
class Entry:
    """Baseline key (`key` is the fingerprint of the finding text) with its occurrence count; in a difference `count` is
    the amount of growth or shrinkage."""
    rule: str
    path: str
    key: str
    count: int


@dataclass(frozen=True)
class Comparison:
    """Result of comparing the whole repo with the baseline: new findings, matched findings and keys that went away."""
    new: list[Finding]
    matched: list[Finding]
    resolved: list[Entry]


@dataclass(frozen=True)
class WriteResult:
    """The written baseline, the growth allowed with a reason, and the shrinkage."""
    entries: list[Entry]
    increases: list[Entry]
    resolved: list[Entry]
    reason: str | None


class BaselineIncrease(Exception):
    """The write would grow the baseline without an approval with a reason. `increases` are the keys and the growth."""

    def __init__(self, increases: list[Entry]):
        names = ", ".join(f"{e.rule} {e.path} +{e.count}" for e in increases)
        super().__init__(f"baseline would grow ({names}) → fix the violations or ask for approval with a reason")
        self.increases = increases


def _sorted_entries(entries: Iterable[Entry]) -> list[Entry]:
    return sorted(entries, key=lambda e: (e.path, e.rule, e.key))


def counts(findings: Iterable[Finding]) -> dict[Key, int]:
    """Occurrence count per finding key."""
    return dict(Counter(f.key() for f in findings))


def _valid(item: object) -> bool:
    if not isinstance(item, dict) or set(item) != set(FIELDS):
        return False
    texts_ok = all(isinstance(item[name], str) for name in FIELDS[:3]) and DIGEST.match(item["fp"]) is not None
    return texts_ok and type(item["count"]) is int and item["count"] >= 1


def load(path: Path) -> dict[Key, int]:
    """Baseline from JSON. A missing file is an empty baseline; an invalid one is a MeasureError."""
    path = Path(path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MeasureError(f"baseline {path.name} is not readable: {exc}") from exc
    if isinstance(data, dict) and data.get("version") == 2:
        raise MeasureError(f"baseline {path.name} is version 2 (field key) → rewrite it: code-check baseline --write")
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get("entries"), list):
        raise MeasureError(f"baseline {path.name}: expected version {VERSION} and a list of entries")
    out: dict[Key, int] = {}
    for item in data["entries"]:
        if not _valid(item):
            raise MeasureError(f"baseline {path.name}: invalid entry {item!r}")
        key = (item["rule"], item["path"], item["fp"])
        if key in out:
            raise MeasureError(f"baseline {path.name}: duplicate key {key!r}")
        out[key] = item["count"]
    return out


def written_at(path: Path) -> str | None:
    """Commit at which the baseline was written (field `commit`), for carrying over entries of renamed files."""
    path = Path(path)
    if not path.exists():
        return None
    try:
        commit = json.loads(path.read_text(encoding="utf-8")).get("commit")
    except (OSError, ValueError, AttributeError) as exc:
        raise MeasureError(f"baseline {path.name} is not readable: {exc}") from exc
    if commit is not None and not (isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40,64}", commit)):
        raise MeasureError(f"baseline {path.name}: commit must be a full git hash")
    return commit


def rename(base: dict[Key, int], renames: dict[str, str]) -> dict[Key, int]:
    """Carries entries of renamed files over to the new path (old → new, e.g. from `scope.renames_since`)."""
    out: Counter = Counter()
    for (rule, path, key), count in base.items():
        out[(rule, renames.get(path, path), key)] += count
    return dict(out)


def select_new(head: Iterable[Finding], base: Iterable[Finding], views: Iterable[FileView]) -> list[Finding]:
    """Diff mode. `head` are findings on the head, `base` on the same files in the base. A finding is new when it is on
    an added line, even if the same text exists in the base, and when its key has no match in the base (multiplicity
    counts one-to-one), so a violation caused by a deletion also shows. A finding outside the scope is MeasureError."""
    head = list(head)
    by_path = {view.path: view for view in views}
    outside = sorted({f.path for f in head if f.path not in by_path})
    if outside:
        raise MeasureError(f"finding for a file outside the scope: {', '.join(outside)}")
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
    """Whole repo: one-to-one matching by key. Occurrences above the baseline count are new (the last ones by line),
    and keys with fewer occurrences than in the baseline are resolved."""
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
    """Head baseline entries above the base baseline: a key absent from the base or a higher count (the difference)."""
    return _sorted_entries(Entry(*key, count - base.get(key, 0)) for key, count in head.items()
                           if count > base.get(key, 0))


def _serialize(entries: list[Entry], commit: str | None) -> str:
    rows = [{"rule": e.rule, "path": e.path, "fp": e.key, "count": e.count} for e in entries]
    doc = {"version": VERSION, **({"commit": commit} if commit else {}), "entries": rows}
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def write(path: Path, findings: Iterable[Finding], previous: dict[Key, int], allow_increase: bool = False,
          reason: str | None = None, commit: str | None = None) -> WriteResult:
    """Writes the baseline from the findings. Shrinkage is always allowed. Growth or a new key requires allow_increase
    and a non-empty reason, otherwise BaselineIncrease and the file stays untouched. `commit` is HEAD at write time."""
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
