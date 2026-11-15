"""The only place that runs git on a repo we do not trust: nothing from the repo's configuration or attributes is
executed.

The git environment is empty except `ENV_KEYS`: no system or global configuration, HOME is /dev/null, and only the
local protocol is allowed. Attributes are read from the empty tree (`--attr-source`), so clean, smudge and process
filters, textconv and diff drivers from `.gitattributes` do not exist for git. The command line disables fsmonitor,
hooks, the pager, `core.sshCommand`, external diff, the editor, credential helpers and automatic gc. What the command
line cannot neutralise is refused before the first command: `include.path` and `includeIf` (the included file is not
visible to the check), a `core.worktree` that leads to a directory without `.git` (a working tree outside the repo; a
submodule stays allowed) and a non-empty `info/attributes` (it cannot be replaced by the empty tree).

The only thing taken from the host is the user's global ignore-pattern file (`$XDG_CONFIG_HOME/git/ignore`): it only
narrows the list of untracked files, which never enter a commit anyway.

From the caller's environment only `GIT_INDEX_FILE` passes, and only for commands that read the index
(`INDEX_READERS`). git sets it in pre-commit: `commit -a` prepares the commit in `.git/index.lock`, and a partial commit
(`git commit <path>`) in `.git/next-index-<pid>.lock`. Without it `code-check diff --staged` in the hook would read
`.git/index`, not what will be committed. The value must be a regular file inside that repo's git directory
(`--absolute-git-dir`); anything else is a GitError, not a silent fallback to `.git/index`.
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
    """git failed or the repo configuration was refused. Never a pass."""


@lru_cache(maxsize=1)
def executable() -> str:
    """Absolute path of git from the caller's PATH; a missing git or one older than 2.40 is a GitError."""
    found = shutil.which("git")
    if found is None:
        raise GitError("git is not installed")
    path = str(Path(found).resolve())
    proc = subprocess.run([path, "version"], capture_output=True, env=environment(path), timeout=TIMEOUT)
    match = re.search(rb"(\d+)\.(\d+)", proc.stdout)
    if proc.returncode or not match or (int(match.group(1)), int(match.group(2))) < MIN_VERSION:
        found_version = proc.stdout.decode(errors="replace").strip()
        raise GitError(f"git {found_version} has no --attr-source; git 2.40 or newer is required")
    return path


def environment(git_path: str | None = None) -> dict[str, str]:
    """The whole environment for git: nothing from the caller's environment except git's directory in PATH."""
    bin_dir = str(Path(git_path or executable()).parent)
    return {
        "PATH": os.pathsep.join(dict.fromkeys([bin_dir, *os.defpath.split(os.pathsep)])), "HOME": os.devnull,
        "LC_ALL": "C", "LANGUAGE": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_ATTR_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_NO_LAZY_FETCH": "1",
        "GIT_ALLOW_PROTOCOL": "file", "GIT_PROTOCOL_FROM_USER": "0",
    }


def user_excludes() -> Path | None:
    """The user's global ignore-pattern file (git's default XDG path), or None when there is none."""
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
        raise GitError(f"git {name} did not finish in {timeout} s") from exc
    except OSError as exc:
        raise GitError(f"git cannot be started: {exc.strerror}") from exc
    if ok is not None and proc.returncode not in ok:
        raise GitError(f"git {name} failed: {proc.stderr.decode(errors='replace').strip()}")
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
        raise GitError(f"{INDEX_FILE}={raw} is not a regular file inside the repo's git directory ({git_dir}) → "
                       f"run the check without {INDEX_FILE} or from that repo's hook")
    return {INDEX_FILE: str(real)}


def _attributes_refusal(path: Path) -> str | None:
    try:
        rows = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return None
    except OSError as exc:
        return f"{path.name} is not readable ({exc.strerror})"
    if any(row.strip() and not row.lstrip().startswith("#") for row in rows):
        return "the repo's info/attributes sets attributes the empty tree does not disable"
    return None


class Git:
    """git on one repo. The configuration is checked once, at creation; a refused one is a GitError."""

    def __init__(self, repo: Path):
        self.repo = Path(repo)
        self.base = [executable(), *_flags(), "-C", str(self.repo)]
        probe = _execute([*self.base, "rev-parse", "--is-inside-work-tree"], "rev-parse", ok=None)
        if probe.returncode and b"not a git repository" in probe.stderr:
            self.inside, self.object_format, self.prefix, self.index_env = False, None, self.base, {}
            return
        if probe.returncode:
            raise GitError(f"git rev-parse failed: {probe.stderr.decode(errors='replace').strip()}")
        self.inside = probe.stdout.strip() == b"true"
        keys = _config_keys(self._plain("config", "--list", "-z", "--no-includes"))
        refused = [key for key in keys if REFUSED_KEYS.match(key)]
        if "core.worktree" in keys and not self._own_worktree():
            refused.append("core.worktree")
        if refused:
            raise GitError(f"repo configuration contains {', '.join(refused)}, which cannot be neutralised → "
                           "remove it from .git/config or check a copy of the repo without it")
        self.object_format = self._plain("rev-parse", "--show-object-format").decode().strip()
        info = Path(self._plain("rev-parse", "--path-format=absolute", "--git-path", "info/attributes")
                    .decode("utf-8", "surrogateescape").strip())
        reason = _attributes_refusal(info)
        if reason:
            raise GitError(f"{reason} → empty {info.name} or check a copy of the repo without it")
        git_dir = Path(self._plain("rev-parse", "--absolute-git-dir").decode("utf-8", "surrogateescape").strip())
        self.index_env = _index_override(git_dir)
        self.prefix = [*self.base[:-2], f"--attr-source={self.empty_tree()}", *self.base[-2:]]

    def _own_worktree(self) -> bool:
        top = self._plain("rev-parse", "--show-toplevel").decode("utf-8", "surrogateescape").strip()
        return bool(top) and os.path.lexists(Path(top) / ".git")

    def _plain(self, *args: str) -> bytes:
        return _execute([*self.base, *args], args[0]).stdout

    def empty_tree(self) -> str:
        """Name of the empty tree in the repo's object format (sha1 or sha256)."""
        return hashlib.new(self.object_format, b"tree 0\0").hexdigest()

    def blob_id(self, data: bytes) -> str:
        """Name of the blob git would write for these bytes, without any conversion."""
        return hashlib.new(self.object_format, b"blob %d\0" % len(data) + data).hexdigest()

    def run(self, *args: str, ok: tuple[int, ...] = (0,), stdin: bytes | None = None,
            timeout: int = TIMEOUT) -> subprocess.CompletedProcess:
        """Run `git <args>` and return the output in bytes; an exit code outside `ok` is GitError with git's message."""
        if not args:
            raise GitError("no git command")
        extra = ["--no-ext-diff", "--no-textconv"] if args[0] in NO_EXTERNAL else []
        index = self.index_env if args[0] in INDEX_READERS else None
        return _execute([*self.prefix, args[0], *extra, *args[1:]], args[0], stdin, timeout, ok, index)

    def text(self, *args: str) -> str:
        """Command output as text without trailing whitespace."""
        return self.run(*args).stdout.decode("utf-8", "surrogateescape").strip()

