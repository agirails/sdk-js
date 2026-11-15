"""Check of a pinned tool on every use: what is executed must be byte for byte from the archive in tools.lock.

The archive in .tools (npm `archive` or `.dl/<name from the url>`) must have the sha256 from tools.lock. For a binary
tool the archive `member` is compared with the installed file, for an npm package `package.json` and the file from its
`main` field, which node loads. A difference, an unpinned version or a missing archive is a MeasureError.
"""
from __future__ import annotations

import json
import tarfile
from functools import lru_cache
from pathlib import Path, PurePosixPath

from . import layout, standard
from .model import MeasureError, sha256, sha256_file

LOCK = layout.LOCK
FIX = "run standard install-tools"


def _member(archive: tarfile.TarFile, name: str) -> bytes:
    try:
        member = archive.getmember(name)
    except KeyError as exc:
        raise MeasureError(f"archive has no {name}") from exc
    data = archive.extractfile(member) if member.isfile() else None
    if data is None:
        raise MeasureError(f"{name} in the archive is not a regular file")
    return data.read()


def _pairs(tool: standard.Tool, archive: tarfile.TarFile, installed: Path) -> list[tuple[str, Path]]:
    if tool.kind != "npm":
        return [(tool.member, installed)]
    package = json.loads(_member(archive, "package/package.json"))
    if package.get("version") != tool.version:
        raise MeasureError(f"archive {tool.name} has version {package.get('version')}, tools.lock {tool.version}")
    main = PurePosixPath(package.get("main") or "index.js")
    if main.is_absolute() or ".." in main.parts:
        raise MeasureError(f"{tool.name}: field main leaves the package")
    return [("package/package.json", installed / "package.json"), (f"package/{main.as_posix()}", installed / main)]


@lru_cache(maxsize=16)
def verified(name: str, tools_root: Path) -> Path:
    """The installed tool `name` under `tools_root` (.tools) after the check against tools.lock; else MeasureError."""
    tools_root = Path(tools_root)
    lock = standard.load_lock(LOCK).tools
    if name not in lock:
        raise MeasureError(f"tool {name} is not in tools.lock")
    tool = lock[name]
    archive = tools_root / (tool.archive or f".dl/{PurePosixPath(tool.url).name}")
    installed = tools_root / tool.dest
    try:
        if sha256_file(archive) != tool.sha256:
            raise MeasureError(f"archive {archive.name} does not have the sha256 from tools.lock; {FIX}")
        with tarfile.open(archive, "r:gz") as tgz:
            for member, path in _pairs(tool, tgz, installed):
                if sha256(_member(tgz, member)) != sha256_file(path):
                    raise MeasureError(f"{tool.name}: {path.relative_to(tools_root)} is not from the pinned archive "
                                       f"{tool.version}; {FIX}")
    except (OSError, tarfile.TarError, ValueError) as exc:
        raise MeasureError(f"{tool.name} {tool.version} cannot be checked against tools.lock ({exc}); {FIX}") from exc
    return installed
