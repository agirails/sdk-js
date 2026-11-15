"""Checks per file (`check(view)`) and per repo (`check_repo(views, repo_root)`): K4, K9, K12, K13, K19, S1, S3."""
from __future__ import annotations

import re
from pathlib import PurePosixPath

from ..model import FileView

CODE_LANGS = frozenset({"py", "ts", "sol", "sh"})
TEST_DIRS = frozenset({"test", "tests", "__tests__", "__e2e__", "e2e", "spec", "specs"})
TEST_NAME = re.compile(r"^test_.*\.py$|_test\.py$|^conftest\.py$|\.(test|spec)\.[cm]?[jt]sx?$|\.t\.sol$")


def is_test_path(path: str) -> bool:
    """Test file by name or by directory; K12 and K19 use the same criterion."""
    parts = PurePosixPath(path).parts
    if not parts:
        return False
    return TEST_NAME.search(parts[-1]) is not None or any(part in TEST_DIRS for part in parts[:-1])


def anchor(view: FileView, start: int, end: int) -> int | None:
    """Line a finding in the range [start, end] is attached to: the first new line in the range, or, without one, the
    start when the check reports everything (`FileView.reports_all`); otherwise None."""
    if view.added is None:
        return start
    hits = [line for line in view.added if start <= line <= end]
    return min(hits) if hits else (start if view.reports_all() else None)


def line_text(text: str, line: int) -> str:
    """Text of line `line` (1-based), empty when the line does not exist."""
    rows = text.split("\n")
    return rows[line - 1] if 0 < line <= len(rows) else ""

