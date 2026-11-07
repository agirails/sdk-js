"""Raspored tvornice: korijen i putanje unutar njega. Jedini izvor korijena i rasporeda.

Korijen je izvor standarda ili `.factory/` ciljnog repoa. `standard sync` kopira datoteke na iste relativne putanje, pa kopija
u `.factory/` radi kao izvor bez ijedne druge putanje. Alati su u `.tools/` ispod korijena i ne kopiraju se.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "lib"
PACKAGE = LIB / "factory"
STANDARD = ROOT / "standard"
RULES = STANDARD / "rules.toml"
REPOS = STANDARD / "repos"
CONFIGS = STANDARD / "configs"
LOCK = STANDARD / "tools.lock"
NAMES = CONFIGS / "internal-names.txt"
DENY = CONFIGS / "sandbox-deny.txt"
RULE_CLASSES = CONFIGS / "rule-classes.toml"
TOOLS = ROOT / ".tools"
TOOL_BIN = TOOLS / "bin"
CODE_CHECK = ROOT / "bin" / "code-check"
STANDARD_BIN = ROOT / "bin" / "standard"
SYNC_DIR = ".factory"


def rel(path: Path) -> str:
    """Putanja relativna prema korijenu, u obliku koji koristi i kopija u `.factory/`."""
    return Path(path).relative_to(ROOT).as_posix()
