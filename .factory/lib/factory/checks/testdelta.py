"""K12: a diff that changes source code but touches no test gives one warning per diff."""
from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Iterable

from ..model import FileView, Finding, plural
from . import CODE_LANGS, is_test_path

SOURCE_DIRS = ("src",)
FIX = "add or change a test that fails without this change"


def _under(path: str, directory: str) -> bool:
    parts, wanted = PurePosixPath(path).parts[:-1], PurePosixPath(directory).parts
    return any(parts[i:i + len(wanted)] == wanted for i in range(len(parts) - len(wanted) + 1))


def check_repo(views: Iterable[FileView], repo_root: Path, source_dirs: tuple[str, ...] = SOURCE_DIRS) -> list[Finding]:
    """K12 warning on the first source file of the diff (line 0, diff level). Source code is code in `source_dirs`
    (default src); codecheck calls `check_repo(views, repo_root)`, so the repo description does not change it yet. A
    test is any file on a test path (`is_test_path`). A whole repo (all `added` None) is not a diff, so K12 reports
    nothing. The snapshot also has files equal to the base (`meta["unchanged"]`); they are not part of the diff."""
    views = [view for view in views if not view.meta.get("unchanged")]
    if all(view.added is None for view in views) or any(is_test_path(view.path) for view in views):
        return []
    sources = sorted(view.path for view in views
                     if view.lang in CODE_LANGS and any(_under(view.path, d) for d in source_dirs))
    if not sources:
        return []
    count = plural(len(sources), "file", "files", "files")
    message = f"source code change without a test change ({count} in {', '.join(source_dirs)})"
    return [Finding("K12", sources[0], 0, message, FIX, "izvorni kod bez testa", "warning")]
