# umbra tool registry. Sourced by bin/umbra.
#
# One block per CLI. Each tool gets:
#   tool_host_bin_<t>    host path of the real binary (symlinks resolved)
#   tool_guest_bin_<t>   where the binary appears inside the sandbox (the same
#                        path it has on the host, so PATH, `which`, and
#                        installation self-checks behave natively)
#   tool_env_<t>         extra env vars set inside the sandbox
#   tool_login_<t>       argv for `umbra login <t>`
#   tool_login_net_<t>   network mode used for login
#   tool_update_<t>      host-side updater argv (run unsandboxed by `umbra update`)
#   tool_import_<t>      seeds the sandbox home from v1 or the host install
#   tool_state_<t>       paths (relative to the sandbox home) holding its state
#   UMBRA_KEYRING_<t> / UMBRA_EXCLUSIVE_<t> / UMBRA_HOSTNET_OK_<t> defaults
#                        (overridable in umbra.conf)
#
# Adding a tool = adding one block like these plus its name to UMBRA_TOOLS.

UMBRA_TOOLS=(claude agy opencode)

# First existing executable among the arguments, symlinks resolved.
_first_bin() {
    local c
    for c in "$@"; do
        [ -n "$c" ] || continue
        if [ -x "$c" ] && [ -f "$c" ]; then
            readlink -f -- "$c"
            return 0
        fi
    done
    return 1
}

# rsync wrapper used by importers: never follow symlinks out of the source,
# never delete anything in the destination.
_import_copy() {
    local src="$1" dst="$2"
    shift 2
    [ -e "$src" ] || return 0
    mkdir -p -- "$(dirname -- "$dst")"
    rsync -a --info=stats0 "$@" -- "$src" "$dst"
}

# Rewrites absolute paths from v1's container HOME (/root) to the real HOME
# in small JSON state files, so plugin/skill paths keep resolving.
_rewrite_root_paths() {
    local f
    for f in "$@"; do
        [ -f "$f" ] || continue
        sed -i "s#\"/root/#\"$HOME/#g" -- "$f"
    done
}

# ---------------------------------------------------------------- claude ---
: "${UMBRA_KEYRING_claude:=1}"
# Claude's state is plain files (JSON/JSONL with lockfiles): parallel
# sessions are safe.
: "${UMBRA_EXCLUSIVE_claude:=0}"

tool_host_bin_claude() {
    _first_bin "${UMBRA_BIN_claude:-}" "$HOME/.local/bin/claude" "$(command -v claude 2>/dev/null)"
}
tool_guest_bin_claude() { echo "$HOME/.local/bin/claude"; }
tool_env_claude() {
    # Binary is mounted read-only from the host install; updates happen on
    # the host via `umbra update`.
    echo DISABLE_AUTOUPDATER=1
}
tool_login_claude() { echo claude auth login; }
tool_login_net_claude() { echo host; }  # OAuth callback on localhost
tool_update_claude() { echo update; }
tool_state_claude() { echo .claude .claude.json; }

tool_import_claude() {
    local src="$1" h="$2"
    case "$src" in
    v1)
        local v1="$UMBRA_V1_DIR/auth/claude"
        [ -d "$v1" ] || { echo "no v1 state at $v1" >&2; return 1; }
        # local-bin / local-share-claude held v1's container copy of the
        # binary; umbra mounts the host binary instead.
        _import_copy "$v1/" "$h/.claude/" \
            --exclude=/local-bin --exclude=/local-share-claude --exclude=/.claude.json \
            --exclude=/daemon.lock --exclude=/.npm
        _import_copy "$v1/.claude.json" "$h/.claude.json"
        _rewrite_root_paths "$h/.claude.json" "$h"/.claude/plugins/*.json
        ;;
    host)
        local f
        mkdir -p "$h/.claude"
        for f in .credentials.json settings.json CLAUDE.md mcp.json agents commands skills \
            plugins output-styles hooks; do
            _import_copy "$HOME/.claude/$f" "$h/.claude/$f"
        done
        _import_copy "$HOME/.claude.json" "$h/.claude.json"
        echo "note: Claude rotates OAuth refresh tokens. If you keep using host-native" >&2
        echo "      claude too, one of the two will eventually be logged out; run" >&2
        echo "      'umbra login claude' to give the sandbox its own session." >&2
        ;;
    esac
}

# ------------------------------------------------------------------- agy ---
: "${UMBRA_KEYRING_agy:=0}"
# agy keeps conversations in SQLite: one live session at a time (two VMs
# writing one SQLite file over virtio-fs would corrupt it).
: "${UMBRA_EXCLUSIVE_agy:=1}"

tool_host_bin_agy() {
    _first_bin "${UMBRA_BIN_agy:-}" "$HOME/.local/bin/agy" "$(command -v agy 2>/dev/null)"
}
tool_guest_bin_agy() { echo "$HOME/.local/bin/agy"; }
tool_env_agy() { echo AGY_CLI_DISABLE_AUTO_UPDATE=1; }
tool_login_agy() { echo agy; }
tool_login_net_agy() { echo host; }  # Google OAuth callback on localhost
tool_update_agy() { echo update; }
tool_state_agy() { echo .gemini; }

tool_import_agy() {
    local src="$1" h="$2"
    case "$src" in
    v1)
        local v1="$UMBRA_V1_DIR/auth/agy"
        [ -d "$v1" ] || { echo "no v1 state at $v1" >&2; return 1; }
        _import_copy "$v1/" "$h/.gemini/"
        ;;
    host)
        local f
        mkdir -p "$h/.gemini/antigravity-cli"
        for f in config skills antigravity; do
            _import_copy "$HOME/.gemini/$f" "$h/.gemini/$f"
        done
        for f in settings.json installation_id bin builtin antigravity-oauth-token; do
            _import_copy "$HOME/.gemini/antigravity-cli/$f" "$h/.gemini/antigravity-cli/$f"
        done
        if [ ! -e "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]; then
            echo "note: host agy keeps its OAuth token in the host keyring, which is" >&2
            echo "      deliberately not copied. Run 'umbra login agy' once." >&2
        fi
        ;;
    esac
}

# -------------------------------------------------------------- opencode ---
: "${UMBRA_KEYRING_opencode:=0}"
# opencode.db is SQLite (WAL): one live session at a time.
: "${UMBRA_EXCLUSIVE_opencode:=1}"
# opencode v2 runs a background service on a fixed loopback port
# (127.0.0.1:49374 by default) found via service.json. Sharing the host
# network would let the sandboxed client reach -- or collide with -- an
# UNSANDBOXED host-side service. Refused unless --force.
: "${UMBRA_HOSTNET_OK_opencode:=0}"

tool_host_bin_opencode() {
    _first_bin "${UMBRA_BIN_opencode:-}" "$HOME/.opencode/bin/opencode" "$(command -v opencode 2>/dev/null)"
}
tool_guest_bin_opencode() { echo "$HOME/.opencode/bin/opencode"; }
# opencode's feature flags (OPENCODE_EXPERIMENTAL_*, OPENCODE_ENABLE_*) follow
# the host shell in, so plugins that need them -- oh-my-opencode-slim's
# background subagents (its `task` tool) -- behave as they do outside.
# Flags only: no OPENCODE_* that could carry a key, config path or server URL.
tool_env_opencode() {
    local v
    while IFS= read -r v; do
        case "$v" in
        OPENCODE_EXPERIMENTAL_* | OPENCODE_ENABLE_*) printf '%s=%s\n' "$v" "${!v}" ;;
        esac
    done < <(compgen -e)
    echo OPENCODE_DISABLE_AUTOUPDATE=1
}
tool_login_opencode() { echo opencode auth login; }
# Not "host": opencode v2 talks to a background service found via
# service.json + loopback. With the host network a sandboxed client could
# end up driving an *unsandboxed* host-side opencode service.
tool_login_net_opencode() { echo ask; }
tool_update_opencode() { echo upgrade; }
tool_state_opencode() { echo .config/opencode .local/share/opencode .local/state/opencode; }

tool_import_opencode() {
    local src="$1" h="$2"
    # service.json files point at a running background service (a loopback
    # port). Importing one could aim the sandboxed client at a host service.
    local ex=(--exclude=service.json --exclude='*.db-shm' --exclude='*.db-wal' --exclude=/locks)
    case "$src" in
    v1)
        local v1="$UMBRA_V1_DIR/auth/opencode2"
        [ -d "$v1" ] || { echo "no v1 state at $v1" >&2; return 1; }
        _import_copy "$v1/config/" "$h/.config/opencode/" "${ex[@]}"
        _import_copy "$v1/share/" "$h/.local/share/opencode/" "${ex[@]}" --exclude=/backups
        _import_copy "$v1/state/" "$h/.local/state/opencode/" "${ex[@]}"
        _import_copy "$v1/cache/" "$h/.cache/opencode/" "${ex[@]}"
        ;;
    host)
        _import_copy "$HOME/.config/opencode/" "$h/.config/opencode/" "${ex[@]}"
        _import_copy "$HOME/.local/share/opencode/auth.json" "$h/.local/share/opencode/auth.json"
        _import_copy "$HOME/.local/share/opencode/account.json" "$h/.local/share/opencode/account.json"
        _import_copy "$HOME/.local/state/opencode/model.json" "$h/.local/state/opencode/model.json"
        # Installed plugin packages (e.g. oh-my-opencode-slim) and the model
        # catalog. Without them the first run has to install plugins, which
        # outlasts opencode's plugin-activation timeout.
        _import_copy "$HOME/.cache/opencode/npm/" "$h/.cache/opencode/npm/" --exclude='.staging-*'
        _import_copy "$HOME/.cache/opencode/models.json" "$h/.cache/opencode/models.json"
        _import_opencode_credentials "$HOME/.local/share/opencode/opencode.db" \
            "$h/.local/share/opencode/opencode.db"
        ;;
    esac
}

# opencode v2 keeps provider credentials and its account login in SQLite
# (tables credential / account / account_state / control_account), not in
# auth.json. Copy just those rows -- not your whole session history. Uses
# sqlite3 itself so a live WAL database is read consistently.
_import_opencode_credentials() {
    local src="$1" dst="$2" t
    [ -f "$src" ] || return 0
    if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "note: sqlite3 not found; opencode credentials not imported" >&2
        return 0
    fi
    mkdir -p -- "$(dirname -- "$dst")"
    if [ ! -f "$dst" ]; then
        # No sandbox database yet: start from an empty copy of the host
        # schema (same opencode version) holding only the credential tables.
        sqlite3 "$src" ".backup '$dst'"
        sqlite3 "$dst" "$(sqlite3 "$dst" "select 'DELETE FROM \"' || name || '\";' from sqlite_master
            where type='table' and name not in ('credential','account','account_state','control_account','migration')
            and name not like 'sqlite_%'")" 'VACUUM;'
        return 0
    fi
    for t in credential account account_state control_account; do
        sqlite3 "$src" "select 1 from sqlite_master where type='table' and name='$t'" | grep -q 1 || continue
        sqlite3 "$src" ".mode insert $t" "select * from \"$t\";" \
            | sed 's/^INSERT INTO/INSERT OR REPLACE INTO/' \
            | sqlite3 "$dst"
    done
}
