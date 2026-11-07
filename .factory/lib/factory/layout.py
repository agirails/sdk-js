"""Factory layout: the root and the paths inside it. The only source of the root and the layout.

The root is the standard's source or the target repo's `.factory/`. `standard sync` copies files to the same paths, so
the copy in `.factory/` works as the source without any other path. Tools are in `.tools/` under the root, not copied.
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
    """Path relative to the root, in the form the copy in `.factory/` also uses."""
    return Path(path).relative_to(ROOT).as_posix()
