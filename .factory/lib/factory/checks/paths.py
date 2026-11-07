"""K9: lokalne putanje i imena interne infrastrukture u isporučenom kodu i dokumentaciji.

Popis internih imena je standard/configs/internal-names.txt. Redak je ime (`Moje Ime`) ili njegov otisak
`sha256:<hex>`; otisak je sha256 riječi imena malim slovima, odvojenih jednim razmakom. Kopija koja ide u javni repo
nosi samo otiske, pa sam popis ne otkriva imena. Ime se traži po riječima, pa `ime-x`, `ime_x` i `Ime X` su isto.
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
FIX_PATH = "izvedi putanju iz HOME, argumenta ili korijena repoa"
FIX_NAME = "ukloni ime ili premjesti sadržaj u privatni repo"


def digest(name: str) -> str:
    """Otisak imena za internal-names.txt: sha256 riječi malim slovima odvojenih razmakom."""
    return sha256(" ".join(word.lower() for word in WORD.findall(name)))


@lru_cache(maxsize=8)
def load_names(path: Path = NAMES_FILE) -> frozenset[str]:
    """Otisci internih imena; nečitljiv popis ili neispravan redak je MeasureError."""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise MeasureError(f"popis internih imena nije čitljiv ({Path(path).name}): {exc.strerror}") from exc
    out = set()
    for number, row in enumerate(raw.splitlines(), 1):
        entry = row.strip()
        if not entry or entry.startswith("#"):
            continue
        if entry.startswith("sha256:"):
            if not DIGEST.match(entry):
                raise MeasureError(f"{Path(path).name}:{number}: otisak mora biti sha256:<64 heksadecimalna znaka>")
            out.add(entry[len("sha256:"):])
            continue
        words = WORD.findall(entry)
        if not words or len(words) > MAX_WORDS:
            raise MeasureError(f"{Path(path).name}:{number}: ime mora imati od 1 do {MAX_WORDS} riječi")
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
    """K9 nalazi na novim redcima bilo koje tekstualne datoteke, i u stringovima, jer i oni izlaze iz repoa."""
    names = load_names(Path(names_file))
    out = []
    for number, row in enumerate(view.text.split("\n"), 1):
        if not view.is_new_line(number):
            continue
        for match in LOCAL_PATH.finditer(row):
            text = match.group()
            out.append(Finding("K9", view.path, number, f"lokalna putanja „{text}“ u isporučenom kodu", FIX_PATH,
                               f"{normalize(text)}: {normalize(row)}"))
        for text in _names_in(row, names):
            out.append(Finding("K9", view.path, number, f"ime interne infrastrukture „{text}“ u isporučenom kodu",
                               FIX_NAME, f"{normalize(text)}: {normalize(row)}"))
    return ordered(out)
