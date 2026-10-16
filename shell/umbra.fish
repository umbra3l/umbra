# umbra shell integration for fish. Installed by install.sh as
# ~/.config/fish/conf.d/umbra.fish (symlink).
#
# `claude`, `agy` and `opencode` now start sandboxed in the current
# directory. The unsandboxed binaries stay reachable with `command claude`
# etc. Arguments pass through untouched, so `claude -c`, `agy -p "..."`,
# `opencode run ...` all behave as before.

function claude --wraps claude --description 'Claude Code (umbra sandbox)'
    umbra run claude $argv
end

function agy --wraps agy --description 'Antigravity CLI (umbra sandbox)'
    umbra run agy $argv
end

function opencode --wraps opencode --description 'OpenCode (umbra sandbox)'
    umbra run opencode $argv
end
