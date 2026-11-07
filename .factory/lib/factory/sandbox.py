"""Running repo code under bwrap: empty environment, only the given paths, no network, with limits (S7).

Inside, only /usr is visible, root symlinks as on the host, a generated /etc/passwd and /etc/group, ld.so.cache
(the dynamic linker finds libraries from ld.so.conf.d through it), a new /proc and a minimal /dev, one private tmpfs
of size `tmp_mb` for HOME and /tmp, and the paths the caller names explicitly. A seccomp filter refuses keyctl, add_key
and request_key, so code does not reach the host keyring. Mounting is refused for the root, home, system and shared
temporary trees, hidden entries at the home root except toolchains, private trees and names from
standard/configs/sandbox-deny.txt (names apply at any depth), and any tree that contains a socket. Output is read while
the command runs, but at most `max_output` bytes per stream are kept and returned only after completion.

Git metadata: a writable path that is inside `.git` or is a symlink to `.git` is always refused. A writable path that
contains `.git` is refused unless the caller sets `git_ro`: then every `.git` in it is mounted read-only over the
writable directory, so a hook or `core.fsmonitor` written from inside does not reach the host, while git still reads
history. A `.git` that the code creates while running stays there, so the writable tree is untrusted after exit: the
host does not run git in it and takes artifacts through `copy_out`.

Limits that exist: `mem_mb` private memory per process in the heap and private writable mappings
(RLIMIT_DATA), `vm_mb` address space per process (RLIMIT_AS, includes reservations without memory, the stack and shared
mappings), `nproc` number of
processes (RLIMIT_NPROC), CPU time per process and total sandbox time (`timeout`), `fsize_mb` size of one
file, core dump 0 (soft and hard, cannot be raised), `tmp_mb` one tmpfs for HOME and /tmp (uses RAM) and `max_output`
per stream. All limits are set as soft and hard, so a process inside cannot raise them.

Why two memory limits: the pinned gitleaks (go-re2 on wazero) reserves about 5.4 GB of address space with PROT_NONE,
but uses about 0.15 GB (measured 2026-11-06 on a fixture and on a pilot repo: VmPeak 5321 and 5386 MB, VmData 110 and
156 MB, VmHWM 74 and 121 MB). Under an RLIMIT_AS of 4 GB it fails at startup. The reservation does not count toward
RLIMIT_DATA, so `mem_mb` stops a process whose heap grows, and `vm_mb` is the upper memory bound of one process. The
default is `VM_MB` (4 GB) for everything; only a call that runs code-check with gitleaks in the sandbox asks for
`GITLEAKS_VM_MB` (8 GB), so the higher limit applies to that call and not to repro or other repo code (decision
2026-11-06: gitleaks gets its own limit). RLIMIT_DATA does not count the stack or shared mappings: the main stack, a
MAP_GROWSDOWN mapping and a stack extended through mremap grow up to `vm_mb` (measured 2026-11-06: 1.5 GB touched
through MAP_GROWSDOWN and through stack mremap under `mem_mb` 512), as do shared anonymous mappings. Known limit: the
total memory of all processes (up to `nproc` × `vm_mb`) and total writes to writable paths are not limited, because
that would need a cgroup over the user systemd bus, which this module does not assume.
"""
from __future__ import annotations

import json, os, platform, pwd, re, shutil, signal, stat, struct, subprocess, tempfile, threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from . import layout
from .model import MeasureError, sha256

BWRAP = "/usr/bin/bwrap"
PRLIMIT = "/usr/bin/prlimit"
VM_MB = 4096
GITLEAKS_VM_MB = 8192
SANDBOX_HOME = "/sandbox/home"
SYSTEM_PATH = ("/usr/local/bin", "/usr/bin")
ROOT_LINKS = ("/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32")
LOADER_CACHE = "/etc/ld.so.cache"
FORBIDDEN_TREES = ("/boot", "/dev", "/etc", "/proc", "/root", "/run", "/sys", "/var/run", "/var/lib", "/var/log")
SHARED_TEMP = ("/tmp", "/var/tmp", "/dev/shm")
TOOLCHAINS = (".local/share/mise/installs", ".foundry/bin")
DENY_FILE = layout.DENY
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
NAME_PREFIX = "name:"
GIT_DIR = ".git"
ARTIFACT_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}")
SCRATCH = "/sandbox"
DRAIN_GRACE = 10
SYSCALLS = {"x86_64": (0xC000003E, (250, 248, 249)), "aarch64": (0xC00000B7, (219, 217, 218))}
X32_BIT = 0x40000000
SECCOMP_ALLOW, SECCOMP_EPERM, SECCOMP_KILL = 0x7FFF0000, 0x00050001, 0x80000000
SECCOMP_NR, SECCOMP_ARCH = 0, 4
BPF_LOAD, BPF_JEQ, BPF_JGE, BPF_RET = 0x20, 0x15, 0x35, 0x06
TIMEOUT_EXIT = 124
FAILURE_EXIT = 125
TRUNCATED = "\n[sandbox-run: output truncated to {n} bytes]\n"


class SandboxError(MeasureError):
    """The sandbox was not set up or refused a mount, so the command did not run. Never a pass."""


@dataclass(frozen=True)
class Result:
    """Outcome of the command. `exit_code` is the command's exit code, or TIMEOUT_EXIT when it timed out."""
    exit_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool
    truncated: bool


def protected_homes() -> list[Path]:
    """Home from passwd and from the HOME variable: neither, their ancestors nor the credentials in them are mounted."""
    homes = [Path(pwd.getpwuid(os.getuid()).pw_dir)]
    if os.environ.get("HOME"):
        homes.append(Path(os.environ["HOME"]))
    return sorted({h.resolve() for h in homes})


def deny_digest(rel: str) -> str:
    """Fingerprint for sandbox-deny.txt: sha256 of a path relative to home, e.g. `project/.private`."""
    return sha256(rel)


def _parse_deny_row(entry: str, where: str) -> tuple[str, str]:
    kind, _, value = entry.partition(":") if entry.startswith(NAME_PREFIX) else ("path", "", entry)
    if DIGEST.match(value):
        return kind, value[len("sha256:"):]
    if kind == "name" and value and "/" not in value and not value.startswith("sha256:"):
        return kind, deny_digest(value)
    if kind == "path" and not value.startswith(("sha256:", "/")) and ".." not in value.split("/"):
        return kind, deny_digest(value.strip("/"))
    raise SandboxError(f"{where}: a line must be sha256:<hex>, a path relative to home or name:<name>")


@lru_cache(maxsize=4)
def _deny_list(path: Path) -> dict[str, frozenset[str]]:
    try:
        rows = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise SandboxError(f"list of denied trees is not readable ({Path(path).name}): {exc.strerror}") from exc
    out: dict[str, set[str]] = {"path": set(), "name": set()}
    for number, row in enumerate(rows, 1):
        entry = row.strip()
        if entry and not entry.startswith("#"):
            kind, digest = _parse_deny_row(entry, f"{Path(path).name}:{number}")
            out[kind].add(digest)
    return {kind: frozenset(values) for kind, values in out.items()}


def denied_digests() -> frozenset[str]:
    """Fingerprints of private trees under home that are never mounted, neither they nor their ancestors."""
    return _deny_list(DENY_FILE)["path"]


def denied_names() -> frozenset[str]:
    """Fingerprints of names (`name:` lines) never mounted at any depth, nor the trees that contain them."""
    return _deny_list(DENY_FILE)["name"]


def _home_refusal(path: Path, home: Path) -> str | None:
    if path == home or path in home.parents:
        return "mounts the whole home"
    if home not in path.parents:
        return None
    rel = path.relative_to(home).as_posix()
    if rel.startswith(".") and not any(rel == t or rel.startswith(t + "/") for t in TOOLCHAINS):
        return "is a hidden entry at the home root (credentials, history or settings)"
    parts = rel.split("/")
    if any(deny_digest("/".join(parts[:i])) in denied_digests() for i in range(1, len(parts) + 1)):
        return "is a private tree from sandbox-deny.txt"
    return None


def _denied_name(path: Path) -> bool:
    return any(deny_digest(part) in denied_names() for part in path.parts)


def _refusal(path: Path, homes: list[Path]) -> str | None:
    if path == Path("/"):
        return "mounts the whole root"
    if _denied_name(path):
        return "is a private tree from sandbox-deny.txt"
    for tree in (*FORBIDDEN_TREES, *SHARED_TEMP):
        if path == Path(tree) or path in Path(tree).parents:
            return f"mounts {tree}"
        if Path(tree) in path.parents and tree in FORBIDDEN_TREES:
            return f"is inside {tree}"
    for home in homes:
        reason = _home_refusal(path, home)
        if reason:
            return reason
    return None


def _denied_entry(path: Path, homes: list[Path]) -> bool:
    if deny_digest(path.name) in denied_names():
        return True
    return any(home in path.parents and deny_digest(path.relative_to(home).as_posix()) in denied_digests()
               for home in homes)


def _tree_scan(root: Path, homes: list[Path]) -> tuple[str | None, list[Path]]:
    stack, gits = [root], []
    while stack:
        current = stack.pop()
        try:
            info = current.lstat()
        except OSError as exc:
            return f"is not readable ({exc.strerror}: {current})", gits
        if stat.S_ISSOCK(info.st_mode):
            return f"contains socket {current}", gits
        if current != root and _denied_entry(current, homes):
            return f"contains private tree {current} from sandbox-deny.txt", gits
        if current.name == GIT_DIR:
            gits.append(current)
        if stat.S_ISDIR(info.st_mode):
            try:
                stack.extend(sorted(Path(entry.path) for entry in os.scandir(current)))
            except OSError as exc:
                return f"is not readable ({exc.strerror}: {current})", gits
    return None, sorted(gits)


def _checked(raw: str, homes: list[Path]) -> tuple[Path, list[Path]]:
    given = Path(raw)
    if not given.is_absolute():
        raise SandboxError(f"path is not absolute: {raw}")
    real = given.resolve()
    for candidate in (Path(os.path.normpath(given)), real):
        reason = _refusal(candidate, homes)
        if reason:
            raise SandboxError(f"refused mount {raw}: {reason}")
    if not real.exists():
        raise SandboxError(f"path does not exist: {raw}")
    reason, gits = _tree_scan(real, homes)
    if reason:
        raise SandboxError(f"refused mount {raw}: {reason}")
    return real, gits


def _writable(raw: str, homes: list[Path], git_ro: bool) -> tuple[Path, list[Path]]:
    real, gits = _checked(raw, homes)
    if GIT_DIR in Path(os.path.normpath(raw)).parts or GIT_DIR in real.parts:
        raise SandboxError(f"refused write to {raw}: the path is inside git metadata ({GIT_DIR})")
    links = [git for git in gits if git.is_symlink()]
    if links:
        raise SandboxError(f"refused write to {raw}: {links[0]} is a symlink {GIT_DIR}")
    if gits and not git_ro:
        raise SandboxError(f"refused write to {raw}: it contains {gits[0]}, and a hook or core.fsmonitor written "
                           f"from inside would run on the host; mount {GIT_DIR} read-only (git_ro, --git-ro)")
    return real, gits


def _binds(ro: list[Path], rw: list[Path], tools: list[Path], gits: list[Path]) -> list[str]:
    flags: dict[Path, str] = {}
    for paths, flag in ((ro, "--ro-bind"), (tools, "--ro-bind"), (gits, "--ro-bind"), (rw, "--bind")):
        for path in paths:
            if flags.setdefault(path, flag) != flag:
                raise SandboxError(f"path is given both for reading and for writing: {path}")
    args: list[str] = []
    for path in sorted(flags, key=lambda p: (len(p.parts), str(p))):
        args += [flags[path], str(path), str(path)]
    return args


def _search_path(tools: list[Path]) -> list[str]:
    dirs = []
    for tool in tools:
        if tool.is_dir():
            dirs.append(str(tool / "bin") if (tool / "bin").is_dir() else str(tool))
        else:
            dirs.append(str(tool.parent))
    return list(dict.fromkeys([*dirs, *SYSTEM_PATH]))


def _command_visible(cmd0: str, search: list[str], roots: list[Path], chdir: str) -> None:
    if "/" in cmd0:
        candidates = [Path(chdir) / cmd0]
    else:
        candidates = [Path(d) / cmd0 for d in search]
    for candidate in candidates:
        real = candidate.resolve()
        inside = any(real == r or r in real.parents for r in roots)
        if inside and real.is_file() and os.access(real, os.X_OK):
            return
    raise SandboxError(f"command is not available in the sandbox: {cmd0}")


def _data_fd(name: str, data: bytes) -> int:
    fd = os.memfd_create(name)
    os.write(fd, data)
    os.lseek(fd, 0, os.SEEK_SET)
    return fd


def seccomp_program(machine: str | None = None) -> bytes:
    """Classic BPF for `bwrap --seccomp`: keyctl, add_key, request_key get EPERM; another arch kills the process."""
    machine = machine or platform.machine()
    if machine not in SYSCALLS:
        raise SandboxError(f"seccomp filter is not defined for architecture {machine}")
    arch, calls = SYSCALLS[machine]
    jumps = ([(BPF_JGE, X32_BIT)] if machine == "x86_64" else []) + [(BPF_JEQ, nr) for nr in calls]
    deny = 3 + len(jumps) + 1
    ops = [(BPF_LOAD, 0, 0, SECCOMP_ARCH), (BPF_JEQ, 0, deny - 1, arch), (BPF_LOAD, 0, 0, SECCOMP_NR)]
    ops += [(code, deny - (3 + i) - 1, 0, value) for i, (code, value) in enumerate(jumps)]
    ops += [(BPF_RET, 0, 0, SECCOMP_ALLOW), (BPF_RET, 0, 0, SECCOMP_EPERM), (BPF_RET, 0, 0, SECCOMP_KILL)]
    return b"".join(struct.pack("=HBBI", *op) for op in ops)


def _keep(chunks: list[bytes], chunk: bytes, cap: int) -> None:
    kept = sum(len(c) for c in chunks)
    if kept <= cap:
        chunks.append(chunk[:cap + 1 - kept])


def _drain(fd: int, cap: int, chunks: list[bytes]) -> None:
    with os.fdopen(fd, "rb", buffering=0) as stream:
        while chunk := stream.read(65536):
            _keep(chunks, chunk, cap)


def _capped(chunks: list[bytes], cap: int) -> tuple[bytes, bool]:
    data = b"".join(chunks)
    if len(data) <= cap:
        return data, False
    return data[:cap] + TRUNCATED.format(n=cap).encode(), True


def printable(data: bytes) -> bytes:
    """Output for a terminal: control characters except LF and TAB (ESC, BEL, CR, C1) become visible `\\xHH`."""
    text = data.decode("utf-8", "backslashreplace")
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", lambda m: f"\\x{ord(m.group()):02x}", text).encode("utf-8")


def _exit_code(status: bytes) -> int | None:
    codes = []
    for line in status.decode().splitlines():
        if line.strip():
            try:
                codes.append(json.loads(line).get("exit-code"))
            except json.JSONDecodeError as exc:
                raise SandboxError(f"bwrap returned an unreadable status: {line[:200]}") from exc
    found = [c for c in codes if c is not None]
    return found[-1] if found else None


def _read_all(fd: int) -> bytes:
    chunks = []
    while chunk := os.read(fd, 65536):
        chunks.append(chunk)
    os.close(fd)
    return b"".join(chunks)


def _argv(search: list[str], status_w: int, seccomp: int, passwd: int, group: int, tmp_mb: int) -> list[str]:
    argv = [BWRAP, "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session",
            "--clearenv", "--setenv", "PATH", ":".join(search), "--setenv", "LANG", "C.UTF-8",
            "--setenv", "HOME", SANDBOX_HOME, "--setenv", "TMPDIR", "/tmp", "--json-status-fd", str(status_w),
            "--seccomp", str(seccomp), "--ro-bind", "/usr", "/usr"]
    for link in ROOT_LINKS:
        if os.path.islink(link):
            argv += ["--symlink", os.readlink(link), link]
        elif os.path.isdir(link):
            argv += ["--ro-bind", link, link]
    argv += ["--proc", "/proc", "--dev", "/dev", "--size", str(tmp_mb << 20), "--tmpfs", SCRATCH,
             "--dir", SANDBOX_HOME, "--dir", f"{SCRATCH}/tmp", "--symlink", f"{SCRATCH}/tmp", "/tmp"]
    if os.path.isfile(LOADER_CACHE):
        argv += ["--ro-bind", LOADER_CACHE, LOADER_CACHE]
    return argv + ["--ro-bind-data", str(passwd), "/etc/passwd", "--ro-bind-data", str(group), "/etc/group"]


def _start(argv: list[str], fds: tuple[int, ...], max_output: int):
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out_w, stderr=err_w, env={}, pass_fds=fds,
                                start_new_session=True)
    except OSError:
        for fd in (out_r, err_r):
            os.close(fd)
        raise
    finally:
        for fd in (out_w, err_w, *fds):
            os.close(fd)
    streams = ([], [])
    drains = [threading.Thread(target=_drain, args=(fd, max_output, chunks), daemon=True)
              for fd, chunks in zip((out_r, err_r), streams)]
    for drain in drains:
        drain.start()
    return proc, drains, streams


def run(cmd: list[str], *, ro=(), rw=(), tools=(), chdir: str | None = None, timeout: int = 300,
        mem_mb: int = 4096, nproc: int = 256, max_output: int = 1 << 20, fsize_mb: int = 1024,
        tmp_mb: int = 2048, git_ro: bool = False, vm_mb: int = VM_MB) -> Result:
    """Run `cmd` in the sandbox and return the output only after completion. A setup error raises SandboxError.

    `git_ro` allows a writable path that contains `.git` and mounts every such `.git` read-only. `mem_mb` is the
    private memory of a process (RLIMIT_DATA), and `vm_mb` its address space (RLIMIT_AS).
    """
    if not cmd:
        raise SandboxError("no command")
    if min(timeout, mem_mb, vm_mb, nproc, max_output, fsize_mb, tmp_mb) <= 0:
        raise SandboxError("limits must be positive")
    for binary in (BWRAP, PRLIMIT):
        if not os.access(binary, os.X_OK):
            raise SandboxError(f"missing {binary}")
    homes = protected_homes()
    ro_p, tool_p = ([_checked(p, homes)[0] for p in group] for group in (ro, tools))
    writable = [_writable(p, homes, git_ro) for p in rw]
    rw_p, gits = [real for real, _ in writable], [git for _, found in writable for git in found]
    search = _search_path(tool_p)
    workdir = chdir or SANDBOX_HOME
    real_dirs = [Path(link) for link in ROOT_LINKS if os.path.isdir(link) and not os.path.islink(link)]
    roots = [Path("/usr").resolve(), *real_dirs, *ro_p, *rw_p, *tool_p]
    _command_visible(cmd[0], search, roots, workdir)
    program = seccomp_program()
    uid, gid = os.getuid(), os.getgid()
    passwd = _data_fd("passwd", f"sandbox:x:{uid}:{gid}:sandbox:{SANDBOX_HOME}:/bin/sh\n".encode())
    group = _data_fd("group", f"sandbox:x:{gid}:\n".encode())
    seccomp = _data_fd("seccomp", program)
    status_r, status_w = os.pipe()
    argv = _argv(search, status_w, seccomp, passwd, group, tmp_mb)
    argv += [*_binds(ro_p, rw_p, tool_p, gits), "--remount-ro", "/", "--chdir", workdir, "--",
             PRLIMIT, f"--cpu={timeout}", f"--data={mem_mb << 20}", f"--as={vm_mb << 20}", f"--nproc={nproc}",
             f"--fsize={fsize_mb << 20}", "--core=0:0", "--", *cmd]
    proc, drains, (out, err) = _start(argv, (status_w, seccomp, passwd, group), max_output)
    try:
        proc.wait(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        timed_out = True
    code = _exit_code(_read_all(status_r))
    for drain in drains:
        drain.join(DRAIN_GRACE)
    if any(drain.is_alive() for drain in drains):
        raise SandboxError(f"command output was not closed {DRAIN_GRACE} s after completion")
    stdout, cut_out = _capped(out, max_output)
    stderr, cut_err = _capped(err, max_output)
    if timed_out:
        return Result(TIMEOUT_EXIT, stdout, stderr, True, cut_out or cut_err)
    if code is None:
        raise SandboxError(f"bwrap did not start the command (exit {proc.returncode}): "
                           f"{stderr.decode(errors='replace').strip()[:500]}")
    return Result(code, stdout, stderr, False, cut_out or cut_err)


def checked_destination(path: Path) -> Path:
    """Destination for `copy_out`, checked before every mkdir: absolute, neither lexically nor really inside `.git`, not
    a symlink, and either missing or an empty directory. Returns the real path that is written to."""
    if not path.is_absolute():
        raise SandboxError(f"destination is not absolute: {path}")
    lexical = Path(os.path.normpath(path))
    anchor = lexical
    while not os.path.lexists(anchor):
        anchor = anchor.parent
    real = anchor.resolve() / lexical.relative_to(anchor)
    if GIT_DIR in lexical.parts or GIT_DIR in real.parts:
        raise SandboxError(f"destination {path} is inside git metadata ({GIT_DIR})")
    if os.path.lexists(lexical) and (lexical.is_symlink() or not lexical.is_dir() or any(lexical.iterdir())):
        raise SandboxError(f"destination {path} exists and is not an empty directory")
    return real


def _artifacts(src: Path, max_files: int, max_bytes: int) -> list[str]:
    try:
        if not stat.S_ISDIR(src.lstat().st_mode):
            raise SandboxError(f"artifacts are not a directory: {src}")
        with os.scandir(src) as listing:
            entries = sorted(((entry.name, entry.stat(follow_symlinks=False)) for entry in listing))
    except OSError as exc:
        raise SandboxError(f"artifacts are not readable ({exc.strerror}: {src})") from exc
    if len(entries) > max_files:
        raise SandboxError(f"there are {len(entries)} artifacts, but {max_files} are allowed")
    for name, info in entries:
        if not ARTIFACT_NAME.fullmatch(name):
            raise SandboxError(f"artifact {name!r} has no allowed name (letters, digits, _ . -, no leading dot)")
        if not stat.S_ISREG(info.st_mode):
            raise SandboxError(f"artifact {name} is not a regular file")
    total = sum(info.st_size for _, info in entries)
    if total > max_bytes:
        raise SandboxError(f"artifacts have {total} bytes, but {max_bytes} are allowed")
    return [name for name, _ in entries]


def _copy_file(src: Path, dst: Path, budget: int) -> int:
    with os.fdopen(os.open(src, os.O_RDONLY | os.O_NOFOLLOW), "rb") as fin:
        if not stat.S_ISREG(os.fstat(fin.fileno()).st_mode):
            raise SandboxError(f"artifact {src.name} is not a regular file")
        with os.fdopen(os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644), "wb") as fout:
            while chunk := fin.read(1 << 20):
                budget -= len(chunk)
                if budget < 0:
                    raise SandboxError(f"artifact {src.name} grew beyond the allowed size")
                fout.write(chunk)
    return budget


def copy_out(src: Path, dest: Path, *, max_files: int, max_bytes: int) -> list[str]:
    """Copy artifacts from the sandbox's writable directory to the host, after the command has exited.

    Accepts only a flat directory of regular files with safe names, at most `max_files` and `max_bytes` in total. All
    is checked before the first mkdir; the destination fills via a sibling temp directory and one rename. Returns names.
    """
    target = checked_destination(dest)
    names = _artifacts(src, max_files, max_bytes)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=target.parent))
    except OSError as exc:
        raise SandboxError(f"destination {dest} could not be prepared: {exc.strerror}") from exc
    try:
        budget = max_bytes
        for name in names:
            budget = _copy_file(src / name, stage / name, budget)
        os.rename(stage, target)
    except OSError as exc:
        raise SandboxError(f"artifacts were not copied to {dest}: {exc.strerror}") from exc
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return names
