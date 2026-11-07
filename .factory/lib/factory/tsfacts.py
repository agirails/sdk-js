"""TypeScript/JavaScript činjenice iz jedinog pomoćnika (ts_facts.cjs, pinani TypeScript): komentari i AST.

Pinani TypeScript se prije prve uporabe provjerava prema tools.lock (`pins`). Sve datoteke koje pozivatelj najavi kroz
`prefetch` mjere se jednim node procesom; rezultat ostaje u memoriji po
(TypeScript, putanja, sha256 teksta), pa provjera komentara i provjere funkcija ne pokreću parser dvaput.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from typing import Iterable

from . import layout, pins
from .model import MeasureError, sha256

TYPESCRIPT = layout.TOOLS / "node" / "node_modules" / "typescript"
HELPER = layout.PACKAGE / "ts_facts.cjs"
TIMEOUT = 600
FIELDS = ("comments", "uncertain", "error", "functions", "handlers", "skips", "assertions")
_CACHE: dict[tuple[str, str, str], str] = {}


def _key(path: str, text: str) -> tuple[str, str, str]:
    return (str(TYPESCRIPT), path, sha256(text))


def _node() -> str:
    if not (TYPESCRIPT / "package.json").is_file():
        raise MeasureError(f"TypeScript nije instaliran u {TYPESCRIPT.relative_to(TYPESCRIPT.parents[3])}; "
                           "pokreni standard install-tools")
    if pins.verified("typescript", TYPESCRIPT.parents[2]) != TYPESCRIPT:
        raise MeasureError(f"TypeScript u {TYPESCRIPT} nije putanja iz tools.lock")
    node = shutil.which("node")
    if node is None:
        raise MeasureError("node nije na PATH-u, pa TS/JS provjere ne mogu izmjeriti")
    return node


def _measure(node: str, files: list[tuple[str, str]]) -> list[dict]:
    payload = json.dumps({"files": [{"path": path, "text": text} for path, text in files]})
    try:
        proc = subprocess.run([node, str(HELPER), str(TYPESCRIPT)], input=payload, capture_output=True,
                              encoding="utf-8", env={}, cwd=str(layout.ROOT), timeout=TIMEOUT, check=False)
    except subprocess.TimeoutExpired as exc:
        raise MeasureError(f"ts_facts.cjs nije završio u {TIMEOUT} s") from exc
    except OSError as exc:
        raise MeasureError(f"ts_facts.cjs se ne može pokrenuti: {exc.strerror}") from exc
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise MeasureError(f"ts_facts.cjs je vratio neispravan izlaz (exit {proc.returncode}): "
                           f"{(proc.stderr or proc.stdout)[-2000:]}") from exc
    found = result.get("files") if isinstance(result, dict) else None
    if proc.returncode != 0 or not result.get("ok") or not isinstance(found, list) or len(found) != len(files):
        error = str(result.get("error", "") if isinstance(result, dict) else "")[-2000:]
        raise MeasureError(f"ts_facts.cjs nije izmjerio (exit {proc.returncode}): {error}")
    if not all(isinstance(item, dict) and set(FIELDS) <= set(item) for item in found):
        raise MeasureError("ts_facts.cjs je vratio datoteku bez očekivanih polja")
    return found


def prefetch(files: Iterable[tuple[str, str]]) -> None:
    """Izmjeri jednim node procesom sve (putanja, tekst) parove kojih još nema u memoriji."""
    node = _node()
    wanted = sorted({(path, text) for path, text in files if _key(path, text) not in _CACHE})
    if wanted:
        for (path, text), item in zip(wanted, _measure(node, wanted)):
            _CACHE[_key(path, text)] = json.dumps(item)


def file_facts(path: str, text: str) -> dict:
    """Svjež rječnik s komentarima i AST činjenicama datoteke; `error` nije None kad parser javi grešku."""
    prefetch([(path, text)])
    return json.loads(_CACHE[_key(path, text)])


def facts(path: str, text: str) -> dict:
    """AST činjenice (functions, handlers, skips, assertions). Datoteka koju parser ne pročita je MeasureError."""
    data = file_facts(path, text)
    if data["error"]:
        raise MeasureError(f"TypeScript AST: {data['error']}")
    return data
