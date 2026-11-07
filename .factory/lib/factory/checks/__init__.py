"""Provjere po datoteci (`check(view)`) i po repou (`check_repo(views, repo_root)`): K4, K9, K12, K13, K19, S1, S3."""
from __future__ import annotations

import re
from pathlib import PurePosixPath

from ..model import FileView

CODE_LANGS = frozenset({"py", "ts", "sol", "sh"})
TEST_DIRS = frozenset({"test", "tests", "__tests__", "__e2e__", "e2e", "spec", "specs"})
TEST_NAME = re.compile(r"^test_.*\.py$|_test\.py$|^conftest\.py$|\.(test|spec)\.[cm]?[jt]sx?$|\.t\.sol$")


def is_test_path(path: str) -> bool:
    """Testna datoteka po imenu ili po direktoriju; isti kriterij koriste K12 i K19."""
    parts = PurePosixPath(path).parts
    if not parts:
        return False
    return TEST_NAME.search(parts[-1]) is not None or any(part in TEST_DIRS for part in parts[:-1])


def anchor(view: FileView, start: int, end: int) -> int | None:
    """Redak na koji se veže nalaz u rasponu [start, end]: prvi novi redak u rasponu, a bez njega početak kad provjera
    javlja sve (`FileView.reports_all`); inače None."""
    if view.added is None:
        return start
    hits = [line for line in view.added if start <= line <= end]
    return min(hits) if hits else (start if view.reports_all() else None)


def line_text(text: str, line: int) -> str:
    """Tekst retka `line` (od 1), prazan kad redak ne postoji."""
    rows = text.split("\n")
    return rows[line - 1] if 0 < line <= len(rows) else ""

