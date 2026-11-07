"""Zajednički tipovi za code-check: nalaz, pogled na datoteku i jezik po putanji."""
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
    """Provjera nije mogla izmjeriti (alat fali, parser pao). Vodi na exit 2, nikad na prolaz."""


def sha256(data: bytes | str) -> str:
    """sha256 bajtova ili teksta (UTF-8, surogati prolaze) kao heksadecimalni zapis. Jedini sha256 u tvornici."""
    raw = data.encode("utf-8", "surrogatepass") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: str | Path) -> str:
    """sha256 sadržaja datoteke, čitane u blokovima od 1 MiB."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class Finding:
    """Jedno kršenje. `key_text` je normalizirani tekst po kojem se nalaz uparuje s bazom i baselineom; izvan procesa
    ide samo njegov otisak (`key()`, `public()`), jer redak može nositi tajnu."""
    rule: str
    path: str
    line: int
    message: str
    fix: str
    key_text: str
    severity: str = "error"

    def render(self) -> str:
        prefix = "" if self.severity == "error" else "upozorenje "
        return f"{prefix}{self.rule} {self.path}:{self.line} {self.message} → {self.fix}"

    def key(self) -> tuple[str, str, str]:
        return (self.rule, self.path, sha256(self.key_text))

    def public(self) -> dict:
        """Nalaz za izvještaj: sve što poruka namjerno prikazuje i otisak ključa umjesto izvornog teksta."""
        return {"rule": self.rule, "path": self.path, "line": self.line, "message": self.message, "fix": self.fix,
                "severity": self.severity, "key": sha256(self.key_text)}


def ordered(findings: Iterable[Finding]) -> list[Finding]:
    """Jedini poredak nalaza: putanja, redak, pravilo, ključ, poruka. Isti ulaz daje isti izlaz."""
    return sorted(findings, key=lambda f: (f.path, f.line, f.rule, f.key_text, f.message))


@dataclass
class FileView:
    """Datoteka koju provjera gleda. `added` su redci koji su novi ili promijenjeni; None znači cijela datoteka.

    `raw` su izvorni bajtovi kad `text` nije točno sadržaj datoteke (preskočena ili čitana sa zamjenskim znakovima).
    `base` je ista datoteka u bazi, kao pogled bez `added`; None kad je datoteka nova ili nema baze.
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
        """Provjera javlja i nalaze izvan novih redaka: kad se gleda cijela datoteka, i kad datoteka ima bazu, jer tada
        codecheck nalaze uparuje s bazom, pa se vidi i kršenje nastalo brisanjem."""
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
    """Broj s imenicom u hrvatskom obliku za 1, 2-4 i 5+ (1 datoteka, 2 datoteke, 5 datoteka)."""
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} {one}"
    return f"{n} {few if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else many}"


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def line_count(text: str) -> int:
    """Broj redaka kao u editoru: zadnji redak bez znaka novog retka se broji."""
    return text.count("\n") + (0 if text == "" or text.endswith("\n") else 1)
