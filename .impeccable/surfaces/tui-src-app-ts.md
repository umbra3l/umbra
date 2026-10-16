---
version: 1
slug: "tui-src-app-ts"
primary_target: "tui/src/app.ts"
related_targets: ["tui/src"]
---

# Surface: umbra TUI launcher (tui/src)

Mode: Operate. The home base for launching sandboxed AI CLIs, opened many times a day in kitty (often a tall niri tile).

Job: pick a tool, see where it will run and how it is protected, then launch it with zero delay. Check on sessions (changes, undo, egress, audit, sign-in) in one keystroke.

Constraints:
- Colours come live from the terminal palette (wallpaper / Material You). Fallback palette when OSC queries go unanswered.
- No launch delay.
- No hacker cliché, no generic boxed dashboard.
- Works from 80×24 to full-screen, and in tall narrow tiles.
- Every mark is truthful state.

## Direction contract

THESIS: Your agents orbit a sealed core. Choosing a tool swings its body to the front; launching sends it into the shadow, and it re-emerges when the session ends. This refuses the category default: centred ASCII logo, boxed list, keybind footer.

OWN-WORLD:
- The terminal's own background is the night.
- One hairline weight in the palette's dim grey, drawn as braille orbits.
- A black core with a corona in the selected tool's colour. A dotted halo around it in palette magenta is the egress mode.
- Tools wear palette inks: claude red/pink (1), opencode blue (4), agy green (2). Warnings use yellow (3).
- No boxes: regions are marked only by corner registration ticks.
- Only the selected tool's name is large (an ASCII display font); everything else is small type.
- State marks: rest = dim key letter; focused = a filled pill in the tool's ink; disabled = struck dim; spent = dim with a reason.

STORY: In one glance you know which tool is up, where it will run (project or sandbox home), the egress mode, live sessions (rings), and what the last session changed. One keystroke launches; returning shows what happened, with a warning when host-executed files changed.

FIRST VIEWPORT (wide):
- Header: ● umbra v2.0 on the left; egress mode · vCPU · RAM on the right.
- Left ~55%: the orrery inside four registration ticks. Core centred, three tilted orbits, the selected body large at the front.
- Right: the tool name at display scale; a subline with full name, version and concurrency; a last-session line; then seven keyed actions with the focused one as a pill.
- Bottom: a status line with ◆ project + branch · snapshots · live sessions, and key hints.

Narrow: orrery on top, name and actions below. Tiny: a one-line orbit strip.

FORM: Orrery, candidate 7 of 7 on my ordered list. Seed key b681ebea. Raised by:
- plate section (registration ticks, never boxes);
- centre-rail (one state-mark grammar; damped single-axis UI motion);
- type specimen (hierarchy by scale contrast alone).

Signature interaction: tool change rotates the system so the chosen body swings to the front along its orbit (exponential ease-out, ~550 ms), while the name slides on one axis. Launch is instant. On resume the body emerges from behind the core to the front (~700 ms) as the session summary fades in.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Motion thesis

- Focal moment: emergence from the umbra after a session.
- Continuity: orbit rotation on tool change; reader views slide in on one axis while the orrery dims into shadow.
- Feedback: pill flash on Enter, which never delays the launch. A corona sweep while an audit runs, with results streaming in.
- Budget: idle drift ≤ 20 fps; transitions 60 fps; reduced motion via UMBRA_REDUCED_MOTION=1 (static, instant).

## Unresolved

- Mouse support is optional (click a body to select it, click an action to run it).
