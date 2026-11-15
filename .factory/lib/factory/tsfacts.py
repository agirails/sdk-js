"""TypeScript/JavaScript facts from the only helper (ts_facts.cjs, pinned TypeScript): comments and AST.

The pinned TypeScript is verified against tools.lock (`pins`) before first use. All files the caller announces through
`prefetch` are measured by one node process; the result stays in memory per
(TypeScript, path, sha256 of the text), so the comment check and the function checks do not run the parser twice.
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
        raise MeasureError(f"TypeScript is not installed in {TYPESCRIPT.relative_to(TYPESCRIPT.parents[3])}; "
                           "run standard install-tools")
    if pins.verified("typescript", TYPESCRIPT.parents[2]) != TYPESCRIPT:
        raise MeasureError(f"TypeScript in {TYPESCRIPT} is not the path from tools.lock")
    node = shutil.which("node")
    if node is None:
        raise MeasureError("node is not on PATH, so the TS/JS checks cannot measure")
    return node


def _measure(node: str, files: list[tuple[str, str]]) -> list[dict]:
    payload = json.dumps({"files": [{"path": path, "text": text} for path, text in files]})
    try:
        proc = subprocess.run([node, str(HELPER), str(TYPESCRIPT)], input=payload, capture_output=True,
                              encoding="utf-8", env={}, cwd=str(layout.ROOT), timeout=TIMEOUT, check=False)
    except subprocess.TimeoutExpired as exc:
        raise MeasureError(f"ts_facts.cjs did not finish in {TIMEOUT} s") from exc
    except OSError as exc:
        raise MeasureError(f"ts_facts.cjs cannot be started: {exc.strerror}") from exc
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise MeasureError(f"ts_facts.cjs returned invalid output (exit {proc.returncode}): "
                           f"{(proc.stderr or proc.stdout)[-2000:]}") from exc
    found = result.get("files") if isinstance(result, dict) else None
    if proc.returncode != 0 or not result.get("ok") or not isinstance(found, list) or len(found) != len(files):
        error = str(result.get("error", "") if isinstance(result, dict) else "")[-2000:]
        raise MeasureError(f"ts_facts.cjs did not measure (exit {proc.returncode}): {error}")
    if not all(isinstance(item, dict) and set(FIELDS) <= set(item) for item in found):
        raise MeasureError("ts_facts.cjs returned a file without the expected fields")
    return found


def prefetch(files: Iterable[tuple[str, str]]) -> None:
    """Measure with one node process all (path, text) pairs not yet in memory."""
    node = _node()
    wanted = sorted({(path, text) for path, text in files if _key(path, text) not in _CACHE})
    if wanted:
        for (path, text), item in zip(wanted, _measure(node, wanted)):
            _CACHE[_key(path, text)] = json.dumps(item)


def file_facts(path: str, text: str) -> dict:
    """A fresh dict with the file's comments and AST facts; `error` is not None when the parser reports an error."""
    prefetch([(path, text)])
    return json.loads(_CACHE[_key(path, text)])


def facts(path: str, text: str) -> dict:
    """AST facts (functions, handlers, skips, assertions). A file the parser cannot read is a MeasureError."""
    data = file_facts(path, text)
    if data["error"]:
        raise MeasureError(f"TypeScript AST: {data['error']}")
    return data
