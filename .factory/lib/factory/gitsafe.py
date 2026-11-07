"""Jedino mjesto koje pokreće git nad repoom kojem ne vjerujemo: ništa iz konfiguracije ni atributa repoa se ne
izvršava.

Okolina gita je prazna osim `ENV_KEYS`: bez sistemske i globalne konfiguracije, HOME je /dev/null, a dopušten je samo
lokalni protokol. Atributi se čitaju iz praznog stabla (`--attr-source`), pa clean, smudge i process filteri, textconv
i diff driveri iz `.gitattributes` ne postoje za git. Naredbeni redak gasi fsmonitor, hookove, pager, `core.sshCommand`,
vanjski diff, editor, pomoćnike za vjerodajnice i automatski gc. Ono što se naredbenim retkom ne može neutralizirati se
odbija prije prve naredbe: `include.path` i `includeIf` (uključena datoteka nije vidljiva provjeri), `core.worktree`
koji vodi u direktorij bez `.git` (radno stablo izvan repoa; submodul ostaje dopušten) i neprazan `info/attributes`
(ne može se zamijeniti praznim stablom).

Jedina stvar s hosta je korisnikova datoteka globalnih ignore uzoraka (`$XDG_CONFIG_HOME/git/ignore`): ona samo sužava
popis nepraćenih datoteka, koje ionako ne ulaze u commit.

Iz okoline pozivatelja prolazi samo `GIT_INDEX_FILE`, i to samo za naredbe koje čitaju indeks (`INDEX_READERS`). git ga
postavlja u pre-commitu: `commit -a` pripremi commit u `.git/index.lock`, a djelomični commit (`git commit <putanja>`)
u `.git/next-index-<pid>.lock`. Bez njega bi `code-check diff --staged` u hooku čitao `.git/index`, a ne ono što će se
commitati. Vrijednost mora biti obična datoteka unutar git direktorija tog repoa (`--absolute-git-dir`); drugdje je
GitError, a ne tihi povratak na `.git/index`.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from .model import MeasureError

MIN_VERSION = (2, 40)
TIMEOUT = 120
OVERRIDES = (
    "core.fsmonitor=false", f"core.hooksPath={os.devnull}", f"core.attributesFile={os.devnull}", "core.pager=cat",
    "core.sshCommand=false", "core.askPass=false", "core.editor=false", "sequence.editor=false",
    "core.alternateRefsCommand=false", "credential.helper=", "diff.external=", "gc.auto=0", "maintenance.auto=false",
    "submodule.recurse=false", "diff.ignoreSubmodules=all", "status.submoduleSummary=false", "protocol.allow=never",
    "protocol.file.allow=always", "gpg.program=false", "gpg.ssh.program=false", "gpg.x509.program=false",
)
NO_EXTERNAL = frozenset({"diff", "log", "show"})
INDEX_READERS = frozenset({"diff", "ls-files", "status"})
INDEX_FILE = "GIT_INDEX_FILE"
REFUSED_KEYS = re.compile(r"^(?:include\.|includeif\.)")
ENV_KEYS = frozenset({
    "PATH", "HOME", "LC_ALL", "LANGUAGE", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL",
    "GIT_ATTR_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS", "GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH",
    "GIT_ALLOW_PROTOCOL", "GIT_PROTOCOL_FROM_USER", INDEX_FILE,
})


class GitError(MeasureError):
    """git nije uspio ili je konfiguracija repoa odbijena. Nikad prolaz."""


@lru_cache(maxsize=1)
def executable() -> str:
    """Apsolutna putanja gita iz PATH-a pozivatelja; git koji fali ili je stariji od 2.40 je GitError."""
    found = shutil.which("git")
    if found is None:
        raise GitError("git nije instaliran")
    path = str(Path(found).resolve())
    proc = subprocess.run([path, "version"], capture_output=True, env=environment(path), timeout=TIMEOUT)
    match = re.search(rb"(\d+)\.(\d+)", proc.stdout)
    if proc.returncode or not match or (int(match.group(1)), int(match.group(2))) < MIN_VERSION:
        found_version = proc.stdout.decode(errors="replace").strip()
        raise GitError(f"git {found_version} nema --attr-source; treba git 2.40 ili noviji")
    return path


def environment(git_path: str | None = None) -> dict[str, str]:
    """Cijela okolina za git: ništa iz okoline pozivatelja osim direktorija gita u PATH-u."""
    bin_dir = str(Path(git_path or executable()).parent)
    return {
        "PATH": os.pathsep.join(dict.fromkeys([bin_dir, *os.defpath.split(os.pathsep)])), "HOME": os.devnull,
        "LC_ALL": "C", "LANGUAGE": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_ATTR_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_NO_LAZY_FETCH": "1",
        "GIT_ALLOW_PROTOCOL": "file", "GIT_PROTOCOL_FROM_USER": "0",
    }


def user_excludes() -> Path | None:
    """Korisnikova datoteka globalnih ignore uzoraka (zadana XDG putanja gita) ili None kad je nema."""
    home = os.environ.get("HOME")
    base = os.environ.get("XDG_CONFIG_HOME") or (str(Path(home) / ".config") if home else None)
    candidate = Path(base) / "git" / "ignore" if base else None
    return candidate if candidate is not None and candidate.is_file() else None


def _flags() -> list[str]:
    excludes = user_excludes()
    pairs = [*OVERRIDES, *([f"core.excludesFile={excludes}"] if excludes else [])]
    return ["--no-pager", "--literal-pathspecs", *[arg for pair in pairs for arg in ("-c", pair)]]


def _execute(argv: list[str], name: str, stdin: bytes | None = None, timeout: int = TIMEOUT,
             ok: tuple[int, ...] | None = (0,), extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(argv, input=stdin, capture_output=True, env={**environment(), **(extra_env or {})},
                              timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {name} nije završio u {timeout} s") from exc
    except OSError as exc:
        raise GitError(f"git se ne može pokrenuti: {exc.strerror}") from exc
    if ok is not None and proc.returncode not in ok:
        raise GitError(f"git {name} nije uspio: {proc.stderr.decode(errors='replace').strip()}")
    return proc


def _config_keys(output: bytes) -> list[str]:
    names = {entry.split(b"\n", 1)[0] for entry in output.split(b"\0") if entry}
    return sorted(name.decode("utf-8", "replace").lower() for name in names)


def _index_override(git_dir: Path) -> dict[str, str]:
    raw = os.environ.get(INDEX_FILE)
    if not raw:
        return {}
    given = Path(os.path.abspath(raw))
    real = given.resolve()
    if given.is_symlink() or not real.is_file() or git_dir.resolve() not in real.parents:
        raise GitError(f"{INDEX_FILE}={raw} nije obična datoteka unutar git direktorija repoa ({git_dir}) → "
                       f"pokreni provjeru bez {INDEX_FILE} ili iz hooka tog repoa")
    return {INDEX_FILE: str(real)}


def _attributes_refusal(path: Path) -> str | None:
    try:
        rows = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return None
    except OSError as exc:
        return f"{path.name} nije čitljiv ({exc.strerror})"
    if any(row.strip() and not row.lstrip().startswith("#") for row in rows):
        return "info/attributes repoa postavlja atribute koje prazno stablo ne gasi"
    return None


class Git:
    """git nad jednim repoom. Konfiguracija se provjerava jednom, pri stvaranju; odbijena je GitError."""

    def __init__(self, repo: Path):
        self.repo = Path(repo)
        self.base = [executable(), *_flags(), "-C", str(self.repo)]
        probe = _execute([*self.base, "rev-parse", "--is-inside-work-tree"], "rev-parse", ok=None)
        if probe.returncode and b"not a git repository" in probe.stderr:
            self.inside, self.object_format, self.prefix, self.index_env = False, None, self.base, {}
            return
        if probe.returncode:
            raise GitError(f"git rev-parse nije uspio: {probe.stderr.decode(errors='replace').strip()}")
        self.inside = probe.stdout.strip() == b"true"
        keys = _config_keys(self._plain("config", "--list", "-z", "--no-includes"))
        refused = [key for key in keys if REFUSED_KEYS.match(key)]
        if "core.worktree" in keys and not self._own_worktree():
            refused.append("core.worktree")
        if refused:
            raise GitError(f"konfiguracija repoa sadrži {', '.join(refused)}, a to se ne može neutralizirati → "
                           "ukloni ga iz .git/config ili provjeri kopiju repoa bez njega")
        self.object_format = self._plain("rev-parse", "--show-object-format").decode().strip()
        info = Path(self._plain("rev-parse", "--path-format=absolute", "--git-path", "info/attributes")
                    .decode("utf-8", "surrogateescape").strip())
        reason = _attributes_refusal(info)
        if reason:
            raise GitError(f"{reason} → isprazni {info.name} ili provjeri kopiju repoa bez njega")
        git_dir = Path(self._plain("rev-parse", "--absolute-git-dir").decode("utf-8", "surrogateescape").strip())
        self.index_env = _index_override(git_dir)
        self.prefix = [*self.base[:-2], f"--attr-source={self.empty_tree()}", *self.base[-2:]]

    def _own_worktree(self) -> bool:
        top = self._plain("rev-parse", "--show-toplevel").decode("utf-8", "surrogateescape").strip()
        return bool(top) and os.path.lexists(Path(top) / ".git")

    def _plain(self, *args: str) -> bytes:
        return _execute([*self.base, *args], args[0]).stdout

    def empty_tree(self) -> str:
        """Ime praznog stabla u formatu objekata repoa (sha1 ili sha256)."""
        return hashlib.new(self.object_format, b"tree 0\0").hexdigest()

    def blob_id(self, data: bytes) -> str:
        """Ime bloba koji bi git zapisao za ove bajtove, bez ijedne pretvorbe."""
        return hashlib.new(self.object_format, b"blob %d\0" % len(data) + data).hexdigest()

    def run(self, *args: str, ok: tuple[int, ...] = (0,), stdin: bytes | None = None,
            timeout: int = TIMEOUT) -> subprocess.CompletedProcess:
        """Pokreni `git <args>` i vrati izlaz u bajtovima; izlazni kod izvan `ok` je GitError s porukom gita."""
        if not args:
            raise GitError("nema git naredbe")
        extra = ["--no-ext-diff", "--no-textconv"] if args[0] in NO_EXTERNAL else []
        index = self.index_env if args[0] in INDEX_READERS else None
        return _execute([*self.prefix, args[0], *extra, *args[1:]], args[0], stdin, timeout, ok, index)

    def text(self, *args: str) -> str:
        """Izlaz naredbe kao tekst bez završnog praznog prostora."""
        return self.run(*args).stdout.decode("utf-8", "surrogateescape").strip()

