"""Shared types for code-check: finding, file view and language by path."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

LANGS = {
    ".py": "py",
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".cjs": "ts",
    ".sol": "sol",
    ".sh": "sh", ".bash": "sh",
    ".zsh": "sh", ".ksh": "sh",
    ".md": "md", ".mdx": "md",
    ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".mk": "make",
}
NAMES = {"Makefile": "make", "makefile": "make", "GNUmakefile": "make"}
SHEBANG = re.compile(r"^#!\S*(?:/env\s+)?(?:\S*/)?(python3?|bash|sh|zsh|ksh|dash|node)\b")
SHEBANG_LANGS = {"python": "py", "python3": "py", "bash": "sh", "sh": "sh", "zsh": "sh", "ksh": "sh", "dash": "sh",
                 "node": "ts"}


class MeasureError(Exception):
    """The check could not measure (tool missing, parser failed). Leads to exit 2, never to a pass."""


def sha256(data: bytes | str) -> str:
    """sha256 of bytes or text (UTF-8, surrogates pass) as hex. The only sha256 in the factory."""
    raw = data.encode("utf-8", "surrogatepass") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: str | Path) -> str:
    """sha256 of a file's content, read in 1 MiB blocks."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class Finding:
    """One violation. `key_text` is the normalised text by which the finding is matched with the base and the baseline;
    only its fingerprint leaves the process (`key()`, `public()`), because the line may carry a secret."""
    rule: str
    path: str
    line: int
    message: str
    fix: str
    key_text: str
    severity: str = "error"

    def render(self) -> str:
        prefix = "" if self.severity == "error" else "warning "
        return f"{prefix}{self.rule} {self.path}:{self.line} {self.message} → {self.fix}"

    def key(self) -> tuple[str, str, str]:
        return (self.rule, self.path, sha256(self.key_text))

    def public(self) -> dict:
        """Finding for the report: all the message shows on purpose, and the key fingerprint instead of the text."""
        return {"rule": self.rule, "path": self.path, "line": self.line, "message": self.message, "fix": self.fix,
                "severity": self.severity, "key": sha256(self.key_text)}


def ordered(findings: Iterable[Finding]) -> list[Finding]:
    """The only order of findings: path, line, rule, key, message. The same input gives the same output."""
    return sorted(findings, key=lambda f: (f.path, f.line, f.rule, f.key_text, f.message))


@dataclass
class FileView:
    """A file the check looks at. `added` are lines that are new or changed; None means the whole file.

    `raw` are the source bytes when `text` is not exactly the file content (skipped, or read with replacement chars).
    `base` is the same file in the base, as a view without `added`; None when the file is new or there is no base.
    """
    path: str
    text: str
    lang: str | None
    added: set[int] | None = None
    old_text: str | None = None
    meta: dict = field(default_factory=dict)
    raw: bytes | None = field(default=None, repr=False)
    base: FileView | None = field(default=None, repr=False)

    def is_new_line(self, line: int) -> bool:
        return self.added is None or line in self.added

    def reports_all(self) -> bool:
        """The check also reports findings outside new lines: when the whole file is checked, and when the file has a
        base, because codecheck then matches findings with the base, so a violation caused by a deletion shows."""
        return self.added is None or self.base is not None


def lang_of(path: str | Path, text: str = "") -> str | None:
    suffix = Path(path).suffix.lower()
    if suffix in LANGS:
        return LANGS[suffix]
    if Path(path).name in NAMES:
        return NAMES[Path(path).name]
    match = SHEBANG.match(text.split("\n", 1)[0])
    return SHEBANG_LANGS[match.group(1)] if match else None


def plural(n: int, one: str, few: str, many: str) -> str:
    """Number with a noun in English form: `one` for 1, `many` otherwise (1 file, 2 files, 21 files). `few` stays in
    the signature for callers and is not used."""
    del few
    return f"{n} {one if n == 1 else many}"


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def line_count(text: str) -> int:
    """Line count as in an editor: a last line without a newline character is counted."""
    return text.count("\n") + (0 if text == "" or text.endswith("\n") else 1)
