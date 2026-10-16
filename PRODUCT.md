# Product

<!-- impeccable:product-schema 1 -->

## Platform

terminal (TUI, built on OpenTUI + Bun; compiled to `build/umbra-tui`). Not web: no browser, no DOM.

## Users

Primary user is the author: a developer on CachyOS with the niri compositor and a quickshell desktop. They use kitty (JetBrains Mono Nerd Font, 11pt), usually in a tall half-screen tile, sometimes full-screen. They run Claude Code, OpenCode and Antigravity (`agy`) many times a day. The TUI is their **home base**: they open `umbra`, pick a tool and launch from it most of the time.

They plan to publish umbra later, so it must also hold up on other people's terminals (other fonts, palettes, sizes).

## Product Purpose

umbra runs each AI coding CLI inside its own microVM so that it feels native while everything else on the laptop stays out of reach:

- the project at its real path, as your uid, with persistent sign-ins;
- egress that asks before reaching new domains;
- an automatic undo snapshot of the project;
- a separate guest kernel behind a jailed VMM.

The TUI is the launcher and control surface for that. Success means getting from `umbra` to a running tool with near-zero delay, while knowing where it will run and how protected it is. Checking on sessions (changes, undo, egress, audit, sign-in) should be one keystroke away.

## Positioning

A sandbox people actually keep on: the security lives in the plumbing (VM, jail, proxy, snapshots), and the surface is about the user and their tools, not about fear.

## Operating Context

- Launched as `umbra` (no arguments) from a project directory. All actions apply to that directory.
- Actions per tool: Launch, Shell, Sign in, Last session's changes (snapshot diff), Undo last session, Egress log, Security audit. opencode also has Refresh models.
- Launch/Shell/Sign in/Undo suspend the TUI and hand the terminal to the tool or VM, then resume. The others render inside the TUI.
- The session summary (files changed, risky files) prints when a tool exits, just before the TUI resumes.
- Tools: Claude Code (parallel sessions OK), OpenCode and agy (one live session each, because of SQLite).
- Egress modes: ask (default), strict, open, host, none.
- The terminal palette is generated from the wallpaper (Material You via quickshell, applied as OSC 4 / 10 / 11 sequences) and changes whenever the wallpaper does.

## Capabilities and Constraints

- Keyboard-first. Mouse optional.
- Must not add perceptible delay to launching. Motion may run while idle or during transitions, but never blocks Enter → tool.
- Must render well from about 80×24 up to full-screen (~250×70), and in tall narrow tiles.
- Colors must follow the terminal's palette (the wallpaper colors), with a sane fallback where palette queries aren't answered.
- After returning from a VM the terminal must be restored to blocking mode (libkrun leaves it O_NONBLOCK; already handled in `umbra.ts`).
- Data the TUI can show truthfully:
  - tool list and versions (from the host binaries);
  - the current directory and its git root;
  - the egress mode;
  - the egress log at `~/.local/share/umbra/logs/egress.log`;
  - snapshot count and age for this project;
  - whether a tool's exclusive lock is held (opencode/agy running);
  - `umbra diff` / `audit` output.

## Brand Commitments

- Name: **umbra**, lowercase in prose. The TUI shows it as the product mark with the version `v2.0`.
- Colors come from the user's terminal palette (wallpaper-derived). This is the only binding visual commitment.
- Must not look like a hacker cliché (neon green, glitch, matrix rain, "cyber" styling) or a generic TUI dashboard (boxes, borders, a list).

## Evidence on Hand

Real data is available at runtime (tools, versions, cwd, egress decisions, snapshots, audit results). No screenshots, logos or external assets exist; don't invent user counts, testimonials or claims.

## Product Principles

1. **The door, not the lobby.** Launching is the main act: one keystroke, no delay.
2. **Show the shadow truthfully.** Every status shown must come from real state (locks, snapshots, egress decisions), never decoration.
3. **Calm by default.** Safety is communicated by clarity, not alarm. Warnings are reserved for real risk (e.g. host-executed files changed).
4. **It's the user's desktop.** Inherit their colors and fit their tiles.
