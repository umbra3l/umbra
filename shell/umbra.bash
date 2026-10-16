# umbra shell integration for bash and zsh. Add to ~/.bashrc or ~/.zshrc:
#     source ~/.config/umbra/shell/umbra.bash
#
# `claude`, `agy` and `opencode` start sandboxed in the current directory;
# `command claude` etc. bypasses the sandbox.

claude() { umbra run claude "$@"; }
agy() { umbra run agy "$@"; }
opencode() { umbra run opencode "$@"; }
