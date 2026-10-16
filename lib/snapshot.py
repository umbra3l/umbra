#!/usr/bin/env python3
"""umbra project snapshots: an automatic, free "undo" for whatever an agent
does to your project.

  snapshot.py take   WORKSPACE STORE [--keep N]   -> prints the snapshot path
  snapshot.py report WORKSPACE SNAPSHOT            -> end-of-session summary
  snapshot.py diff   WORKSPACE SNAPSHOT            -> list of changed files
  snapshot.py list   STORE

On btrfs/XFS (your $HOME is btrfs) every file is cloned with FICLONE: the
snapshot shares all data blocks with the original, takes ~40 ms per 1000
files, and costs no disk space until one side changes. Regenerable caches
(node_modules, virtualenvs, Rust target/, __pycache__, ...) are skipped so
huge dependency trees don't slow startup; `umbra undo` leaves those
directories alone too.

On filesystems without reflinks, small projects (< 256 MiB) are copied and
larger ones are skipped with a notice.
"""

import concurrent.futures
import fcntl
import os
import shutil
import stat
import sys
import time

FICLONE = 0x40049409
MAX_FILES = 150_000
COPY_FALLBACK_LIMIT = 256 * 1024 * 1024

# Directory names that are always regenerable.
SKIP_DIRS = {
    "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".tox", ".nox", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache",
    ".gradle", ".zig-cache", "zig-out", ".direnv", ".terraform",
}

# Files/dirs the *host* executes or loads when you build, test, open the
# folder in an editor, or cd into it. Changes here are reported after every
# session. (Paths are matched relative to the workspace.)
RISKY_NAMES = {
    "Makefile", "makefile", "GNUmakefile", "justfile", "Justfile", "Taskfile.yml",
    "package.json", ".npmrc", ".yarnrc", ".yarnrc.yml", ".envrc",
    "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "noxfile.py", "conftest.py",
    "Cargo.toml", "build.rs", "go.mod", "flake.nix", "shell.nix", "default.nix",
    ".pre-commit-config.yaml", ".gitmodules", ".gitattributes", ".tool-versions",
    ".mise.toml", "mise.toml", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    "compose.yml", "compose.yaml", ".clang-format", "CMakeLists.txt", "meson.build",
}
RISKY_SUFFIXES = (".mk",)
RISKY_DIRS = (
    ".vscode/", ".idea/", ".zed/", ".github/workflows/", ".gitlab-ci", ".husky/", ".githooks/",
    ".devcontainer/", ".claude/", ".opencode/", ".gemini/", ".agents/", ".cargo/", ".mvn/",
)


def skip_dir(name, parent_entries):
    if name in SKIP_DIRS:
        return True
    if name in ("venv", ".venv", "env") and "pyvenv.cfg" in parent_entries.get(name, ()):
        return True
    if name == "target" and "Cargo.toml" in parent_entries.get("", ()):
        return True
    return False


def walk(root):
    """Yields (relpath, DirEntry) for everything under root that a snapshot
    covers, parents before children."""
    stack = [""]
    while stack:
        rel = stack.pop()
        path = os.path.join(root, rel) if rel else root
        try:
            entries = list(os.scandir(path))
        except OSError:
            continue
        names = {e.name for e in entries}
        for e in entries:
            child = f"{rel}/{e.name}" if rel else e.name
            try:
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                look = {"": names}
                if e.name in ("venv", ".venv", "env"):
                    try:
                        look[e.name] = set(os.listdir(e.path))
                    except OSError:
                        look[e.name] = set()
                if skip_dir(e.name, look):
                    continue
                yield child, e
                stack.append(child)
            else:
                yield child, e


def clone_file(src, dst, reflink):
    with open(src, "rb") as s, open(dst, "xb") as d:
        if reflink:
            fcntl.ioctl(d.fileno(), FICLONE, s.fileno())
        else:
            shutil.copyfileobj(s, d, 1 << 20)
    shutil.copystat(src, dst, follow_symlinks=False)


def supports_reflink(src_dir, dst_dir):
    probe_src = os.path.join(dst_dir, ".umbra-probe-src")
    probe_dst = os.path.join(dst_dir, ".umbra-probe-dst")
    try:
        # Probe across the two filesystems actually involved.
        for rel, e in walk(src_dir):
            if e.is_file(follow_symlinks=False):
                try:
                    with open(e.path, "rb") as s, open(probe_dst, "xb") as d:
                        fcntl.ioctl(d.fileno(), FICLONE, s.fileno())
                    return True
                except OSError:
                    return False
                finally:
                    if os.path.exists(probe_dst):
                        os.unlink(probe_dst)
        return True  # no regular files at all: nothing to clone
    finally:
        if os.path.exists(probe_src):
            os.unlink(probe_src)


def cmd_take(ws, store, keep):
    ws = os.path.realpath(ws)
    os.makedirs(store, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    final = os.path.join(store, stamp)
    n = 1
    while os.path.exists(final):
        n += 1
        final = os.path.join(store, f"{stamp}.{n}")
    partial = os.path.join(store, f".partial-{os.getpid()}")
    os.makedirs(partial)
    try:
        reflink = supports_reflink(ws, partial)
        entries = []
        total = 0
        for rel, e in walk(ws):
            entries.append((rel, e))
            if len(entries) > MAX_FILES:
                raise RuntimeError(f"more than {MAX_FILES} files")
            if not reflink and e.is_file(follow_symlinks=False):
                total += e.stat(follow_symlinks=False).st_size
                if total > COPY_FALLBACK_LIMIT:
                    raise RuntimeError("filesystem has no reflinks and project is > 256 MiB")

        dirs = []
        files = []
        for rel, e in entries:
            dst = os.path.join(partial, rel)
            if e.is_dir(follow_symlinks=False):
                os.mkdir(dst)
                dirs.append((e.path, dst))
            elif e.is_symlink():
                os.symlink(os.readlink(e.path), dst)
            elif e.is_file(follow_symlinks=False):
                files.append((e.path, dst))
            # sockets, fifos, devices: not snapshotted

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda sd: clone_file(sd[0], sd[1], reflink), files, chunksize=64))
        for src, dst in reversed(dirs):
            shutil.copystat(src, dst, follow_symlinks=False)
        shutil.copystat(ws, partial, follow_symlinks=False)
        with open(os.path.join(store, ".source"), "w") as f:
            f.write(ws + "\n")
        os.rename(partial, final)
    except Exception as exc:
        shutil.rmtree(partial, ignore_errors=True)
        print(f"skipped: {exc}")
        return 0

    snaps = sorted(d for d in os.listdir(store) if d[:1].isdigit())
    for old in snaps[:-keep] if keep > 0 else []:
        shutil.rmtree(os.path.join(store, old), ignore_errors=True)
    print(final)
    return 0


def same(a, b):
    try:
        sa, sb = os.lstat(a), os.lstat(b)
    except FileNotFoundError:
        return False
    if stat.S_IFMT(sa.st_mode) != stat.S_IFMT(sb.st_mode):
        return False
    if stat.S_ISLNK(sa.st_mode):
        return os.readlink(a) == os.readlink(b)
    if sa.st_size != sb.st_size:
        return False
    if sa.st_mtime_ns == sb.st_mtime_ns:
        return True
    with open(a, "rb") as fa, open(b, "rb") as fb:
        while True:
            x, y = fa.read(1 << 20), fb.read(1 << 20)
            if x != y:
                return False
            if not x:
                return True


def changes(ws, snap):
    """Returns (added, modified, deleted, made_executable) relative paths."""
    added, modified, deleted, mkexec = [], [], [], []
    seen = set()
    for rel, e in walk(ws):
        if e.is_dir(follow_symlinks=False) or rel == ".git" or rel.startswith(".git/"):
            continue  # git internals: covered by undo, not worth reporting
        seen.add(rel)
        other = os.path.join(snap, rel)
        if not os.path.lexists(other):
            added.append(rel)
            continue
        if not same(e.path, other):
            modified.append(rel)
        try:
            new_x = os.lstat(e.path).st_mode & 0o111
            old_x = os.lstat(other).st_mode & 0o111
            if new_x and not old_x and not e.is_symlink():
                mkexec.append(rel)
        except OSError:
            pass
    for rel, e in walk(snap):
        if e.is_dir(follow_symlinks=False) or rel == ".git" or rel.startswith(".git/"):
            continue
        if rel not in seen:
            deleted.append(rel)
    return added, modified, deleted, mkexec


def risky(rel):
    base = rel.rsplit("/", 1)[-1]
    if base in RISKY_NAMES or base.endswith(RISKY_SUFFIXES):
        return True
    if base.startswith(".env"):
        return True
    probe = rel + ("/" if not rel.endswith("/") else "")
    return any(probe.startswith(d) or f"/{d}" in f"/{rel}" for d in RISKY_DIRS)


def cmd_report(ws, snap):
    added, modified, deleted, mkexec = changes(ws, snap)
    total = len(added) + len(modified) + len(deleted)
    if total == 0:
        return 0
    print(f"changed {total} file{'s' if total != 1 else ''} "
          f"(+{len(added)} ~{len(modified)} -{len(deleted)})")
    flagged = sorted({r for r in added + modified if risky(r)} | set(mkexec))
    if flagged:
        shown = ", ".join(flagged[:6]) + (f", +{len(flagged) - 6} more" if len(flagged) > 6 else "")
        print(f"RISK {shown}")
    return 0


def cmd_diff(ws, snap):
    added, modified, deleted, mkexec = changes(ws, snap)
    for tag, items in (("A", added), ("M", modified), ("D", deleted), ("X", mkexec)):
        for r in sorted(items):
            flag = "  !" if (tag != "D" and risky(r)) or tag == "X" else ""
            print(f"{tag} {r}{flag}")
    return 0


def cmd_list(store):
    if not os.path.isdir(store):
        return 0
    for d in sorted(x for x in os.listdir(store) if x[:1].isdigit()):
        print(os.path.join(store, d))
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "take" and len(argv) >= 4:
        keep = 20
        if "--keep" in argv:
            keep = int(argv[argv.index("--keep") + 1])
        return cmd_take(argv[2], argv[3], keep)
    if cmd == "report" and len(argv) == 4:
        return cmd_report(argv[2], argv[3])
    if cmd == "diff" and len(argv) == 4:
        return cmd_diff(argv[2], argv[3])
    if cmd == "list" and len(argv) == 3:
        return cmd_list(argv[2])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
