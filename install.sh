#!/usr/bin/env bash
# umbra v2 installer. Idempotent, needs no root, touches nothing outside:
#   ~/.config/umbra/build/              compiled helpers + TUI
#   ~/.local/bin/umbra                  symlink to bin/umbra
#   ~/.local/share/umbra/               per-tool homes, snapshots, logs
#   ~/.config/fish/conf.d/umbra.fish    symlink (skip with --no-shell)
#
#   ./install.sh [--no-shell] [--no-tui]
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd -P)"
BUILD="$ROOT/build"
SHELL_HOOK=1
TUI=1
for a in "$@"; do
    case "$a" in
    --no-shell) SHELL_HOOK=0 ;;
    --no-tui) TUI=0 ;;
    -h | --help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "install: unknown option $a" >&2; exit 2 ;;
    esac
done

say() { printf '\033[1minstall:\033[0m %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" != 0 ] || die "run as your user, not root"

# ---- dependencies
missing=()
for c in bwrap pasta nft gcc pkg-config python3 rsync git flock; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
done
pkg-config --exists libseccomp 2>/dev/null || missing+=("libseccomp (headers)")
have_lib() { local d; for d in /usr/lib /usr/lib64 /usr/local/lib /usr/lib/x86_64-linux-gnu; do [ -e "$d/$1" ] && return 0; done; return 1; }
{ [ -f /usr/include/libkrun.h ] && have_lib libkrun.so.1; } || missing+=("libkrun")
have_lib libkrunfw.so.5 || have_lib libkrunfw.so.4 || missing+=("libkrunfw")
if [ ${#missing[@]} -gt 0 ]; then
    say "missing: ${missing[*]}"
    if command -v pacman >/dev/null 2>&1; then
        say "on Arch/CachyOS: sudo pacman -S --needed bubblewrap passt nftables gcc pkgconf libseccomp python rsync git util-linux libkrun libkrunfw"
    fi
    die "install the missing dependencies and re-run"
fi
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not accessible: add yourself to the 'kvm' group and log in again"
bwrap --unshare-user --ro-bind / / true 2>/dev/null \
    || die "unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone)"

mkdir -p "$BUILD"
CFLAGS=(-O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie)

say "building seccomp filter generator"
# shellcheck disable=SC2046
gcc "${CFLAGS[@]}" -o "$BUILD/umbra-seccomp" "$ROOT/seccomp/umbra-seccomp.c" $(pkg-config --cflags --libs libseccomp)
"$BUILD/umbra-seccomp" </dev/null >"$BUILD/.probe.bpf" || die "seccomp generator does not run"
[ -s "$BUILD/.probe.bpf" ] || die "seccomp generator produced no output"
rm -f "$BUILD/.probe.bpf"

say "building umbra-vmm (libkrun launcher) and umbra-init (guest init)"
gcc "${CFLAGS[@]}" -o "$BUILD/umbra-vmm" "$ROOT/vmm/umbra-vmm.c" -lkrun
gcc "${CFLAGS[@]}" -o "$BUILD/umbra-init" "$ROOT/guest/umbra-init.c"

if [ "$TUI" = 1 ]; then
    if command -v bun >/dev/null 2>&1; then
        say "building the TUI (bun)"
        (
            cd "$ROOT/tui"
            [ -d node_modules/@opentui/core ] || bun install --frozen-lockfile
            bun build --compile --outfile "$BUILD/umbra-tui" src/index.ts >/dev/null
        ) || say "TUI build failed; 'umbra' without arguments will print help instead"
    else
        say "bun not found; skipping the TUI ('umbra' without arguments prints help)"
    fi
fi

# ---- permissions on everything the host executes
chmod 0755 "$ROOT/bin/umbra" "$ROOT/lib/enter" "$ROOT/guest/init" \
    "$ROOT"/guest/bin/* "$ROOT"/guest/clip/*
chmod 0644 "$ROOT/lib/tools.sh" "$ROOT/lib/egress.py" "$ROOT/lib/snapshot.py" "$ROOT/umbra.conf" \
    "$ROOT"/egress/defaults.*

# ---- state
STATE="${XDG_DATA_HOME:-$HOME/.local/share}/umbra"
mkdir -p -m 0700 "$STATE" "$STATE/home" "$STATE/snapshots" "$STATE/logs" "$STATE/locks"
for t in claude agy opencode; do
    mkdir -p -m 0700 "$STATE/home/$t"
done
[ -f "$ROOT/egress/allow" ] || printf '# Your egress allowlist (see egress/defaults.allow for the format).\n' >"$ROOT/egress/allow"

# ---- launcher on PATH
mkdir -p "$HOME/.local/bin"
if [ -e "$HOME/.local/bin/umbra" ] && [ ! -L "$HOME/.local/bin/umbra" ]; then
    mv "$HOME/.local/bin/umbra" "$HOME/.local/bin/umbra.pre-v2-backup"
    say "moved the existing ~/.local/bin/umbra to umbra.pre-v2-backup"
fi
ln -sfn "$ROOT/bin/umbra" "$HOME/.local/bin/umbra"
say "linked ~/.local/bin/umbra"

# ---- shell integration
if [ "$SHELL_HOOK" = 1 ]; then
    if [ -d "$HOME/.config/fish" ]; then
        mkdir -p "$HOME/.config/fish/conf.d"
        ln -sfn "$ROOT/shell/umbra.fish" "$HOME/.config/fish/conf.d/umbra.fish"
        say "linked ~/.config/fish/conf.d/umbra.fish (claude/agy/opencode are sandboxed in new fish shells)"
        if [ -f "$HOME/.config/fish/functions/agy.fish" ] && grep -q 'podman run' "$HOME/.config/fish/functions/agy.fish"; then
            say "NOTE: ~/.config/fish/functions/agy.fish is the old podman wrapper; umbra's conf.d"
            say "      function takes precedence, but you can delete it."
        fi
    fi
    say "bash/zsh: add 'source $ROOT/shell/umbra.bash' to your rc file"
fi

say "done -- umbra $("$ROOT/bin/umbra" version | cut -d' ' -f2). Next:"
cat <<EOF
    umbra doctor                 # check everything
    umbra selftest               # verify the isolation from inside a VM
    umbra                        # the TUI
    cd ~/some/project && claude  # (new fish shell) sandboxed in a microVM
EOF
