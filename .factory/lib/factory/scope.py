"""Check scope: which files code-check looks at, what they were in the base and which of their lines are new (diff
against the base, whole repo, snapshot).

The working tree is read directly from disk and compared with the base blob by blob id, so a repo attribute (ident,
eol, filter) cannot hide a change. A symbolic link is a skipped file whose bytes are its target, so S1 still reads it.
Git runs only through `gitsafe`. New lines are computed with the same algorithm in every mode.
A snapshot is exactly its manifest: nothing is ignored. A directory walk outside git skips generated directories only
at the root (`ignored_for_full` names them), and version-control metadata and interpreter caches at any depth.
"""
from __future__ import annotations

import difflib
import io
import json
import os
import re
import tokenize
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import NamedTuple

from . import gitsafe
from .model import FileView, MeasureError, lang_of, line_count, sha256

MAX_BYTES = 1_000_000
DEFAULT_BASE = "origin/main"
FALLBACK_BASE = "main"
ANY_DEPTH_DIRS = frozenset({".git", ".hg", ".svn", "__pycache__"})
ROOT_DIRS = frozenset({
    "node_modules", "dist", "build", ".next", "out", "coverage", ".venv", "venv", ".tox", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".turbo", ".vercel",
})
ROOT_PATHS = frozenset({"lib/forge-std", "lib/openzeppelin-contracts", "lib/openzeppelin-contracts-upgradeable"})
GITLINK, SYMLINK = "160000", "120000"
DIFF_FLAGS = ("-M", "--relative", "--text", "--no-color", "--diff-algorithm=myers")
GENERATED = frozenset({"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock",
                       "composer.lock", "Gemfile.lock"})
UNREADABLE = {"oversized": "larger than 1 MB", "binary": "contains a NUL byte", "not_utf8": "not in declared encoding"}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
RENAME_SCORE = 0.5


class _Change(NamedTuple):
    status: str
    old_path: str | None
    path: str


class _Entry(NamedTuple):
    mode: str
    sha: str
    data: bytes | None = None


def _zsplit(data: bytes) -> list[str]:
    return [part.decode("utf-8", "surrogateescape") for part in data.split(b"\0") if part]


def _decode(data: bytes, path: str = "") -> tuple[str | None, str | None]:
    if len(data) > MAX_BYTES and PurePosixPath(path).name in GENERATED:
        return None, "generated"
    if b"\0" in data[:8000]:
        return None, "binary"
    lang = lang_of(path, data.split(b"\n", 1)[0].decode("utf-8", "replace"))
    if lang is None:
        try:
            return data.decode("utf-8-sig"), None
        except UnicodeDecodeError:
            return data.decode("utf-8", "replace"), "lossy"
    if len(data) > MAX_BYTES:
        return None, "oversized"
    encoding = "utf-8-sig"
    if lang == "py":
        try:
            encoding = tokenize.detect_encoding(io.BytesIO(data).readline)[0]
        except SyntaxError:
            return None, "not_utf8"
    try:
        return data.decode(encoding), None
    except (UnicodeDecodeError, LookupError):
        return None, "not_utf8"


def unreadable(views: list[FileView]) -> list[str]:
    """Code or documentation files that cannot be read, with the reason; the check must not skip them."""
    return sorted(f"{view.path} ({UNREADABLE[view.meta['skipped']]})" for view in views
                  if view.meta.get("skipped") in UNREADABLE and lang_of(view.path) is not None)


def _skipped(path: str, reason: str, meta: dict, raw: bytes | None = None) -> FileView:
    return FileView(path, "", None, added=set(), meta={**meta, "skipped": reason}, raw=raw)


def _view(path: str, data: bytes | str, meta: dict) -> FileView:
    if isinstance(data, str):
        return _skipped(path, data, meta)
    text, reason = _decode(data, path)
    if reason == "lossy":
        return FileView(path, text, None, meta={**meta, "lossy": "not_utf8"}, raw=data)
    if reason:
        return _skipped(path, reason, meta, raw=data)
    return FileView(path, text, lang_of(path, text), meta={**meta})


def _readable(view: FileView | None) -> bool:
    return view is not None and not view.meta.get("skipped")


def _pair(path: str, data: bytes | str, old: bytes | None, meta: dict) -> FileView:
    base = None if old is None else _view(path, old, meta)
    head = _view(path, data, meta)
    if head.meta.get("skipped"):
        return replace(head, base=base)
    if _readable(base):
        return replace(head, added=_added_against(base.text, head.text), old_text=base.text, base=base)
    return replace(head, added=set(range(1, line_count(head.text) + 1)), base=base)


def _deleted(path: str, old: bytes, meta: dict) -> FileView | None:
    base = _view(path, old, meta)
    if not _readable(base) or base.lang is None:
        return None
    return FileView(path, "", base.lang, added=set(), old_text=base.text, meta={**meta, "deleted": True}, base=base)


def _link(path: str, target: bytes, before: _Entry | None, blobs: dict[str, bytes], meta: dict) -> FileView:
    base = _skipped(path, "symlink", meta, raw=blobs[before.sha]) if before and before.mode == SYMLINK else None
    return replace(_skipped(path, "symlink", meta, raw=target), base=base)


def _read_disk(root: Path, rel: str) -> bytes | str:
    full = root / rel
    if full.is_symlink():
        return "symlink"
    if full.is_dir():
        return "submodule"
    if not full.is_file():
        return "missing"
    return full.read_bytes()


def resolve_base(repo: Path, base: str | None, git: gitsafe.Git | None = None) -> tuple[str, str, str | None]:
    """Base name, its commit and a note when the default base was replaced. No base → MeasureError."""
    git = git or gitsafe.Git(Path(repo))
    candidates = [base] if base else [DEFAULT_BASE, FALLBACK_BASE]
    for name in candidates:
        proc = git.run("rev-parse", "--verify", "--quiet", "--end-of-options", f"{name}^{{commit}}", ok=(0, 1))
        if proc.returncode == 0:
            note = None if name in (base, DEFAULT_BASE) else f"{DEFAULT_BASE} does not exist; base is {name}"
            return name, proc.stdout.decode().strip(), note
    raise MeasureError(f"base {' nor '.join(candidates)} does not exist in the repo")


def _changes(git: gitsafe.Git, *rev: str) -> list[_Change]:
    tokens = _zsplit(git.run("diff", "--raw", "-z", "--no-abbrev", *DIFF_FLAGS, *rev).stdout)
    out, i = [], 0
    while i < len(tokens):
        fields = tokens[i].lstrip(":").split(" ")
        if len(fields) != 5 or i + 1 >= len(tokens):
            raise MeasureError(f"unexpected git diff --raw output: {tokens[i]!r}")
        status = fields[4][0]
        if status in "RC":
            old, path, i = tokens[i + 1], tokens[i + 2], i + 3
        else:
            old, path, i = (None if status == "A" else tokens[i + 1]), tokens[i + 1], i + 2
        out.append(_Change(status, old, path))
    return out


def _blobs(git: gitsafe.Git, shas: set[str]) -> dict[str, bytes]:
    wanted = sorted(shas)
    if not wanted:
        return {}
    data = git.run("cat-file", "--batch", stdin="".join(f"{sha}\n" for sha in wanted).encode()).stdout
    out, pos = {}, 0
    for sha in wanted:
        end = data.index(b"\n", pos)
        header = data[pos:end].split(b" ")
        if len(header) != 3 or header[1] != b"blob":
            raise MeasureError(f"git cat-file did not return blob {sha}")
        size = int(header[2])
        out[sha] = data[end + 1:end + 1 + size]
        pos = end + 1 + size + 1
    return out


def _entries(output: bytes, sha_field: int) -> dict[str, _Entry]:
    out: dict[str, _Entry] = {}
    for record in _zsplit(output):
        info, _, path = record.partition("\t")
        fields = info.split(" ")
        if len(fields) != 3 or not path:
            raise MeasureError(f"unexpected git output: {record!r}")
        out.setdefault(path, _Entry(fields[0], fields[sha_field]))
    return out


def _kind(mode: str) -> str:
    return mode if mode in (GITLINK, SYMLINK) else "file"


def _same(old: _Entry | None, new: _Entry) -> bool:
    return old is not None and _kind(old.mode) == _kind(new.mode) and old.sha == new.sha


def _disk_entry(git: gitsafe.Git, repo: Path, rel: str, index: _Entry | None) -> _Entry | None:
    if index is not None and index.mode == GITLINK:
        return index
    full = repo / rel
    if index is None and full.is_dir() and not full.is_symlink():
        return _Entry(GITLINK, "")
    if full.is_symlink():
        target = os.fsencode(os.readlink(full))
        return _Entry(SYMLINK, git.blob_id(target), target)
    if not full.is_file():
        return None
    data = full.read_bytes()
    return _Entry("file", git.blob_id(data), data)


def _worktree(git: gitsafe.Git, repo: Path, index: dict[str, _Entry]) -> dict[str, _Entry]:
    untracked = [rel.rstrip("/") for rel in _zsplit(git.run("ls-files", "-z", "--others", "--exclude-standard").stdout)]
    found = {rel: _disk_entry(git, repo, rel, index.get(rel)) for rel in sorted({*index, *untracked})}
    return {rel: entry for rel, entry in found.items() if entry is not None}


def _renames(git: gitsafe.Git, rev: tuple[str, ...], added: set[str], gone: set[str]) -> dict[str, str]:
    if not added or not gone:
        return {}
    pairs = [c for c in _changes(git, *rev) if c.status == "R"]
    return {c.path: c.old_path for c in pairs if c.path in added and c.old_path in gone}


def views_for_diff(repo: Path, base: str | None = None, staged: bool = False) -> list[FileView]:
    """Files changed since the merge base of HEAD and the base. The head is the disk (or the index with `staged`), the
    base is the merge-base blob; `added` are head lines absent from the base, `base` is the view of the base file."""
    repo = Path(repo)
    git = gitsafe.Git(repo)
    base_ref, base_commit, note = resolve_base(repo, base, git)
    merge_base = git.text("merge-base", "HEAD", base_commit)
    meta = {"base_ref": base_ref, "merge_base": merge_base, **({"base_note": note} if note else {})}
    old = _entries(git.run("ls-tree", "-r", "-z", merge_base).stdout, 2)
    index = _entries(git.run("ls-files", "-s", "-z").stdout, 1)
    new = index if staged else _worktree(git, repo, index)
    changed = sorted(path for path, entry in new.items() if not _same(old.get(path), entry))
    gone = {path for path in old if path not in new}
    renames = _renames(git, ("--cached", merge_base) if staged else (merge_base,),
                       {p for p in changed if p not in old}, gone)
    sources = {renames.get(path, path) for path in changed} | (gone - set(renames.values()))
    wanted = {old[p].sha for p in sources if p in old and _kind(old[p].mode) != GITLINK}
    wanted |= {new[p].sha for p in changed if new[p].data is None and _kind(new[p].mode) != GITLINK}
    blobs = _blobs(git, wanted)
    views = []
    for path in changed:
        source = renames.get(path, path)
        view_meta = {**meta, **({"renamed_from": source} if path in renames else {})}
        entry, before = new[path], old.get(source)
        if entry.mode == GITLINK:
            views.append(_skipped(path, "submodule", view_meta))
            continue
        if entry.mode == SYMLINK:
            views.append(_link(path, entry.data or blobs[entry.sha], before, blobs, view_meta))
            continue
        old_data = blobs[before.sha] if before is not None and _kind(before.mode) == "file" else None
        views.append(_pair(path, entry.data if entry.data is not None else blobs[entry.sha], old_data, view_meta))
    for path in sorted(gone - set(renames.values())):
        if _kind(old[path].mode) == "file":
            deleted = _deleted(path, blobs[old[path].sha], meta)
            views.extend([deleted] if deleted else [])
    return sorted(views, key=lambda v: v.path)


def head(repo: Path) -> str | None:
    """HEAD commit for the baseline record; None outside git or in a repo without commits."""
    git = gitsafe.Git(Path(repo))
    if not git.inside:
        return None
    return git.run("rev-parse", "--verify", "--quiet", "HEAD", ok=(0, 1)).stdout.decode().strip() or None


def has_commit(repo: Path, rev: str) -> bool:
    """Whether commit `rev` is in the repo history (e.g. a baseline commit after a squash merge or a deleted branch)."""
    return gitsafe.Git(Path(repo)).run("cat-file", "-e", f"{rev}^{{commit}}", ok=(0, 1, 128)).returncode == 0


def renames_since(repo: Path, rev: str) -> dict[str, str]:
    """Renames from `rev` to the working tree, old path → new, for carrying the baseline over."""
    return {c.old_path: c.path for c in _changes(gitsafe.Git(Path(repo)), rev) if c.status == "R" and c.old_path}


def _rel(rel_dir: str, name: str) -> str:
    return PurePosixPath(rel_dir, name).as_posix().removeprefix("./")


def _ignored_dir(rel: str, name: str) -> bool:
    return name in ANY_DEPTH_DIRS or rel in ROOT_DIRS or rel in ROOT_PATHS


def _walk(root: Path, ignore: bool) -> tuple[list[str], list[str]]:
    found, skipped = [], []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        if ignore:
            skipped += [_rel(rel_dir, d) for d in dirnames if _ignored_dir(_rel(rel_dir, d), d)]
            dirnames[:] = [d for d in dirnames if not _ignored_dir(_rel(rel_dir, d), d)]
        linked = [d for d in dirnames if (Path(dirpath) / d).is_symlink()]
        found.extend(_rel(rel_dir, name) for name in filenames + linked)
    return sorted(found), sorted(skipped)


def ignored_for_full(repo: Path) -> list[str]:
    """What a directory walk outside git skips: generated root directories by path, and version-control metadata and
    interpreter caches by name (at any depth). Empty inside git, because `git ls-files` then defines the scope."""
    repo = Path(repo)
    if gitsafe.Git(repo).inside:
        return []
    skipped = _walk(repo, ignore=True)[1]
    rooted = [f"{rel}/" for rel in skipped if PurePosixPath(rel).name not in ANY_DEPTH_DIRS]
    anywhere = sorted({f"{PurePosixPath(rel).name}/ (at any depth)" for rel in skipped
                       if PurePosixPath(rel).name in ANY_DEPTH_DIRS})
    return rooted + anywhere


def views_for_full(repo: Path) -> list[FileView]:
    """Whole repo: tracked and untracked non-ignored files from `git ls-files`, and outside git a tree walk without
    the generated root directories. added=None."""
    repo = Path(repo)
    git = gitsafe.Git(repo)
    listed = ("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    rels = sorted(set(_zsplit(git.run(*listed).stdout))) if git.inside else _walk(repo, ignore=True)[0]
    return [_full_view(repo, rel) for rel in rels]


def _full_view(repo: Path, rel: str) -> FileView:
    data = _read_disk(repo, rel)
    if data == "symlink":
        return _skipped(rel, data, {}, raw=os.fsencode(os.readlink(repo / rel)))
    return _view(rel, data, {})


def _manifest(path: Path) -> dict[str, str]:
    try:
        files = json.loads(Path(path).read_text())["files"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise MeasureError(f"manifest {Path(path).name} is not readable: {exc}") from exc
    if not isinstance(files, dict):
        raise MeasureError("manifest: field files is not an object")
    for rel, digest in files.items():
        parts = PurePosixPath(rel).parts
        if not isinstance(digest, str) or not SHA256.match(digest):
            raise MeasureError(f"manifest: {rel} has no valid sha256")
        if not parts or PurePosixPath(rel).is_absolute() or ".." in parts or "\\" in rel:
            raise MeasureError(f"manifest: path {rel} leaves the candidate")
    return files


def _added_against(old_text: str, new_text: str) -> set[int]:
    matcher = difflib.SequenceMatcher(None, old_text.split("\n"), new_text.split("\n"), autojunk=False)
    added: set[int] = set()
    for tag, _, _, j1, j2 in matcher.get_opcodes():
        if tag in ("replace", "insert"):
            added.update(range(j1 + 1, j2 + 1))
    return {line for line in added if line <= line_count(new_text)}


def _snapshot_view(candidate: Path, base: Path, rel: str, digest: str, source: str | None) -> FileView:
    data = _read_disk(candidate, rel)
    if isinstance(data, str):
        raise MeasureError(f"{rel}: the candidate contains a {data}, not a regular file")
    if sha256(data) != digest:
        raise MeasureError(f"{rel}: sha256 does not match the manifest")
    old = _read_disk(base, source or rel)
    old = old if isinstance(old, bytes) else None
    view = _pair(rel, data, old, {"snapshot": True, **({"renamed_from": source} if source else {})})
    return replace(view, meta={**view.meta, "unchanged": True}) if old == data and not source else view


def _generated_root(rel: str) -> str | None:
    return next((root for root in sorted(ROOT_DIRS | ROOT_PATHS) if rel.startswith(f"{root}/")), None)


def _base_files(base: Path, expected: dict[str, str]) -> list[str]:
    found = _walk(base, ignore=True)[0]
    for root in sorted({root for rel in expected if (root := _generated_root(rel))}):
        if (base / root).is_dir() and not (base / root).is_symlink():
            found += [f"{root}/{rel}" for rel in _walk(base / root, ignore=False)[0]]
    return [rel for rel in found if not ANY_DEPTH_DIRS & set(PurePosixPath(rel).parts[:-1])]


def _lines(data: bytes | str) -> list[bytes] | None:
    if not isinstance(data, bytes) or not data or len(data) > MAX_BYTES:
        return None
    return data.split(b"\n")


def _snapshot_renames(candidate: Path, base: Path, added: list[str], gone: list[str]) -> dict[str, str]:
    old = {rel: lines for rel in gone if (lines := _lines(_read_disk(base, rel))) is not None}
    scored = []
    for path in added:
        new = _lines(_read_disk(candidate, path))
        if new is None:
            continue
        matcher = difflib.SequenceMatcher(None, autojunk=False)
        matcher.set_seq2(new)
        for source, lines in old.items():
            matcher.set_seq1(lines)
            if matcher.real_quick_ratio() >= RENAME_SCORE and matcher.quick_ratio() >= RENAME_SCORE:
                score = matcher.ratio()
                scored.extend([(-score, path, source)] if score >= RENAME_SCORE else [])
    renames, used = {}, set()
    for _, path, source in sorted(scored):
        if path not in renames and source not in used:
            renames[path] = source
            used.add(source)
    return renames


def views_for_snapshot(candidate_dir: Path, manifest_path: Path, base_dir: Path) -> list[FileView]:
    """A candidate without git as a diff against base_dir: the scope is exactly the manifest and every file must match
    its manifest sha256. New lines are computed against the same path in base_dir; a file equal to the base stays in
    scope with `meta["unchanged"]`, and a file present only in base_dir comes as deleted (except version-control
    metadata, interpreter caches and generated root directories the candidate does not carry, because base_dir may be
    a checkout with installed dependencies). A new path whose content is at least RENAME_SCORE similar to a deleted
    one is a rename (`meta["renamed_from"]`) as in `git diff -M`: most similar pair first, each path in at most one
    pair, and empty files and files larger than 1 MB are not paired. Nothing in the candidate is ignored."""
    candidate, base = Path(candidate_dir), Path(base_dir)
    expected = _manifest(manifest_path)
    present = _walk(candidate, ignore=False)[0]
    extra, absent = sorted(set(present) - set(expected)), sorted(set(expected) - set(present))
    if extra:
        raise MeasureError(f"{', '.join(extra)}: candidate file is not in the manifest")
    if absent:
        raise MeasureError(f"{', '.join(absent)}: manifest file does not exist in the candidate")
    gone = sorted(set(_base_files(base, expected)) - set(expected))
    renames = _snapshot_renames(candidate, base, [rel for rel in present if not os.path.lexists(base / rel)], gone)
    views = [_snapshot_view(candidate, base, rel, expected[rel], renames.get(rel)) for rel in present]
    for rel in sorted(set(gone) - set(renames.values())):
        old = _read_disk(base, rel)
        deleted = _deleted(rel, old, {"snapshot": True}) if isinstance(old, bytes) else None
        views.extend([deleted] if deleted else [])
    return sorted(views, key=lambda v: v.path)
