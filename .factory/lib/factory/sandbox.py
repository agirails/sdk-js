"""Pokretanje koda iz repoa pod bwrap: prazna okolina, samo navedene putanje, bez mreže, s ograničenjima (S7).

Unutra se vidi samo /usr, simboličke veze korijena kao na hostu, generirani /etc/passwd i /etc/group, ld.so.cache
(dinamički linker po njemu nalazi biblioteke iz ld.so.conf.d), novi /proc i minimalni /dev, jedan privatni tmpfs
veličine `tmp_mb` za HOME i /tmp te putanje koje pozivatelj izričito navede. Seccomp filtar odbija keyctl, add_key i
request_key, pa kod ne dolazi do keyringa hosta. Montiranje se odbija za korijen, home, sistemska i dijeljena
privremena stabla, skrivene stavke u korijenu home-a osim toolchaina, privatna stabla i imena iz
standard/configs/sandbox-deny.txt (imena vrijede na svakoj dubini) i svako stablo u kojem je socket. Izlaz se čita dok
naredba radi, ali se čuva najviše `max_output` bajtova po toku i vraća tek nakon završetka.

Git metapodaci: putanja za pisanje koja je unutar `.git` ili je simbolička veza `.git` uvijek se odbija. Putanja za
pisanje koja sadrži `.git` odbija se, osim kad pozivatelj zada `git_ro`: tada se svaki `.git` u njoj montira samo za
čitanje preko mape za pisanje, pa hook ili `core.fsmonitor` upisan iznutra ne dolazi do hosta, a git i dalje čita
povijest. `.git` koji kod stvori tijekom rada tamo ostaje, pa je stablo za pisanje nakon izlaza nepovjerljivo: host u
njemu ne pokreće git, a artefakte uzima kroz `copy_out`.

Ograničenja koja postoje: `mem_mb` privatna memorija po procesu u heapu i privatnim mapiranjima za pisanje
(RLIMIT_DATA), `vm_mb` adresni prostor po procesu (RLIMIT_AS, uključuje rezervacije bez memorije, stog i dijeljena
mapiranja), `nproc` broj
procesa (RLIMIT_NPROC), CPU vrijeme po procesu i ukupno vrijeme sandboxa (`timeout`), `fsize_mb` veličina jedne
datoteke, core dump 0 (soft i hard, ne može se podići), `tmp_mb` jedan tmpfs za HOME i /tmp (troši RAM) i `max_output`
po toku. Svi limiti postavljaju se kao soft i hard, pa ih proces unutra ne može podići.

Zašto dva memorijska limita: pinani gitleaks (go-re2 na wazero) rezervira oko 5,4 GB adresnog prostora s PROT_NONE,
a koristi oko 0,15 GB (izmjereno 2026-11-06 na fixtureu i na sdk-js: VmPeak 5321 i 5386 MB, VmData 110 i 156 MB,
VmHWM 74 i 121 MB). Pod RLIMIT_AS od 4 GB pada već pri pokretanju. Rezervacija se ne broji u RLIMIT_DATA, pa
`mem_mb` zaustavlja proces kojem heap raste, a `vm_mb` je gornja granica memorije jednog procesa. Zadano je
`VM_MB` (4 GB) za sve; samo poziv koji u sandboxu pokreće code-check s gitleaksom traži `GITLEAKS_VM_MB` (8 GB),
pa viši limit vrijedi za taj poziv, a ne za repro i ostali kod repoa (Damir 2026-11-06: gitleaks dobiva vlastiti limit).
RLIMIT_DATA ne broji stog ni dijeljena mapiranja: glavni stog, mapiranje s MAP_GROWSDOWN i stog proširen kroz
mremap rastu do `vm_mb` (izmjereno 2026-11-06: 1,5 GB dotaknuto kroz MAP_GROWSDOWN i kroz mremap stoga pod `mem_mb`
512), kao i dijeljena anonimna mapiranja. Poznato ograničenje: ukupna memorija svih procesa (do `nproc` ×
`vm_mb`) i ukupno pisanje u putanje za pisanje nisu ograničeni, jer bi to tražilo cgroup preko korisničkog systemd
busa, a modul ga ne pretpostavlja.
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
TRUNCATED = "\n[sandbox-run: izlaz skraćen na {n} bajtova]\n"


class SandboxError(MeasureError):
    """Sandbox nije postavljen ili je odbio montiranje, pa naredba nije pokrenuta. Nikad nije prolaz."""


@dataclass(frozen=True)
class Result:
    """Ishod naredbe. `exit_code` je izlaz naredbe, a TIMEOUT_EXIT kad je prekoračeno vrijeme."""
    exit_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool
    truncated: bool


def protected_homes() -> list[Path]:
    """Home iz passwd-a i iz HOME varijable: oba, njihovi preci i vjerodajnice u njima se ne montiraju."""
    homes = [Path(pwd.getpwuid(os.getuid()).pw_dir)]
    if os.environ.get("HOME"):
        homes.append(Path(os.environ["HOME"]))
    return sorted({h.resolve() for h in homes})


def deny_digest(rel: str) -> str:
    """Otisak za sandbox-deny.txt: sha256 putanje relativne prema home-u, npr. `projekt/.privatno`."""
    return sha256(rel)


def _parse_deny_row(entry: str, where: str) -> tuple[str, str]:
    kind, _, value = entry.partition(":") if entry.startswith(NAME_PREFIX) else ("path", "", entry)
    if DIGEST.match(value):
        return kind, value[len("sha256:"):]
    if kind == "name" and value and "/" not in value and not value.startswith("sha256:"):
        return kind, deny_digest(value)
    if kind == "path" and not value.startswith(("sha256:", "/")) and ".." not in value.split("/"):
        return kind, deny_digest(value.strip("/"))
    raise SandboxError(f"{where}: redak mora biti sha256:<hex>, putanja relativna prema home-u ili name:<ime>")


@lru_cache(maxsize=4)
def _deny_list(path: Path) -> dict[str, frozenset[str]]:
    try:
        rows = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise SandboxError(f"popis zabranjenih stabala nije čitljiv ({Path(path).name}): {exc.strerror}") from exc
    out: dict[str, set[str]] = {"path": set(), "name": set()}
    for number, row in enumerate(rows, 1):
        entry = row.strip()
        if entry and not entry.startswith("#"):
            kind, digest = _parse_deny_row(entry, f"{Path(path).name}:{number}")
            out[kind].add(digest)
    return {kind: frozenset(values) for kind, values in out.items()}


def denied_digests() -> frozenset[str]:
    """Otisci privatnih stabala pod home-om koja se nikad ne montiraju, ni ona ni njihovi preci."""
    return _deny_list(DENY_FILE)["path"]


def denied_names() -> frozenset[str]:
    """Otisci imena (`name:` retci) koja se nikad ne montiraju ni na kojoj dubini, ni stabla u kojima jesu."""
    return _deny_list(DENY_FILE)["name"]


def _home_refusal(path: Path, home: Path) -> str | None:
    if path == home or path in home.parents:
        return "montira cijeli home"
    if home not in path.parents:
        return None
    rel = path.relative_to(home).as_posix()
    if rel.startswith(".") and not any(rel == t or rel.startswith(t + "/") for t in TOOLCHAINS):
        return "je skrivena stavka u korijenu home-a (vjerodajnice, povijest ili postavke)"
    parts = rel.split("/")
    if any(deny_digest("/".join(parts[:i])) in denied_digests() for i in range(1, len(parts) + 1)):
        return "je privatno stablo iz sandbox-deny.txt"
    return None


def _denied_name(path: Path) -> bool:
    return any(deny_digest(part) in denied_names() for part in path.parts)


def _refusal(path: Path, homes: list[Path]) -> str | None:
    if path == Path("/"):
        return "montira cijeli korijen"
    if _denied_name(path):
        return "je privatno stablo iz sandbox-deny.txt"
    for tree in (*FORBIDDEN_TREES, *SHARED_TEMP):
        if path == Path(tree) or path in Path(tree).parents:
            return f"montira {tree}"
        if Path(tree) in path.parents and tree in FORBIDDEN_TREES:
            return f"je unutar {tree}"
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
            return f"nije čitljiv ({exc.strerror}: {current})", gits
        if stat.S_ISSOCK(info.st_mode):
            return f"sadrži socket {current}", gits
        if current != root and _denied_entry(current, homes):
            return f"sadrži privatno stablo {current} iz sandbox-deny.txt", gits
        if current.name == GIT_DIR:
            gits.append(current)
        if stat.S_ISDIR(info.st_mode):
            try:
                stack.extend(sorted(Path(entry.path) for entry in os.scandir(current)))
            except OSError as exc:
                return f"nije čitljiv ({exc.strerror}: {current})", gits
    return None, sorted(gits)


def _checked(raw: str, homes: list[Path]) -> tuple[Path, list[Path]]:
    given = Path(raw)
    if not given.is_absolute():
        raise SandboxError(f"putanja nije apsolutna: {raw}")
    real = given.resolve()
    for candidate in (Path(os.path.normpath(given)), real):
        reason = _refusal(candidate, homes)
        if reason:
            raise SandboxError(f"odbijeno montiranje {raw}: {reason}")
    if not real.exists():
        raise SandboxError(f"putanja ne postoji: {raw}")
    reason, gits = _tree_scan(real, homes)
    if reason:
        raise SandboxError(f"odbijeno montiranje {raw}: {reason}")
    return real, gits


def _writable(raw: str, homes: list[Path], git_ro: bool) -> tuple[Path, list[Path]]:
    real, gits = _checked(raw, homes)
    if GIT_DIR in Path(os.path.normpath(raw)).parts or GIT_DIR in real.parts:
        raise SandboxError(f"odbijeno pisanje u {raw}: putanja je unutar git metapodataka ({GIT_DIR})")
    links = [git for git in gits if git.is_symlink()]
    if links:
        raise SandboxError(f"odbijeno pisanje u {raw}: {links[0]} je simbolička veza {GIT_DIR}")
    if gits and not git_ro:
        raise SandboxError(f"odbijeno pisanje u {raw}: sadrži {gits[0]}, a hook ili core.fsmonitor upisan iznutra "
                           f"izvršio bi se na hostu; montiraj {GIT_DIR} samo za čitanje (git_ro, --git-ro)")
    return real, gits


def _binds(ro: list[Path], rw: list[Path], tools: list[Path], gits: list[Path]) -> list[str]:
    flags: dict[Path, str] = {}
    for paths, flag in ((ro, "--ro-bind"), (tools, "--ro-bind"), (gits, "--ro-bind"), (rw, "--bind")):
        for path in paths:
            if flags.setdefault(path, flag) != flag:
                raise SandboxError(f"putanja je navedena i za čitanje i za pisanje: {path}")
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
    raise SandboxError(f"naredba nije dostupna u sandboxu: {cmd0}")


def _data_fd(name: str, data: bytes) -> int:
    fd = os.memfd_create(name)
    os.write(fd, data)
    os.lseek(fd, 0, os.SEEK_SET)
    return fd


def seccomp_program(machine: str | None = None) -> bytes:
    """Klasični BPF za `bwrap --seccomp`: keyctl, add_key i request_key vraćaju EPERM; druga arhitektura ubija proces."""
    machine = machine or platform.machine()
    if machine not in SYSCALLS:
        raise SandboxError(f"seccomp filtar nije definiran za arhitekturu {machine}")
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
    """Izlaz za terminal: kontrolni znakovi osim LF i TAB (ESC, BEL, CR, C1) postaju vidljivi `\\xHH`."""
    text = data.decode("utf-8", "backslashreplace")
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", lambda m: f"\\x{ord(m.group()):02x}", text).encode("utf-8")


def _exit_code(status: bytes) -> int | None:
    codes = []
    for line in status.decode().splitlines():
        if line.strip():
            try:
                codes.append(json.loads(line).get("exit-code"))
            except json.JSONDecodeError as exc:
                raise SandboxError(f"bwrap je vratio nečitljiv status: {line[:200]}") from exc
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
    """Pokreni `cmd` u sandboxu i vrati izlaz tek nakon završetka. Greška postavljanja diže SandboxError.

    `git_ro` dopušta putanju za pisanje koja sadrži `.git` i montira svaki takav `.git` samo za čitanje. `mem_mb` je
    privatna memorija procesa (RLIMIT_DATA), a `vm_mb` njegov adresni prostor (RLIMIT_AS).
    """
    if not cmd:
        raise SandboxError("nema naredbe")
    if min(timeout, mem_mb, vm_mb, nproc, max_output, fsize_mb, tmp_mb) <= 0:
        raise SandboxError("ograničenja moraju biti pozitivna")
    for binary in (BWRAP, PRLIMIT):
        if not os.access(binary, os.X_OK):
            raise SandboxError(f"nema {binary}")
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
        raise SandboxError(f"izlaz naredbe nije zatvoren {DRAIN_GRACE} s nakon završetka")
    stdout, cut_out = _capped(out, max_output)
    stderr, cut_err = _capped(err, max_output)
    if timed_out:
        return Result(TIMEOUT_EXIT, stdout, stderr, True, cut_out or cut_err)
    if code is None:
        raise SandboxError(f"bwrap nije pokrenuo naredbu (exit {proc.returncode}): "
                           f"{stderr.decode(errors='replace').strip()[:500]}")
    return Result(code, stdout, stderr, False, cut_out or cut_err)


def checked_destination(path: Path) -> Path:
    """Odredište za `copy_out`, provjereno prije svakog mkdir: apsolutno, ni leksički ni stvarno unutar `.git`, nije
    simbolička veza i ne postoji ili je prazna mapa. Vraća stvarnu putanju u koju se piše."""
    if not path.is_absolute():
        raise SandboxError(f"odredište nije apsolutno: {path}")
    lexical = Path(os.path.normpath(path))
    anchor = lexical
    while not os.path.lexists(anchor):
        anchor = anchor.parent
    real = anchor.resolve() / lexical.relative_to(anchor)
    if GIT_DIR in lexical.parts or GIT_DIR in real.parts:
        raise SandboxError(f"odredište {path} je unutar git metapodataka ({GIT_DIR})")
    if os.path.lexists(lexical) and (lexical.is_symlink() or not lexical.is_dir() or any(lexical.iterdir())):
        raise SandboxError(f"odredište {path} postoji, a nije prazna mapa")
    return real


def _artifacts(src: Path, max_files: int, max_bytes: int) -> list[str]:
    try:
        if not stat.S_ISDIR(src.lstat().st_mode):
            raise SandboxError(f"artefakti nisu mapa: {src}")
        with os.scandir(src) as listing:
            entries = sorted(((entry.name, entry.stat(follow_symlinks=False)) for entry in listing))
    except OSError as exc:
        raise SandboxError(f"artefakti nisu čitljivi ({exc.strerror}: {src})") from exc
    if len(entries) > max_files:
        raise SandboxError(f"artefakata je {len(entries)}, a dopušteno je {max_files}")
    for name, info in entries:
        if not ARTIFACT_NAME.fullmatch(name):
            raise SandboxError(f"artefakt {name!r} nema dopušteno ime (slova, brojke, _ . -, bez točke na početku)")
        if not stat.S_ISREG(info.st_mode):
            raise SandboxError(f"artefakt {name} nije obična datoteka")
    total = sum(info.st_size for _, info in entries)
    if total > max_bytes:
        raise SandboxError(f"artefakti imaju {total} bajtova, a dopušteno je {max_bytes}")
    return [name for name, _ in entries]


def _copy_file(src: Path, dst: Path, budget: int) -> int:
    with os.fdopen(os.open(src, os.O_RDONLY | os.O_NOFOLLOW), "rb") as fin:
        if not stat.S_ISREG(os.fstat(fin.fileno()).st_mode):
            raise SandboxError(f"artefakt {src.name} nije obična datoteka")
        with os.fdopen(os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644), "wb") as fout:
            while chunk := fin.read(1 << 20):
                budget -= len(chunk)
                if budget < 0:
                    raise SandboxError(f"artefakt {src.name} je narastao preko dopuštene veličine")
                fout.write(chunk)
    return budget


def copy_out(src: Path, dest: Path, *, max_files: int, max_bytes: int) -> list[str]:
    """Kopiraj artefakte iz mape za pisanje sandboxa na host, nakon što je naredba izašla.

    Prihvaća samo ravnu mapu običnih datoteka sigurnih imena, najviše `max_files` i `max_bytes` ukupno. Sve se provjeri
    prije prvog mkdir, a odredište se puni preko susjedne privremene mape i jednog rename-a. Vraća kopirana imena.
    """
    target = checked_destination(dest)
    names = _artifacts(src, max_files, max_bytes)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=target.parent))
    except OSError as exc:
        raise SandboxError(f"odredište {dest} nije moguće pripremiti: {exc.strerror}") from exc
    try:
        budget = max_bytes
        for name in names:
            budget = _copy_file(src / name, stage / name, budget)
        os.rename(stage, target)
    except OSError as exc:
        raise SandboxError(f"artefakti nisu kopirani u {dest}: {exc.strerror}") from exc
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return names
