"""K9: local paths and internal infrastructure names in shipped code and documentation.

The list of internal names is standard/configs/internal-names.txt. A line is a name (`My Name`) or its fingerprint
`sha256:<hex>`; the fingerprint is the sha256 of the name's lowercase words, separated by one space. The public copy
carries only fingerprints, so the list does not reveal names. Names match by words: `name-x`, `name_x`, `Name X` match.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from .. import layout
from ..model import FileView, Finding, MeasureError, normalize, ordered, sha256

NAMES_FILE = layout.NAMES
MAX_WORDS = 4
WORD = re.compile(r"[A-Za-z0-9]+")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
PLACEHOLDER_USERS = ("user", "username", "runner")
PLACEHOLDER = "|".join(PLACEHOLDER_USERS)
UNIX_USER = rf"(?!(?:{PLACEHOLDER})(?![\w.-]))[A-Za-z0-9._-]+(?![\w.-])"
WIN_USER = rf"(?!(?:{PLACEHOLDER})(?![^\\/\s\"'`]))[^\\/\s\"'`]+"
WIN_SEP = r"(?:\\\\|\\|/)"
SEP = r"[\\/]"
SEGMENT = r"[^\\/\s\"'`]+"
ROOT_PREFIX = (rf"file://(?:localhost)?|vscode://file|/mnt/[A-Za-z](?={SEP})|/[A-Za-z](?=/(?i:users)/)"
               rf"|/Volumes/{SEGMENT}|{SEP}{{2}}wsl(?:\$|\.localhost){SEP}{SEGMENT}")
LOCAL_PATH = re.compile(
    rf"\b[A-Za-z]:{WIN_SEP}(?i:users){WIN_SEP}{WIN_USER}"
    rf"|(?<![\w.~/\\-])(?:{ROOT_PREFIX})?(?:{SEP}(?i:home|users|var{SEP}home){SEP}{UNIX_USER}|/root/[\w.-])")
FIX_PATH = "derive the path from HOME, an argument or the repo root"
FIX_NAME = "remove the name or move the content to a private repo"


def digest(name: str) -> str:
    """Fingerprint of a name for internal-names.txt: sha256 of its lowercase words joined by one space."""
    return sha256(" ".join(word.lower() for word in WORD.findall(name)))


@lru_cache(maxsize=8)
def load_names(path: Path = NAMES_FILE) -> frozenset[str]:
    """Fingerprints of internal names; an unreadable list or an invalid line is a MeasureError."""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise MeasureError(f"list of internal names is not readable ({Path(path).name}): {exc.strerror}") from exc
    out = set()
    for number, row in enumerate(raw.splitlines(), 1):
        entry = row.strip()
        if not entry or entry.startswith("#"):
            continue
        if entry.startswith("sha256:"):
            if not DIGEST.match(entry):
                raise MeasureError(f"{Path(path).name}:{number}: fingerprint must be sha256:<64 hex characters>")
            out.add(entry[len("sha256:"):])
            continue
        words = WORD.findall(entry)
        if not words or len(words) > MAX_WORDS:
            raise MeasureError(f"{Path(path).name}:{number}: a name must have 1 to {MAX_WORDS} words")
        out.add(digest(entry))
    return frozenset(out)


def _names_in(row: str, names: frozenset[str]) -> list[str]:
    words = list(WORD.finditer(row))
    hits = []
    for first in range(len(words)):
        for size in range(1, MAX_WORDS + 1):
            group = words[first:first + size]
            if len(group) < size:
                break
            joined = " ".join(match.group().lower() for match in group)
            if sha256(joined) in names:
                hits.append(row[group[0].start():group[-1].end()])
    return hits


def check(view: FileView, names_file: Path = NAMES_FILE) -> list[Finding]:
    """K9 findings on new lines of any text file, strings included, because they also leave the repo."""
    names = load_names(Path(names_file))
    out = []
    for number, row in enumerate(view.text.split("\n"), 1):
        if not view.is_new_line(number):
            continue
        for match in LOCAL_PATH.finditer(row):
            text = match.group()
            out.append(Finding("K9", view.path, number, f"local path '{text}' in shipped code", FIX_PATH,
                               f"{normalize(text)}: {normalize(row)}"))
        for text in _names_in(row, names):
            out.append(Finding("K9", view.path, number, f"internal infrastructure name '{text}' in shipped code",
                               FIX_NAME, f"{normalize(text)}: {normalize(row)}"))
    return ordered(out)
