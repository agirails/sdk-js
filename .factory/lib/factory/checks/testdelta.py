"""K12: diff koji mijenja izvorni kod, a ne dira nijedan test, daje jedno upozorenje po diffu."""
from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Iterable

from ..model import FileView, Finding, plural
from . import CODE_LANGS, is_test_path

SOURCE_DIRS = ("src",)
FIX = "dodaj ili promijeni test koji bez ove izmjene pada"


def _under(path: str, directory: str) -> bool:
    parts, wanted = PurePosixPath(path).parts[:-1], PurePosixPath(directory).parts
    return any(parts[i:i + len(wanted)] == wanted for i in range(len(parts) - len(wanted) + 1))


def check_repo(views: Iterable[FileView], repo_root: Path, source_dirs: tuple[str, ...] = SOURCE_DIRS) -> list[Finding]:
    """K12 upozorenje na prvoj izvornoj datoteci diffa (redak 0, razina diffa). Izvorni kod je kod u `source_dirs`
    (zadano src); codecheck zove `check_repo(views, repo_root)`, pa opis repoa to još ne mijenja. Test je svaka
    datoteka na testnoj putanji (`is_test_path`). Cijeli repo (svi `added` su None) nije diff, pa K12 tada ništa ne
    javlja. Snapshot nosi i datoteke jednake bazi (`meta["unchanged"]`); one nisu dio diffa."""
    views = [view for view in views if not view.meta.get("unchanged")]
    if all(view.added is None for view in views) or any(is_test_path(view.path) for view in views):
        return []
    sources = sorted(view.path for view in views
                     if view.lang in CODE_LANGS and any(_under(view.path, d) for d in source_dirs))
    if not sources:
        return []
    count = plural(len(sources), "datoteka", "datoteke", "datoteka")
    message = f"izmjena izvornog koda bez izmjene testa ({count} u {', '.join(source_dirs)})"
    return [Finding("K12", sources[0], 0, message, FIX, "izvorni kod bez testa", "warning")]
