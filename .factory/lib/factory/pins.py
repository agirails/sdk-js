"""Provjera pinanog alata pri svakoj uporabi: ono što se izvršava mora biti bajt za bajt iz arhive iz tools.lock.

Arhiva u .tools (npm `archive` ili `.dl/<ime iz url-a>`) mora imati sha256 iz tools.lock. Za binarni alat se uspoređuje
`member` arhive s instaliranom datotekom, a za npm paket `package.json` i datoteka iz njegova polja `main`, koju node
učitava. Razlika, verzija koja nije pinana ili arhiva koja fali je MeasureError, pa provjera ne radi s krivim alatom.
"""
from __future__ import annotations

import json
import tarfile
from functools import lru_cache
from pathlib import Path, PurePosixPath

from . import layout, standard
from .model import MeasureError, sha256, sha256_file

LOCK = layout.LOCK
FIX = "pokreni standard install-tools"


def _member(archive: tarfile.TarFile, name: str) -> bytes:
    try:
        member = archive.getmember(name)
    except KeyError as exc:
        raise MeasureError(f"arhiva nema {name}") from exc
    data = archive.extractfile(member) if member.isfile() else None
    if data is None:
        raise MeasureError(f"{name} u arhivi nije obična datoteka")
    return data.read()


def _pairs(tool: standard.Tool, archive: tarfile.TarFile, installed: Path) -> list[tuple[str, Path]]:
    if tool.kind != "npm":
        return [(tool.member, installed)]
    package = json.loads(_member(archive, "package/package.json"))
    if package.get("version") != tool.version:
        raise MeasureError(f"arhiva {tool.name} nosi verziju {package.get('version')}, a tools.lock {tool.version}")
    main = PurePosixPath(package.get("main") or "index.js")
    if main.is_absolute() or ".." in main.parts:
        raise MeasureError(f"{tool.name}: polje main izlazi iz paketa")
    return [("package/package.json", installed / "package.json"), (f"package/{main.as_posix()}", installed / main)]


@lru_cache(maxsize=16)
def verified(name: str, tools_root: Path) -> Path:
    """Instalirani alat `name` ispod `tools_root` (.tools) nakon provjere prema tools.lock; inače MeasureError."""
    tools_root = Path(tools_root)
    lock = standard.load_lock(LOCK).tools
    if name not in lock:
        raise MeasureError(f"alat {name} nije u tools.lock")
    tool = lock[name]
    archive = tools_root / (tool.archive or f".dl/{PurePosixPath(tool.url).name}")
    installed = tools_root / tool.dest
    try:
        if sha256_file(archive) != tool.sha256:
            raise MeasureError(f"arhiva {archive.name} nema sha256 iz tools.lock; {FIX}")
        with tarfile.open(archive, "r:gz") as tgz:
            for member, path in _pairs(tool, tgz, installed):
                if sha256(_member(tgz, member)) != sha256_file(path):
                    raise MeasureError(f"{tool.name}: {path.relative_to(tools_root)} nije iz pinane arhive "
                                       f"{tool.version}; {FIX}")
    except (OSError, tarfile.TarError, ValueError) as exc:
        raise MeasureError(f"{tool.name} {tool.version} se ne može provjeriti prema tools.lock ({exc}); {FIX}") from exc
    return installed
